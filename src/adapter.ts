/**
 * adapter.ts — the harness-side `LlmAdapter` that fans one model out to many relays.
 *
 * ## The shape of the problem
 *
 * The harness asks an adapter for exactly two kinds of thing: "what models do you serve" and
 * "stream this request". Everything between — which relay is live, which key it uses, what it
 * calls the model, how it spells its thinking parameters — is this file's business, and none
 * of it is visible to the harness.
 *
 * ## Why a new pi-ai collection per call
 *
 * The pi-ai adapter makes the argument and it applies here unchanged: `streamSimple()` resolves
 * the provider lazily, after the credential await, so a collection mutated between requests
 * would let a call that started under one configuration finish under another. Building the
 * collection per call makes a settings change reach the next request and never the current one.
 * The cost is one small object graph per request, which is noise next to an HTTP call.
 *
 * ## Why the ledger is written here
 *
 * `usage` only exists at this boundary: the harness's token meter replays a session log to
 * estimate context pressure, which is a different question from "what did this relay report for
 * this request". The ledger write cannot fail the call — accounting is not allowed to be a
 * single point of failure for model traffic.
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context as PiContext,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
// The factory lives on the lazy subpath (the root entry does not re-export it); it defers the
// OpenAI SDK load to the first request, which is why the plugin boots quickly.
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

import { ADVERTISED_MODEL_ID, ADVERTISED_MODEL_NAME, CLIENT_USER_AGENT, OPENCODE_SESSION_FALLBACK, OPENCODE_SESSION_HEADER } from './presets.js'
import type { ResolvedChannel } from './channels.js'
import { selectChannel, type RouteFailure } from './route.js'
import type { LedgerEntry } from './usage-ledger.js'

/** The single provider route this plugin owns. */
export const PROVIDER_ID = 'any-deepseek'

/** Display name for the route in provider selectors. */
export const PROVIDER_NAME = 'Any DeepSeek'

/** What the adapter needs from the plugin, so it can be tested without a harness context. */
export interface AdapterDeps {
  /** Enabled, resolved channels in configuration order. */
  channels: () => readonly ResolvedChannel[]
  /** The configured channel id. */
  current: () => string | undefined
  /**
   * Resolve a credential REFERENCE name to its value; undefined when unconfigured.
   *
   * Only consulted for `credential.kind === 'reference'` (a legacy entry). A literal key is
   * carried by the channel itself and never travels through this seam.
   */
  resolveKey: (ref: string) => Promise<string | undefined>
  /** Record one finished request. Must never throw. */
  record: (entry: LedgerEntry) => Promise<void>
  /**
   * Read one image's request bytes from the durable attachment store.
   *
   * 🔴 Optional, and its absence is a real state (a composition without the attachment service).
   * An `ImageBlock` in the harness carries only an `attachmentId` — never bytes — so without this
   * seam an image cannot be sent at all. When it is missing, image content is replaced by a text
   * placeholder rather than silently dropped: the model should know an image existed even when it
   * cannot see it.
   * @param attachmentId - durable id from the message block.
   * @param mediaType - the block's declared media type.
   * @returns base64 bytes and the media type to put on the wire.
   */
  readImage?: (attachmentId: string, mediaType: string) => Promise<{ data: string; mediaType: string } | undefined>
  /** Clock, injectable so tests are deterministic. */
  now: () => Date
  /** Monotonic-ish millisecond clock for durations. */
  elapsed: () => number
}

/** One finished call, as the adapter observed it. */
interface CallOutcome {
  ok: boolean
  code?: string
  usage: TokenUsage | null
}

