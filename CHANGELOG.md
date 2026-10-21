# Changelog

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
