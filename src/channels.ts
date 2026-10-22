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
  type BalanceProbe,
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
  /**
   * The key itself, stored in the entry.
   *
   * 🔴 Prefer this over {@link apiKeyEnv}. Owner decision 2026-10-21: the panel takes the key the
   * user has and writes it here — no invented reference name, no second store to consult. The
   * accepted cost (a key visible in `--dump-config` output and in the profile patch) is recorded
   * on `ChannelConfigSchema`.
   */
  apiKey?: string
  /**
   * Legacy: a credential reference name, resolved through the harness credential seam or the
   * process environment. Still honoured so a configuration written before the change keeps
   * working, but the panel no longer produces one.
   */
  apiKeyEnv?: string
  /**
   * @deprecated Retired. Kept in the schema only so an existing configuration that still carries
   * the field does not fail validation; it is **ignored**.
   *
   * The design has exactly one axis for "which relay serves requests": `current`. A second
   * on/off axis says the same thing twice and can contradict itself — a channel that is
   * `enabled` but not `current` does nothing, and one that is `current` but disabled is a
   * straight incoherence. Removing the axis also removes a whole class of UI state: there is no
   * such thing as a "closed channel" to render greyed out.
   */
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
  /**
   * How this channel authenticates.
   *
   * A discriminated shape rather than two optional strings, so no caller can read the wrong one
   * and so "no key at all" is a state the type forces someone to handle.
   */
  credential:
    | { kind: 'literal'; value: string }
    | { kind: 'reference'; ref: string }
    | { kind: 'none' }
  /**
   * Preset id this channel was built from, when it named one.
   *
   * Kept through resolution so the panel can label a channel it did not fully recognise, and so
   * a future preset change can be reasoned about per channel.
   */
  preset?: string
  contextWindow: number
  maxTokens: number
  input: ChannelModality[]
  reasoningEfforts?: Record<string, string | null>
  compat?: Record<string, unknown>
  headers?: Record<string, string>
  /**
   * How this endpoint's remaining balance can be read, when it can be.
   *
   * Absent means "no balance API" — a real state, not a missing value. See `presets.ts` for the
   * four verified shapes. Note the two different kinds of "no number": OpenCode Go reports usage
   * WINDOWS rather than money (it does have a surface), while Open Design publishes no surface at
   * all (measured: seven candidates, all 404). The panel distinguishes them, and checks liveness
   * for the latter instead of inventing an amount.
   */
  balance?: BalanceProbe
  /** Facts the user should see because a default was applied rather than declared. */
  warnings: string[]
}

/** Why one entry could not be resolved. */
export interface ChannelProblem {
  id: string
  code:
    | 'UNKNOWN_PRESET'
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
  'apiKey',
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

/**
 * The grammar a credential REFERENCE name must match.
 *
 * Transcribed from the harness's own credential seam
 * (`@deepseek-ai/dsh-credentials` → `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`).
 *
 * This plugin no longer WRITES references (the panel stores the key itself), but it still READS
 * them, and the grammar is what lets the read distinguish the two shapes. A string that cannot be
 * an environment-variable name cannot be a reference — so when one appears in `apiKeyEnv` it can
 * only be a value in the wrong slot, which is a repairable configuration error rather than a
 * mystery.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Whether a string could name a credential reference at all.
 * @param value - candidate name.
 * @returns true when the field can be read as a reference.
 */
export function isCredentialRefName(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value)
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