/**
 * Derive the value for the OpenCode session header.
 *
 * 🔴 This is THIS PLUGIN's job, not the harness's. `/zen/go` is one relay's private requirement;
 * the host cannot know about it and must not be expected to stamp anything for it. Whatever the
 * harness happens to put on a request is only an input to a decision made here.
 *
 * The id is a stable hash of the harness session id, so:
 *  · the same conversation keeps one affinity key (what the endpoint wants), and
 *  · the value is opaque rather than echoing an internal id to a third party.
 *
 * Two hard requirements, both learned from a 400:
 *  · **never absent** — the header is always sent, so a request can never go out without it;
 *  · **stable when there is no session** — falling back to a random value would give every
 *    request a different affinity key, which is worse than a constant.
 * @param sessionId - the harness session id, when it supplied one.
 * @returns a stable, non-empty session id.
 */
export function opencodeSessionId(sessionId: unknown): string {
  const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId).trim()
  if (raw === '') return OPENCODE_SESSION_FALLBACK
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * Build the pi-ai model entry for one channel.
 *
 * The advertised id (`deepseek-v4.1-flash`) never reaches the wire here: each channel's own
 * `model` does. That substitution is the entire reason this layer exists.
 * @param channel - the resolved channel.
 * @returns a pi-ai chat model describing that relay's view of the model.
 */
export function buildPiModel(channel: ResolvedChannel): Model<Api> {
  // 🔴 The thinking map is pi-ai's own translation layer, not ours.
  //
  // The harness sends `GenerateOptions.reasoningEffort` (a level name), pi-ai takes a
  // `ThinkingLevel`, and `model.thinkingLevelMap` turns that level into whatever the relay wants
  // on the wire (`reasoning_effort: "high"`, or `null` for "not supported"). Implementing our own
  // mapping would duplicate a translation the transport already performs, and the two would
  // drift the first time either side learned a new level.
  //
  // Only levels with a real wire value are passed: `null` means "explicitly unsupported", and
  // declaring a level unsupported is a stronger claim than simply not offering it.
  const thinkingLevelMap = channel.reasoningEfforts === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries(channel.reasoningEfforts).filter(([, value]) => value !== null),
    )
  const hasThinking = thinkingLevelMap !== undefined && Object.keys(thinkingLevelMap).length > 0

  return {
    id: channel.model,
    name: channel.label,
    api: channel.api as Api,
    provider: PROVIDER_ID,
    baseUrl: channel.baseURL,
    input: [...channel.input],
    // Costs are unknown here (no price table ships with this plugin) and zero is the honest
    // value: pi-ai uses `cost` only to annotate usage, never to route or size a request.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: channel.contextWindow,
    maxTokens: channel.maxTokens,
    reasoning: hasThinking,
    ...hasThinking ? { thinkingLevelMap: thinkingLevelMap as Record<string, string> } : {},
    ...channel.compat === undefined ? {} : { compat: channel.compat as Record<string, never> },
    ...channel.headers === undefined ? {} : { headers: { ...channel.headers } },
  }
}

/** One resolved image, keyed by attachment id. */
export type ImageBytes = Map<string, { data: string; mediaType: string }>

/**
 * Collect the bytes for every image in a request.
 *
 * 🔴 A separate pass, because the conversion itself is synchronous and the store is not. This is
 * also how the host's own pi-ai adapter does it, for the same reason.
 *
 * A block that cannot be read is left OUT of the map, and the converter then substitutes a text
 * placeholder. That is deliberate: dropping the block would tell the model nothing, while a
 * placeholder at least says an image was attached and names why it could not be shown. Skipping
 * it silently is the failure mode this whole change exists to remove — the user sent an image and
 * the model answered as though the message had been text only.
 * @param options - the harness request.
 * @param readImage - the attachment seam, when the composition has one.
 * @returns resolved images keyed by attachment id.
 */
