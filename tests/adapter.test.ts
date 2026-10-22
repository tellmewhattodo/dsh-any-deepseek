import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import {
  AnyDeepSeekAdapter,
  PROVIDER_ID,
  buildPiModel,
  classifyFailure,
  collectImages,
  opencodeSessionId,
  toPiContext,
  toStreamChunks,
  toTokenUsage,
  type AdapterDeps,
} from '../src/adapter.js'
import { ADVERTISED_MODEL_ID, OPENCODE_SESSION_FALLBACK } from '../src/presets.js'
import type { ResolvedChannel } from '../src/channels.js'
import type { LedgerEntry } from '../src/usage-ledger.js'

/** A resolved channel with the fields the adapter reads. */
function channel(overrides: Partial<ResolvedChannel> = {}): ResolvedChannel {
  return {
    id: 'go',
    label: 'OpenCode Go',
    api: 'openai-completions',
    baseURL: 'https://relay.example/v1',
    model: 'deepseek-v4.1-flash',
    credential: { kind: 'literal', value: 'sk-secret-value' },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text'],
    warnings: [],
    ...overrides,
  }
}

/** A minimal pi-ai assistant message shell for terminal events. */
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'any-deepseek',
    model: 'deepseek-v4.1-flash',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

/** Drive the chunk generator over a fixed event list and collect the result. */
async function drive(events: AssistantMessageEvent[]): Promise<{
  chunks: Awaited<ReturnType<typeof collect>>
  outcome: unknown
}> {
  let outcome: unknown
  const chunks = await collect(toStreamChunks(
    (async function* () { for (const event of events) yield event })(),
    (observed) => { outcome = observed },
  ))
  return { chunks, outcome }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('buildPiModel', () => {
  // The reason this whole plugin exists: one advertised model, many upstream spellings.
  it('sends the channel\'s own model id, not the advertised one', () => {
    const model = buildPiModel(channel({ model: 'deepseek/deepseek-v4.1-flash' }))
    expect(model.id).toBe('deepseek/deepseek-v4.1-flash')
  })
  it('carries the endpoint and capacities so no catalog lookup is needed', () => {
    const model = buildPiModel(channel())
    expect(model.baseUrl).toBe('https://relay.example/v1')
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.maxTokens).toBe(384_000)
  })

  it('🔴 is reasoning-capable even when the channel declares NO levels', () => {
    // 🔴 The old rule was "no declared levels ⇒ not a reasoning model", and it did not describe
    // the model — it described one channel's configuration. The consequence was measurable on a
    // real host: with no channel (first-run setup) the composer's thinking-strength control was
    // simply absent, because pi-ai drops `reasoningEffort` entirely for a model whose
    // `reasoning` is false (`openai-completions.js:623-725` gates every thinking branch on it).
    // Capability is the MODEL's, so a silent channel inherits the model's table.
    expect(buildPiModel(channel()).reasoning).toBe(true)
    // An empty map is silence (what `z.dict()` writes), not a negative declaration.
    expect(buildPiModel(channel({ reasoningEfforts: {} })).reasoning).toBe(true)
    // A channel that really does declare levels keeps exactly its own set.
    expect(buildPiModel(channel({ reasoningEfforts: { low: 'low' } })).reasoning).toBe(true)
    // …and one that declares nothing usable is the only case that turns the feature off.
    expect(buildPiModel(channel({ reasoningEfforts: { off: null } })).reasoning).toBe(false)
  })

  it('copies headers rather than sharing the array reference', () => {
    const headers = { 'x-test': '1' }
    const model = buildPiModel(channel({ headers }))
    expect(model.headers).toEqual(headers)
    expect(model.headers).not.toBe(headers)
  })
})

