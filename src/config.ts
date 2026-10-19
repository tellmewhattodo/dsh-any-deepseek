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
 * v1 selects one channel and does not fail over (owner decision). Declaring the field now means
 * enabling failover later is a behaviour change, not a configuration migration — and an unread
 * field is honest about that, whereas a hidden field would be a surprise later.
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** Nameable schema type; see the TS2742 note in the file header. */
type SchemaOf<S, T = S> = Schemastery<S, T>

/** One channel entry as a user writes it (schema INPUT). */
export interface ChannelConfigInput {
  label?: string
  preset?: string
  api?: string
  baseURL?: string
  model?: string
  apiKeyEnv?: string
  enabled?: boolean
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
  readonly apiKeyEnv?: string
  readonly enabled?: boolean
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
 *  - the key group (`apiKeyEnv`) — the only thing a user must supply for a preset channel;
 *  - the endpoint group (`api` / `baseURL` / `model` / capacities) — filled from a preset, or
 *    declared by hand for a custom channel.
 */
export const ChannelConfigSchema: SchemaOf<ChannelConfigInput, ChannelConfigValue> = z.object({
  /** Label shown in the panel; falls back to the preset's display name, then the id. */
  label: z.string().description('显示名（留空则用预设名或渠道 id）'),
  /** Preset id from this plugin's own table. */
  preset: z.string().description('内置规格 id（选了它就不用填下面端点那些字段）'),
  api: z.string().description('接口协议：openai-completions（默认）/ openai-responses / anthropic-messages'),
  baseURL: z.string().description('端点根地址'),
  model: z.string().description('上游模型 id（各家拼写不同，必填）'),
  apiKeyEnv: z.string().description('凭据引用名（环境变量名）；真实 key 存在凭据库里，不落配置'),
  enabled: z.boolean().default(true).description('是否启用'),
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
  usage?: UsageConfigValue
  fallback?: string[]
}

/**
 * Plugin configuration as the plugin reads it (schema OUTPUT).
 *
 * `channels` parses to a reference wrapper — created even when the user set nothing, so the
 * field is always present. Read it through {@link unwrapChannels}.
 */
export interface PluginConfigValue {
  channels: Volatile<Record<string, ChannelConfigValue>>
  current: string
  usage: UsageConfigValue
  fallback: string[]
}

/**
 * Plugin configuration schema.
 *
 * `channels` is volatile: the panel can only render and edit a field the harness sees as a
 * reference, and the runtime value arrives as a wrapper whose `.get()` returns the document.
 */
export const PluginConfigSchema: SchemaOf<PluginConfigInput, PluginConfigValue> = z.object({
  channels: z.dict(ChannelConfigSchema).default({}).volatile().description('渠道表：每行一个中转渠道'),
  current: z.string().default('').description('当前使用的渠道 id'),
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