export async function collectImages(
  options: GenerateOptions,
  readImage: AdapterDeps['readImage'],
): Promise<ImageBytes> {
  const images: ImageBytes = new Map()
  if (readImage === undefined) return images
  const pending: Array<{ id: string; mediaType: string }> = []
  for (const message of options.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const candidate = block as { type?: string; attachment?: { attachmentId?: string; mediaType?: string } }
      if (candidate.type !== 'image') continue
      const id = candidate.attachment?.attachmentId
      const mediaType = candidate.attachment?.mediaType
      if (typeof id !== 'string' || typeof mediaType !== 'string') continue
      if (images.has(id)) continue
      pending.push({ id, mediaType })
    }
  }
  const resolved = await Promise.all(pending.map(async (item) => {
    try {
      return [item.id, await readImage(item.id, item.mediaType)] as const
    } catch {
      // A failed read is a missing image, not a failed request: the placeholder path covers it.
      return [item.id, undefined] as const
    }
  }))
  for (const [id, value] of resolved) if (value !== undefined) images.set(id, value)
  return images
}

/**
 * Translate one harness request into a pi-ai context.
 *
 * @param options - the harness request.
 * @param images - image bytes collected by {@link collectImages}; omitted for a text-only request.
 * @returns a pi-ai context plus the one-shot system prompt, when the caller set one.
 */
export function toPiContext(options: GenerateOptions, images?: ImageBytes): PiContext {
  const messages = options.messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: message.content.map((block) => {
          if (block.type === 'text') return { type: 'text' as const, text: block.text }
          if (block.type === 'reasoning') return { type: 'thinking' as const, thinking: block.text }
          if (block.type === 'tool-call') {
            return {
              type: 'toolCall' as const,
              id: block.id,
              name: block.name,
              arguments: safeJson(block.arguments),
            }
          }
          // A tool-addition/removal block is a harness bookkeeping construct with no wire form
          // of its own; it is dropped rather than turned into text the model would misread.
          return undefined
        }).filter((block): block is NonNullable<typeof block> => block !== undefined),
        api: '' as Api,
        provider: PROVIDER_ID,
        model: options.model,
        usage: emptyUsage(),
        stopReason: 'stop' as const,
        timestamp: 0,
      }
    }
    if (message.role === 'tool') {
      // Harness tool results carry no tool name: the id references the call, which names it.
      return {
        role: 'toolResult' as const,
        toolCallId: message.toolCallId,
        toolName: 'tool',
        content: textBlocks(message.content),
        isError: message.isError ?? false,
        timestamp: 0,
      }
    }    return {
      role: 'user' as const,
      content: userContent(message.content, images),
      timestamp: 0,
    }
  })

  return {
    systemPrompt: options.system,
    messages,
    tools: options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  } as PiContext
}

/** pi-ai's zero usage value, for synthesizing message shells. */
function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Parse a tool-call argument string into an object; an unparseable one becomes empty. */
function safeJson(raw: string): Record<string, never> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, never>
  } catch {
    return {}
  }
}

/** A text or image block, in pi-ai's shape. */
type WireContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/**
 * Map one user message's blocks to pi-ai content.
 *
 * 🔴 An image block carries an `attachmentId`, never bytes — so it can only become an image when
 * {@link collectImages} resolved it. When it did not, the block becomes a TEXT PLACEHOLDER rather
 * than disappearing: the model should be told an image was attached and that it could not be
 * read. The previous version dropped such blocks entirely, which is how a user's screenshot
 * reached the plugin and the model answered as though the message had been text only.
 * @param content - harness content blocks.
 * @param images - resolved image bytes, when any were collected.
 * @returns pi-ai content blocks.
 */
function userContent(content: readonly unknown[], images?: ImageBytes): WireContent[] {
  const out: WireContent[] = []
  for (const block of content) {
    const typed = block as {
      type?: string
      text?: string
      attachment?: { attachmentId?: string; mediaType?: string; name?: string; offloaded?: true }
      offloaded?: true
    }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      out.push({ type: 'text', text: typed.text })
      continue
    }
    if (typed.type !== 'image') continue
    const id = typed.attachment?.attachmentId
    const resolved = typeof id === 'string' ? images?.get(id) : undefined
    if (resolved !== undefined) {
      out.push({ type: 'image', data: resolved.data, mimeType: resolved.mediaType })
      continue
    }
    // The harness already replaced this image with its own placeholder when it offloaded it; a
    // second one would only add noise.
    if (typed.offloaded === true || typed.attachment?.offloaded === true) continue
    const name = typed.attachment?.name === undefined ? '' : ` (${typed.attachment.name})`
    out.push({
      type: 'text',
      text: `[an image was attached${name}, but this route could not read its bytes]`,
    })
  }
  return out
}

