# dsh-any-deepseek

One **DeepSeek V4.1 Flash** provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Instead of configuring every third-party DeepSeek relay as its own provider, install one
provider with **exactly one model**, paste a key per channel in the settings panel, and pick
which channel is live. Token usage is booked **per real upstream**, so you can see what each
relay actually cost you in tokens.

```text
composer → any-deepseek / deepseek-v4.1-flash
                │
                ├─ channel selected in the panel (manual switch, v1)
                ├─ key resolved from ctx.credentials per request
                └─ forwarded as openai-completions to the channel's endpoint
```

## Why

- **One row in the model picker.** Your relay list stops being N provider groups.
- **Only a key is user input.** Endpoint, upstream model id, context window, output cap and
  compatibility flags ship in the plugin's own preset table.
- **Per-channel accounting.** Input / cache-read / cache-write / output are recorded per
  request and grouped by the channel that actually served it.
- **Keys never enter configuration.** They live in the harness credential store; the config
  only carries the reference name, exactly like the official Models page.

## Install

```bash
dsh plugin --profile web add dsh-any-deepseek
```

Then restart DSH and open **Settings → Any DeepSeek**.

> **Restart is required for a first install** — the profile's layer list changed, and the
> composing graph is built at boot. Editing an already-installed plugin's client half reloads
> in the browser without a restart; its node half does not.
>
> `dsh plugin` forwards its arguments to pnpm, so `add <spec>` accepts a registry name, a
> tarball path, or a local directory (which installs as a symlink).

## Configuration

Everything lives under the `dsh-any-deepseek` settings namespace — that is the **profile entry
id** from `cordis.patch.yml`, and it is what the panel binds to:

```yaml
dsh-any-deepseek:
  current: opencode-go          # the live channel (manual)
  channels:
    opencode-go:
      apiKey: sk-…              # the key itself
    commandcode:
      apiKey: sk-…              # the key itself
  usage:
    enabled: true
```

`channels.<id>` may be either:

- **preset-backed** — `preset: opencode-go` plus optional overrides; or
- **fully declared** — `baseURL` + `model` are required; `api` defaults to
  `openai-completions`, and `contextWindow` / `maxTokens` fall back to documented defaults
  (the panel shows a warning next to the row when a default was applied rather than declared).

### Where the key lives

`apiKey` holds the key **itself**, on the channel. The panel never asks you to invent a name for
it — you paste the key, and it is written here.

⚠️ **That means the key is in your profile configuration.** `dsh --dump-config` prints patch
layers verbatim and does not redact, so a diagnostic dump, a `git diff` of the profile, or a
pasted config includes it. Do not share the profile document. Environment-variable injection
(`-e SOME_KEY=…`) is not consulted — nothing resolves a name.

`apiKeyEnv` is still **read** for configurations written before this change: when its value
matches the credential-reference grammar (`^[A-Za-z_][A-Za-z0-9_]*$`) it is resolved as a name;
when it does not, it cannot be a name, so it is adopted as the key itself. `apiKey` always wins
when both are present, so re-keying through the panel is enough to migrate an entry.

A channel with no key still **appears** in the panel — that is how you find and fix it. Requests
through it fail with `MISSING_CREDENTIAL`, and the row shows an unconfigured dot.

### Channels vs. protocols

`openai-completions` is the default and the recommended protocol: it is what almost every
relay speaks, it exposes the largest compatibility surface (~20 switches), and its usage
normalization already reconciles the three cache-token spellings relays use
(`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, top-level `cached_tokens`).

Set `api` on one channel only when that relay speaks something else (`openai-responses`,
`anthropic-messages`). The picker never changes per channel behind your back.

### Switching channels

v1 is deliberately manual. A channel that fails reports its error; it does not silently fail
over to another one. Switching invalidates the prompt cache for the running conversation, so
switch at a natural boundary (or start a new session).

## Usage accounting

The ledger is append-only JSONL, split by month, under the harness home:

```text
~/.dsh/any-deepseek/usage-YYYY-MM.jsonl
```

One line per request:

```json
{"at":"2026-10-19T10:12:03+08:00","channel":"opencode-go","model":"deepseek-v4.1-flash","ok":true,"ms":4210,"firstTokenMs":810,"usage":{"input":812,"output":96,"cacheRead":40960,"cacheWrite":0,"reasoning":0,"total":41868}}
```

`usage` is `null` when a relay does not report token counts — the panel shows `—`, never `0`,
because a zero would read as "this request was free".

**Counting convention.** `TokenUsage` counts are *disjoint*: `input` is uncached input only,
cache reads and writes are reported separately, and the three together are the billable input.
The stats table states this next to the numbers.

## Development

```bash
pnpm install
pnpm run typecheck     # host types come from pinned devDependencies
pnpm run test          # pure layers only; no harness needed
pnpm run build         # lib/index.js + lib/client.js
```

The pure layers (`presets`, `channels`, `route`, `usage-ledger`) do not import the harness and
are covered by the unit tests. The adapter and panel talk to the host through public seams
only.

## Boundaries

- Does not modify the harness, and does not replace `deepseek-official` or `llm-pi-ai` routes.
- Exposes exactly one model id. Upstream model ids differ per relay and are mapped in presets.
- No cost estimation (no price table), no automatic failover (v1), no multi-model aggregation.

## License

MIT
