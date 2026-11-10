/**
 * dsh-window — host half.
 *
 * One job, two levers, both session-scoped and memory-only:
 *
 *  1. **Window** — `llm.prepareCall` / `llm.resolveModelInfo` are wrapped so the
 *     active session's `context.contextWindow` is the override, with `maxTokens`
 *     clamped to fit it. The frozen prepared call stays internally consistent
 *     because `maxTokens` is changed through the supported `configure` callback.
 *  2. **Compaction threshold** — `compaction-basic` prices pressure from the
 *     routed window with its own defaults (0.8 × window, capped by
 *     `window - reservation - headroom`). Those are tuned for the catalog window,
 *     so an override also swaps the policy object it reads (ratio 1, headroom 0)
 *     and reports no completion reservation for that single pricing step: the
 *     threshold becomes the selected window itself. Sessions without an override
 *     keep the shipped policy object untouched.
 *
 * `Session#requestHeader` is clamped while an override is live so the request
 * envelope never reserves more output than the smaller window can hold.
 *
 * Every seam is prototype-patched and restored on unload. Nothing is written to
 * the Profile or to the session log; a new session starts at the catalog value.
 */

const API_PREFIX = '/dsh-window/api';
const MAX_REQUEST_BODY = 64 * 1024;
const MAX_TRACKED_SESSIONS = 512;
const MIN_COMPLETION_TOKENS = 256;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,200}$/;
const LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** compaction-basic's shipped pressure ratio; only used to report the default path. */
const OFFICIAL_THRESHOLD_RATIO = 0.8;
const DEFAULT_SETTINGS = {
  presets: [307200],
  completionRatio: 0.25,
  headroomTokens: 65536,
  minimumWindow: 131072,
};

export const name = 'dsh-window';

/** The LLM registry/stream service and the Agent registry (for session attribution). */
export const inject = ['llm', 'agents'];

