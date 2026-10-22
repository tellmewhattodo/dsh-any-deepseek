# Changelog

## v0.0.8

### 修复（owner 2026-10-22 一次报六条）

- 🔴 **增删渠道后要关面板重开才看见** —— 面板渲染的行来自 `/any-deepseek/channels`，那是
  从**配置**算出来的、不是推送。而 `removeChannel` 写完**从不重读**（`addChannel` 也没有），
  所以面板一直显示写之前的快照。修法：把重读收进 `write()` 的成功分支 —— **每个写入点自动
  继承**，不再依赖"记得加一行"。

- 🔴 **think 强度选了不生效**（"所有渠道 think 强度要支持设定"）—— 功能**不存在**，不是坏了。
  宿主 `GenerateOptions.reasoningEffort` → pi-ai `SimpleStreamOptions.reasoning` →
  `model.thinkingLevelMap` 翻成 wire 值，**三段都在，我们中间没接**：`reasoning` 只是个布尔，
  没值的；请求里的档位也没往下传。
  - 现在 `buildPiModel` 输出 `thinkingLevelMap`、`stream()` 传 `options.reasoningEffort`。
  - **没有自写翻译层**：pi-ai 的 map 就是翻译层，重复实现必然与它漂移。
  - 档位从 `low/high/max` 扩到 `low/medium/high/max`，`off` 显式标为不支持（`null`），
    选择器也不再列出不支持的那一档。

- 🔴 **opencode 渠道 400 `MissingSessionID`** —— 官方文档三条要求，我们一条没满足对：
  ① session id 必须**按会话稳定**，而 preset 里写的是**常量**（所有会话共用一个 id）；
  ② `User-Agent` 要**自报客户端**，而 pi-ai 默认用的是通用 SDK 名；
  ③ 文档把 **DeepSeek Harness 明确列为 known-problematic client**（"session information
  arrives on some model paths, but is missing on others"）。
  - 修法：session id 从宿主的 `options.sessionId` **按请求注入**；`User-Agent` 覆盖成
    `dsh-any-deepseek/1.0`。preset 里不再放静态 session。
  - ⚠️ 第 ③ 条是上游对我们这类客户端的已知态度，即使三条都做对，这条渠道仍可能比别家严。

- 🔴 **「当前渠道」不够明显** —— 原来只有一个小徽标加几乎看不出的边框差。现在三重标识：
  左侧色条 + 更强边框 + 底色，并补 `aria-current`。每行**预留**左边条，选中时不产生位移。

### 新增

- **显示名可改**（同一渠道多账号）—— `label` 字段运行时**一直支持**，面板却从没让人填过。
  添加表单带出预设名可改；每行有「改名」入口。**改名只动 `label`，绝不动 id**——id 是渠道身份，
  改了就变成另一个渠道（另一个 key、另一个 current 目标）。

### 多模态（owner 反证后补上）

- 🔴 **图片现在真的能到达模型了**。同一版本的更早一次改动曾声明 `text-only`，理由是「取字节的
  通路还没接」—— 而 owner 用它发图时**看不到图**，正是那条声明的直接后果：`input` 不含
  `image` 时，宿主根本不会把图片投影进来。
  - 三处落地：① 预设 `input` 含 `image`；② 新增 `collectImages()` 异步预取字节（转换本身是
    同步的），`userContent()` 把块映射成 pi-ai 的 `{type:'image', data:base64, mimeType}`；
    ③ `index.ts` 注入 `readImage`，走宿主的 `ctx.attachments.readImageRequest()`（宿主自己的
    pi-ai adapter 同款路径）。
  - 🔴 **读不到字节时不静默丢弃**，换成可见文本占位（"an image was attached … could not read
    its bytes"）。原缺陷的形态正是「用户发了图，模型当纯文本回答」——静默比报错更糟。
  - 附件服务缺失 / 单张读取失败都只降级为占位，**绝不失败整条请求**。

### opencode session 头的两次修正

- 第一次修法是**错的**：把预设里的静态 session 删掉、改成只读 `options.sessionId` —— 而宿主
  **并不总给这个字段**，于是请求**一个 session 头都不带**，仍然 400 `MissingSessionID`。
- 正解：`opencodeSessionId(session)` —— 有会话 id 就取 sha256 前 32 位（稳定、不透明、按会话
  变化），没有就回退常量。两条硬要求：**永不缺席**、**无会话时也稳定**。
- 归属明确：`/zen/go` 是某一家 relay 的私有要求，**必须我们自己传**，宿主不会也不该为此负责。

### 顺带修的真缺陷

- **`headers` 改为按 key 合并**（原为整体替换）：用户加一个自己的 header 会**整体丢掉预设的
  必填 header**（opencode 正好靠那两个头才能用）。合并时按 HTTP 语义**大小写不敏感**去重。

