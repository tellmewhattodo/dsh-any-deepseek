# 参与改进 dsh-any-deepseek

这是个实用小工具，改动从「一个字段的文案」到「接一家新渠道」都欢迎。

**先读 [README.md](README.md)** —— 那里讲的是怎么用；这一份讲怎么改。

---

## 最有价值的三种贡献

### 1. 接一个新渠道

内置 5 家，接别家通常只改 [`src/presets.ts`](src/presets.ts) 一个文件。

```ts
'your-relay': {
  displayName: 'Your Relay',
  api: 'openai-completions',
  baseURL: 'https://your-relay.example/v1',
  // 🔴 用**这家自己的**拼写。各家模型名不同：
  //    deepseek-v4.1-flash / deepseek/deepseek-v4.1-flash / deepseek-flash
  //    抄错不会在本地报错 —— 会在第一次真请求时被上游拒。
  model: 'deepseek-v4.1-flash',
  ...V41_FLASH_CAPS,
  // 可选：这家有没有余额接口、是哪种形状（见 src/balance.ts 的四种 shape）
  // balance: { shape: 'openai-billing' },
},
```

加完这一条，面板的规格下拉里就有它了 —— 不需要改别处。

**两条硬规矩**（都是付过代价的）：

1. **注释里不要写「我探过了」，除非真的探过。**
   这个仓里曾经有一条 `Probed live: the billing pair answers` 的注释，而那个路由**从没被调用过**，
   第一次真调用就 404。**假证据比没有注释更坏** —— 它让下一个读者不再去查。

2. **`model` 填上游的拼写，不是我们的 id。**
   我们对外只暴露 `deepseek-v4.1-flash` 一个 id，各家的拼写由预设吸收。
   **这正是这个插件存在的理由** —— 所以别在预设里图省事写我们的 id。

### 2. 修一处文案

面板上的每一句都应该是一个**能在页面上验证的事实**。读到含糊、过时、或替宿主猜原因的，直接改。

判断标准（本项目一直在用）：

- ❌ 「已安全保存」—— 读者无法验证。
- ✅ 「存在 `channels.<id>.apiKey`，会出现在 `--dump-config` 输出里」—— 可验证。
- ❌ 「只读部署，或设置服务未启用」—— 替宿主猜了两个**没查过**的原因。
- ✅ 「宿主拒绝了这个修改」+ 宿主自己的错误信息 —— 只说知道的事。

### 3. 报一个「装了但没反应」

**静默失效是本项目最贵的一类缺陷** —— 装了不生效、写了没保存、功能存在但不可达，
全都零报错。复现步骤比任何猜测都值钱。

这类问题通常有这几个藏身处，如果你能指出是哪一处，修起来会快很多：

| 现象 | 可能的位置 |
|---|---|
| 面板整块不出现，控制台零错误 | `SETTINGS_NS` 与 `cordis.patch.yml` 的条目 id 不一致 |
| 面板在，但每次请求都失败、表格显示「还没有渠道」 | `inject` 里少了 `webServer`，路由被静默跳过 |
| 设置写不进去，但看不出原因 | schema 少了 `.volatile()`，或写入被 `.catch` 吞了 |
| provider 装了但模型选择器里没有 | 注册元数据（`inputModalities` / `reasoning`）没声明 |

## 加一种余额形状（少见）

如果某家有余额接口但形状是新的，改 [`src/balance.ts`](src/balance.ts)：

1. 给 `BalanceProbe.shape` 加一个值；
2. 写一个 `parseXxx()`；
3. 在 `balanceUrls()` 里给它路径；
4. 在 `readBalance()` 里分发。

`balanceUrls()` 是**唯一**知道路径的地方 —— 这样预设就不可能和传输层意见相左。

还有一条底线：**缺数字就报缺，绝不填 0。**
「读不到」和「是空的」导致相反的行动，而只有一个是真的。

## 开发

```bash
pnpm install
pnpm run typecheck     # 两个 tsconfig：node 半 + client 半
pnpm run test          # 纯函数层，不需要装上 harness
pnpm run build         # lib/index.js + lib/client.js
```

纯函数层（`presets` / `channels` / `route` / `usage-ledger` / `balance`）不 import harness，
所以单测跑得很快。适配器与面板只通过宿主的公开接缝和它说话。

## 判据必须承重

**每条新判据都要附一次「把它弄红」的实验结果。**

把修复回滚，那条用例必须红；否则它只是装饰。这个仓的 CHANGELOG 里每个结论都带着它的负控制读数
（例如「去掉 `percent` 取反 ⇒ 精确红 3 条」）。

三种特别容易写成**假判据**的形态，本项目都踩过：

1. **判据与被判对象同源**。例：`bump` 改的是 CHANGELOG 首个标题，而 `version` 只读首个标题 ⇒
   永远读绿。要抓这类缺陷，判据必须碰**别的不变式**（现在是「集合包含」：原有每个标题都在，且恰好多一个）。
2. **假传输层掩盖走错协议**。测试里传输层是假的，走错协议照样「通」。
   分发决策要用**结构判据**钉住（断言 `api: apiImplementations()` 存在、旧形态不回来）。
3. **自写抽取器出错时不喊**。手写的 YAML 正则抽空了，用例照样绿。
   ⇒ 抽取要**如实落盘原文**再看，不要在抽取器里顺手「清洗」。

## 截图怎么更新

README 里的三张图来自 `scripts/screenshot-harness.tsx`，它渲染**真实面板组件**
（假数据、真 CSS/JSX/文案）—— 面板本身在 token 保护的 Web UI 后面，干净 profile 打开是空白页，
所以直拍拿不到。

```bash
msm("any-deepseek-develop", ["shot"])        # 打包成单文件页面
```

生成的页面在 `_tmp/shot/screenshot-harness.html`，用浏览器打开后截图即可。
加 `?variant=add` 可以拍「添加渠道」表单那一种状态。

> ⚠️ 打包时有两个坑，都会让页面**空白且零报错**：产物里残留 `import`（内联模块无法解析）、
> 或外部 `<script src>` 在 `file://` 下被 CORS 拒。`shot` 已自带「不许有残留 import」的判据。

## 发布

维护者用的开发通道是 CCC 的 MSM `any-deepseek-develop`（safe-mode 下没有 bash）。
`stage check` 是「能不能装」的唯一判据 —— **`npm publish` 的退出码 0 不代表可安装**，
新版本要一两分钟后才在 registry 上出现。

## 许可

MIT
