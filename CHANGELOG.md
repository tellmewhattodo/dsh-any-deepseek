# Changelog

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