## v0.0.6

### 变更（语义）

- 🔴 **密钥直接存在渠道条目上（`apiKey`），不再走凭据引用名。** owner 2026-10-21 裁决。
  面板以前问的是「凭据引用名」，并提示「密钥请通过凭据中心设置」——**该界面在这个宿主里不存在**
  （密钥只在 `~/.dsh/.credentials.yaml` 的扁平表里），于是用户手里的 key **无处可放**。
  - 现在：面板收 **key 本体**，写进 `channels.<id>.apiKey`；名字不再需要发明。
  - 面板不再依赖 `remote.credentials` —— 一个渠道自带 key，就不需要凭据服务被装配。
  - ⚠️ **明确接受的代价**：`dsh --dump-config` 逐字渲染 patch 且**不脱敏** ⇒ key 会出现在
    诊断输出与 profile diff 里；环境变量注入（`-e X=…`）不再被读取。README 已写明。

### 兼容

- **存量配置自动迁移，无需脚本**：`apiKeyEnv` 仍会被读，判据是**语法**——
  匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/` 才当引用名解析；不匹配的不可能是环境变量名，
  ⇒ 只可能是放错位置的值，直接当 key 用。`apiKey` 存在时永远优先。

### 修复

- 🔴 **没有 key 的渠道不再从解析中失败**（原 `MISSING_API_KEY_REF`）：解析失败会让整条渠道
  从面板消失，而面板正是修复它的唯一入口。key 有无改由**每条请求**（`MISSING_CREDENTIAL`）
  与**面板每行**（`keyConfigured`）回答。
- **`/probe` 与运行态用同一条取 key 逻辑**：探针若用另一条路径读 key，就会给一个实际跑不通的
  渠道盖章。

## v0.0.5

### 变更（语义）

- 🔴 **渠道列表改成单选列表；`enabled` 这根轴整根退休。**
  `any-deepseek` 在 DSH 层是**一个 provider**，内部渠道全由本面板定义 —— "哪个渠道生效"
  只有 `current` 一个答案。原来的 `enabled` 把同一个问题问了第二遍，还能自相矛盾
  （启用但非当前 = 什么都不做；当前但禁用 = 无意义）。
  - 连带删掉：schema 的 `enabled` 字段、`enabledChannels()` 过滤、路由错误码 `CHANNEL_DISABLED`。
  - 现在的列表函数叫 `allChannels()`：**不隐藏任何已解析的渠道**。
  - 🔴 **这条修的是一个真实可见的症状**：旧版会把 `enabled: false` 的渠道从 `/channels` 里
    过滤掉，于是面板上**一条都不显示**，而那个渠道也就永远没有机会被重新选中。

### 修复

- 🔴 **`/stats` 读的账本与写的不一致**：读侧调 `ledgerDirectory(undefined)`，
  **把用户配置的 `usage.path` 丢了**；写侧用的是 `ledgerDirectory(usage.path)`。
  只要改过账本目录，面板就永远显示「还没有用量记录」。现在两侧由 `apply` 注入同一个解析器。
- 🔴 **面板 CSS 引用了 12 处不存在的设计变量**：实测该宿主的文档只声明 29 个自定义属性、
  **没有一个颜色**，所以 `var(--dsw-alias-color-*, #fallback)` 全部走 fallback，
  而 fallback 是**硬编码浅色** ⇒ 深色主题下边框与分割线等于看不见。
  面板现在自定义 `--ad-line` / `--ad-fill`（`color-mix` + `currentColor`），**不依赖宿主任何 token**。
- 🔴 **原生 `<select>` 弹层浅底深色字**：透明背景 + 死 fallback ⇒ 弹层用平台默认浅色调色板。
  改用 `color-scheme: dark light` + 自绘 chevron + 跟随文字色的背景层。

### 交互

- **添加表单只问必须问的**：规格改为**必选**，选完自动带出**渠道 id**（去重：第二个
  `open-design` → `open-design-2`）与**凭据引用名**（`open-design` → `OPEN_DESIGN_API_KEY`）。
  手填过的值切规格时**不会被覆盖**（按"是否仍等于上次推导值"判断）。
- 渠道行整块可点选（radio），行尾只保留「测试」「移除」两个真动作。

## v0.0.4

### 修复

- 🔴 **模型选择器报「非法的 reasoning metadata」**：`resolveModel()` 只要 `reasoningEfforts`
  **不是 `undefined`** 就输出 `reasoning: { efforts: [...] }`。当那个 map 存在但**是空对象**
  （`{}` —— 正是 `z.dict()` 在面板写入时的取值，或预设被覆盖后留下的形态），
  输出就是 `efforts: []`，而宿主把它当**畸形**而非"不支持推理"：
  ```js
  if (reasoning.efforts.length === 0) throw new LlmError(…, 'INVALID_MODEL_REASONING')
  ```
  （`dsh-llm/lib/index.js:2144`）⇒ 整个模型选择器加载失败。
  - 修法：**按 `Object.keys(...).length === 0` 判，空就不发 `reasoning`**（省略 ≠ 空数组）。
  - 负控制：把判据改回 `=== undefined` ⇒ 用例精确红 `expected { efforts: [] } to be undefined`；还原 ⇒ 126 用例回绿。

## v0.0.3

### 修复

- 🔴 **provider 已注册，却"看不见"**：`listModels()` 原先**只在能解析到 key 时才返回模型**，
  没有 key 就返回 `[]`。于是模型选择器里根本没有 `any-deepseek` —— 而这恰恰是
  **最需要看见它的时刻**（首次配置、还没有 key 时）。"装了但没配"与"根本没装"外观完全相同。
  - 判断错在哪：原注释写"没有 key 的渠道不给目录条目，选择器会自动隐藏整组，
    这是宿主的 dormant-provider 约定"。**那把凭据当成了身份。**
  - 现在：目录**无条件**返回那一个模型（`deepseek-v4.1-flash`），无渠道时描述写
    `no channel configured yet`。key 的有无由**每条请求**（`MISSING_CREDENTIAL`）和
    **面板每行**（`keyConfigured`）回答 —— 那两个地方用户才动得了。
  - 已做负控制：把 `listModels` 改回"无 key 返回 `[]`" ⇒ 3 条用例精确红（含"无渠道"那条）；还原 ⇒ 回绿。

## v0.0.2

### 修复

- 🔴 **点「设为当前」必被宿主拒绝**：`current` 字段没有标 `.volatile()`，而宿主写路径
  `SettingsForms.write()` 只接受落在 volatile 节点下的路径
  （`dsh-settings/lib/index.js:507`，判据 `isVolatilePath` 同文件 `:153-158`）。
  表现极具误导性：**加渠道能成功、选渠道必失败**，且面板把它报成
  「只读部署，或设置服务未启用」——那句文案**两个原因都没查过**，真因在 schema 里少标了一个修饰符。
  - 连带：`.volatile()` 让该字段解析成引用包装（`schemastery/src/index.ts:521-530`），
    运行时直接读会得到一个**恒真的对象** ⇒ 渠道永远选不中且零报错。读取侧改用 `unwrap()`。
- **拒绝文案不再替宿主归因**：写失败如实报「宿主拒绝了这个修改」+ 宿主原始消息。
  猜原因比不说更坏——它把人引向错误的排查方向。

### 新增

- **每个面板可写字段必须有 `.volatile()`**，并由用例守着（少标一个 ⇒ 精确红在该字段名）。
  已做负控制：去掉 `current` 的 `.volatile()` ⇒ 用例报 `current must be .volatile()`；还原 ⇒ 回绿。

## v0.0.1

首个可用版本。一个 provider、一个模型（DeepSeek V4.1 Flash），多个中转渠道，
按**实际供应商**记账。

### 能力

- **自建 `LlmAdapter`**：运行时只暴露一个 provider / 一个模型；上游模型 id 各渠道不同
  （`deepseek-v4.1-flash` / `deepseek/deepseek-v4.1-flash` / `deepseek-v4-flash-202605`），
  映射层在 `route.ts` 里做，所以选择器里永远只有一个名字。
- **手动选路，不做故障转移**：请求只发给选中的那一个渠道。切换渠道不会静默换供应商，
  失败就是失败（`NO_CHANNEL_SELECTED` / 上游错误原样上抛）。
- **转发层复用 `@earendil-works/pi-ai`**（`createModels` + `createProvider`），
  不自写 SSE；直接获得 compat 位、`usage` 事件与错误分类。
- **自建用量账本** `~/.dsh/any-deepseek/usage.jsonl`（按月切），**不碰** `tokenMeter` —
  后者语义是上下文占用显示，不是计费账。
- **设置面板三屏**：当前渠道 / 用量表 / 逐渠道 `probe`（会发一次最小真实请求、消耗 token）。
  面板**从不显示密钥**，只显示"是否已配置"。

### 口径

宿主 token 计数是**不相交**的：`输入 = 未命中缓存的输入`，缓存读 / 写分列，
三者相加才是计费输入。面板把这条口径**印在数字旁边**，因为把三列加错的读表人
会得出"输入被少报了"的错误结论。

### 说明

- 全部模型条目**自维护**（不消费任何公共预设目录）⇒ 换/加渠道不用等上游目录更新，
  也绕开了"模型不在目录里就被宿主拒（`needs a baseURL`）"的坑。
- 未做：费用估算（无价目表）、会话级分组统计（按 owner 裁决只做总体）、
  故障转移（schema 预留 `fallback?: string[]`，v2 再做，届时不必改 schema）。