/** Map harness content blocks to pi-ai text blocks (tool results carry no images once projected). */
function textBlocks(content: readonly unknown[]): Array<{ type: 'text'; text: string }> {
  const out: Array<{ type: 'text'; text: string }> = []
  for (const block of content) {
    const typed = block as { type?: string; text?: string }
    if (typed.type === 'text' && typeof typed.text === 'string') out.push({ type: 'text', text: typed.text })
  }
  return out
}

/** Map pi-ai usage onto the harness's disjoint counters. */
export function toTokenUsage(usage: AssistantMessage['usage']): TokenUsage {
  const total = usage.totalTokens ??
    (usage.input + usage.output + usage.cacheRead + usage.cacheWrite)
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: total,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning },
  }
}

/**
 * Map pi-ai events onto harness stream chunks.
 *
 * The two protocols agree on the important part (indexed blocks, deltas, one terminal event),
 * so this is a rename table plus the terminal handling. Failures arrive as an `error` event
 * rather than a throw — pi-ai never throws mid-stream — which is why the terminal event is the
 * only place a failure code can be produced.
 * @param events - the pi-ai event stream.
 * @param onOutcome - called once with the terminal outcome, before the finish chunk.
 * @returns harness chunks, ending with `finish`.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  onOutcome: (outcome: CallOutcome) => void,
): AsyncGenerator<StreamChunk> {
  let sawUsage = false
  /** pi-ai block index → harness block index. */
  const indexOf = new Map<number, number>()
  let nextIndex = 0
  const toolNames = new Map<number, string>()
  const toolIds = new Map<number, string>()

  for await (const event of events) {
    switch (event.type) {
      case 'text_start': {
        const index = reserve(event.contentIndex)
        yield { type: 'block-start', index, blockType: 'text' }
        break
      }
      case 'thinking_start': {
        const index = reserve(event.contentIndex)
        yield { type: 'block-start', index, blockType: 'reasoning' }
        break
      }
      case 'toolcall_start': {
        const index = reserve(event.contentIndex)
        // The id and name only become authoritative at `toolcall_end`; a placeholder here
        // keeps the harness's block-open/close pairing valid, and the close carries the truth.
        toolIds.set(event.contentIndex, `call-${event.contentIndex}`)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        break
      }
      case 'text_delta': {
        const index = indexOf.get(event.contentIndex)
        if (index !== undefined) yield { type: 'text-delta', index, text: event.delta }
        break
      }
      case 'thinking_delta': {
        const index = indexOf.get(event.contentIndex)
        if (index !== undefined) yield { type: 'reasoning-delta', index, text: event.delta }
        break
      }
      case 'toolcall_delta': {
        const index = indexOf.get(event.contentIndex)
        const id = toolIds.get(event.contentIndex)
        if (index !== undefined && id !== undefined) {
          const name = toolNames.get(event.contentIndex)
          yield {
            type: 'tool-call-delta',
            index,
            id: ToolCallId(id),
            ...name === undefined ? {} : { name },
            argumentsDelta: event.delta,
          }
        }
        break
      }
      case 'text_end': {
        const index = indexOf.get(event.contentIndex)
        if (index !== undefined) {
          yield { type: 'block-end', index, block: { type: 'text', text: event.content } }
        }
        break
      }
      case 'thinking_end': {
        const index = indexOf.get(event.contentIndex)
        if (index !== undefined) {
          yield { type: 'block-end', index, block: { type: 'reasoning', text: event.content } }
        }
        break
      }
      case 'toolcall_end': {
        const index = indexOf.get(event.contentIndex)
        if (index !== undefined) {
          const call = event.toolCall
          toolNames.set(event.contentIndex, call.name)
          toolIds.set(event.contentIndex, call.id)
          yield {
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: ToolCallId(call.id),
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          }
        }
        break
      }
      case 'done': {
        const usage = toTokenUsage(event.message.usage)
        sawUsage = true
        yield { type: 'usage', usage }
        onOutcome({ ok: true, usage })
        yield { type: 'finish', reason: finishReason(event.reason) }
        return
      }
      case 'error': {
        const message = event.error
        const code = classifyFailure(message)
        onOutcome({
          ok: false,
          code,
          usage: hasUsage(message.usage) ? toTokenUsage(message.usage) : null,
        })
        yield {
          type: 'finish',
          reason: {
            kind: event.reason === 'aborted' ? 'aborted' : 'error',
            failure: { message: message.errorMessage ?? code, code },
          },
        }
        return
      }
      case 'start':
        break
      default:
        // A newer pi-ai may add event types; unknown ones are ignored rather than fatal, so a
        // library upgrade cannot break streaming until someone classifies the addition.
        break
    }
  }

  // pi-ai guarantees a terminal event; reaching here means the stream closed early.
  const code = 'STREAM_CLOSED'
  onOutcome({ ok: false, code, usage: null })
  yield {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'the provider stream closed without a terminal event', code } },
  }

  /** Reserve the next harness block index for a pi-ai content index. */
  function reserve(contentIndex: number): number {
    const existing = indexOf.get(contentIndex)
    if (existing !== undefined) return existing
    const index = nextIndex++
    indexOf.set(contentIndex, index)
    return index
  }

  // `sawUsage` is only meaningful for the error path above; keeping the variable named makes
  // that contract visible to the next reader instead of an unexplained assignment.
  void sawUsage
}

