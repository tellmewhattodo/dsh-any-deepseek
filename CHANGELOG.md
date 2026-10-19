# Changelog

## v0.1.0

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
