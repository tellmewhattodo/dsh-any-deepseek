/**
 * config.ts — the plugin's configuration schema.
 *
 * ## Why `channels` is `Volatile`
 *
 * The harness projects an entry's `Config` into a settings form only for fields marked
 * `.volatile()`: `volatileForm()` reads `meta.volatile` and nothing else. A plain object field
 * would make the whole panel section disappear, which is a failure mode already paid for once
 * (the serenity-hooks settings section). The read-side consequence is that the runtime value is
 * a reference wrapper, not a bare object — always unwrap it.
 *
 * ## Why the schema constants carry explicit annotations
 *
 * `z.dict(...)` expands to `Schema<Dict<…>, …>`, and `Dict` comes from cosmokit — a name
 * schemastery's public type surface does not re-export. Under `declaration: true`, tsc then
 * cannot name the inferred type of an exported schema constant and fails with TS2742
 * ("cannot be named without a reference to …cosmokit"). Annotating with the **global**
 * `Schemastery<S, T>` interface gives it a nameable type. Measured alternatives that do NOT
 * work: inlining the object, naming without annotating, or reaching for
 * `Schemastery.Schema<…>` (that name lives in the namespace, not the global interface).
 *
 * ## Why there is one value type, not an input/output pair
 *
 * A `.volatile()` field makes schemastery derive the output from the *input* side, so an
 * input/output split still fails to assign. One mutable shape is therefore both what a user
 * writes and what the plugin reads; `channels.ts` takes `unknown` and normalizes from there.
 *
 * ## Why `fallback` exists but nothing reads it
 *
 * v1 selected one channel and did not fail over (owner decision 2026-10-19). Failover arrived on
 * 2026-11-12 as the **supply group** (`supplyGroup.members`) at the owner's request, and it is
 * deliberately NOT built on `fallback`: the group is one ordered list the user edits, whereas
 * `fallback` was an unordered per-channel hint that nothing ever populated. `fallback` stays
 * declared-and-unread as the honest record of a shape we decided not to use — deleting it would
 * make an old configuration containing it fail schema validation.
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** Nameable schema type; see the TS2742 note in the file header. */
type SchemaOf<S, T = S> = Schemastery<S, T>

/**
 * The sentinel `current` value that means "the supply group serves requests".
 *
 * 🔴 **Why a sentinel value instead of an `enabled` flag** — this is the load-bearing decision of
 * the whole feature. "Which supplier is live" must be answerable from ONE field. A separate
 * `supplyGroup.enabled` would let the document say two contradictory things:
 * `enabled: true` with `current: 'opencode-go'` (which one wins?) and
 * `enabled: false` with nothing selected (did the user turn the group off, or never pick a channel?).
 * The panel would then need rules to reconcile the pair, and those rules would be the new bug
 * surface. The old per-channel `enabled` flag was retired for exactly this reason (`channels.ts`).
 *
 * The value is deliberately not a valid channel id: `__group__` fails `^[a-z0-9][a-z0-9_-]*$`
 * (leading underscore, and the panel's id validator rejects it), so it can never collide with a
 * real channel — a collision would make "the group is on" indistinguishable from "a channel named
 * `__group__` is on".
 */
export const SUPPLY_GROUP_ID = '__group__'

/** One channel entry as a user writes it (schema INPUT). */
export interface ChannelConfigInput {
  label?: string
  preset?: string
  api?: string
  baseURL?: string
  model?: string
  /** The key itself, stored in the channel entry. The panel writes this. */
  apiKey?: string
  /** Legacy: a credential reference name, resolved through the harness seam / environment. */
  apiKeyEnv?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoningEfforts?: Record<string, string | null>
  compat?: Record<string, unknown>
  headers?: Record<string, string>
}

/**
 * One channel entry as the plugin reads it (schema OUTPUT).
 *
 * Arrays are readonly: schemastery always parses them that way, so the output type has to say
 * so — otherwise the schema constant is unassignable to its own annotation.
 */
