/**
 * dsh-window — client half.
 *
 * One control, two slots, no shipped DOM touched:
 *
 *  - `conversation.input.right` (list, session, replaceRisk: none) renders the
 *    text trigger beside the model selector. Clicking it opens the shipped
 *    `Menu` primitive straight on the size list — the same component the
 *    permission chip and the slash-command popup use, so the card material,
 *    rows, keyboard walk, focus return and outside-click dismissal are DSH's.
 *  - `conversation.input.model.label` (inline single, session, replaceRisk: none)
 *    renders plain `model.name` text, as the contract requires, and records the
 *    owner's provider/model ids as data so the trigger can ask the host for the
 *    session's catalog window. It adds no node behaviour.
 *
 * Styling is the shipped trigger recipe (ModelSelect `.trigger`, 13px/20px,
 * `--dsw-alias-label-secondary`, 28px tall, `--dsw-radius-sm`, hover/focus
 * tokens) written once here rather than resolved from the model package at
 * runtime — the values below are copied from that stylesheet, and the 6px pull-in
 * mirrors the shipped sibling idiom (`.root + .root{margin-left:-6px}`).
 */

window.__ModuleLoader__.load({
  // Must be the package name: the loader registers the boot-graph row
  // (@rayadesu/dsh-window) and checks `factories.has(row.id)` after executing
  // this bundle. A bare plugin id registers a factory the graph never consumes,
  // so the row reports "loaded without registering".
  id: '@rayadesu/dsh-window',
  factory(require) {
    const React = require('react');
    const { Menu } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const NS = 'dsh-window';
    const LABEL_SLOT = 'conversation.input.model.label';
    const CONTROL_SLOT = 'conversation.input.right';
    const API_BASE = 'dsh-window/api';
    const CSS_MARKER = 'dsh-window';
    const DEFAULT_ID = 'default';

    const zh = {
      'trigger.aria': '上下文窗口，当前 {value}（仅本会话）',
      'trigger.title': '上下文窗口 {value} · 压缩阈值 {threshold}',
      'trigger.unknown': '—',
      'option.default': '默认（跟随模型）',
      'panel.error': '无法读取当前上下文窗口',
      'panel.failed': '切换失败',
    };
    const en = {
      'trigger.aria': 'Context window, currently {value} (this session only)',
      'trigger.title': 'Context window {value} · compacts at {threshold}',
      'trigger.unknown': '—',
      'option.default': 'Default (follows the model)',
      'panel.error': 'Could not read the current context window',
      'panel.failed': 'Could not change the context window',
    };

    const CSS = `
.dw_seat{margin-right:-6px}
.dw_trigger{display:inline-flex;align-items:center;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:20px;font-weight:400;white-space:nowrap;cursor:pointer}
.dw_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dw_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dw_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dw_value{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
`;

    // ------------------------------------------------------------- utilities

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
      if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576}M`;
      if (value >= 1024) {
        const kilo = value / 1024;
        return Number.isInteger(kilo) ? `${kilo}K` : `${kilo.toFixed(1)}K`;
      }
      return String(value);
    }

    function fill(template, vars) {
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      );
    }

    function pageBase() {
      try {
        const url = new URL(document.baseURI);
        url.search = '';
        url.hash = '';
        if (!url.pathname.endsWith('/')) {
          url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
        }
        return url;
      } catch {
        return new URL('/', window.location.origin);
      }
    }

    function apiUrl(resource, query) {
      const url = new URL(`${API_BASE}/${resource}`.replace(/^\/+/, ''), pageBase());
      if (query !== undefined) {
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
      }
      return url.href;
    }

    /** One JSON round trip; anything but `{ok: true}` rejects. */
    async function callApi(resource, init, query) {
      const body = init?.body;
      const response = await fetch(apiUrl(resource, query), {
        credentials: 'same-origin',
        ...init,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`);
      }
      return payload;
    }

    // --------------------------------------------------- catalog data bridge

    // `conversation.input.model.label` owner props carry the exact catalog
    // provider/model pair. Recorded as plain data — no DOM, no interaction — so
    // the trigger can ask the host for that model's catalog window.
    const catalog = { provider: '', model: '', revision: 0, listeners: new Set() };

    function publishCatalog(provider, model) {
      if (catalog.provider === provider && catalog.model === model) return;
      catalog.provider = provider;
      catalog.model = model;
      catalog.revision += 1;
      for (const listener of catalog.listeners) listener();
    }

    function subscribeCatalog(listener) {
      catalog.listeners.add(listener);
      return () => catalog.listeners.delete(listener);
    }

    function catalogRevision() {
      return catalog.revision;
    }

    function resolveSessionId(props, ctx) {
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
      try {
        const binding = ctx.get('uiSession')?.current?.getSnapshot?.();
        if (typeof binding?.key === 'string') return binding.key;
      } catch {
        /* the session service is optional for this control */
      }
      return '';
    }

    // ------------------------------------------------------------ label slot

    /** Strictly the official contract: non-interactive inline model name. */
    function ModelLabel(props) {
      const providerId = typeof props.provider?.id === 'string' ? props.provider.id : '';
      const modelId = typeof props.model?.id === 'string' ? props.model.id : '';
      const name = typeof props.model?.name === 'string' && props.model.name !== '' ? props.model.name : modelId;
      // Option rows call this slot too; publishing those would make the catalog
      // jump between models.
      const isCurrent =
        props.selected === true || props.placement === 'trigger' || props.placement === 'menu';
      React.useEffect(() => {
        if (isCurrent && providerId !== '' && modelId !== '') publishCatalog(providerId, modelId);
      }, [isCurrent, providerId, modelId]);
      return h('span', { title: props.provider?.name }, name);
    }

    // ---------------------------------------------------------- the control

    function ContextWindow(props) {
      const t = React.useCallback(
        (key, vars) => {
          const text = typeof props.t === 'function' ? props.t(key) : key;
          return vars === undefined ? text : fill(text, vars);
        },
        [props.t],
      );
      const sessionId = resolveSessionId(props, props.ctx);
      const revision = React.useSyncExternalStore(subscribeCatalog, catalogRevision);
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      React.useEffect(() => {
        if (sessionId === '') return undefined;
        const controller = new AbortController();
        callApi(
          'state',
          { signal: controller.signal },
          { sessionId, provider: catalog.provider, model: catalog.model },
        )
          .then((body) => {
            if (controller.signal.aborted) return;
            setState(body);
            setFailed(false);
          })
          .catch(() => {
            if (!controller.signal.aborted) setFailed(true);
          });
        return () => controller.abort();
      }, [sessionId, revision]);

      const choose = React.useCallback(
        async (window) => {
          if (busy || sessionId === '') return;
          if ((state?.override ?? null) === window) return;
          setBusy(true);
          try {
            const body = await callApi('set', {
              method: 'POST',
              body: JSON.stringify({
                sessionId,
                provider: catalog.provider,
                model: catalog.model,
                window,
              }),
            });
            setState(body);
            setFailed(false);
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        },
        [busy, sessionId, state],
      );

      const value = formatTokens(state?.effective) || t('trigger.unknown');
      const aria = t('trigger.aria', { value });
      const threshold = formatTokens(state?.compaction?.threshold);
      const presets = Array.isArray(state?.presets) ? state.presets : [];
      const items = failed
        ? [{ id: 'error', label: t('panel.error'), disabled: true }]
        : [
            { id: DEFAULT_ID, label: t('option.default') },
            ...presets.map((preset) => ({ id: String(preset), label: formatTokens(preset) })),
          ];

      return h(Menu, {
        open,
        className: 'dw_seat',
        side: 'top',
        align: 'end',
        portal: true,
        anchor: h(
          'button',
          {
            type: 'button',
            className: 'dw_trigger',
            'aria-label': aria,
            title: threshold === '' ? aria : t('trigger.title', { value, threshold }),
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            disabled: busy,
            onClick: () => setOpen(!open),
          },
          h('span', { className: 'dw_value' }, value),
        ),
        items,
        selectedId:
          state === null ? undefined : state.override === null ? DEFAULT_ID : String(state.override),
        onSelect: (id) => {
          if (id === 'error') return;
          setOpen(false);
          void choose(id === DEFAULT_ID ? null : Number(id));
        },
        onClose: () => setOpen(false),
      });
    }

    // ---------------------------------------------------------------- plugin

    let styleTag = null;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (styleTag === null) {
            styleTag = document.createElement('style');
            styleTag.dataset.pluginCss = CSS_MARKER;
            styleTag.textContent = CSS;
            document.head.appendChild(styleTag);
          }
          return () => {
            styleTag?.remove();
            styleTag = null;
          };
        }, 'dsh-window: styles');

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-window: dictionaries');

        ctx.slots.inject(LABEL_SLOT, () =>
          ctx.slots.register({ name: LABEL_SLOT, priority: -1000, locale: NS }, ModelLabel),
        );

        ctx.slots.inject(CONTROL_SLOT, () =>
          ctx.slots.register(
            { name: CONTROL_SLOT, id: 'dsh-window', order: 100, locale: NS },
            (props) => h(ContextWindow, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
