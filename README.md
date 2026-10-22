# dsh-any-deepseek

把多家 DeepSeek 中转站收成**一个** provider、**一个**模型，在设置面板里粘 key、点一下切换。

一个开源小工具（MIT）。欢迎改、欢迎加渠道 —— 见 [参与改进](#参与改进)。

[English](README.en.md) · 中文（本页）

![渠道分页](docs/screenshot-channels.png)

---

## 它解决的是什么问题

你在好几个地方买了 DeepSeek 的额度：官方、某家中转、某个云厂商、某个同事推荐的便宜渠道。
在 DeepSeek Harness 里，它们本来会变成**模型选择器里的 N 个条目**，而每次换渠道都要改配置、
换模型名、换 key，还得自己记住这个月哪个渠道花了多少 token。

装了这个插件之后：

- 模型选择器里只有**一行**：`any-deepseek / deepseek-v4.1-flash`。
- 下面挂**任意多个渠道**，每个渠道 = 一个端点 + 一个 key + 一个显示名。
- 点哪个渠道的圆点，请求就发到哪个。**不会自动切换**（见 [为什么不做自动切换](#为什么不做自动切换)）。
- 用量按**真实上游**分别记账。

```
                ┌── 渠道 A（官方）      ← 当前选中这个
composer ──────►│
  │             ├── 渠道 B（某中转）
  ▼             └── 渠道 C（另一家）
any-deepseek
  / deepseek-v4.1-flash
   （唯一对外模型）
```

## 安装

```bash
dsh plugin --profile web add dsh-any-deepseek
```

然后**重启 DSH**，打开 设置 → **Any DeepSeek**。

> **首次安装必须重启**：profile 的分层列表变了，而装配图是启动时构建的。
> 改已装插件的 client 半只需刷新浏览器；改它的 node 半则要重启。
>
> `dsh plugin` 会把参数转给 pnpm，所以 `add` 后面可以是 registry 名、tarball 路径或本地目录。

## 用法

### 加一个渠道

点 **添加渠道**，只有两样东西是必填的：

| 字段 | 必填 | 说明 |
|---|---|---|
| **规格** | ✅ | 决定端点地址、上游模型名、协议。选它这三样就不用填了。 |
| **渠道 id** | ✅ | 配置里的键名，`[a-z0-9][a-z0-9_-]*`。同规格可加多次，第二个自动变成 `-2`。 |
| **显示名** | — | 只影响界面显示。同一家开两个号时靠它区分。**改名不动 id。** |
| **密钥** | ✅ | 服务商给你的那串 key 本体，不需要先起名字。 |

内置规格：**DeepSeek 官方**、**OpenCode Go**、**Ollama Cloud**、**Open Design**、**CommandCode**。
想接别的中转，见 [加一个新渠道](#加一个新渠道要改什么)。

### 切换渠道

点行左边的圆点。当前渠道有三重标识：左侧色条、更强边框、底色，另加 `aria-current`。

**切换会让当前对话的 prompt 缓存失效**，所以尽量在自然的断点切，或新开一个会话。

### 看余额

点 **查询余额**（按需触发，不在打开面板时自动扫）。四种结果被严格区分，因为它们的下一步动作不同：

| 显示 | 含义 |
|---|---|
| `642.44 CNY` / `55.48 USD` | 读到了金额 |
| `rolling 100% · weekly 81% · monthly 75%` | 这家只给**订阅窗口**，不给钱 |
| **余额未尽**（无余额接口，实测可用：…） | 这家没有余额接口，但**实测能用** ⇒ 账户没欠费。**不代表余额数字**（见下） |
| 不支持查询 / 读取失败 / 未配置密钥 | 三种不同的"没有" |

> ⚠️ **余额未尽 ≠ 余额还有多少。** 它是一次最小真实请求（消耗一两个 token）成功的结果，
> 只证明三件事：端点在线、key 可用、账户**没有**因为欠费被拒（欠费会答 402/quota，不答 200）。
> 所以面板只写「未尽」，**绝不编一个金额**——写 `0.00` 会被读成"你没钱了"，与事实正相反。

> ⚠️ **绝不用 0 代替"读不到"。** 缺数字就报缺。"读不到"与"是空的"导致相反的行动。

### 看用量

![用量分页](docs/screenshot-usage.png)

每个渠道一行，可以按渠道或按天分组。

**口径**（面板里也印着）：harness 的 token 计数是**不相交**的 —— **输入**只算未命中缓存的输入，
**缓存读** / **缓存写**单独成列，三者相加才是**计费输入**。把「输入」直接当总量会得出
"输入被少报了"的错误结论。

**速度**只算生成阶段（总时长减去首字等待）。把排队 + 首字 + 生成混成一个数，会让
"想得久但吐得快"和"全程都慢"读数相同，而这两者的处理方式完全相反。
`—` 表示没测到，**不是 0**。

## 配置

设置都在这一个命名空间下 —— 它是 `cordis.patch.yml` 里的 **profile 条目 id**，面板绑定的就是它：

```yaml
dsh-any-deepseek:
  current: opencode-go          # 当前渠道
  channels:
    opencode-go:
      apiKey: sk-…              # key 本体
    open-design:
      preset: open-design
      label: Open Design（主号）  # 可选，显示名
  usage:
    enabled: true
```

`channels.<id>` 有两种写法：

- **预设背书** — `preset: opencode-go`，可选覆盖若干字段；
- **完全手写** — `baseURL` + `model` 必填，`api` 默认 `openai-completions`，
  `contextWindow` / `maxTokens` 有文档值兜底（走兜底时面板会在该行显示 ⚠）。

### key 存在哪（请读完这段）

`apiKey` 存的是 **key 本人**，就在渠道条目上。面板不会让你给它起名字 —— 你粘 key，它就写在这儿。

⚠️ **这意味着 key 在你的 profile 配置文件里。** `dsh --dump-config` 逐字打印 patch 层且
**不脱敏**，所以一次诊断输出、一次 `git diff` 都会带上它。**别把 profile 文件发给别人。**
环境变量注入（`-e SOME_KEY=…`）不会被查询 —— 没有任何地方去解析一个名字。

> 早期版本把 key 藏在"凭据引用名"后面，并提示你"到凭据中心设置" —— 而这个界面本身并不存在。
> 现在的做法是：一个字段、一个存储、一次写入。

`apiKeyEnv` 仍会**读**，为了兼容旧配置：值符合引用名语法（`^[A-Za-z_][A-Za-z0-9_]*$`）时当名字解析；
不符合时不可能是名字，于是当 key 本体用。`apiKey` 存在时永远优先，所以在面板里重填一次 key
就把旧条目迁移完了。

没配 key 的渠道**照样出现在面板里** —— 那是你发现并修复它的方式。通过它发请求会失败
（`MISSING_CREDENTIAL`），该行的状态点是空心的。

### 协议

`openai-completions` 是默认也是推荐：几乎所有中转都说它，兼容位最多（约 20 个），
且 usage 的三种缓存字段拼写（`prompt_tokens_details.cached_tokens` /
`prompt_cache_hit_tokens` / 顶层 `cached_tokens`）已由传输层归一。

只有当某家真的说别的协议时才在**那一个渠道**上设 `api`（`openai-responses` / `anthropic-messages`）。
面板永远不会背着你在渠道间改协议。

### 思考强度

每个渠道声明自己支持哪些档位，harness 里选的档位会一路传到上游：

```
harness reasoningEffort → pi-ai ThinkingLevel → model.thinkingLevelMap → wire value
```

**本插件里没有第二层映射**：传输层用的 `thinkingLevelMap` **就是**映射层，再写一个必然与它漂移。
声明成 `null` 的档位表示不支持，不会出现在选择器里。

### 图片输入

支持。两个渠道都可以收发图片，前提是宿主把 `input` 声明为含 `image` —— 该声明在**注册模型时**给出
（`inputModalities`），不是写在请求处理里。这是个踩过的坑：能力是 provider 的属性，
不是某条渠道或某次请求的属性。

## 为什么不做自动切换

v1 刻意只做手动。一个渠道失败就**报它自己的错**，不会静默转到另一个：

- 静默切换会让"这次答案是谁给的"变得不可知，而用量表会照实记另一个渠道 —— 两处口径不一致。
- 半途换渠道会让 prompt 缓存失效，成本比你省下的那次失败更高。
- 失败是信息。把它藏起来，你就不知道某个渠道正在坏掉。

## 加一个新渠道要改什么

这是一个**实用小插件**，加渠道是最有价值的贡献 —— 大多数情况下只需要动一个文件。

### 只加一个预设（最常见）

改 [`src/presets.ts`](src/presets.ts)，往 `CHANNEL_PRESETS` 里加一条：

```ts
'your-relay': {
  displayName: 'Your Relay',
  api: 'openai-completions',
  baseURL: 'https://your-relay.example/v1',
  // 🔴 用**这家自己的**拼写。各家中转的模型名不同：
  //    deepseek-v4.1-flash / deepseek/deepseek-v4.1-flash / deepseek-flash …
  //    抄错不会报错，只会在第一次请求时被上游拒。
  model: 'deepseek-v4.1-flash',
  ...V41_FLASH_CAPS,
  // 可选：这家有没有余额接口、是什么形状（见 src/balance.ts 的四种 shape）
  // balance: { shape: 'openai-billing' },
},
```

就够了 —— 面板的规格下拉会自动多出这一项。

⚠️ **两条规矩**（都有实际代价）：

1. **注释里不要写"我探过了"，除非真的探过。** 这个仓里曾经有一条
   `Probed live: the billing pair answers` 的注释，而它从没被调用过，第一次真调用就 404。
   **假证据比没有注释更坏**，因为它让下一个读者不再去查。
2. **`model` 用上游的拼写，不是我们的 id。** 我们对外只暴露 `deepseek-v4.1-flash` 一个 id，
   上游拼写由预设吸收 —— 这正是这个插件存在的理由。

### 加一种余额形状（少见）

如果这家有余额接口但形状是新的一种，改 [`src/balance.ts`](src/balance.ts)：
加一个 `shape`、加一个 `parseXxx()`、在 `balanceUrls()` 里给路径、在 `readBalance()` 里分发。
`balanceUrls()` 是**唯一**知道路径的地方，所以预设无法与传输层意见相左。

### 门禁（提交前必跑）

```bash
pnpm run typecheck     # 两个 tsconfig：node 半 + client 半
pnpm run test          # 纯函数层，不需要 harness
pnpm run build         # lib/index.js + lib/client.js
```

改动要带**能变红的用例**。这个仓的规矩是：**判据必须承重** —— 把修复回滚，那条用例必须红；
否则它只是装饰。仓里每条重要结论都附了它的负控制结果。

## 已知边界

- 不修改 harness，也不替代 `deepseek-official` / `llm-pi-ai` 路由。
- 只暴露一个模型 id。上游模型 id 各家不同，由预设映射。
- **不做费用估算**（没有价目表）。
- **不做自动故障转移**（v1，见上）。
- **不做多模型聚合** —— 这个插件就是"一个模型、多个来源"，不是模型路由器。

## 参与改进

欢迎 fork、提 issue、发 PR。特别是：

- **加一家渠道** —— 见上，改一个文件。
- **修一处文案** —— 面板上的每一句都应该是一个可验证的事实；读到含糊或过时的，直接改。
- **报一个"装了但没反应"** —— 这类静默失效是本项目最花时间的一类缺陷，
  复现步骤比任何猜测都值钱。

源码：<https://github.com/tellmewhattodo/dsh-any-deepseek>

## 许可

MIT
