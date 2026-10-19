import { describe, expect, it } from 'vitest'
import {
  enabledChannels,
  resolveChannel,
  resolveChannels,
  type ResolvedChannel,
} from '../src/channels.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../src/presets.js'

/** Narrow a resolve result in a test, failing loudly when it is the wrong arm. */
function mustResolve(id: string, raw: unknown): ResolvedChannel {
  const result = resolveChannel(id, raw)
  if (!result.ok) throw new Error(`expected ${id} to resolve, got ${result.problem.code}: ${result.problem.detail}`)
  return result.channel
}

describe('resolveChannel — preset-backed entries', () => {
  it('needs only a preset id and a credential reference', () => {
    const channel = mustResolve('go', { preset: 'opencode-go', apiKeyEnv: 'GO_KEY' })
    expect(channel.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(channel.model).toBe('deepseek-v4.1-flash')
    expect(channel.apiKeyEnv).toBe('GO_KEY')
    expect(channel.label).toBe('OpenCode Go')
    expect(channel.warnings).toEqual([])
  })

  it('lets an entry override a preset field without losing the rest', () => {
    const channel = mustResolve('go', {
      preset: 'opencode-go',
      apiKeyEnv: 'GO_KEY',
      maxTokens: 65536,
      label: 'My Go',
    })
    expect(channel.maxTokens).toBe(65536)
    expect(channel.label).toBe('My Go')
    expect(channel.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(channel.compat).toBeDefined()
  })
})

describe('resolveChannel — custom entries', () => {
  it('resolves a fully declared channel', () => {
    const channel = mustResolve('mine', {
      apiKeyEnv: 'MY_KEY',
      api: 'openai-completions',
      baseURL: 'https://relay.example/v1',
      model: 'deepseek-v4.1-flash',
      contextWindow: 128000,
      maxTokens: 8192,
      input: ['text', 'image'],
    })
    expect(channel.contextWindow).toBe(128000)
    expect(channel.maxTokens).toBe(8192)
    expect(channel.input).toEqual(['text', 'image'])
  })

  it('applies documented capacity defaults and says so', () => {
    const channel = mustResolve('mine', {
      apiKeyEnv: 'MY_KEY',
      api: 'openai-completions',
      baseURL: 'https://relay.example/v1',
      model: 'm',
    })
    expect(channel.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(channel.maxTokens).toBe(DEFAULT_MAX_TOKENS)
    expect(channel.warnings).toHaveLength(2)
    expect(channel.warnings[0]).toContain('contextWindow')
  })

  it('defaults to text-only rather than claiming image support', () => {
    const channel = mustResolve('mine', {
      apiKeyEnv: 'K',
      api: 'openai-completions',
      baseURL: 'https://x.example/v1',
      model: 'm',
    })
    expect(channel.input).toEqual(['text'])
  })

  it('names every missing endpoint field at once', () => {
    const result = resolveChannel('mine', { apiKeyEnv: 'K' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('MISSING_FIELD')
    // `api` is NOT in this list: it defaults to openai-completions, which is what the schema
    // text and the design decision both promise. Only the facts that cannot be guessed are named.
    expect(result.problem.detail).toContain('baseURL')
    expect(result.problem.detail).toContain('model')
    expect(result.problem.detail).not.toContain('api,')
  })

  it('defaults the wire protocol to openai-completions when a custom channel omits it', () => {
    // A relay that speaks only Responses can still say so explicitly; making `api` mandatory
    // meant the documented "just give a model and a baseURL" path was rejected outright.
    const result = resolveChannel('mine', { apiKeyEnv: 'K', baseURL: 'https://x.example/v1', model: 'm' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.api).toBe('openai-completions')
  })
})

describe('resolveChannel — rejections', () => {
  it('requires a credential reference even on a preset channel', () => {
    const result = resolveChannel('go', { preset: 'opencode-go' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('MISSING_API_KEY_REF')
  })

  it('reports an unknown preset instead of silently treating it as custom', () => {
    const result = resolveChannel('x', { preset: 'nope', apiKeyEnv: 'K' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('UNKNOWN_PRESET')
    expect(result.problem.detail).toContain('nope')
  })

  it('rejects an unsupported protocol', () => {
    const result = resolveChannel('x', {
      apiKeyEnv: 'K',
      api: 'grpc',
      baseURL: 'https://x.example',
      model: 'm',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INVALID_API')
  })

  it('rejects unknown fields so a typo cannot be silently ignored', () => {
    const result = resolveChannel('x', { preset: 'ollama', apiKeyEnv: 'K', baseUrl: 'https://typo' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('UNKNOWN_KEY')
    expect(result.problem.detail).toContain('baseUrl')
  })

  it('rejects a non-object entry', () => {
    const result = resolveChannel('x', 'just a string')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('MISSING_FIELD')
  })

  it('treats blank strings as absent', () => {
    const result = resolveChannel('go', { preset: '  ', apiKeyEnv: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('MISSING_API_KEY_REF')
  })
})

describe('resolveChannels', () => {
  it('keeps the good channels when one is broken', () => {
    const { channels, problems } = resolveChannels({
      a: { preset: 'ollama', apiKeyEnv: 'A_KEY' },
      b: { preset: 'ghost', apiKeyEnv: 'B_KEY' },
      c: { preset: 'commandcode', apiKeyEnv: 'C_KEY' },
    })
    expect([...channels.keys()]).toEqual(['a', 'c'])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.id).toBe('b')
  })

  it('returns an empty result for a non-object map', () => {
    expect(resolveChannels(undefined).channels.size).toBe(0)
    expect(resolveChannels([]).problems).toHaveLength(0)
  })
})

describe('enabledChannels', () => {
  it('drops channels the user switched off and keeps the rest in order', () => {
    const entries = {
      a: { preset: 'ollama', apiKeyEnv: 'A' },
      b: { preset: 'ollama', apiKeyEnv: 'B', enabled: false },
      c: { preset: 'ollama', apiKeyEnv: 'C' },
    }
    const resolution = resolveChannels(entries)
    expect(enabledChannels(resolution, entries).map((channel) => channel.id)).toEqual(['a', 'c'])
  })

  it('keeps a channel whose enabled flag is merely absent', () => {
    const entries = { a: { preset: 'ollama', apiKeyEnv: 'A' } }
    expect(enabledChannels(resolveChannels(entries), entries)).toHaveLength(1)
  })
})
