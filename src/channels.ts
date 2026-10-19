/**
 * channels.ts — the configuration entry → resolved channel profile layer.
 *
 * ## Two shapes, one resolution
 *
 * A channel entry is either preset-backed (`preset: opencode-go`, key only) or fully declared
 * (every field present). Both resolve through {@link resolveChannel} to the same
 * {@link ResolvedChannel}, so the adapter never branches on which shape the user chose.
 *
 * ## Why a missing field is an error rather than a default
 *
 * A partially declared custom channel is a configuration mistake, not a preference: guessing
 * the endpoint would send the user's key somewhere they did not name. The only defaults
 * applied are the ones the host itself documents (capacities), and they are applied *loudly*
 * in the returned `warnings` so the panel can show them.
 */

import {
  ADVERTISED_MODEL_ID,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  type ChannelApi,
  type ChannelModality,
  presetById,
} from './presets.js'

/** One channel as the configuration document stores it. */
export interface ChannelEntry {
  /** Human label; falls back to the preset's or the id. */
  label?: string
  /** Preset id this entry references. Mutually exclusive with a fully declared channel. */
  preset?: string
  /** Wire protocol. Required for a channel that names no preset. */
  api?: string
  /** Endpoint. Required for a channel that names no preset. */
  baseURL?: string
  /** Upstream model id. Required for a channel that names no preset. */
  model?: string
  /** Credential reference (environment-variable name). Required. */
  apiKeyEnv?: string
  /** Whether the panel offers this channel. Absent means enabled. */
  enabled?: boolean
  /** Overrides applied on top of a preset, or the whole declaration for a custom channel. */
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  reasoningEfforts?: Record<string, string | null>
  compat?: Record<string, unknown>
  headers?: Record<string, string>
}

/** A channel with every fact the adapter needs, and nothing optional left to guess. */
export interface ResolvedChannel {
  /** Stable channel id (the configuration key). */
  id: string
  label: string
  api: ChannelApi
  baseURL: string
  /** Upstream model id, as the relay spells it. */
  model: string
  apiKeyEnv: string
  contextWindow: number
  maxTokens: number
  input: ChannelModality[]
  reasoningEfforts?: Record<string, string | null>
  compat?: Record<string, unknown>
  headers?: Record<string, string>
  /** Facts the user should see because a default was applied rather than declared. */
  warnings: string[]
}

/** Why one entry could not be resolved. */
export interface ChannelProblem {
  id: string
  code:
    | 'UNKNOWN_PRESET'
    | 'MISSING_API_KEY_REF'
    | 'MISSING_FIELD'
    | 'INVALID_API'
    | 'UNKNOWN_KEY'
  detail: string
}

/** Result of resolving a whole configuration's channel map. */
export interface ChannelResolution {
  /** Channels that resolved, keyed by id, in configuration order. */
  channels: Map<string, ResolvedChannel>
  /** Entries that could not resolve; each is reported rather than skipped silently. */
  problems: ChannelProblem[]
}

/** Protocols a channel may name. Anything else is a typo, not an extension point. */
const SUPPORTED_APIS: readonly ChannelApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/**
 * Wire protocol applied when a channel declares none.
 *
 * OpenAI-compatible completions is what essentially every relay speaks, it has the widest compat
 * surface in pi-ai, and pi-ai already normalizes the three usage spellings it produces. A channel
 * that only offers Responses can still say so explicitly.
 */
const DEFAULT_API: ChannelApi = 'openai-completions'

/** Fields a channel entry may carry; used only to report unknown keys. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'label',
  'preset',
  'api',
  'baseURL',
  'model',
  'apiKeyEnv',
  'enabled',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoningEfforts',
  'compat',
  'headers',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Normalize a modality list, dropping anything the wire cannot carry. */
function modalities(value: unknown): ChannelModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ChannelModality[] = []
  for (const item of value) {
    if (item === 'text' || item === 'image') {
      if (!out.includes(item)) out.push(item)
    }
  }
  return out.length === 0 ? undefined : out
}

/**
 * Resolve one channel entry.
 *
 * Precedence is preset first, entry second: an entry that names a preset inherits everything
 * and overrides only what it declares. A custom entry (no preset) must supply the endpoint
 * facts itself.
 * @param id - configuration key, used verbatim as the channel's identity.
 * @param raw - the entry as stored.
 * @returns the resolved channel, or the problem that prevented resolution.
 */