/** Whether a pi-ai usage record carries any real counters. */
function hasUsage(usage: AssistantMessage['usage'] | undefined): usage is AssistantMessage['usage'] {
  if (usage === undefined) return false
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0
}

/** Map pi-ai's stop reason onto the harness vocabulary. */
function finishReason(reason: 'stop' | 'length' | 'toolUse' | 'deferred'): { kind: 'stop' | 'tool-calls' | 'max-tokens' } {
  switch (reason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'stop':
    case 'deferred':
      return { kind: 'stop' }
  }
}

/**
 * Assign a provider-neutral failure code.
 *
 * The harness routes retries on these codes, so the mapping matters more than the message. A
 * relay's own wording is preserved in the message; only the class is normalized here.
 * @param message - the terminal pi-ai message.
 * @returns a harness failure code.
 */
export function classifyFailure(message: AssistantMessage): string {
  const text = `${message.errorMessage ?? ''} ${message.rawStopReason ?? ''}`.toLowerCase()
  if (message.stopReason === 'aborted') return 'ABORTED'
  if (text.includes('context') && (text.includes('length') || text.includes('window') || text.includes('exceed'))) {
    return 'CONTEXT_WINDOW_EXCEEDED'
  }
  if (text.includes('rate') && text.includes('limit')) return 'RATE_LIMIT'
  if (text.includes('quota') || text.includes('balance') || text.includes('credit')) return 'QUOTA'
  if (text.includes('401') || text.includes('403') || text.includes('unauthor') || text.includes('invalid api key')) {
    return 'AUTH'
  }
  return 'SERVER'
}

/**
 * The adapter. One instance serves the single provider route.
 */
