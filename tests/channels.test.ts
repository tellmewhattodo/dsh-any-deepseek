import { describe, expect, it } from 'vitest'
import {
  allChannels,
  isCredentialRefName,
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
  it('needs only a preset id and a key', () => {
    const channel = mustResolve('go', { preset: 'opencode-go', apiKey: 'sk-live-value' })
    expect(channel.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(channel.model).toBe('deepseek-v4.1-flash')
    expect(channel.credential).toEqual({ kind: 'literal', value: 'sk-live-value' })
    expect(channel.label).toBe('OpenCode Go')
    expect(channel.warnings).toEqual([])
  })

  it('lets an entry override a preset field without losing the rest', () => {
    const channel = mustResolve('go', {
      preset: 'opencode-go',
      apiKey: 'sk-live-value',
      maxTokens: 65536,
      label: 'My Go',
    })
    expect(channel.maxTokens).toBe(65536)
    expect(channel.label).toBe('My Go')
    expect(channel.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(channel.compat).toBeDefined()
  })
})

describe('resolveChannel — the credential shape', () => {
  it('prefers `apiKey` when both fields are present', () => {
    // The two fields can coexist in a migrated document. `apiKey` is the one the panel writes,
    // so it is the one that wins — a stale reference must never shadow a key the user just set.
    const channel = mustResolve('go', { preset: 'ollama', apiKey: 'sk-new', apiKeyEnv: 'OLD_REF' })
    expect(channel.credential).toEqual({ kind: 'literal', value: 'sk-new' })
  })

  it('reads a grammar-valid `apiKeyEnv` as a reference', () => {
    const channel = mustResolve('go', { preset: 'ollama', apiKeyEnv: 'MY_REF_NAME' })
    expect(channel.credential).toEqual({ kind: 'reference', ref: 'MY_REF_NAME' })
  })

  it('🔴 adopts a grammar-INVALID `apiKeyEnv` as the key itself', () => {
    // The observed legacy state: an older panel asked for a "credential reference name" and a
    // user put the key there. A string that cannot match `/^[A-Za-z_][A-Za-z0-9_]*$/` cannot be
    // an environment-variable name, so reading it as a value is not a guess — it is the only
    // reading that can be true. This is what makes the migration need no script.
    const channel = mustResolve('go', { preset: 'open-design', apiKeyEnv: 'sk-amr-eb12-3456' })
    expect(channel.credential).toEqual({ kind: 'literal', value: 'sk-amr-eb12-3456' })
  })

  it('🔴 resolves a channel that has NO key at all', () => {
    // A missing key must not remove the channel from the panel: the row is how the user finds out
    // and fixes it, and the model directory must not depend on a secret (decision 26). The gap is
    // reported per request (`MISSING_CREDENTIAL`) and per row (`keyConfigured`).
    const channel = mustResolve('go', { preset: 'opencode-go' })
    expect(channel.credential).toEqual({ kind: 'none' })
    expect(channel.baseURL).toBe('https://opencode.ai/zen/go/v1')
  })

  it('treats a blank key as absent rather than as a credential', () => {
    const channel = mustResolve('go', { preset: 'ollama', apiKey: '   ' })
    expect(channel.credential).toEqual({ kind: 'none' })
  })
})

describe('isCredentialRefName', () => {
  it('accepts environment-variable spelling and rejects everything else', () => {
    expect(isCredentialRefName('MY_REF')).toBe(true)
    expect(isCredentialRefName('_x9')).toBe(true)
    // A key value: has a dash, so it cannot be a name.
    expect(isCredentialRefName('sk-amr-eb12')).toBe(false)
    // Leading digit, dots, spaces — all outside the grammar.
    expect(isCredentialRefName('9LIVES')).toBe(false)
    expect(isCredentialRefName('A.B')).toBe(false)
    expect(isCredentialRefName('')).toBe(false)
  })
})

describe('resolveChannel — custom entries', () => {
  it('resolves a fully declared channel', () => {
    const channel = mustResolve('mine', {
      apiKey: 'sk-value',
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
      api: 'openai-completions',
      baseURL: 'https://x.example/v1',
      model: 'm',
    })
    expect(channel.input).toEqual(['text'])
  })

  it('names every missing endpoint field at once', () => {
    const result = resolveChannel('mine', {})
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
    const result = resolveChannel('mine', { baseURL: 'https://x.example/v1', model: 'm' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.api).toBe('openai-completions')
  })
})

describe('resolveChannel — rejections', () => {
  it('reports an unknown preset instead of silently treating it as custom', () => {
    const result = resolveChannel('x', { preset: 'nope', apiKey: 'sk-v' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('UNKNOWN_PRESET')
    expect(result.problem.detail).toContain('nope')
  })

  it('rejects an unsupported protocol', () => {
    const result = resolveChannel('x', {
      api: 'grpc',
      baseURL: 'https://x.example',
      model: 'm',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('INVALID_API')
  })

  it('rejects unknown fields so a typo cannot be silently ignored', () => {
    const result = resolveChannel('x', { preset: 'ollama', apiKey: 'K', baseUrl: 'https://typo' })
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

  it('treats a blank preset as absent, so the entry is judged as a custom channel', () => {
    const result = resolveChannel('go', { preset: '  ', apiKey: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Not a credential complaint: an empty preset simply means "no preset", and the endpoint
    // facts a custom channel must supply are what is missing.
    expect(result.problem.code).toBe('MISSING_FIELD')
    expect(result.problem.detail).toContain('baseURL')
  })
})

describe('resolveChannels', () => {
  it('keeps the good channels when one is broken', () => {
    const { channels, problems } = resolveChannels({
      a: { preset: 'ollama', apiKey: 'A' },
      b: { preset: 'ghost', apiKey: 'B' },
      c: { preset: 'commandcode', apiKey: 'C' },
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

describe('allChannels', () => {
  it('returns every resolved channel in configuration order', () => {
    const entries = {
      a: { preset: 'ollama', apiKey: 'A' },
      b: { preset: 'ollama', apiKey: 'B' },
      c: { preset: 'ollama', apiKey: 'C' },
    }
    expect(allChannels(resolveChannels(entries)).map((channel) => channel.id)).toEqual(['a', 'b', 'c'])
  })

  it('🔴 does NOT hide a channel carrying a legacy `enabled: false`', () => {
    // `enabled` was retired as a second on/off axis: `current` is the only thing that decides
    // which relay serves requests. A config that still carries the old flag must keep working —
    // and the channel must stay VISIBLE, because a hidden channel cannot be selected again.
    const entries = {
      a: { preset: 'ollama', apiKey: 'A' },
      b: { preset: 'ollama', apiKey: 'B', enabled: false },
    }
    expect(allChannels(resolveChannels(entries)).map((channel) => channel.id)).toEqual(['a', 'b'])
  })

  it('omits channels that failed to resolve (they are reported separately)', () => {
    const entries = { a: { preset: 'ollama', apiKey: 'A' }, bad: { preset: 'nope' } }
    const resolution = resolveChannels(entries)
    expect(allChannels(resolution).map((channel) => channel.id)).toEqual(['a'])
    expect(resolution.problems).toHaveLength(1)
  })
})
