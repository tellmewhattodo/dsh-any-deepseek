# dsh-any-deepseek

**Use DeepSeek credit from several providers inside DeepSeek Harness — with one extra row in the
model list, not N.**

You bought DeepSeek credit in several places: the official API, a relay, a cloud vendor, a cheap
one a friend recommended. This plugin collects them into **one** provider: paste a few keys, click
to switch — and usage is booked per real upstream, so you can see what each one cost this month.

![Channel list](docs/screenshot-channels.png)

[中文](README.md) · English (this page)

---

## Before you install: is this for you?

**Yes**, if any of these is true:

- You have **more than one** DeepSeek endpoint and want to switch between them without editing
  configuration.
- You want **per-channel usage accounting** instead of one blended total.
- You use relays whose model ids differ (`deepseek-v4.1-flash` / `deepseek/deepseek-v4.1-flash` /
  `deepseek-flash`) and don't want to keep track yourself.

**No**, if:

- You have a single endpoint and it is the official one — the built-in `deepseek-official` already
  covers you; this plugin is unnecessary.
- You want **automatic failover** (one endpoint dies, requests move to the next). v1 does not do
  that — see [Why no failover](#why-no-failover).
- You want to **switch between models**. This is "one model, many sources", not a model router.

## Install

Requires DeepSeek Harness to be installed already. In a terminal:

```bash
dsh plugin --profile web add dsh-any-deepseek
```

Then **restart DSH** and open Settings → **Any DeepSeek**.

> **Why the restart**: the plugin is added to the profile's load list, which is read only at
> startup. Afterwards, changing this plugin's UI half needs only a browser refresh — but the
> **first install** needs the restart.

## First run: three steps

### 1. Add a channel

Click **添加渠道** (Add channel). Two fields are required:

![Add channel](docs/screenshot-add-channel.png)

| Field | What it means |
|---|---|
| **规格** (preset) | Pick your provider. It determines the endpoint, model id, and protocol — so you don't type them. |
| **密钥** (key) | The key that provider gave you. Paste it. There is no name to invent. |

**渠道 id** (channel id) is filled in for you — it is just the configuration key, and you can
change it. **显示名** (display name) defaults to the preset name; when you run two accounts on the
same provider, set something like "main" / "backup".

Bundled presets: DeepSeek Official, OpenCode Go, Ollama Cloud, Open Design, CommandCode.
For another provider, see [Adding a provider](#adding-a-provider).

### 2. Make sure it is selected

The first channel you add **becomes the current channel automatically** — its row gets a radio
dot, a colour bar down the left edge, and a 「当前」 badge.

To switch later: click the dot at the left of a row.

### 3. Start using it

In the model picker, choose **DeepSeek V4.1 Flash** (the provider is `any-deepseek`).
Every request then goes to whichever channel you selected.

## Three things you will actually do

### Switch channels

Click the dot at the left of a row.

> ⚠️ **Switching invalidates the prompt cache for the running conversation**, so switch at a topic
> boundary, or just start a new session.

### See how much credit is left

Click **查询余额** (Check balance). It does not run when the panel opens — each check calls every
provider's server.

Different providers can report different things, and the panel keeps them apart:

| What you see | Meaning |
|---|---|
| `642.44 CNY`, `55.48 USD` | This provider reports an amount |
| `rolling 100% · weekly 81% · monthly 75%` | This provider reports **subscription usage percentages**, not money |
| **余额未尽** (verified live: …) | This provider has **no balance API**, but a minimal live request **succeeded** ⇒ the account is not blocked |
| 不支持查询 / 读取失败 / 未配置密钥 | Three different kinds of "nothing" |

> **"Not exhausted" is not "how much is left".** One successful request proves exactly three
> things: the endpoint is reachable, the key is valid, and the account is not blocked for lack of
> credit (an exhausted account answers 402, not 200). So the panel says only 「未尽」 and **never
> invents an amount**.

### See what this month cost

Switch to the **用量** (Usage) tab.

![Usage](docs/screenshot-usage.png)

Group by channel or by day. "Input" counts only cache misses; cache reads and writes are separate
columns, and the three together are the billable input. In the speed column, `—` means
**unmeasured — not zero**.

## Is my key safe

**It is stored in your local configuration file, in plaintext.**

The path is `channels.<channel-id>.apiKey` inside the profile. The plugin never sends it to any
third party, but:

> ⚠️ `dsh --dump-config` prints the configuration verbatim and does **not** redact it. So:
> **do not share your profile configuration**, and do not paste its `git diff` anywhere public.

If you need to share config for troubleshooting, delete the `apiKey` lines first.

## Troubleshooting

**The model list has no DeepSeek V4.1 Flash.**
→ You have not restarted since installing. Restart DSH.

**Settings has no "Any DeepSeek".**
→ Same; or check you installed into the `web` profile: `dsh plugin --profile web list`.

**`MISSING_CREDENTIAL`.**
→ That channel has no key yet. Its status dot is hollow; click 「填写密钥」 to add one.

**`NO_CHANNEL_SELECTED`.**
→ No channel is selected. The panel shows a hint at the bottom; click any row's dot.

**「查询余额」 shows 「读取失败」.**
→ That provider did not answer properly just now; retry. If it never works, your network may not
reach it.

**401 / 403 / out of credit.**
→ The key is wrong or expired, or that account really is out of money.

**Answers got slower or worse after switching.**
→ Providers do not behave identically. Use the 测试 (Test) button per channel, and the 用量 tab to
compare speeds.

## Why no failover

A failing channel reports its own error; it never silently moves to another. Three reasons:

- Silent failover makes "who answered this?" unknowable, while the usage table honestly records
  the other provider — the two parts would disagree.
- Switching mid-conversation invalidates the prompt cache, costing more than the failure saved.
- Failure is information. Hide it and you never learn a provider is degrading.

## Adding a provider

Five are bundled; adding another usually touches one file. See
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Configuration reference (advanced)

Everything lives under the `dsh-any-deepseek` namespace:

```yaml
dsh-any-deepseek:
  current: opencode-go          # the current channel
  channels:
    opencode-go:
      apiKey: sk-…              # the key itself
    open-design:
      preset: open-design       # use a bundled preset
      label: Open Design (main) # optional display name
    my-relay:
      baseURL: https://relay.example/v1   # or declare it fully
      model: deepseek-v4.1-flash
      apiKey: sk-…
  usage:
    enabled: true
```

**Protocol**: defaults to `openai-completions` (almost every relay speaks it). Set `api:
openai-responses` or `api: anthropic-messages` on **that one channel** only when it really speaks
something else.

**Thinking level**: each channel declares which levels it supports, and the level you pick in the
UI is the one sent upstream. Unsupported levels are not offered in the picker.

**Images**: sending and receiving images is supported.

**Legacy config**: early versions stored the key in `apiKeyEnv`. That field is still read — a value
that looks like an environment-variable name is resolved as one, otherwise it is used as the key
itself. `apiKey` always wins, so re-entering the key once in the panel migrates the entry.

## Boundaries

- Does not modify Harness itself, and does not replace the built-in `deepseek-official` route.
- Exposes exactly one model id (`deepseek-v4.1-flash`); per-provider upstream ids are mapped by
  presets.
- **No cost estimation** — there is no price table, only token counts.
- **No automatic failover** (v1).
- **No multi-model aggregation**.

## License

MIT. This is a small practical tool — forks, issues and PRs are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md).

<https://github.com/tellmewhattodo/dsh-any-deepseek>
