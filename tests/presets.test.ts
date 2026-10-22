import { describe, expect, it } from 'vitest'
import {
  ADVERTISED_MODEL_ID,
  CHANNEL_PRESETS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  presetById,
  presetIds,
} from '../src/presets.js'

describe('presets', () => {
  it('advertises exactly one model id', () => {
    expect(ADVERTISED_MODEL_ID).toBe('deepseek-v4.1-flash')
  })

  it('every preset names a supported protocol and a non-empty endpoint', () => {
    for (const [id, preset] of Object.entries(CHANNEL_PRESETS)) {
      expect(preset.baseURL, id).toMatch(/^https?:\/\//)
      expect(preset.model.length, id).toBeGreaterThan(0)
      expect(['openai-completions', 'openai-responses', 'anthropic-messages'], id)
        .toContain(preset.api)
    }
  })

  // The whole reason "one model in the picker" works: relays spell the upstream id
  // differently, so the mapping has to be data. If this ever collapses to one spelling,
  // the mapping layer can be deleted — until then it must stay.
  it('carries relay-specific upstream model spellings rather than assuming one', () => {
    expect(CHANNEL_PRESETS.commandcode?.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(CHANNEL_PRESETS['opencode-go']?.model).toBe('deepseek-v4.1-flash')
  })

  it('preset ids round-trip through presetById', () => {
    const ids = presetIds()
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(presetById(id)?.displayName).toBeDefined()
  })

  it('rejects ids that only look like table keys', () => {
    expect(presetById('toString')).toBeUndefined()
    expect(presetById('__proto__')).toBeUndefined()
    expect(presetById('')).toBeUndefined()
  })

  it('documents defaults that match the harness adapter', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(262_144)
    expect(DEFAULT_MAX_TOKENS).toBe(32_768)
  })

  it('🔴 the opencode-go preset does NOT bake in a session id', () => {
    // The endpoint wants the session header to be STABLE PER CONVERSATION. A literal in the preset
    // is one value shared by every conversation, which satisfies "the header exists" while
    // defeating the routing/cache affinity it exists for. The per-request value is injected in
    // `adapter.ts` from the harness's own `sessionId`; what the preset must carry is only the
    // static client identity.
    const preset = CHANNEL_PRESETS['opencode-go']
    expect(preset?.headers?.['x-opencode-session']).toBeUndefined()
    expect(preset?.headers?.['X-Session-ID']).toBeUndefined()
    expect(preset?.headers?.['x-opencode-client']).toBeDefined()
    // The marker the adapter keys off must be present, or no session header is ever injected.
    expect(Object.hasOwn(preset?.headers ?? {}, 'x-opencode-client')).toBe(true)
  })

  it('🔴 every preset declares image input, and the adapter can actually deliver bytes', () => {
    // An `ImageBlock` carries an attachmentId, not bytes, so declaring `image` is only honest once
    // the adapter resolves those bytes through the attachment store. Both halves are asserted:
    // the declaration here, the delivery path in the adapter tests. Declaring without delivering
    // was a measured failure — a screenshot reached the plugin and the model answered as though
    // the message had been text only.
    for (const [id, preset] of Object.entries(CHANNEL_PRESETS)) {
      expect(preset.input, id).toContain('image')
    }
  })

  it('🔴 thinking levels are declared as real wire values, not as a bare boolean', () => {
    // The values are what the relay expects on the wire; pi-ai consumes this map as
    // `thinkingLevelMap`, which is why this plugin has no translation layer of its own.
    const preset = CHANNEL_PRESETS['opencode-go']
    expect(preset?.reasoningEfforts?.low).toBe('low')
    expect(preset?.reasoningEfforts?.high).toBe('high')
    // `off` is declared unsupported rather than silently missing, so a caller asking for it gets
    // an explicit answer instead of an invented one.
    expect(preset?.reasoningEfforts?.off).toBeNull()
  })
})