export function apply(ctx, config) {
  const settings = normalizeSettings(config);
  /** sessionId -> requested context window */
  const overrides = new Map();
  /** sessionId -> output reservation derived from the last resolution */
  const reservations = new Map();
  const diagnostics = { prepareCalls: 0, resolveCalls: 0, applied: 0, lastSessionId: null, lastWindow: null };

  const llm = ctx.llm;
  const llmPrototype = prototypeOf(llm);
  if (llmPrototype === undefined) return;
  const shippedPrepareCall = llmPrototype.prepareCall;
  const shippedResolveModelInfo = llmPrototype.resolveModelInfo;
  if (typeof shippedPrepareCall !== 'function' || typeof shippedResolveModelInfo !== 'function') return;

  /**
   * Session the compaction engine is pricing right now. `currentInitiator()` is
   * not reliable inside that round trip, so the wrappers below bind it
   * explicitly for the duration of the call.
   */
  let compactionSession = null;
  /** Session whose completion reservation is zeroed for one pricing tick. */
  let zeroReservationFor = null;
  let zeroReservationTimer = null;

  // ------------------------------------------------------------- attribution

  function initiatorSessionId() {
    try {
      const sessionId = ctx.agents.currentInitiator()?.session?.id;
      return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
    } catch {
      /* no initiator boundary, or the registry is shutting down */
      return undefined;
    }
  }

  /** The session an `llm` call belongs to: compaction's binding wins. */
  function activeSessionId() {
    return compactionSession ?? initiatorSessionId();
  }

  function requestedWindow() {
    const sessionId = activeSessionId();
    if (sessionId === undefined) return undefined;
    const requested = overrides.get(sessionId);
    return requested === undefined ? undefined : { sessionId, requested };
  }

  function remember(sessionId, maxTokens) {
    reservations.delete(sessionId);
    reservations.set(sessionId, maxTokens);
    while (reservations.size > MAX_TRACKED_SESSIONS) {
      const oldest = reservations.keys().next();
      if (oldest.done === true) break;
      reservations.delete(oldest.value);
    }
    diagnostics.applied += 1;
    diagnostics.lastSessionId = sessionId;
  }

  // ------------------------------------------------------- window arithmetic

  /** Shrink `base` to the override; `changed` gates every further step. */
  function resolveWindow(base, requested) {
    const hasBase = Number.isInteger(base) && base > 0;
    const effective = hasBase ? Math.min(requested, base) : requested;
    return { effective, changed: hasBase ? effective < base : true };
  }

  /** Output budget that still fits the window (≤ ratio × window, keeps headroom). */
  function completionLimit(window, requested) {
    const safe = Math.max(2 * MIN_COMPLETION_TOKENS, Math.floor(window));
    const headroom = Math.min(settings.headroomTokens, Math.floor(safe / 2));
    const ratioLimit = Math.max(MIN_COMPLETION_TOKENS, Math.floor(safe * settings.completionRatio));
    const budgetLimit = Math.max(MIN_COMPLETION_TOKENS, safe - headroom - 1);
    const limit = Math.min(ratioLimit, budgetLimit);
    if (!Number.isFinite(requested)) return limit;
    const value = Math.floor(requested);
    return value < 1 ? limit : Math.min(value, limit);
  }

  // -------------------------------------------------------------- llm seams

  function patchedPrepareCall(config, signal, configure) {
    diagnostics.prepareCalls += 1;
    const active = requestedWindow();
    if (active === undefined) return shippedPrepareCall.call(this, config, signal, configure);
    let resolution;
    const configureCall = (controls, modelInfo) => {
      resolution = resolveWindow(modelInfo?.context?.contextWindow, active.requested);
      diagnostics.lastWindow = resolution.effective;
      const seeded = typeof configure === 'function' ? configure(controls, modelInfo) : controls;
      if (resolution.changed !== true) return seeded;
      return {
        ...seeded,
        maxTokens: completionLimit(resolution.effective, seeded?.maxTokens ?? modelInfo?.defaultMaxTokens),
      };
    };
    return Promise.resolve(shippedPrepareCall.call(this, config, signal, configureCall)).then((prepared) => {
      if (resolution === undefined || resolution.changed !== true) return prepared;
      remember(active.sessionId, completionLimit(resolution.effective, prepared?.config?.maxTokens));
      if (prepared?.context === undefined || prepared.context === null) return prepared;
      return Object.freeze({
        ...prepared,
        context: Object.freeze({ ...prepared.context, contextWindow: resolution.effective }),
      });
    });
  }

  function patchedResolveModelInfo(provider, model, signal) {
    diagnostics.resolveCalls += 1;
    const active = requestedWindow();
    if (active === undefined) return shippedResolveModelInfo.call(this, provider, model, signal);
    return Promise.resolve(shippedResolveModelInfo.call(this, provider, model, signal)).then((info) => {
      const resolution = resolveWindow(info?.context?.contextWindow, active.requested);
      if (resolution.changed !== true) return info;
      // compaction-basic reads the reservation from `session.requestHeader()`
      // in the same tick as this call; zeroing it there makes the threshold the
      // window itself.
      if (compactionSession === active.sessionId) armZeroReservation(active.sessionId);
      const defaultMaxTokens = completionLimit(resolution.effective, info?.defaultMaxTokens);
      remember(active.sessionId, defaultMaxTokens);
      return {
        ...info,
        context: { ...(info?.context ?? {}), contextWindow: resolution.effective },
        defaultMaxTokens,
      };
    });
  }

  ctx.effect(() => {
    llmPrototype.prepareCall = patchedPrepareCall;
    llmPrototype.resolveModelInfo = patchedResolveModelInfo;
    return () => {
      if (llmPrototype.prepareCall === patchedPrepareCall) llmPrototype.prepareCall = shippedPrepareCall;
      if (llmPrototype.resolveModelInfo === patchedResolveModelInfo) {
        llmPrototype.resolveModelInfo = shippedResolveModelInfo;
      }
    };
  }, 'dsh-window: llm seams');

  // ------------------------------------------------------- request envelope

  function armZeroReservation(sessionId) {
    zeroReservationFor = sessionId;
    if (zeroReservationTimer !== null) clearTimeout(zeroReservationTimer);
    zeroReservationTimer = setTimeout(() => {
      zeroReservationFor = null;
      zeroReservationTimer = null;
    }, 0);
  }

  function clampHeader(header, sessionId) {
    if (header === null || header === undefined || sessionId === undefined) return header;
    const config = header.config;
    if (config === null || config === undefined) return header;
    const zeroed = zeroReservationFor !== null && zeroReservationFor === sessionId;
    const reservation = reservations.get(sessionId);
    if (!zeroed && reservation === undefined) return header;
    const current = config.maxTokens;
    const next = zeroed ? 0 : Number.isFinite(current) ? Math.min(current, reservation) : reservation;
    if (next === current) return header;
    return Object.freeze({ ...header, config: Object.freeze({ ...config, maxTokens: next }) });
  }

  const headerPatches = new Map();

  function patchSession(session) {
    if (session === null || typeof session !== 'object') return;
    const proto = prototypeOf(session);
    if (proto === undefined || headerPatches.has(proto)) return;
    const original = proto.requestHeader;
    if (typeof original !== 'function') return;
    const wrapper = function requestHeaderWithWindowOverride() {
      return clampHeader(original.call(this), this?.id);
    };
    headerPatches.set(proto, { original, wrapper });
    proto.requestHeader = wrapper;
  }

  ctx.effect(() => {
    const stop = ctx.on('agent/created', (payload) => {
      try {
        patchSession(payload?.agent?.session);
      } catch {
        /* the Agent may be disposed while we look at it */
      }
    });
    try {
      for (const agent of ctx.agents.list()) patchSession(agent?.session);
    } catch {
      /* registry not readable yet */
    }
    return () => {
      if (typeof stop === 'function') stop();
      for (const [proto, entry] of headerPatches) {
        if (proto.requestHeader === entry.wrapper) proto.requestHeader = entry.original;
      }
      headerPatches.clear();
    };
  }, 'dsh-window: request envelope');

  ctx.on('agent/disposed', (payload) => {
    const sessionId = payload?.agent?.session?.id;
    if (typeof sessionId === 'string') reservations.delete(sessionId);
  });

  // --------------------------------------------------- compaction threshold

  /**
   * The policy object `compaction-basic` reads. Getters keep the shipped values
   * for every ordinary session and report `ratio 1` + `headroom 0` only while an
   * overriding session is being priced.
   */
  function policyView(shipped) {
    const overriding = () =>
      compactionSession !== null && overrides.get(compactionSession) !== undefined;
    const view = {};
    for (const key of Object.keys(shipped)) {
      if (key === 'thresholdRatio' || key === 'headroomTokens') continue;
      Object.defineProperty(view, key, { enumerable: true, get: () => shipped[key] });
    }
    Object.defineProperty(view, 'thresholdRatio', {
      enumerable: true,
      get: () => (overriding() ? 1 : shipped.thresholdRatio),
    });
    Object.defineProperty(view, 'headroomTokens', {
      enumerable: true,
      get: () => (overriding() ? 0 : shipped.headroomTokens),
    });
    return view;
  }

  /** Run one engine call with its session bound; clears on every exit path. */
  function bindSession(original) {
    return function compactionWithWindowOverride(agent, ...rest) {
      if (compactionSession !== null) return original.apply(this, [agent, ...rest]);
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId === '') return original.apply(this, [agent, ...rest]);
      compactionSession = sessionId;
      const leave = () => {
        compactionSession = null;
      };
      let pending;
      try {
        pending = original.apply(this, [agent, ...rest]);
      } catch (error) {
        leave();
        throw error;
      }
      if (pending === null || typeof pending?.then !== 'function') {
        leave();
        return pending;
      }
      return pending.then(
        (value) => {
          leave();
          return value;
        },
        (error) => {
          leave();
          throw error;
        },
      );
    };
  }

  ctx.inject(['compaction'], (scope) => {
    const engine = scope.compaction;
    const proto = engine === null || typeof engine !== 'object' ? undefined : prototypeOf(engine);
    const shipped = engine?.config;
    if (proto === undefined || shipped === null || typeof shipped !== 'object') return;
    const shippedIfNeeded = proto.compactIfNeeded;
    const shippedNow = proto.compactNow;
    if (typeof shippedIfNeeded !== 'function' || typeof shippedNow !== 'function') return;
    const view = policyView(shipped);
    const patchedIfNeeded = bindSession(shippedIfNeeded);
    const patchedNow = bindSession(shippedNow);
    scope.effect(() => {
      engine.config = view;
      proto.compactIfNeeded = patchedIfNeeded;
      proto.compactNow = patchedNow;
      return () => {
        if (engine.config === view) engine.config = shipped;
        if (proto.compactIfNeeded === patchedIfNeeded) proto.compactIfNeeded = shippedIfNeeded;
        if (proto.compactNow === patchedNow) proto.compactNow = shippedNow;
      };
    }, 'dsh-window: compaction threshold');
  });

  // ------------------------------------------------------------------- API

  /** Pressure point the engine will use; `official` is DSH's own rule. */
  function compactionInfo(sessionId, window, overridden) {
    if (!Number.isInteger(window) || window <= 0) return null;
    if (overridden) return { mode: 'window', ratio: 1, headroom: 0, reserved: 0, threshold: window };
    const reservation = reservations.get(sessionId);
    const reserved = Number.isInteger(reservation) ? reservation : completionLimit(window, undefined);
    const headroom = settings.headroomTokens;
    const budget = Math.max(0, window - reserved - headroom);
    const threshold = Math.floor(Math.min(window * OFFICIAL_THRESHOLD_RATIO, budget));
    return { mode: 'official', ratio: OFFICIAL_THRESHOLD_RATIO, headroom, reserved, threshold: Math.max(0, threshold) };
  }

  function describe(sessionId, base, requested) {
    const hasBase = Number.isInteger(base) && base > 0;
    const hasOverride = Number.isInteger(requested);
    const window = hasOverride ? (hasBase ? Math.min(requested, base) : requested) : base;
    const presets = hasBase
      ? settings.presets.filter((value) => value <= base && value >= settings.minimumWindow)
      : settings.presets.slice();
    return {
      ok: true,
      sessionId,
      base: hasBase ? base : null,
      override: hasOverride ? requested : null,
      effective: Number.isInteger(window) ? window : null,
      presets,
      compaction: compactionInfo(sessionId, window, hasOverride),
    };
  }

  /** Catalog window for one provider/model, bypassing our own wrapper. */
  async function catalogWindow(provider, model) {
    if (provider === '' || model === '') return undefined;
    try {
      const info = await shippedResolveModelInfo.call(llm, provider, model);
      const value = info?.context?.contextWindow;
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async function handleState(req, res) {
    if (!trusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const query = new URL(req.url ?? API_PREFIX, 'http://localhost').searchParams;
    const sessionId = query.get('sessionId') ?? '';
    const base = await catalogWindow(query.get('provider') ?? '', query.get('model') ?? '');
    if (!SESSION_ID_PATTERN.test(sessionId)) return writeJson(res, 200, describe('', base, undefined));
    return writeJson(res, 200, describe(sessionId, base, overrides.get(sessionId)));
  }

  async function handleSet(req, res) {
    if (!trusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return writeJson(res, 400, { ok: false, error: messageOf(error) });
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return writeJson(res, 400, { ok: false, error: 'invalid session id' });
    }
    const base = await catalogWindow(
      typeof body.provider === 'string' ? body.provider : '',
      typeof body.model === 'string' ? body.model : '',
    );
    const requested = body.window;
    if (requested === null || requested === undefined) {
      overrides.delete(sessionId);
      reservations.delete(sessionId);
      return writeJson(res, 200, describe(sessionId, base, undefined));
    }
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
      return writeJson(res, 400, { ok: false, error: 'window must be a positive integer or null' });
    }
    if (requested < settings.minimumWindow) {
      return writeJson(res, 400, {
        ok: false,
        error: `window must be at least ${settings.minimumWindow}`,
        minimumWindow: settings.minimumWindow,
      });
    }
    if (Number.isInteger(base) && requested > base) {
      return writeJson(res, 400, { ok: false, error: 'window must not exceed the model default', base });
    }
    // Picking the catalog window clears the override instead of pinning an equal
    // value, so the session keeps following the catalog if it grows.
    if (Number.isInteger(base) && requested === base) {
      overrides.delete(sessionId);
      reservations.delete(sessionId);
      return writeJson(res, 200, describe(sessionId, base, undefined));
    }
    overrides.set(sessionId, requested);
    reservations.delete(sessionId);
    while (overrides.size > MAX_TRACKED_SESSIONS) {
      const oldest = overrides.keys().next();
      if (oldest.done === true) break;
      overrides.delete(oldest.value);
    }
    return writeJson(res, 200, describe(sessionId, base, requested));
  }

  function handleHealth(req, res) {
    if (!trusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
    return writeJson(res, 200, {
      ok: true,
      plugin: name,
      sessions: overrides.size,
      reservations: reservations.size,
      headerPatches: headerPatches.size,
      diagnostics,
      settings,
    });
  }

  const trusted = (req) => isTrustedRequest(req, trustedHosts());

  function trustedHosts() {
    try {
      return ctx.webRuntime?.trustedHosts;
    } catch {
      return undefined;
    }
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  }

  ctx.inject(['webServer'], (scope) => {
    const routes = [
      [`${API_PREFIX}/state`, handleState],
      [`${API_PREFIX}/set`, handleSet],
      [`${API_PREFIX}/health`, handleHealth],
    ];
    for (const [path, handler] of routes) {
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path,
            handler: (req, res) => {
              Promise.resolve(handler(req, res)).catch((error) => {
                writeJson(res, 500, { ok: false, error: messageOf(error) });
              });
            },
          }),
        `dsh-window: route ${path}`,
      );
    }
  });
}