  /**
   * How this channel authenticates — never a reason to fail resolution.
   *
   * 🔴 A channel with no key still RESOLVES. The panel has to be able to show it (that is how the
   * user gets to fix it), and the model directory must not depend on a secret being present
   * (decision 26: a provider that vanishes when unconfigured looks exactly like one that is not
   * installed). A missing key is answered per request — `MISSING_CREDENTIAL` — and per row.
   *
   * Migration, by grammar: `apiKey` wins when present. Otherwise `apiKeyEnv` is read as a
   * reference ONLY when it matches the host's reference grammar. A string that cannot be a name
   * is a key in the wrong slot — an observed state, since the previous version of this panel
   * asked for a name and one user's YAML holds `sk-…` there. Adopting it is a repair, not a
   * guess: no environment variable can have that spelling.
   */
  const literal = nonEmpty(entry.apiKey)
  const legacy = nonEmpty(entry.apiKeyEnv)
  const credential: ResolvedChannel['credential'] =
    literal !== undefined
      ? { kind: 'literal', value: literal }
      : legacy === undefined
        ? { kind: 'none' }
        : isCredentialRefName(legacy)
          ? { kind: 'reference', ref: legacy }
          : { kind: 'literal', value: legacy }

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
      credential,
      ...presetId === undefined ? {} : { preset: presetId },
      contextWindow,
      maxTokens,
      input,
      ...(entry.reasoningEfforts ?? preset?.reasoningEfforts) === undefined
        ? {}
        : { reasoningEfforts: (entry.reasoningEfforts ?? preset?.reasoningEfforts) as Record<string, string | null> },
      ...(entry.compat ?? preset?.compat) === undefined
        ? {}
        : { compat: (entry.compat ?? preset?.compat) as Record<string, unknown> },
      /**
       * 🔴 Headers MERGE per key; they do not replace.
       *
       * `entry.headers ?? preset?.headers` treated the two as alternatives, so a user who added
       * one header of their own silently lost the preset's — and for OpenCode Go those are the
       * headers the endpoint refuses requests without. Merging keeps the preset's required set
       * and lets the entry win only on the keys it actually names.
       */
      ...mergeHeaders(preset?.headers, entry.headers) === undefined
        ? {}
        : { headers: mergeHeaders(preset?.headers, entry.headers) as Record<string, string> },
      // Carried through so the panel can ask "what does this endpoint report" without knowing
      // the preset table — and so a channel's own override can later replace it in one place.
      ...preset?.balance === undefined ? {} : { balance: preset.balance },
      warnings,
    },
  }
}

/**
 * Merge preset headers with entry headers, the entry winning per key.
 *
 * HTTP field names are case-insensitive, so a user writing `X-Session-ID` must override a
 * preset's `x-session-id` rather than appearing alongside it as a second header — sending both
 * would leave the upstream to pick one, which is exactly the ambiguity the header exists to
 * resolve.
 * @param preset - headers the preset declares.
 * @param entry - headers the entry declares.
 * @returns the merged set, or undefined when neither side declares any.
 */
function mergeHeaders(
  preset: Record<string, string> | undefined,
  entry: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (entry === undefined) return preset === undefined ? undefined : { ...preset }
  if (preset === undefined) return { ...entry }
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(preset)) merged[name] = value
  for (const [name, value] of Object.entries(entry)) {
    // Drop any preset spelling that differs only by case, then write the entry's own spelling.
    for (const existing of Object.keys(merged)) {
      if (existing !== name && existing.toLowerCase() === name.toLowerCase()) delete merged[existing]
    }
    merged[name] = value
  }
  return merged
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
 * Every resolved channel, in configuration order — the panel's list and the router's candidate set.
 *
 * 🔴 There is no filtering step here, deliberately. This used to be `enabledChannels()`, which
 * dropped entries with `enabled: false`. That made two things impossible:
 *   · the panel could not show a channel it had hidden, so you could not switch it back on;
 *   · "which relay serves requests" had two answers (`enabled` AND `current`) that could disagree.
 * The design has one axis — `current` — so the only list is "all channels", and selection is a
 * separate fact.
 * @param resolution - output of {@link resolveChannels}.
 * @returns all resolved channels (the router picks one of them via `current`).
 */
export function allChannels(resolution: ChannelResolution): ResolvedChannel[] {
  return [...resolution.channels.values()]
}

/** The advertised model id, re-exported so callers need one import for routing facts. */
export { ADVERTISED_MODEL_ID }