export interface ChannelConfigValue {
  readonly label?: string
  readonly preset?: string
  readonly api?: string
  readonly baseURL?: string
  readonly model?: string
  readonly apiKey?: string
  readonly apiKeyEnv?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly input?: ReadonlyArray<'text' | 'image'>
  readonly reasoningEfforts?: Readonly<Record<string, string | null>>
  readonly compat?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * One channel entry schema.
 *
 * Fields split into two groups the panel treats differently:
 *  - the key group (`apiKey`) — the only thing a user must supply for a preset channel;
 *  - the endpoint group (`api` / `baseURL` / `model` / capacities) — filled from a preset, or
 *    declared by hand for a custom channel.
 *
 * ## Why the key is stored here and not behind a reference
 *
 * This plugin used to take a credential REFERENCE NAME and store the value through
 * `ctx.remote.credentials`. Owner decision 2026-10-21: store the key in the entry itself.
 *
 * The price is explicit and accepted, recorded here so nobody rediscovers it as a bug:
 *  · `dsh --dump-config` renders patch layers verbatim and does NOT redact — a key in the
 *    configuration tree prints in full in diagnostics and diffs;
 *  · the environment-injection path (`-e SOME_KEY=…`) no longer reaches this plugin, because
 *    nothing resolves a name any more; a container run must carry the value in the profile.
 * What it buys: one storage location, no invented naming layer, and a panel that asks only for
 * the thing the user actually has.
 *
 * `role('secret')` is still declared. It does nothing for `dump-config` (measured: that path has
 * no redaction hook), but it makes the REMOTE settings read strip the field, so the browser form
 * never receives a value it did not type.
 */
export const ChannelConfigSchema: SchemaOf<ChannelConfigInput, ChannelConfigValue> = z.object({
  /** Label shown in the panel; falls back to the preset's display name, then the id. */
  label: z.string().description('显示名（留空则用预设名或渠道 id）'),
  /** Preset id from this plugin's own table. */
  preset: z.string().description('内置规格 id（选了它就不用填下面端点那些字段）'),
  api: z.string().description('接口协议：openai-completions（默认）/ openai-responses / anthropic-messages'),
  baseURL: z.string().description('端点根地址'),
  model: z.string().description('上游模型 id（各家拼写不同，必填）'),
  apiKey: z.string().role('secret').description('密钥本体（面板里粘贴，写在这条渠道上）'),
  apiKeyEnv: z.string().description('旧式：凭据引用名（环境变量名）。仅当 apiKey 为空时才用'),
  contextWindow: z.number().description('上下文窗口（tokens）'),
  maxTokens: z.number().description('单次输出上限（tokens）'),
  input: z.array(z.union([z.const('text'), z.const('image')])).description('输入模态'),
  reasoningEfforts: z.dict(z.union([z.string(), z.const(null)])).description('推理档位 → wire 取值'),
  compat: z.dict(z.any()).description('协议兼容开关（透传给 pi-ai）'),
  headers: z.dict(z.string()).description('额外请求头（不含密钥）'),
})

/** Ledger settings. */
export interface UsageConfigValue {
  enabled?: boolean
  path?: string
}

/**
 * The supply group: an ordered member list.
 *
 * ⚠️ **The INPUT side must use a mutable `string[]`.** schemastery derives the input type from
 * `z.array(z.string())` as `string[]`, so declaring `readonly string[]` here makes the schema
 * unassignable to its own annotation (measured: TS2322 on `PluginConfigSchema`). The OUTPUT side
 * is the one that is readonly, because that is what the schema actually produces.
 */
export interface SupplyGroupConfig {
  members?: string[]
}

/** Ledger settings schema. */
export const UsageConfigSchema: SchemaOf<UsageConfigValue> = z.object({
  enabled: z.boolean().default(true).description('是否记账'),
  path: z.string().description('账本目录（留空用 ~/.dsh/any-deepseek）'),
})

/**
 * Plugin configuration as a user writes it (schema INPUT).
 *
 * `channels` is a plain map here: `.volatile()` changes only the parsed OUTPUT type.
 */
export interface PluginConfigInput {
  channels?: Record<string, ChannelConfigInput>
  current?: string
  supplyGroup?: SupplyGroupConfig
  usage?: UsageConfigValue
  fallback?: string[]
}

/**
 * Plugin configuration as the plugin reads it (schema OUTPUT).
 *
 * `channels` and `current` parse to reference wrappers — created even when the user set
 * nothing, so the fields are always present. Read them through {@link unwrap}.
 *
 * 🔴 **`current` is volatile too, and that is not cosmetic** — see the `.volatile()` note on
 * `PluginConfigSchema`.
 */
export interface PluginConfigValue {
  channels: Volatile<Record<string, ChannelConfigValue>>
  current: Volatile<string>
  supplyGroup: Volatile<{ readonly members: readonly string[] }>
  usage: UsageConfigValue
  fallback: string[]
}

/**
 * Plugin configuration schema.
 *
 * ## Why EVERY panel-writable field must be `.volatile()`
 *
 * The host projects an entry's Config into a settings form only for volatile fields, and its
 * write path **refuses** any path outside one:
 *
 * ```js
 * for (const path of paths) if (path.length && !isVolatilePath(schema, path))
 *   throw new Error(`Config field "${path.join('.')}" is not volatile`)
 * ```
 *
 * `channels` was volatile from the start, so channel edits worked. `current` was **not**, so
 * every click on "设为当前" was rejected by the host — and the host's client-side form turns
 * that refusal into a bare `false`, which the panel reported as "read-only deployment or the
 * settings service is not enabled". **That message named two causes it had never checked.**
 * The real cause was a schema annotation three layers away.
 *
 * ⇒ Rule: a field the panel writes must be `.volatile()`, and the runtime side must
 * `unwrap()` it. Adding a writable field without both halves reproduces this bug silently.
 */
export const PluginConfigSchema: SchemaOf<PluginConfigInput, PluginConfigValue> = z.object({
  channels: z.dict(ChannelConfigSchema).default({}).volatile().description('渠道表：每行一个中转渠道'),
  /**
   * What serves requests: a channel id, or {@link SUPPLY_GROUP_ID}.
   *
   * 🔴 **The supply group is a VALUE of this field, not a second flag beside it.** See
   * {@link SUPPLY_GROUP_ID} for why that matters.
   */
  current: z.string().default('').volatile().description('当前使用：渠道 id，或供应组（__group__）'),
  /**
   * The one supply group: an ORDERED list of channel ids.
   *
   * 🔴 **There is no `enabled` field, and that is the design.** "Is the group on?" is answered by
   * `current === SUPPLY_GROUP_ID` — one fact, one place. Adding `enabled` would create two axes
   * that can contradict each other (enabled but not selected = a switch that does nothing;
   * selected but disabled = an incoherent state), which is exactly the defect that retired the
   * old per-channel `enabled` flag (see `channels.ts`).
   *
   * 🔴 **"Only one group" is a shape guarantee, not a validation.** A single array cannot express
   * a second group. Supporting several later would require an explicit schema change rather than
   * an accidental one.
   *
   * Order is the trial order: index 0 is tried first.
   */
  supplyGroup: z.object({
    members: z.array(z.string()).default([]).description('供应组成员（按使用顺序）'),
  }).default({ members: [] }).volatile().description('供应组：按顺序自动切换的渠道列表'),
  usage: UsageConfigSchema.default({ enabled: true }),
  fallback: z.array(z.string()).default([]).description('预留：故障转移顺序（v1 未实现）'),
})

/**
 * Read a volatile-or-bare value.
 *
 * A volatile field parses to a reference wrapper even when the user has not set it (the wrapper
 * is created before the default branch runs), so `unwrap(...) ?? fallback` is the only correct
 * read order. Reading the wrapper directly would yield an object that is always truthy.
 * @param value - reference wrapper, bare value, or undefined.
 * @returns the current value, or undefined.
 */
export function unwrap<T>(value: T | { get(): T } | undefined): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/**
 * Read the channel map out of a parsed configuration.
 * @param value - the `channels` field, wrapped or bare.
 * @returns the channel map (never undefined).
 */
export function unwrapChannels(
  value: PluginConfigValue['channels'] | undefined,
): Record<string, ChannelConfigValue> {
  return unwrap(value) ?? {}
}