describe('toTokenUsage', () => {
  // Disjoint counters: the harness bills input + cacheRead + cacheWrite, so a mapping that
  // folded caches into input would double-count downstream.
  it('keeps the cache counters separate from input', () => {
    const usage = toTokenUsage({
      input: 100,
      output: 50,
      cacheRead: 400,
      cacheWrite: 25,
      reasoning: 7,
      totalTokens: 575,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
    expect(usage.inputTokens).toBe(100)
    expect(usage.cacheReadTokens).toBe(400)
    expect(usage.cacheWriteTokens).toBe(25)
    expect(usage.reasoningTokens).toBe(7)
    expect(usage.totalTokens).toBe(575)
  })

  it('omits reasoning when the provider did not report it', () => {
    const usage = toTokenUsage({
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
    expect('reasoningTokens' in usage).toBe(false)
  })
})

describe('toStreamChunks', () => {
  it('translates a text stream and reports usage', async () => {
    const { chunks, outcome } = await drive([
      { type: 'start', partial: message() },
      { type: 'text_start', contentIndex: 0, partial: message() },
      { type: 'text_delta', contentIndex: 0, delta: 'he', partial: message() },
      { type: 'text_delta', contentIndex: 0, delta: 'llo', partial: message() },
      { type: 'text_end', contentIndex: 0, content: 'hello', partial: message() },
      {
        type: 'done',
        reason: 'stop',
        message: message({ usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      },
    ])
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(outcome).toMatchObject({ ok: true, usage: { inputTokens: 10, outputTokens: 2 } })
  })

  it('maps thinking blocks to reasoning blocks', async () => {
    const { chunks } = await drive([
      { type: 'thinking_start', contentIndex: 0, partial: message() },
      { type: 'thinking_delta', contentIndex: 0, delta: 'hm', partial: message() },
      { type: 'thinking_end', contentIndex: 0, content: 'hm', partial: message() },
      { type: 'done', reason: 'stop', message: message() },
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'hm' })
    expect(chunks[2]).toMatchObject({ type: 'block-end', block: { type: 'reasoning', text: 'hm' } })
  })

  it('gives tool calls a real id and JSON arguments at block end', async () => {
    const { chunks } = await drive([
      { type: 'toolcall_start', contentIndex: 0, partial: message() },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"a":', partial: message() },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call_1', name: 'read', arguments: { a: 1 } },
        partial: message(),
      },
      { type: 'done', reason: 'toolUse', message: message() },
    ])
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    expect(end).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"a":1}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps a length stop to max-tokens', async () => {
    const { chunks } = await drive([{ type: 'done', reason: 'length', message: message() }])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('turns an error event into a terminal failure with a normalized code', async () => {
    const { chunks, outcome } = await drive([
      {
        type: 'error',
        reason: 'error',
        error: message({ stopReason: 'error', errorMessage: 'rate limit exceeded' }),
      },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } })
    expect(outcome).toMatchObject({ ok: false, code: 'RATE_LIMIT', usage: null })
  })

  it('marks an aborted stream as aborted rather than error', async () => {
    const { chunks } = await drive([
      { type: 'error', reason: 'aborted', error: message({ stopReason: 'aborted', errorMessage: 'stopped' }) },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  // A stream that closes without a terminal event is a protocol violation; the harness must see
  // a failure rather than a silently truncated reply.
  it('fails loudly when the source ends without a terminal event', async () => {
    const { chunks, outcome } = await drive([
      { type: 'text_start', contentIndex: 0, partial: message() },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED' } } })
    expect(outcome).toMatchObject({ ok: false, code: 'STREAM_CLOSED' })
  })
})

describe('listModels — the provider catalog', () => {
  const adapterWith = (overrides: Partial<AdapterDeps> = {}): AnyDeepSeekAdapter => new AnyDeepSeekAdapter({
    channels: () => [channel()],
    current: () => 'go',
    resolveKey: async () => 'sk-test',
    record: async () => undefined,
    now: () => new Date(0),
    elapsed: () => 0,
    ...overrides,
  })

  it('advertises exactly one model under the any-deepseek provider', async () => {
    const models = await adapterWith().listModels(PROVIDER_ID)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ provider: PROVIDER_ID, id: ADVERTISED_MODEL_ID })
  })

  it('🔴 keeps the model visible when the channel has NO key', async () => {
    // This is the regression that made the provider look "not installed": the catalog came back
    // empty whenever no key resolved, so the model picker showed nothing even though the adapter
    // was registered. Credentials must not decide identity.
    const models = await adapterWith({ resolveKey: async () => undefined }).listModels(PROVIDER_ID)
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe(ADVERTISED_MODEL_ID)
  })

  it('🔴 keeps the model visible when NO channel is configured at all', async () => {
    const models = await adapterWith({ channels: () => [], current: () => undefined }).listModels(PROVIDER_ID)
    expect(models).toHaveLength(1)
    // No channel ⇒ say so rather than inventing a relay name.
    expect(models[0]?.description).toContain('no channel')
  })

  it('names the selected channel when there is one', async () => {
    const models = await adapterWith().listModels(PROVIDER_ID)
    expect(models[0]?.description).toContain('OpenCode Go')
  })
})

describe('resolveModel — reasoning metadata', () => {
  const adapterWith = (channels: ResolvedChannel[], current = 'go'): AnyDeepSeekAdapter => new AnyDeepSeekAdapter({
    channels: () => channels,
    current: () => current,
    resolveKey: async () => 'sk-test',
    record: async () => undefined,
    now: () => new Date(0),
    elapsed: () => 0,
  })

  it('reports the declared efforts in configuration order', async () => {
    const info = await adapterWith([channel({ reasoningEfforts: { low: 'low', high: 'high' } })])
      .resolveModel(PROVIDER_ID, ADVERTISED_MODEL_ID)
    expect(info.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['low', 'high'])
  })

  it('🔴 advertises the model\'s levels when the channel declares none', async () => {
    // Owner's report, verbatim: "右下角思考强度还是不能改". The levels were always the model's; only
    // a channel's silence made them disappear — most visibly during first-run setup, which is
    // exactly when the user goes looking for the control.
    const info = await adapterWith([channel()]).resolveModel(PROVIDER_ID, ADVERTISED_MODEL_ID)
    expect(info.reasoning?.efforts.map((effort) => String(effort.id)).sort())
      .toEqual(['high', 'low', 'max', 'medium'])
  })

  it('🔴 advertises the model\'s levels when the declared map is present but EMPTY', async () => {
    // An empty `z.dict()` value is silence, not a claim that the model cannot think.
    const info = await adapterWith([channel({ reasoningEfforts: {} })]).resolveModel(PROVIDER_ID, ADVERTISED_MODEL_ID)
    expect(info.reasoning?.efforts.length).toBe(4)
  })

  it('🔴 advertises the model\'s levels when NO channel is selected', async () => {
    // The catalog must not depend on runtime configuration (decision 26, same direction).
    const info = await adapterWith([], undefined).resolveModel(PROVIDER_ID, ADVERTISED_MODEL_ID)
    expect(info.reasoning?.efforts.length).toBe(4)
  })

  it('🔴 never sends `efforts: []` — the host treats that as malformed', async () => {
    // The one reachable empty state after the fallback exists: a channel that declares levels and
    // maps every one of them to null ("this relay supports none of them"). The host throws
    // `INVALID_MODEL_REASONING` for `efforts.length === 0` (`dsh-llm/lib/index.js:2144`), and the
    // whole model picker fails to load with "非法的 reasoning metadata".
    const info = await adapterWith([channel({ reasoningEfforts: { off: null, low: null } })])
      .resolveModel(PROVIDER_ID, ADVERTISED_MODEL_ID)
    expect(info.reasoning).toBeUndefined()
  })
})

describe('resolveModel — input modalities', () => {
  const adapterWith = (channels: ResolvedChannel[], current: string | undefined = 'go'): AnyDeepSeekAdapter => new AnyDeepSeekAdapter({
    channels: () => channels,
    current: () => current,
    resolveKey: async () => 'sk-test',
    record: async () => undefined,
    now: () => new Date(0),
    elapsed: () => 0,
  })

  it('🔴 declares image input, with and without a channel', async () => {
    // 🔴 The host only keeps an image in a request when this says the model accepts one:
    // `if (modelInfo.inputModalities !== undefined && !…includes('image') && …) {
    //    projectedMessages = projectImagesForTextModel(…) }` (`dsh-llm/lib/index.js:2337`).
    // Absent means UNKNOWN, and the old code never sent it — so a user's screenshot was replaced
    // by a text placeholder before this plugin was ever called.
    for (const adapter of [adapterWith([channel()]), adapterWith([], undefined)]) {
      const info = await adapter.resolveModel(PROVIDER_ID, ADVERTISED_MODEL_ID)
      expect([...(info.inputModalities ?? [])]).toEqual(['text', 'image'])
    }
  })

  it('is declared by the catalog too — the picker and dispatch must agree', async () => {
    const models = await adapterWith([channel()]).listModels(PROVIDER_ID)
    expect([...(models[0]?.inputModalities ?? [])]).toEqual(['text', 'image'])
  })
})

describe('classifyFailure', () => {
  it('recognizes the failure classes the harness routes on', () => {
    expect(classifyFailure(message({ stopReason: 'aborted' }))).toBe('ABORTED')
    expect(classifyFailure(message({ errorMessage: 'This model\'s maximum context length is 200000' })))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(classifyFailure(message({ errorMessage: 'rate limit reached for requests' }))).toBe('RATE_LIMIT')
    expect(classifyFailure(message({ errorMessage: 'insufficient balance' }))).toBe('QUOTA')
    expect(classifyFailure(message({ errorMessage: '401 Unauthorized' }))).toBe('AUTH')
  })

  it('falls back to SERVER for an unrecognized message', () => {
    expect(classifyFailure(message({ errorMessage: 'something odd happened' }))).toBe('SERVER')
    expect(classifyFailure(message())).toBe('SERVER')
  })
})

describe('AdapterDeps contract', () => {
  // The ledger writer must never be able to fail a model call; this pins the shape the adapter
  // relies on so a future refactor cannot make `record` throwable-by-type.
  it('types `record` as returning a promise that the adapter awaits but does not inspect', () => {
    const deps: AdapterDeps = {
      channels: () => [channel()],
      current: () => 'go',
      resolveKey: async () => 'sk-test',
      record: async (entry: LedgerEntry) => { void entry },
      now: () => new Date(),
      elapsed: () => 0,
    }
    expect(typeof deps.record).toBe('function')
  })
})

describe('image input', () => {
  // 🔴 The defect these pin: `input` declared text-only AND the converter dropped image blocks
  // outright, so a user's screenshot reached the plugin and the model answered as though the
  // message had been text only. Two independent halves must hold — the declaration, and a
  // delivery path that turns an attachment id into bytes.

  /** A harness user message carrying one image block. */
  function imageRequest(): unknown {
    return {
      provider: PROVIDER_ID,
      model: ADVERTISED_MODEL_ID,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 4, height: 4, name: 'shot.png' },
          },
        ],
      }],
    }
  }

  it('🔴 maps a resolved image to pi-ai image content (base64 + mime)', () => {
    const images = new Map([['att-1', { data: 'QUJD', mediaType: 'image/png' }]])
    const context = toPiContext(imageRequest() as never, images)
    const user = context.messages[0] as unknown as { content: Array<Record<string, unknown>> }
    expect(user.content).toContainEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' })
    expect(user.content).toContainEqual({ type: 'text', text: 'look at this' })
  })

  it('🔴 substitutes a VISIBLE placeholder when the bytes could not be read', () => {
    // Not silence: the model must be able to say "I was sent an image I could not read" instead
    // of answering a question about something it never knew existed.
    const context = toPiContext(imageRequest() as never, new Map())
    const user = context.messages[0] as unknown as { content: Array<Record<string, unknown>> }
    expect(user.content.some((block) => block.type === 'image')).toBe(false)
    const text = user.content.map((block) => String(block.text ?? '')).join(' ')
    expect(text).toContain('could not read its bytes')
  })

  it('collects bytes for every image through the attachment seam', async () => {
    const readImage = vi.fn(async () => ({ data: 'QUJD', mediaType: 'image/png' }))
    const images = await collectImages(imageRequest() as never, readImage)
    // 🔴 The WHOLE reference is handed over, not `(id, mediaType)`. The store's
    // `readImageRequest` takes an `ImageAttachmentRef`, and a reduced one is not a valid input —
    // its rejection reads downstream as "this image could not be read", i.e. a model that cannot
    // see images. That was the first version of this code and it took a real screenshot to find.
    expect(readImage).toHaveBeenCalledWith({
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: 10,
      width: 4,
      height: 4,
      name: 'shot.png',
    })
    expect(images.get('att-1')).toEqual({ data: 'QUJD', mediaType: 'image/png' })
  })

  it('🔴 a failed image read does not fail the request', async () => {
    // A broken store must degrade the message to text, never turn a conversation into an error.
    const readImage = vi.fn(async () => { throw new Error('store offline') })
    const images = await collectImages(imageRequest() as never, readImage)
    expect(images.size).toBe(0)
  })

  it('does nothing when the composition has no attachment service', async () => {
    const images = await collectImages(imageRequest() as never, undefined)
    expect(images.size).toBe(0)
  })
})

describe('opencode session header', () => {
  it('🔴 derives a stable, non-empty id from the harness session', () => {
    // 🔴 This plugin's job, not the harness's: `/zen/go` is one relay's private requirement, so
    // nothing upstream will ever stamp it for us.
    const a = opencodeSessionId('session-abc')
    expect(opencodeSessionId('session-abc')).toBe(a)
    expect(a).not.toBe('')
    // Opaque rather than echoing the harness's own id to a third party.
    expect(a).not.toBe('session-abc')
    // Different conversations get different keys, which is what the header is FOR.
    expect(opencodeSessionId('session-xyz')).not.toBe(a)
  })

  it('🔴 ALWAYS returns a value — a missing session must not mean a missing header', () => {
    // Measured failure: reading `options.sessionId` and sending nothing when absent produced 400
    // `MissingSessionID` — the exact error the header exists to prevent. A constant is a worse
    // affinity key than a real per-session id and far better than none.
    expect(opencodeSessionId(undefined)).toBe(OPENCODE_SESSION_FALLBACK)
    expect(opencodeSessionId('')).toBe(OPENCODE_SESSION_FALLBACK)
    expect(opencodeSessionId('   ')).toBe(OPENCODE_SESSION_FALLBACK)
  })
})

describe('thinking level passthrough', () => {
  it('🔴 the model carries a thinking map, minus levels the relay does not support', () => {
    // The map is what gives a selected level a wire spelling; without it a level is a name with
    // nothing to send.
    const model = buildPiModel(channel({ reasoningEfforts: { low: 'low', high: 'high' } }))
    expect(model.thinkingLevelMap).toEqual({ low: 'low', high: 'high' })

    // A level mapped to null means "explicitly unsupported" and must NOT be advertised.
    const filtered = buildPiModel(channel({ reasoningEfforts: { low: 'low', off: null } }))
    expect(filtered.thinkingLevelMap).toEqual({ low: 'low' })
  })
})