export class AnyDeepSeekAdapter extends LlmAdapter {
  constructor(private readonly deps: AdapterDeps) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * Advertise exactly one model — **unconditionally**.
   *
   * 🔴 **This used to require a resolvable key, and that was wrong.**
   *
   * The old rule was "a relay with no key gets no catalog entry; the picker then hides the whole
   * group, which is the harness's convention for a dormant provider." That reasoning leaks the
   * provider's *credentials* into its *identity*: the provider disappeared from the model picker
   * exactly when the user most needed to see it — during first-run setup, before any key exists.
   * Measured on a real host (owner report, 2026-10-19): with the only channel disabled, the
   * catalog came back `[]`, so `any-deepseek` was registered but *invisible*, which reads as
   * "the plugin did not install" no matter what the schema or the routes say.
   *
   * ⇒ The catalog answers "what does this provider serve", which is a property of the plugin.
   * Key presence is answered per request (`MISSING_CREDENTIAL`) and per row in the panel
   * (`keyConfigured`), where the user can actually act on it.
   */
  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    const selected = this.selected()
    const first = this.deps.channels()[0]
    const label = selected?.label ?? first?.label
    return [{
      provider: PROVIDER_ID,
      id: ADVERTISED_MODEL_ID,
      name: ADVERTISED_MODEL_NAME,
      // Naming the route is useful when one exists; with no channel configured the honest
      // description says so instead of inventing a relay.
      description: label === undefined ? 'no channel configured yet' : `via ${label}`,
    }]
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const channel = this.selected()
    // 🔴 `reasoning` must be OMITTED, never sent as `{ efforts: [] }`.
    //
    // The host treats an empty effort list as malformed, not as "no reasoning support":
    //   if (reasoning.efforts.length === 0) throw new LlmError(…, 'INVALID_MODEL_REASONING')
    // (`dsh-llm/lib/index.js:2144`). Measured path to that state: a channel whose
    // `reasoningEfforts` is a present-but-empty map — which is exactly what `z.dict()` yields
    // when the panel writes the field as `{}`, or what a preset override can leave behind.
    // The old guard only checked `=== undefined`, so `{}` slipped through and broke the model
    // picker with "非法的 reasoning metadata".
    //
    // ⇒ Emit `reasoning` only when there is at least one real effort.
    //
    // A level mapped to `null` means "explicitly unsupported on this relay", so it is filtered
    // out of the PICKER as well — offering a level the wire will refuse is the same class of
    // mistake as hiding one the wire accepts.
    const efforts = Object.entries(channel?.reasoningEfforts ?? {})
      .filter(([, wire]) => wire !== null)
      .map(([id]) => id)
    const reasoning = efforts.length === 0
      ? {}
      : { reasoning: { efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } }
    return {
      provider,
      id: model,
      name: ADVERTISED_MODEL_NAME,
      description: channel === undefined ? undefined : `via ${channel.label}`,
      context: { contextWindow: channel?.contextWindow ?? 1_000_000 },
      defaultMaxTokens: channel?.maxTokens,
      ...reasoning,
    }
  }

  /**
   * Bind the model metadata and the dispatch to one channel generation.
   *
   * The harness calls `prepareCall` before logging a request header and dispatches later; binding
   * here is what stops a panel change from landing in the middle of a recorded step.
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const startedAt = this.deps.elapsed()
    let channel: ResolvedChannel | undefined
    let outcome: CallOutcome = { ok: false, code: 'UNKNOWN', usage: null }
    let recorded = false

    const finish = async (): Promise<void> => {
      if (recorded || channel === undefined) return
      recorded = true
      await this.deps.record({
        at: this.deps.now().toISOString(),
        channel: channel.id,
        model: channel.model,
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        ...options.purpose === undefined ? {} : { purpose: options.purpose },
        ok: outcome.ok,
        ms: Math.max(0, Math.round(this.deps.elapsed() - startedAt)),
        usage: outcome.usage === null ? null : {
          input: outcome.usage.inputTokens,
          output: outcome.usage.outputTokens,
          cacheRead: outcome.usage.cacheReadTokens ?? 0,
          cacheWrite: outcome.usage.cacheWriteTokens ?? 0,
          reasoning: outcome.usage.reasoningTokens ?? 0,
          ...outcome.usage.totalTokens === undefined ? {} : { total: outcome.usage.totalTokens },
        },
        ...outcome.code === undefined ? {} : { code: outcome.code },
      })
    }

    // 1. Which channel serves this request.
    const selection = selectChannel(this.deps.channels(), this.deps.current())
    if (!selection.ok) {
      yield failureChunk(selection.failure)
      return
    }
    channel = selection.channel

    // 2. The key. A literal one is read from the channel entry; a legacy reference is resolved
    //    per request so a rotation reaches the next call.
    const key = channel.credential.kind === 'literal'
      ? channel.credential.value
      : channel.credential.kind === 'reference'
        ? await this.deps.resolveKey(channel.credential.ref)
        : undefined
    if (key === undefined || key === '') {
      outcome = { ok: false, code: 'MISSING_CREDENTIAL', usage: null }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `channel "${channel.id}" has no key configured`,
            code: 'MISSING_CREDENTIAL',
          },
        },
      }
      await finish()
      return
    }

    // 3–5. Build a fresh collection and dispatch.
    const model = buildPiModel(channel)
    const models = createModels()
    models.setProvider(createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseUrl: channel.baseURL,
      auth: { apiKey: { name: channel.label, resolve: async () => ({ auth: { apiKey: key } }) } },
      models: [model],
      api: openAICompletionsApi(),
    }))

    /**
     * Per-request headers.
     *
     * Two things OpenCode Go requires cannot live in a preset, because neither is a constant:
     *
     *  · `x-opencode-session` must be STABLE PER CONVERSATION, and it must ALWAYS be present.
     *    Both halves matter, and getting only the first produced a 400: an earlier version read
     *    `options.sessionId` and sent nothing when it was absent — and the harness does not stamp
     *    one on every request. So the value is a stable hash of the harness session id when we
     *    have one, and a constant when we do not. A hash keeps the id opaque while staying stable
     *    for the same conversation, which is all the endpoint's affinity key needs.
     *  · `User-Agent` must identify THIS client rather than the generic SDK. pi-ai sets its own,
     *    so the preset's static headers alone can never satisfy that rule.
     */
    const requestHeaders: Record<string, string> = {}
    // The `x-opencode-client` header is this plugin's marker for "this is an OpenCode endpoint".
    // Keying off it (rather than the channel id or the base URL) keeps the rule in one place: the
    // preset that declares the endpoint is the preset that declares its requirements.
    if (channel.headers !== undefined && Object.hasOwn(channel.headers, 'x-opencode-client')) {
      const session = opencodeSessionId(options.sessionId)
      requestHeaders[OPENCODE_SESSION_HEADER] = session
      requestHeaders['X-Session-ID'] = session
      requestHeaders['User-Agent'] = CLIENT_USER_AGENT
    }

    const streamOptions: SimpleStreamOptions = {
      apiKey: key,
      signal: options.signal,
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      // The harness's selected level goes one layer down into pi-ai's vocabulary. Passing it
      // through is the whole feature: without it `reasoning` was a boolean with no value, so
      // every request used the relay's own default and the picker's choice was discarded.
      ...options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort as SimpleStreamOptions['reasoning'] },
      ...Object.keys(requestHeaders).length === 0 ? {} : { headers: requestHeaders },
    }

    try {
      // 🔴 Images are collected BEFORE the conversion, because the conversion is synchronous and
      // the attachment store is not. Skipping this step is what made "the model can see images"
      // false while the panel said the model was multimodal.
      const images = await collectImages(options, this.deps.readImage)
      const events = models.streamSimple(model, toPiContext(options, images), streamOptions)
      for await (const chunk of toStreamChunks(events, (observed) => { outcome = observed })) {
        yield chunk
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = { ok: false, code: 'TRANSPORT', usage: null }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message, code: 'TRANSPORT' } },
      }
    } finally {
      await finish()
    }
  }

  /** The channel the panel has selected, if any (used for model metadata). */
  private selected(): ResolvedChannel | undefined {
    const selection = selectChannel(this.deps.channels(), this.deps.current())
    return selection.ok ? selection.channel : undefined
  }
}

/** Turn a routing failure into a terminal chunk. */
function failureChunk(failure: RouteFailure): StreamChunk {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message: failure.detail, code: failure.code } },
  }
}

/** Re-export the credential helper so callers build references the same way the adapter does. */
export { credentialRef }
