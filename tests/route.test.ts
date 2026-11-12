import { describe, expect, it } from 'vitest'
import { currentIsDangling, selectChannel } from '../src/route.js'
import type { ResolvedChannel } from '../src/channels.js'
import { SUPPLY_GROUP_ID } from '../src/config.js'

/** Minimal resolved channel; tests only read id and label, so the rest is filler. */
function channel(id: string): ResolvedChannel {
  return {
    id,
    label: id,
    api: 'openai-completions',
    baseURL: 'https://example.invalid/v1',
    model: 'm',
    credential: { kind: 'literal', value: 'sk-secret-value' },
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

  // v1 selected exactly one channel and did not fail over. That is still true for a plain channel
  // selection: naming something that does not exist must fail rather than quietly pick another.
  // (The SUPPLY GROUP does walk its members — that is a different, explicitly chosen mode.)
  it('never falls back to another channel', () => {
    const result = selectChannel([channel('a'), channel('b')], 'c')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('CHANNEL_UNKNOWN')
  })

  it('names the available channels in the failure so the fix is obvious', () => {
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

  it('🔴 never reports the supply-group sentinel as dangling', () => {
    // The sentinel is not a channel id and never will be — `currentIsDangling` must understand
    // that, or the panel would show 「未找到」 on a perfectly healthy group selection.
    expect(currentIsDangling(['a'], SUPPLY_GROUP_ID)).toBe(false)
    expect(currentIsDangling([], SUPPLY_GROUP_ID)).toBe(false)
  })
})

describe('selectChannel — the supply group', () => {
  it('🔴 resolves to the first member, with the rest as ordered alternates', () => {
    const result = selectChannel([channel('a'), channel('b'), channel('c')], SUPPLY_GROUP_ID, ['b', 'c', 'a'], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The GROUP's order wins, not the configuration's order.
    expect(result.channel.id).toBe('b')
    expect(result.alternates.map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(result.source).toEqual({ kind: 'group', index: 0, of: 3, cursorAdvanced: false })
  })

  it('🔴 starts from the sticky cursor and treats earlier members as the tail', () => {
    // Member 0 already failed, so the group is parked on 1. The rotation must still offer 2 and
    // then wrap back to 0 — a group that stops trying is not "供应不中断".
    const result = selectChannel([channel('a'), channel('b'), channel('c')], SUPPLY_GROUP_ID, ['a', 'b', 'c'], 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.id).toBe('b')
    expect(result.alternates.map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(result.source).toEqual({ kind: 'group', index: 1, of: 3, cursorAdvanced: true })
  })

  it('clamps a cursor past the end instead of wrapping to 0', () => {
    // Wrapping to 0 would re-attempt a relay the group already gave up on, before every request.
    const result = selectChannel([channel('a'), channel('b')], SUPPLY_GROUP_ID, ['a', 'b'], 99)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.id).toBe('b')
  })

  it('🔴 skips members that name no channel, keeping the configured order', () => {
    // A stale id is a repairable config problem; failing the whole route over it would take the
    // provider offline for one dangling string.
    const result = selectChannel([channel('a'), channel('c')], SUPPLY_GROUP_ID, ['a', 'ghost', 'c'], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.id).toBe('a')
    expect(result.alternates.map((entry) => entry.id)).toEqual(['c'])
    // The count reflects RESOLVABLE members, because that is what the group can actually walk.
    expect(result.source).toEqual({ kind: 'group', index: 0, of: 2, cursorAdvanced: false })
  })

  it('🔴 distinguishes an empty group from a group whose members all vanished', () => {
    const empty = selectChannel([channel('a')], SUPPLY_GROUP_ID, [], 0)
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.failure.code).toBe('GROUP_EMPTY')
    expect(empty.failure.detail).toContain('no members')

    const allDangling = selectChannel([channel('a')], SUPPLY_GROUP_ID, ['ghost', 'phantom'], 0)
    expect(allDangling.ok).toBe(false)
    if (allDangling.ok) return
    // Both are GROUP_EMPTY, but the MESSAGE must differ: one is "configure it", the other is
    // "your configuration is stale" — different fixes, so different sentences.
    expect(allDangling.failure.code).toBe('GROUP_EMPTY')
    expect(allDangling.failure.detail).toContain('ghost')
  })

  it('a plain channel selection carries no alternates', () => {
    const result = selectChannel([channel('a'), channel('b')], 'a', ['a', 'b'], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.channel.id).toBe('a')
    expect(result.alternates).toEqual([])
    expect(result.source).toEqual({ kind: 'channel', index: 0 })
  })
})