export function resolveChannel(
  id: string,
  raw: unknown,
): { ok: true; channel: ResolvedChannel } | { ok: false; problem: ChannelProblem } {
  if (!isPlainObject(raw)) {
    return { ok: false, problem: { id, code: 'MISSING_FIELD', detail: 'channel entry must be an object' } }
  }
  const entry = raw as ChannelEntry
  const warnings: string[] = []

  for (const key of Object.keys(entry)) {
    if (!KNOWN_KEYS.has(key)) {
      return {
        ok: false,
        problem: { id, code: 'UNKNOWN_KEY', detail: `unknown channel field "${key}"` },
      }
    }
  }

  const apiKeyEnv = nonEmpty(entry.apiKeyEnv)
  if (apiKeyEnv === undefined) {
    return {
      ok: false,
      problem: {
        id,
        code: 'MISSING_API_KEY_REF',
        detail: 'apiKeyEnv is required: a channel without a credential reference cannot authenticate',
      },
    }
  }

  const presetId = nonEmpty(entry.preset)
  const preset = presetId === undefined ? undefined : presetById(presetId)
  if (presetId !== undefined && preset === undefined) {
    return {
      ok: false,
      problem: { id, code: 'UNKNOWN_PRESET', detail: `no preset named "${presetId}"` },
    }
  }

  // Endpoint facts: preset value, then the entry's own declaration.
  //
  // `api` is the one field that DEFAULTS rather than being required: OpenAI-compatible completions
  // is the lowest common denominator every relay speaks, and the schema text promises it. Making
  // it mandatory meant a user who followed the documented "just give a model and a baseURL" path
  // was rejected with MISSING_FIELD — the config said "default" and the code said "required".
  const apiRaw = nonEmpty(entry.api) ?? preset?.api ?? DEFAULT_API
  const baseURL = nonEmpty(entry.baseURL) ?? preset?.baseURL
  const model = nonEmpty(entry.model) ?? preset?.model

  const missing: string[] = []
  if (baseURL === undefined) missing.push('baseURL')
  if (model === undefined) missing.push('model')
  if (missing.length > 0) {
    return {
      ok: false,
      problem: {
        id,
        code: 'MISSING_FIELD',
        detail: `a channel without a preset must declare ${missing.join(', ')}`,
      },
    }
  }

  if (!SUPPORTED_APIS.includes(apiRaw as ChannelApi)) {
    return {
      ok: false,
      problem: {
        id,
        code: 'INVALID_API',
        detail: `unsupported api "${apiRaw}"; expected one of ${SUPPORTED_APIS.join(', ')}`,
      },
    }
  }

  const declaredContext = positiveInt(entry.contextWindow) ?? preset?.contextWindow
  const declaredMax = positiveInt(entry.maxTokens) ?? preset?.maxTokens

  let contextWindow = declaredContext
  if (contextWindow === undefined) {
    contextWindow = DEFAULT_CONTEXT_WINDOW
    warnings.push(`contextWindow not declared; assumed ${DEFAULT_CONTEXT_WINDOW}`)
  }
  let maxTokens = declaredMax
  if (maxTokens === undefined) {
    maxTokens = DEFAULT_MAX_TOKENS
    warnings.push(`maxTokens not declared; assumed ${DEFAULT_MAX_TOKENS}`)
  }

  const input = modalities(entry.input) ?? preset?.input ?? ['text']

  return {
    ok: true,
    channel: {
      id,
      label: nonEmpty(entry.label) ?? preset?.displayName ?? id,
      api: apiRaw as ChannelApi,
      baseURL: baseURL as string,
      model: model as string,
      apiKeyEnv,
      contextWindow,
      maxTokens,
      input,
      ...(entry.reasoningEfforts ?? preset?.reasoningEfforts) === undefined
        ? {}
        : { reasoningEfforts: (entry.reasoningEfforts ?? preset?.reasoningEfforts) as Record<string, string | null> },
      ...(entry.compat ?? preset?.compat) === undefined
        ? {}
        : { compat: (entry.compat ?? preset?.compat) as Record<string, unknown> },
      ...(entry.headers ?? preset?.headers) === undefined
        ? {}
        : { headers: (entry.headers ?? preset?.headers) as Record<string, string> },
      warnings,
    },
  }
}

/**
 * Resolve every channel in one configuration document.
 *
 * Problems are collected, never thrown: one broken channel must not make the rest of the
 * panel unusable, and the panel needs the per-entry reason to show next to the row.
 * @param entries - the configuration's `channels` map.
 * @returns resolved channels plus every problem found.
 */
export function resolveChannels(entries: unknown): ChannelResolution {
  const channels = new Map<string, ResolvedChannel>()
  const problems: ChannelProblem[] = []
  if (!isPlainObject(entries)) return { channels, problems }

  for (const [id, raw] of Object.entries(entries)) {
    const result = resolveChannel(id, raw)
    if (result.ok) channels.set(id, result.channel)
    else problems.push(result.problem)
  }
  return { channels, problems }
}

/**
 * Channels that should appear and serve requests: resolved AND not explicitly disabled.
 * @param resolution - output of {@link resolveChannels}.
 * @param entries - the same configuration map, read again for the `enabled` flags.
 * @returns enabled channels, configuration order preserved.
 */
export function enabledChannels(
  resolution: ChannelResolution,
  entries: unknown,
): ResolvedChannel[] {
  const out: ResolvedChannel[] = []
  const map = isPlainObject(entries) ? entries : {}
  for (const [id, channel] of resolution.channels) {
    const raw = map[id]
    const disabled = isPlainObject(raw) && raw.enabled === false
    if (!disabled) out.push(channel)
  }
  return out
}

/** The advertised model id, re-exported so callers need one import for routing facts. */
export { ADVERTISED_MODEL_ID }
