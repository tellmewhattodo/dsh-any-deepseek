/**
 * presets.ts — channel specifications maintained by this plugin.
 *
 * ## Why a private table instead of a public catalog
 *
 * Owner decision (2026-10-19): the plugin must not consume any upstream provider catalog,
 * because public catalogs update slower than the relays do. Every relay's endpoint, wire
 * protocol, upstream model id and capability numbers live here, where we can change them in
 * the same commit that notices the change.
 *
 * ## Why a full model entry rather than a bare id
 *
 * `dsh-llm-pi-ai` resolves a route's endpoint as `request.baseURL ?? catalog.baseUrl ??
 * providerBaseUrl`. For a model the installed catalog does not describe, all three are empty
 * and the host rejects the whole configuration with `needs a baseURL; the installed catalog
 * does not describe this route`. Carrying `baseURL` + capacities in the preset means that
 * failure shape cannot occur here.
 *
 * ## Field provenance
 *
 * Values are transcribed from endpoints we operate, not invented: a relay's `compat` block is
 * copied from a sibling model on the same wire family when we cannot observe it directly.
 * Anything unverified stays absent and falls back to the documented default below, which is
 * the honest choice — an unverified `maxTokens` that is too high turns into a provider-side
 * rejection after the message is already durable.
 */

/** Wire protocols this plugin is willing to drive. */
export type ChannelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** Modality a request can carry. */
export type ChannelModality = 'text' | 'image'

/**
 * One relay's fixed facts.
 *
 * A preset is *data*: it says what the endpoint is and how it must be spoken to. Anything a
 * user can reasonably differ on (which key, whether the channel is enabled, a header a
 * particular tenant needs) belongs to the channel entry that references the preset.
 */
export interface ChannelPreset {
  /** Display label used when the channel entry does not override it. */
  displayName: string
  /** Wire protocol this relay speaks. */
  api: ChannelApi
  /** Endpoint the model requests append to. */
  baseURL: string
  /**
   * Model id the relay expects on the wire. This is deliberately NOT the id this plugin
   * advertises: relays disagree (`deepseek-v4.1-flash`, `deepseek/deepseek-v4.1-flash`,
   * `deepseek-v4-flash-202605`), which is exactly why the mapping has to exist.
   */
  model: string
  /** Combined request+response capacity, in tokens. */
  contextWindow?: number
  /** Per-request output cap, in tokens. */
  maxTokens?: number
  /** Accepted request modalities. Absent means text-only. */
  input?: ChannelModality[]
  /** Selectable reasoning levels and the spelling this relay wants for each. */
  reasoningEfforts?: Record<string, string | null>
  /** Protocol switches for relays whose behaviour the defaults do not describe. */
  compat?: Record<string, unknown>
  /** Headers every request to this relay carries. Never secrets. */
  headers?: Record<string, string>
  /** One-line note for the panel, when the relay needs explaining. */
  note?: string
}

/**
 * The model id this plugin advertises — the single entry in the picker.
 *
 * It is intentionally provider-neutral: the composer shows one model, and which relay serves
 * it is a panel decision, not a model-list decision.
 */
export const ADVERTISED_MODEL_ID = 'deepseek-v4.1-flash'

/** Display name for {@link ADVERTISED_MODEL_ID}. */
export const ADVERTISED_MODEL_NAME = 'DeepSeek V4.1 Flash'

/**
 * Fallbacks for a custom channel that declares a model without capacities.
 *
 * These match the pi-ai adapter's own documented defaults (`DEFAULT_CONTEXT_WINDOW`,
 * `DEFAULT_MAX_TOKENS`) so a half-filled custom channel behaves the same way a pi-ai route
 * would, rather than surprising the user with a plugin-specific number.
 */
export const DEFAULT_CONTEXT_WINDOW = 262_144
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * Capability numbers shared by every DeepSeek V4.1 Flash deployment we know of.
 *
 * Kept as one constant because these are properties of the *model*, not of a relay; a relay
 * that disagrees corrects them in its own preset.
 */
const V41_FLASH_CAPS = {
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  input: ['text'] as ChannelModality[],
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' } as Record<string, string | null>,
}

/**
 * DeepSeek's chat-completions thinking dialect: a `thinking` object plus `reasoning_effort`,
 * with replay needing an explicit empty `reasoning_content` on assistant messages.
 */
const DEEPSEEK_THINKING_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
} as const

/**
 * Header family the OpenCode Go endpoint requires.
 *
 * `/zen/go` answers 400 `Request is missing x-opencode-session` without it. The values are
 * static on purpose: the header is resolved once per route, so a per-request value would
 * either change nothing or silently change the cache key.
 */
const OPENCODE_HEADERS = {
  'x-opencode-session': 'dsh-any-deepseek',
  'X-Session-ID': 'dsh-any-deepseek',
  'x-opencode-client': 'dsh',
  'x-opencode-project': 'global',
} as const

/**
 * Presets keyed by a stable id.
 *
 * The id is what a channel entry stores (`preset: opencode-go`), so it is part of the user's
 * configuration surface: renaming one breaks saved channels. Add, do not rename.
 */
export const CHANNEL_PRESETS: Readonly<Record<string, ChannelPreset>> = {
  'opencode-go': {
    displayName: 'OpenCode Go',
    api: 'openai-completions',
    baseURL: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4.1-flash',
    ...V41_FLASH_CAPS,
    compat: { ...DEEPSEEK_THINKING_COMPAT },
    headers: { ...OPENCODE_HEADERS },
    note: 'Requires the OpenCode session headers; shipped with the preset.',
  },
  commandcode: {
    displayName: 'CommandCode',
    api: 'openai-completions',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    // Note the slash: this relay namespaces its model ids by vendor.
    model: 'deepseek/deepseek-v4.1-flash',
    ...V41_FLASH_CAPS,
    compat: { ...DEEPSEEK_THINKING_COMPAT },
  },
  ollama: {
    displayName: 'Ollama Cloud',
    api: 'openai-completions',
    baseURL: 'https://ollama.com/v1',
    model: 'deepseek-v4.1-flash',
    ...V41_FLASH_CAPS,
  },
  'open-design': {
    displayName: 'Open Design',
    api: 'openai-completions',
    baseURL: 'https://amr-link.open-design.ai/v1',
    model: 'deepseek-v4.1-flash',
    ...V41_FLASH_CAPS,
  },
  'deepseek-official': {
    displayName: 'DeepSeek Official',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4.1-flash',
    ...V41_FLASH_CAPS,
  },
}

/** Every preset id, in table order — the panel's picker source. */
export function presetIds(): string[] {
  return Object.keys(CHANNEL_PRESETS)
}

/**
 * Look one preset up.
 * @param id - preset key from a channel entry.
 * @returns the preset, or `undefined` when the id is unknown.
 */
export function presetById(id: string): ChannelPreset | undefined {
  return Object.hasOwn(CHANNEL_PRESETS, id) ? CHANNEL_PRESETS[id] : undefined
}
