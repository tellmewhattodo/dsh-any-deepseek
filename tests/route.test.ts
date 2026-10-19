import { describe, expect, it } from 'vitest'
import { currentIsDangling, selectChannel } from '../src/route.js'
import type { ResolvedChannel } from '../src/channels.js'

/** Minimal resolved channel; tests only read id and label, so the rest is filler. */
function channel(id: string): ResolvedChannel {
  return {
    id,
    label: id,
    api: 'openai-completions',
    baseURL: 'https://example.invalid/v1',
    model: 'm',
    apiKeyEnv: `${id.toUpperCase()}_KEY`,
    contextWindow: 1000,
    maxTokens: 100,
    input: ['text'],
    warnings: [],
  }
}

describe('selectChannel', () => {
  it('returns the channel named by current', () => {
    const result = selectChannel([channel('a'), channel('b')], 'b')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.id).toBe('b')
  })

  it('separates "nothing configured" from "nothing selected"', () => {
    const empty = selectChannel([], 'a')
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.failure.code).toBe('NO_CHANNELS')

    const unset = selectChannel([channel('a')], '')
    expect(unset.ok).toBe(false)
    if (unset.ok) return
    expect(unset.failure.code).toBe('NO_CHANNEL_SELECTED')
  })

  it('treats a whitespace selection as not selected', () => {
    const result = selectChannel([channel('a')], '   ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('NO_CHANNEL_SELECTED')
  })

  // v1 does not fail over. A selection naming something that is not enabled must fail rather
  // than quietly pick another channel — that silence is exactly what manual mode rules out.
  it('never falls back to another channel', () => {
    const result = selectChannel([channel('a'), channel('b')], 'c')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CHANNEL_DISABLED')
  })

  it('names the enabled channels in the failure so the fix is obvious', () => {
    const result = selectChannel([channel('a'), channel('b')], 'ghost')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.detail).toContain('ghost')
    expect(result.failure.detail).toContain('a, b')
  })

  it('honours a selection that differs only by surrounding whitespace', () => {
    const result = selectChannel([channel('a')], '  a  ')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.id).toBe('a')
  })
})

describe('currentIsDangling', () => {
  it('flags a selection naming no configured channel', () => {
    expect(currentIsDangling(['a', 'b'], 'c')).toBe(true)
  })

  it('accepts a configured channel and an empty selection', () => {
    expect(currentIsDangling(['a'], 'a')).toBe(false)
    expect(currentIsDangling(['a'], '')).toBe(false)
    expect(currentIsDangling([], undefined)).toBe(false)
  })
})
