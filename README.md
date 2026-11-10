# 上下文窗口切换器 · dsh-window

在 DSH 输入框的工具行右侧，为**当前会话**临时切换上下文窗口大小（`contextWindow`）；
新建会话自动恢复 Profile 默认值。

对标 WorkBuddy：模型详情面板中「思考强度」+「上下文窗口」两个配置项并列，会话级临时生效。

## 维护说明

本仓库是 [luyiheng1111/dsh-context-window-picker](https://github.com/luyiheng1111/dsh-context-window-picker)
的**延续维护版**。原作者发布 v0.1.0 后未再维护（MIT 许可），本仓库自 v0.2.0 起接手开发，
v0.4.0 起定名为 `dsh-window`（包名、插件 id、API 前缀、bundle patch 同步变更；
仓库也一并改名为 `dsh-window`），原作者的署名与版权完整保留。

> npm 上的 `dsh-window` 已被别人占用，所以发布名是 **`@rayadesu/dsh-window`**。
> 插件 id / API 前缀仍然是 `dsh-window`，不带 scope。

## 安装

```bash
npm i @rayadesu/dsh-window
```

或者从源码装：

```bash
git clone https://github.com/rayadesune/dsh-window.git
```

然后在 DSH 的 Plugins 页面里用本地目录安装（Install from path / 本地 bundle）指向刚 clone 的目录。
插件没有构建步骤、没有运行时依赖（React 由宿主提供），
默认走 bundle patch 里的 `presets`/`completionRatio` 等默认值，无需任何配置。

> **注意**：如果之前安装过原版 `dsh-context-window-picker`，请先卸载再装本插件。
> 两者是不同的插件 id，同时安装会对 `llm` 服务产生双重包装。

## 交互

1. 输入框工具行里，**模型按钮左边**有一个 **`1M`** 这样的纯文字按钮 —— 不带图标、不带箭头。
2. 点一下**直接展开档位菜单**（和「允许完全访问」那个审批按钮同一套 `Menu` 组件）：
   - 默认（跟随模型）
   - 300K / 600K（只列出不超过当前模型默认窗口的档位；
     选中与默认相同的档位等同于回到「默认」）
   当前档位右侧有勾选标记。
3. 选中后菜单关闭、焦点回到按钮，覆盖立即写入当前会话；
   再发一条消息，`request/context` 事件里的上下文窗口即为新值。
4. 新建会话不携带该选择，自动回到适配器目录里的默认窗口。

菜单的定位、材质、键盘行走（`↑`/`↓`/`Tab`/`Enter`/`Esc`）、选中后回焦、点击外部关闭
全部由原生 `Menu` 组件负责，插件不重写其中任何一条。

## 为什么不是「改 Profile 配置」

`defaultContextWindow` 是适配器目录（`llm-pi-ai.providers.*.models[].contextWindow` / `llm-deepseek`）
的全局值，改它会影响所有会话。本插件只在宿主内存里按 **sessionId** 记录覆盖值，
不写任何配置文件，也不写会话日志（不污染 session log）。

## 实现要点

### 客户端半：只用官方开放槽位，不碰原生模型弹窗

- **`conversation.input.right`**（`list` / `session` / `replaceRisk: none`）
  注册一个独立控件 —— 就是工具行上的那个窗口按钮。这是本插件唯一的交互入口。
- **`conversation.input.model.label`**（`inline single` / `session` / `replaceRisk: none`）
  严格按官方契约只渲染**非交互**的 `model.name` 文本，
  同时把 owner props 里的 `provider.id` / `model.id` 当作纯数据记录下来，
  供控件向宿主查询当前模型的基准窗口。它不注入控件、不隐藏节点、不抢焦点。
- 菜单直接用原生 `Menu` 组件（`@deepseek-ai/dsh-client-ui-primitives`，平台共享模块）：
  `side="top"`、`align="end"`、`portal`，items 就是「默认 / 300K / 600K」三行数据。
  材质、圆角、行高、字号、勾选样式、键盘行走、选中回焦、外部点击关闭全部来自组件本身，
  插件不复制任何一条规则、也不接管焦点。
- 触发器只写一份 5 条规则的小样式表，数值直接取自官方 `ModelSelect` 的 `.trigger`：
  `28px` 高、`13px/20px`、`--dsw-alias-label-secondary`、`--dsw-radius-sm`、
  hover 用 `--dsw-alias-interactive-bg-hover`、focus ring 用 `--dsw-focus-ring-color`，
  再补 `padding:0 8px`（没有图标也没有箭头，左右对称）和
  `margin-right:-6px`（官方兄弟控件收紧间距的写法，把容器 12px 的 gap 收成 6px）。
  不再运行时解析官方 CSS Module 哈希，也就没有 fallback 分支。

因为整条链路都在官方槽位契约内，插件的交互节点从未进入原生模型弹窗，
所以不存在「点击后被官方 `onBlur` 关掉」的问题，也不会因为官方改弹窗内部结构而失效。

### 宿主半

在 `llm` 服务的原型上包装两个公开方法（插件卸载时精确还原）：

- `llm.prepareCall(config, signal, configure)`：通过官方 `configure` 回调收紧 `maxTokens`，
  并在返回的冻结调用对象上把 `context.contextWindow` 换成会话覆盖值。
  这一步保证 `request/context` 事件、token 计量、压缩阈值看到的是同一个窗口。
- `llm.resolveModelInfo(provider, model)`：`compaction-basic` 通过它取窗口，
  所以压缩压力判断同样使用会话覆盖值。
- `Session#requestHeader` 在覆盖生效期间夹紧 `config.maxTokens`，
  避免压缩策略拿旧的 256K 完成预留去比新的小窗口而直接抛错。

客户端与宿主之间走本机回环 JSON 接口：
`GET /dsh-window/api/{state,health}`、`POST /dsh-window/api/set`，
请求校验 Host 为回环地址、拒绝 `sec-fetch-site: cross-site` 与非同源 `Origin`。

## 压缩阈值

自动压缩由 `compaction-basic` 按路由到的窗口定价。官方规则是
`阈值 = min(窗口 × 0.8, 窗口 − 本次输出预留 − headroom)`，默认 headroom 64K。
这套参数是按 Profile 里的目录窗口（例如 1M）调的，所以只改窗口不改阈值时，
选了 300K 的会话仍会在 1M 的压力点上才压缩 —— 请求早就超窗了。

本插件按档位切换策略：

| 档位 | 压缩阈值 | 规则 |
| --- | --- | --- |
| 默认 | `min(窗口 × 0.8, 窗口 − 预留 − headroom)` | 官方规则，插件不干预 |
| 300K / 600K | **307,200 / 614,400** | 等于所选窗口本身 |

阈值等于整个窗口之所以安全：覆盖只缩小 DSH 的**规划**窗口，适配器真实的
`contextWindow` 仍是目录里的值（这台机器是 1M）。请求实际能装下的空间没有变小，
所以「到 300K 才压缩」不会超窗，只是把压缩点推到了 300K。

实现上，宿主半边在 `compaction` 服务的 `compactIfNeeded` / `compactNow` 外面包一层，
把当前会话绑定到这次调用；`llm.resolveModelInfo` 返回覆盖窗口后，定价那一拍
把 `Session#requestHeader().config.maxTokens` 报成 0（只在同一个 tick 内，下一个宏任务就恢复），
于是 `compaction-basic` 算出 `阈值 = min(窗口 × 1, 窗口 − 0 − 0) = 窗口`。
策略视图按会话取值（覆盖会话 `thresholdRatio 1` + `headroom 0`，其余会话透传官方配置对象），
默认会话完全不会被改写。

## 配置（bundle patch 或 profile patch 里可改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `presets` | `[307200, 614400]` | 候选窗口（300K / 600K；只显示不超过模型默认值的） |
| `completionRatio` | `0.25` | 单次输出上限 ≤ 窗口 × 该比例 |
| `headroomTokens` | `65536` | 与压缩策略的 headroom 对齐，保证压缩不会因预留不足报错 |
| `minimumWindow` | `131072` | 最小可选窗口；低于它的模型只显示「默认」 |

## 文件

- `index.js` — 宿主插件（llm 拦截、按会话覆盖、回环 API）
- `client.js` — 客户端 UI（工具行按钮 + 同卡切页的档位卡片）
- `cordis.patch.yml` — bundle patch，插入宿主插件行
- `locale/{zh,en}.json` — 插件管理器 / 市场展示元数据
- `icon.svg` — 插件图标

## 已验证

- 宿主：`GET /dsh-window/api/state` 在当前模型（base 1048576）上给出
  `默认 → 阈值 720896`（官方规则）、`300K → 307200`、`600K → 614400`，
  `compaction.mode` 分别为 `official` / `window`；`POST /api/set` 设值、越界、
  回默认三条路径都验证过。覆盖后下一条请求的 `request/context` 记录新的
  `contextWindow`，`request/header.maxTokens` 同步收紧。
- 客户端：`node --check client.js` 通过；菜单走原生 `Menu`，客户端里没有自绘卡片、
  没有焦点/定位/外部点击代码，也没有官方 CSS 哈希解析。

> 改 profile 的 `cordis.patch.yml`（例如换档位）由 HMR 热加载，连 `index.js`
> 的新代码也会一起重新求值，不需要重启 DSH。`client.js` 仍需刷新窗口。

## 安全说明

宿主半边通过包装 `llm` 服务原型的方法（`prepareCall` / `resolveModelInfo`）、
`Session#requestHeader`，以及 `compaction` 服务的 `compactIfNeeded` / `compactNow`
来施加覆盖——DSH 目前没有官方的「按会话改上下文窗口 / 压缩阈值」接口。
这些包装在插件卸载时精确还原。所有对客户端暴露的接口都是本机回环 JSON：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/dsh-window/api/state` | GET | 读取当前会话的基准窗口 / 覆盖值 / 候选档位 |
| `/dsh-window/api/set` | POST | 设置或（传 `null`）清除本会话覆盖 |
| `/dsh-window/api/health` | GET | patch 计数与当前配置（诊断用） |

请求会被校验：Host 必须是回环地址或 `webRuntime.trustedHosts` 中的授权域，
拒绝 `sec-fetch-site: cross-site`，且 `Origin` 必须缺失、为 `dsh-app://app` 或与 Host 同源。

## 已知限制

- 候选档位只显示**不超过**模型基准窗口的值（放大窗口属于模型/Profile 层面的能力）。
- 覆盖只影响之后发出的请求；正在执行的 step 保持它启动时的窗口。
- 压缩阈值等于所选窗口是建立「适配器真实窗口远大于所选窗口」这个前提上的：
  若某天所选值接近模型真实上限，请把档位调低。
- 入口在输入框工具行，**不在原生模型弹窗内部**。官方的 root pane 行列表是硬编码 JSX，
  没有对应的 list/chain 槽位，第三方无法合规地往那里追加一行；
  而 `conversation.input.model.label` 的契约明确要求只渲染非交互内联内容。
  把入口放在 `conversation.input.right` 是当前唯一无契约风险的方案。
- 输入框上的模型按钮不追加窗口后缀；窗口只在工具行的独立按钮上展示。

## 许可

[MIT](LICENSE) © 2026 [luyiheng1111](https://github.com/luyiheng1111)（原作者）
© 2026 rayadesune（当前维护者）