// --------------------------------------------------------------------- utils

function normalizeSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const presets = Array.isArray(source.presets)
    ? source.presets.filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b)
    : [];
  return {
    presets: presets.length === 0 ? [...DEFAULT_SETTINGS.presets] : presets,
    completionRatio: clampNumber(source.completionRatio, 0.05, 0.9, DEFAULT_SETTINGS.completionRatio),
    headroomTokens: Math.max(0, Math.floor(clampNumber(source.headroomTokens, 0, 1e7, DEFAULT_SETTINGS.headroomTokens))),
    minimumWindow: Math.max(8192, Math.floor(clampNumber(source.minimumWindow, 8192, 1e8, DEFAULT_SETTINGS.minimumWindow))),
  };
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function prototypeOf(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) return undefined;
    return proto;
  } catch {
    return undefined;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isLoopback(hostname) {
  const host = stripBrackets(hostname);
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::' || LOOPBACK_PATTERN.test(host);
}

function isTrustedRequest(req, trustedHosts) {
  const hostname = hostnameOf(req?.headers?.host);
  if (hostname === undefined) return false;
  const authorized = isLoopback(hostname) || (Array.isArray(trustedHosts) && trustedHosts.some((entry) => {
    if (typeof entry !== 'string') return false;
    const authority = hostnameOf(entry) ?? entry.trim().toLowerCase();
    return stripBrackets(authority) === stripBrackets(hostname);
  }));
  if (!authorized) return false;
  const site = req?.headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') return false;
  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'dsh-app://app') {
    let originHostname;
    try {
      originHostname = new URL(origin).hostname.trim().toLowerCase();
    } catch {
      return false;
    }
    if (stripBrackets(originHostname) !== stripBrackets(hostname)) return false;
  }
  return true;
}
