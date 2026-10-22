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

  it('🔴 each preset carries the model id ITS endpoint accepts', () => {
    // Owner report (2026-10-22), straight from DeepSeek's own rejection:
    //   "The supported API model names are deepseek-flash, deepseek-v4-pro,
    //    but you passed deepseek-v4.1-flash."
    // This is exactly the divergence the plugin exists to absorb — every relay spells the same
    // model differently — so the table must be pinned per endpoint, not derived by copy-paste.
    expect(CHANNEL_PRESETS['deepseek-official']?.model).toBe('deepseek-flash')
    // The relays that DO take the long id keep it; the pin is per endpoint, not a global change.
    expect(CHANNEL_PRESETS['open-design']?.model).toBe('deepseek-v4.1-flash')
    // CommandCode namespaces its ids by vendor — a spelling no other preset uses.
    expect(CHANNEL_PRESETS.commandcode?.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('🔴 prefers the Responses API where the endpoint documents it', () => {
    // Owner directive (2026-10-22): 「优先支持并使用 responses api(这个api更先进)」.
    // DeepSeek documents `POST /responses` for deepseek-flash, so the official preset leads.
    expect(CHANNEL_PRESETS['deepseek-official']?.api).toBe('openai-responses')
  })

  it('🔴 but does NOT assume Responses where it is unverified', () => {
    // "Prefer" is not "assume": a relay that 404s `/responses` would fail every request. A preset
    // declares Responses only where the endpoint is documented to serve it; the rest stay on
    // completions, the lowest common denominator. This pin is what stops a future blanket
    // find-and-replace from silently breaking working relays.
    for (const id of ['opencode-go', 'commandcode', 'ollama', 'open-design']) {
      expect(CHANNEL_PRESETS[id]?.api, id).toBe('openai-completions')
    }
  })

  describe('balance probes — declared only where measured', () => {
    it('the verified shapes are wired to the right presets', () => {
      expect(CHANNEL_PRESETS['deepseek-official']?.balance).toEqual({ shape: 'deepseek' })
      expect(CHANNEL_PRESETS.ollama?.balance).toEqual({ shape: 'ollama', baseURL: 'https://ollama.com' })
    })

    it('🔴 a relay with NO balance route declares none', () => {
      // 🔴 This pins a mistake that actually shipped in 0.0.13's first draft: the open-design
      // entry declared `openai-billing` with a comment claiming it had been "probed live". It had
      // not. The first real call returned 404, while `/v1/models` on the same host returned 401 —
      // so the route does not exist at all.
      //
      // An invented shape is worse than no shape: it produces a transient-looking "读取失败" row,
      // so the user retries forever against a route that will never exist.
      expect(CHANNEL_PRESETS['open-design']?.balance).toBeUndefined()
    })

    it('🔴 OpenCode Go declares the WINDOWS shape — it has a query surface, but not a balance', () => {
      // 🔴 The owner remembered correctly that OpenCode exposes a usage query, and it does:
      // `/zen/go/v1/usage` answers **401** (route exists) while a made-up path under the same
      // prefix answers **404**. My first version declared NO probe at all, which was wrong.
      //
      // What it returns is subscription windows (rolling/weekly/monthly) — NOT the credit
      // wallet, which needs a logged-in browser session. `/zen/v1/balance` is 404: that endpoint
      // is what anomalyco/opencode#44189 is still asking for.
      expect(CHANNEL_PRESETS['opencode-go']?.balance).toEqual({ shape: 'opencode-windows' })
    })

    it('ollama overrides the base on purpose: inference /v1, balance /api', () => {
      // Without the override, `balanceUrls` would append /api to the /v1 base and 404.
      expect(CHANNEL_PRESETS.ollama?.balance?.baseURL).toBe('https://ollama.com')
      expect(CHANNEL_PRESETS.ollama?.baseURL).toBe('https://ollama.com/v1')
    })
  })
})
