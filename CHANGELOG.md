# Changelog

> ⚠️ **版本边界缺口（2026-10-23 发现，已止血未回填）**：本文件 `v0.0.7` ~ `v0.0.14` 之间的
> 版本标题缺失。原因不是漏写，而是工具缺陷：`any-deepseek-develop bump` 当时用
> `text.replace(/^## v[\d.]+/m, …)` **重命名首个标题**而非**插入新标题**，于是每发一版就把上一版
> 的边界吃掉一条；而 `version` 子命令只比对首个标题，**与 bump 改的正是同一处** ⇒ 每次都报绿。
> **内容的边界去哪找**：`git log --oneline` 的 `chore(release): x.y.z` 提交就是权威的分版点
> （每个 release 提交对应那一版的内容）。正文本身未丢失，只是被并入了上方标题。
> 工具已修（改为插入 + 集合包含判据），**但历史边界不予臆造回填** —— 猜一个边界比缺一个边界更坏。

## v0.0.19

### 修正：Tencent TokenHub 收不到图（owner 2026-10-23 报告「能用，但收不到图」）

`0.0.18` 给这条渠道写的是 `input: ['text']`，注释理由是「owner 的 profile 就写 text」——
**那份记录说的正相反**：`dump-config` 里 `llm-pi-ai.providers.zy-tecenthub.models[0].input`
= **`[text, image]`**。腾讯云[模型列表](https://cloud.tencent.com/document/product/1823/130051)
（中文版，2026-10-21 更新）也把该 id 标为「图片理解」。

**这条声明本身就是投递开关**：pi-ai 的 `downgradeUnsupportedImages()` 在 `model.input` 不含
`image` 时把图片块改写成 `(image omitted: model does not support images)`
（`transform-messages.js:38-57`，由 `openai-completions.js:899` 调用）⇒ **请求照常成功、零报错、
模型当纯文本回答**。这正是决策 32 当初要消灭的那种静默。

⇒ 预设改 `['text', 'image']`。负控制：改回 `['text']` ⇒ **精确红 2 条**（两条图片断言），其余不动。
⚠️ **中英文档互相矛盾**：国际版同一页（2026-09-25 更新）**没有**标图片理解。两份都是官方，
取较新者；分歧写进 `note` 而不是抹平——下一个读者该知道这里有过争议，而不是「早有共识」。

### 修正：判据的例外口子已拆除

`0.0.18` 为这条渠道开了个 `textOnlyByRecord` 豁免：「除非记录说纯文本，且必须在 `note` 里说明为什么」。
问题不在记录错，而在**这条判据可以用散文满足** —— `note` 由写它的人自己提供论据与结论两侧，
**它不是证据**。⇒ 改为无例外：每个预设都必须声明 `image`。
一般化的教训：**能被一段说明文字满足的判据，不是关于行为的判据。**
且这个方向错得不对称：多声明 `image` 最坏是上游报一个看得见的错；少声明则**静默失败**。

### 面板：渠道行紧凑化（owner 2026-10-24「每个渠道高度希望小一些，紧凑些」）

行内原本是四行堆叠（模型·协议·地址 / 密钥态 / 探测结果 / 余额），五个渠道就吃掉大半个面板。
改法是**版式，不是删信息**：四行合并成一条会自动换行的详情行，行高实测 **167px → 73px**、
**160px → 50px**（降 56%~69%，用注入旧样式的 A/B 量得，非目测）。

- `.ad-row` padding `10px 12px` → `7px 10px`，`align-items` 改 `center`；
- `.ad-keyLine` 由块级 flex 改 `inline-flex` 并去掉 `padding-top`，让它作为**一个词**留在详情行里；
- 窄面板下详情行会换行——这是正确取舍：行可读 > URL 被截断。

### 用量：默认只看近 7 天（owner 2026-10-24「只保留近一周」）

`/stats` 在**未显式给 from/to** 时默认返回最近 7 天。⚠️ **这是视图默认值，不是数据删除**：
按月的 JSONL 账本一行未动，历史记录是花销的唯一凭据，删掉就回不来了；显式 `from`/`to` 仍能读任意区间。
面板底部把范围**印出来**——同一张表不带范围说明，会被读成「全部」，而一周的「合计」和一个月的外观一样。

### 用量：新增「平均上下文」列（owner 2026-10-24「希望统计平均的上下文窗口大小」）

`meanContextTokens(aggregate)` = `total` / (报告了用量的请求数)。三个取舍都有理由：

- **不是模型能力值**：各渠道窗口恒为 1M，重复它等于没说话。有意义的读数是它与窗口的**差距**——
  平均远低于窗口 ⇒ 成本由对话长度驱动，不是窗口。这正是「供成本优化参考」的落点。
- **缓存命中计入分子**：缓存 token 仍占窗口（只是单价低），剔除会低估上下文压力。
- **分母不是 `requests`**：未回报用量的请求对分子贡献 0，算进除数会稀释均值。
  🔴 也**不是** `requests - unreported - failures` —— 失败且无用量的调用已被 `unreported` 统计，
  再减一次 `failures` 会重复扣除、把均值抬高。负控制：改成那个式子 ⇒ 精确红 1 条。
  不可测时报 `null` 渲染 `—`，**绝不填 0**（0 读作「每次请求零 token」，是另一句话）。

## v0.0.18

### 新增渠道：Tencent TokenHub（owner 2026-10-23）

owner 原话：「我本机dsh还配了tokenhub这个渠道，这个渠道是腾讯云的渠道，它的模型名称是固定的0605
后缀就是向官方的转发，把这个也加入Any Deepseek，余额查询是没有的做成测通查询即可」。

- 预设 `tencent-tokenhub`，`displayName: 'Tencent TokenHub'`。
- **端点 `https://tokenhub.tencentmaas.com/v1/`**、**模型 `deepseek-v4-flash-202605`**、
  容量 `1024000` / `384000` —— 全部取自 owner 本机 profile 的
  `llm-pi-ai.providers.zy-tecenthub`，并有两份独立容器记录佐证（2026-10-15 渠道调研、2026-10-19 研究笔记）。
- 🔴 **`-202605` 是 id 的一部分，不是日期后缀**。这是本插件存在理由的最锋利例子：
  同一个模型在中转站叫 `deepseek-v4.1-flash`、在官方叫 `deepseek-flash`、在这里叫
  `deepseek-v4-flash-202605`。把它"规整"掉**本地不报错**，只在第一次真请求时被上游拒。
  ⇒ 负控制：改回 `deepseek-v4.1-flash` ⇒ **精确红 1 条**（就是那条 id 断言）。
- 🔴 **不声明 `balance`，用「测通」**（owner 明确要求）。判据是状态码，不是猜：
  不带 key 时 `/v1/models` 回 **401**（路由存在、需鉴权），而造一个假路径回 **404**；
  随后四个余额候选在同一前缀逐个探，**全部 404**：
  `/v1/dashboard/billing/subscription`、`/v1/user/balance`、`/v1/credits`。
  ⇒ 只有推理面。面板因此显示「不支持查询」并**退回一次最小真实请求**，成功即「余额未尽」。
  ⇒ 负控制：给它加一个 `openai-billing` ⇒ **精确红 1 条**（那条"不许声明 balance"断言）。
- **`input: ['text', 'image']`** —— 🔴 **修正 `0.0.18` 的假证据**（owner 报告 2026-10-23：
  「腾讯云这个渠道能用，但是收不到图，别的渠道正常」）。
  `0.0.18` 写的是 `input: ['text']`，注释理由是「owner 的 profile 就写 text」——**那份记录说的正相反**：
  `dump-config` 里 `llm-pi-ai.providers.zy-tecenthub.models[0].input` = **`[text, image]`**。
  腾讯云[模型列表](https://cloud.tencent.com/document/product/1823/130051)（中文版，2026-10-21 更新）
  同样把该 id 标为「图片理解」。**这条声明本身就是投递开关**：pi-ai 的 `downgradeUnsupportedImages()`
  在 `model.input` 不含 `image` 时把图片块改写成一句 `(image omitted: model does not support images)`
  （`transform-messages.js:38-57`，由 `openai-completions.js:899` 调用）⇒ **请求照常成功、零报错、
  模型当纯文本回答**，正是决策 32 当初要消灭的那种静默。
  ⇒ 负控制：改回 `['text']` ⇒ **精确红 2 条**（两条图片断言），其余 23 条不动。
  ⚠️ **中英文档互相矛盾**：国际版同一页（2026-09-25 更新）**没有**标图片理解。两份都是官方，
  取较新者；分歧写进 `note` 而不是抹平——下一个读者该知道这里有过争议，而不是"早有共识"。
- 🔴 **判据的例外口子已拆除**（`tests/presets.test.ts`）。`0.0.18` 为这条渠道开了个
  `textOnlyByRecord` 豁免：「除非记录说纯文本，且必须在 `note` 里说明为什么」。
  问题不在记录错，而在**这条判据可以用散文满足**——`note` 由写它的人自己提供论据与结论两侧，
  **它不是证据**。⇒ 改为无例外：每个预设都必须声明 `image`。
  一般化的教训：**能被一段说明文字满足的判据，不是关于行为的判据。**
  且这个方向错得不对称：多声明 `image` 最坏是上游报一个看得见的错；少声明则**静默失败**。
- 思考档位表与 DeepSeek 的 thinking 方言**照常继承**：这条渠道是 DeepSeek 自家模型的一手转发，
  wire 拼写属同一族。

### 文档

- README 的内置规格清单加上 Tencent TokenHub（含"名字与下拉框一致"那句）；
  余额小节新增一段点名 **Open Design 与 Tencent TokenHub 没有余额接口**，
  让「余额未尽」这一行有解释，而不是让人以为坏了。
- `CONTRIBUTING.md` 的硬规矩从两条扩到三条，新增第 3 条**「没有余额接口就写没有，别猜形状」**
  并附**三种真实模型拼写对照表**（`deepseek-v4.1-flash` / `deepseek-flash` /
  `deepseek-v4-flash-202605`）—— 那张表是这个仓最容易踩的坑的浓缩。

### 未验（如实记录）

⚠️ **没有做过一次真实的 TokenHub 推理请求。** owner 选择「先不真机验，按取证结果发版」。
已验的是：端点与模型 id（两份独立记录 + 你的 profile）、`/v1/models` 的 401、
四个余额候选的 404。**未验的是**：这条 key 能否真的通过该端点出一次答案。
⇒ 装上后点一次「测试」就能补上这一格。

### 门禁

`typecheck` 双半 ✓ / **257 用例**（252 → 257）✓ / `build` ✓ / `pack-check` ✓。

## v0.0.17

### 文档：README 换成「第一次用的人」的读者（owner 2026-10-23「README 是给没用过这个东西的人看的，不是给我看的」）

🔴 **上一版的问题不是文笔，是受众错位。** 我把**判据集**当成了 README：为什么不做自动切换的三个
机制理由、`apiKeyEnv` 的迁移语义、"判据必须承重"、负控制读数。每一条都真实，但它们回答的是
**维护者**的问题（"这个决定对吗"），而读者带来的是**用户**的问题（"我要不要装、怎么装、出问题怎么办"）。

- **重排依据换成「读者此刻要回答什么」**：装不装 → 怎么装 → 第一次用三步 → 日常三件事 →
  key 安全吗 → 出问题了 → 进阶 → 边界。
- **新增「装之前先看一眼：适合你吗」**（适合 / 不适合两类）。**「这不适合我」是最省时间的结论**，
  旧版要一路读到末尾的"边界"才发现；现在开头就劝退单渠道用户、要自动故障转移的人、要模型路由的人。
- **故障排查改成「你看到什么 → 该做什么」**：`MISSING_CREDENTIAL` / `NO_CHANNEL_SELECTED` /
  找不到面板 / 余额读取失败 / 401。错误码在用户眼里只是一串字，得先翻译成现象。
- **维护者内容整体搬进新增的 `CONTRIBUTING.md`**：加一个渠道改哪个文件、两条硬规矩
  （不许写"我探过了"除非真探过；`model` 用上游拼写）、判据必须承重（含三种假判据形态）、
  截图怎么更新（含 `shot` 的两个"空白页且零报错"坑）、发布通道。README 只留一行指针。
- `README.en.md` 同结构重写；三份文档互相链接。

### 新增第三张截图：添加渠道表单

- `docs/screenshot-add-channel.png`，由同一套 `shot` 渲染。`?variant=add` 用两个渠道 + 展开表单，
  因为四渠道列表加上表单是 1154px 高，超出 813px 的窗口 —— 这是**真实状态**，不是摆拍。

### 新增两条文档一致性判据

- **README 列出的规格 ⇄ 代码里的规格**，**双向**断言：README 写了不存在的规格会让人去找一个不存在的东西；
  代码里有而 README 没写，则是个没人能发现的功能。
- **文档引用的图片必须真的存在于磁盘**（仓内判据）；`pack-check` 侧另有一条覆盖"是否打进发布物"，
  并新增**文档互链**检查（`README` 指向 `CONTRIBUTING.md`，而后者没进 `files` 就成了死链）。
  负控制：去掉 `CONTRIBUTING.md` ⇒ 精确点名该文件并 exit 1。

  🔴 **这条判据第一次报红，红的是它自己的抽取器**：`\s` 把「OpenCode Go」的空格吃掉变成
  `OpenCodeGo`。修好抽取器后才暴露出**真的漂移** —— README 写「DeepSeek 官方」，而下拉框里
  实际是「DeepSeek Official」。**两轮红的性质完全不同**：报红时先问"判据本身对吗"，再问"被judged 的东西错了吗"。

### 门禁

`typecheck` 双半 ✓ / **252 用例**（249 → 252）✓ / `build` ✓ / `pack-check` ✓（文档资产 3 图 3 链）。

## v0.0.16

### 界面：分 tab，两个问题各得整屏（owner 2026-10-23「这两个用分tab页面panel方式做 … 可以让用户不用滚动鼠标滚轮」）

- **渠道 / 用量 两个 tab**，互斥渲染。此前两者堆在一屏，读用量表要先滚过每一条渠道行。
  `role="tablist"` + `aria-selected` + `role="tabpanel"`，渠道 tab 带条数徽标。
- **默认落在「渠道」**：空装状态下打开一个空的用量表什么也没回答，用户该看到的是"加一个渠道"。

### 界面：按钮尺寸 / 间距 / 布局

- `.ad-btn` 由 4px/10px 提到 5px/12px，加 `min-width: 56px` / `min-height: 26px` —— 原尺寸约
  22px 高，低于舒适点击阈值，且让行内动作（测试 / 移除）看起来像文本而不是控件。
- `.ad-input` 同步到 26px 高，使「字段 + 按钮」同行时无需逐处微调即可对齐。
- 用量分组改为**分段控件**（`按渠道 | 按天 | 刷新`）：三者共享一个含义，画成一个对象；
  表格加横向滚动容器，十列数字不再把整块面板撑宽。
- 添加表单字段间距 8 → 14px，并给每个字段加一行**为什么需要它**的说明。

### 文案：按 EAP 重写（每句都是可在页面上验证的事实）

- 头部说清三件事：这是**哪一个 provider**、对外**只有一个模型**、选渠道**不会自动切换**。
- 添加表单标注 **必选 / 可空** —— 此前"哪些能跳过"无从判断，而唯一不可跳过的（密钥）
  看起来和可跳过的两个一模一样。
- key 的落点从 `保存在本机 profile` 改为写出确切路径 `channels.<id>.apiKey`，并显式说它会出现在
  `--dump-config` 输出里、别把 profile 发出去（左侧色条 + 底色，是唯一不许被略过的一条提示）。
- 用量口径写全：输入 = 未命中缓存；缓存读/写分列；三者相加才计费；
  **`—` 表示没测到，不是 0**（0 会读作"这次请求是免费的"）。
- 错误横幅由「加载失败」改为「操作未完成」——这个横幅也承载**写入被拒**，而那不是"加载"。

### 面板里附上仓库地址

- `REPO_URL` 常量 + 页脚链接（`target="_blank"` + `rel="noreferrer"`），文案「开源小工具，MIT 许可
  —— 欢迎改、欢迎加渠道」。用户判断"这东西我能不能改"不该需要去搜。

### README 按 EAP 完整重写（中文为主 + 英文版）

- `README.md`（中文为主）与 `README.en.md`，互相链接；回链改指向自己
  （英文页原本链回中文页，形成**互相指回对方**的歧义 → 已改）。
- 新增两处**真实截图**（`docs/screenshot-channels.png` / `docs/screenshot-usage.png`）。
  截图由 `scripts/screenshot-harness.tsx` 渲染**真实面板组件**（假数据、真 CSS/JSX/文案）——
  面板本身在 token 保护的 Web UI 后面，干净 profile 打开是空白页，这是唯一诚实的取证方式。
- 新增**贡献者向**章节：加一个预设要改哪个文件、两条硬规矩（不许写"我探过了"除非真探过；
  `model` 用上游拼写）、门禁命令、以及"判据必须承重"的规矩。

### 工具：`shot` 子命令 + 打包判据

- 新增 `any-deepseek-develop shot`：esbuild 打包截图渲染件，**bundle 与 CSS 均内联成单文件**。
- 🔴 两个静默缺陷，都是本轮实测出来的（都会让页面**空白且零报错**）：
  ① `--external:*.css` 把 `import "./SettingsPage.css"` 留在产物里 ⇒ 内联模块无法解析 ⇒ 整模块不执行；
  ② 外部 `<script src>` 在 `file://` 下被 Chrome 以 CORS 拒绝。⇒ 改用 `--loader:.css=text` + 全内联，
  并加一条**「产物里不许有残留 import」**的判据。
- `pack-check` 新增一条：**README 引用的图片必须在发布物里**。坏图在 npm 页面上一眼可见，
  而本地文件在磁盘上、`npm pack --dry-run` 也不会因此报错 ⇒ 它需要自己的判据。
  负控制：去掉 `docs/*.png` ⇒ 精确点名两张图并 exit 1。

### 门禁

`typecheck` 双半 ✓ / **249 用例**（236 → 249）✓ / `build` ✓ / `pack-check` ✓。
负控制：把渠道面板的守卫改成 `{true && (` ⇒ 精确红 1 条（互斥那条），其余 248 全绿。

## v0.0.15

### 新增：无余额接口的渠道改为「测通」

owner 2026-10-23 指令：**「对于不支持查余额的，改成直接测通，通则说明余额还是有的，没用完，
显示出来（消耗一两个token）」**。

- 新增第四种状态 `alive`：`fetchBalance()` 报 `unsupported` 时，复用 `probeChannel()` 发一次
  最小真实请求，通则说明端点在线、密钥可用、**账户未因欠费被拒**（欠费答 402/quota，不答 200）。
- 🔴 **`alive` 永不渲染成数字**：它只证「未尽」，不证「还剩多少」。面板文案写「余额未尽」，
  并附 `responded` + `ms` 作为证据 —— "它回答了"是断言，"它作为 deepseek-flash 在 1448ms 内
  回答了"是证据。
- 🔴 **兜底范围刻意最窄**：只在 `unsupported` 时探。已拿到数字的 `ok` 不重复花钱；
  `unavailable` 是"该有却没有"的**重试**态，探它会把一次暂时故障换成一条看着更好的绿行。
- 🔴 **`QUOTA` 是一次「答案」而非错误**：探通失败里只有它报告了"欠费"这个探针本来要查的事实
  ⇒ 单独渲染成「余额不足（实测被拒）」，不并进「读取失败」。
- 负控制两条都精确：① 去掉 `unsupported` 判定 ⇒ 红 4 条，且"不该探"的两条仍绿；
  ② 把 `alive` 渲染成 `0.00 CNY` ⇒ 红 3 条，产出正是要防的那个假数字。

### 修复：`bump` 会吃掉上一版的 CHANGELOG 标题（工具缺陷）

详见文首 ⚠️。`bump` 改为**插入**新标题；新增 `planChangelogBump()`（纯函数，写入前判
**集合包含**：原有每个标题必须还在，且恰好多一个）+ `checkChangelogOrder()`（顺序/重复）。
负控制：退回 rename 语义 ⇒ 精确红 3 条，其余 23 条仍绿。

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
