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

  it('gives the opencode-go preset the session headers its endpoint requires', () => {
    const preset = CHANNEL_PRESETS['opencode-go']
    expect(preset?.headers?.['x-opencode-session']).toBeDefined()
    expect(preset?.headers?.['X-Session-ID']).toBeDefined()
  })
})
