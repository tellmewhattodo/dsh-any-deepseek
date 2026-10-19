import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import {
  AnyDeepSeekAdapter,
  PROVIDER_ID,
  buildPiModel,
  classifyFailure,
  toStreamChunks,
  toTokenUsage,
  type AdapterDeps,
} from '../src/adapter.js'
import { ADVERTISED_MODEL_ID } from '../src/presets.js'
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
    apiKeyEnv: 'GO_KEY',
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

  it('marks a model with reasoning levels as reasoning-capable and one without as not', () => {
    expect(buildPiModel(channel({ reasoningEfforts: { low: 'low' } })).reasoning).toBe(true)
    expect(buildPiModel(channel({ reasoningEfforts: {} })).reasoning).toBe(false)
    expect(buildPiModel(channel()).reasoning).toBe(false)
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
