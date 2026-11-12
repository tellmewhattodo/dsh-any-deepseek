import { describe, expect, it } from 'vitest'
import { SupplyStatus, canSwitchAttempt } from '../src/failover.js'
import { selectChannel } from '../src/route.js'
import type { ResolvedChannel } from '../src/channels.js'
import { SUPPLY_GROUP_ID } from '../src/config.js'

/**
 * Reproduce ONE whole request against a supply group, without a transport.
 *
 * This mirrors the dispatch loop in `adapter.ts` step for step — resolve, walk, record, stop — and
 * every routing decision comes from the same two pure functions the adapter calls
 * (`selectChannel` and `canSwitchAttempt`). The transport is not what these questions are about.
 *
 * ## What this simulates exactly, and what it does not
 *
 * `answers` gives each member's outcome for this call. `'ok'` means the attempt succeeded (the
 * adapter would have forwarded the terminal chunk); anything else is that member's failure code.
 * Nothing is ever emitted before failing, so the `emitted` guard is `false` throughout — the
 * mid-stream case is `failover.test.ts`'s job, where it can be stated as one boolean.
 * @param channels - every resolvable channel.
 * @param members - the group's member ids, index 0 first.
 * @param answers - per-member outcome; a missing entry means `QUOTA`.
 * @param status - the shared display-only recorder (this is what the panel shows).
 * @returns the ids actually attempted, in order.
 */
function walkOneRequest(
  channels: ResolvedChannel[],
  members: string[],
  answers: Record<string, 'ok' | string> = {},
  status = new SupplyStatus(),
): string[] {
  status.bind(members)
  const selection = selectChannel(channels, SUPPLY_GROUP_ID, members)
  if (!selection.ok) return []
  const candidates = [selection.channel, ...selection.alternates]
  const fromGroup = selection.source.kind === 'group'

  const tried: string[] = []
  for (let position = 0; position < candidates.length; position++) {
    const channel = candidates[position]!
    tried.push(channel.id)
    const answer = answers[channel.id] ?? 'QUOTA'

    if (answer === 'ok') {
      if (fromGroup) status.noteServed(channel.id)
      return tried
    }

    const canSwitch = canSwitchAttempt({ code: answer, emitted: false, hasNext: position + 1 < candidates.length })
    if (canSwitch) {
      if (fromGroup) status.noteSwitch(channel.id, candidates[position + 1]!.id, answer, 1000)
      continue
    }

    // 🔴 Only walking off the END of the list is "the group is exhausted". Failing here with members
    // left (a code the group cannot switch on) fails the REQUEST, not the group.
    if (fromGroup) status.noteFailure(channel.id, position + 1 >= candidates.length)
    return tried
  }
  return tried
}

function channel(id: string): ResolvedChannel {
  return {
    id,
    label: id,
    api: 'openai-completions',
    baseURL: 'https://example.invalid/v1',
    model: 'm',
    credential: { kind: 'literal', value: 'sk-x' },
    contextWindow: 1000,
    maxTokens: 100,
    input: ['text'],
    warnings: [],
  }
}

const channels = [channel('a'), channel('b'), channel('c')]
const members = ['a', 'b', 'c']

describe('🔴 priority order — every request walks 1…n from the first member', () => {
  it('a healthy first member serves alone: nobody else is contacted', () => {
    // 🔴 The owner's other half of the rule (2026-11-12): 「失败了才触发组内重选逻辑」. Walking the
    // group is a RECOVERY path, not a rotation — a request that member 1 can serve must never touch
    // member 2, because every extra attempt costs a round-trip, a cold prompt cache and a ledger
    // line under another account's name.
    const status = new SupplyStatus()
    expect(walkOneRequest(channels, members, { a: 'ok' }, status)).toEqual(['a'])
    expect(status.serving).toBe('a')
    expect(status.isExhausted).toBe(false)
    expect(status.lastSwitch).toBeUndefined()
  })

  it('member 1 refusing quota moves to member 2, which serves', () => {
    const status = new SupplyStatus()
    expect(walkOneRequest(channels, members, { b: 'ok' }, status)).toEqual(['a', 'b'])
    expect(status.serving).toBe('b')
    expect(status.lastSwitch).toEqual({ from: 'a', to: 'b', code: 'QUOTA', atMs: 1000 })
  })

  it('one request walks every member exactly once and stops at the end', () => {
    expect(walkOneRequest(channels, members)).toEqual(['a', 'b', 'c'])
  })

  it('🔴 the group is exhausted only after the LAST member also fails', () => {
    const status = new SupplyStatus()
    walkOneRequest(channels, members, {}, status)
    expect(status.isExhausted).toBe(true)
    expect(status.lastTried).toBe('c')
    // Nobody is serving, and the panel must not name one.
    expect(status.serving).toBeUndefined()
  })

  it('🔴 and therefore the NEXT request starts at member 1 again — a→b→c, not c→a→b', () => {
    // This is the whole revision. The first cut left a sticky cursor here, so an exhausted group
    // came back as c→a→b: the priority order was silently rewritten by history, and topping up
    // member 1 did not put it back to work until a manual reset. The owner rejected that.
    //
    // ⚠️ The cost is stated in `failover.ts`: while member 1 is dead, EVERY request pays one wasted
    // 402 round-trip to it before reaching a working member. That is accepted on purpose — it costs
    // no tokens (a quota refusal returns before generating).
    const status = new SupplyStatus()
    expect(walkOneRequest(channels, members, {}, status)).toEqual(['a', 'b', 'c'])
    expect(walkOneRequest(channels, members, {}, status)).toEqual(['a', 'b', 'c'])
    expect(walkOneRequest(channels, members, {}, status)).toEqual(['a', 'b', 'c'])
  })

  it('🔴 topping up member 1 takes effect on the very next request, with no reset action', () => {
    // The recovery the previous design could not do. There is no cursor to clear, no button to
    // press, no host restart: the member list IS the priority order, so充值 immediately restores it.
    const status = new SupplyStatus()
    walkOneRequest(channels, members, {}, status)
    expect(walkOneRequest(channels, members, { a: 'ok' }, status)).toEqual(['a'])
    expect(status.serving).toBe('a')
    expect(status.isExhausted).toBe(false)
  })

  it('a single-member group stays on its only member', () => {
    const one = [channel('a')]
    expect(walkOneRequest(one, ['a'])).toEqual(['a'])
    expect(walkOneRequest(one, ['a'], { a: 'ok' })).toEqual(['a'])
  })

  it('does not mutate the configured member order', () => {
    // Routing reads the order; it must never rewrite the settings document — the order the user
    // arranged is the contract this whole feature rests on.
    const order = ['a', 'b', 'c']
    walkOneRequest(channels, order, {}, new SupplyStatus())
    walkOneRequest(channels, order, {}, new SupplyStatus())
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('🔴 the switch set still governs whether the group moves at all', () => {
  it('a mid-list member failing with a NON-switchable code stops the request right there', () => {
    // SERVER / RATE_LIMIT belong to the retry layer: switching on them would throw away a warm
    // prompt cache (and, for a rate limit, hammer a relay that will recover in seconds).
    const status = new SupplyStatus()
    expect(walkOneRequest(channels, members, { a: 'SERVER' }, status)).toEqual(['a'])
    expect(status.serving).toBeUndefined()
    // 🔴 The request failed, but the GROUP is not exhausted — members b and c were never asked.
    expect(status.isExhausted).toBe(false)
    expect(status.lastTried).toBe('a')
  })

  it('CONTEXT_WINDOW_EXCEEDED never walks the group, even as member 1', () => {
    // Two reasons, either sufficient: it cannot help (every member serves the same model with the
    // same window), and it is dangerous (the harness treats that code as proof of a real overflow
    // and runs the destructive compaction path).
    expect(walkOneRequest(channels, members, { a: 'CONTEXT_WINDOW_EXCEEDED' }, new SupplyStatus())).toEqual(['a'])
  })

  it('every switchable code the set names does move on, and nothing else does', () => {
    // Both directions in one place: the switch set is the whole trigger for re-selection.
    for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
      expect(walkOneRequest(channels, members, { a: code }), code).toEqual(['a', 'b', 'c'])
    }
    for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'ABORTED']) {
      expect(walkOneRequest(channels, members, { a: code }), code).toEqual(['a'])
    }
  })
})

describe('member list edits are respected immediately', () => {
  it('a reordered list changes the heads on the next request, with no reset', () => {
    const status = new SupplyStatus()
    expect(walkOneRequest(channels, ['a', 'b', 'c'], {}, status)).toEqual(['a', 'b', 'c'])
    expect(walkOneRequest(channels, ['c', 'b', 'a'], {}, status)).toEqual(['c', 'b', 'a'])
  })

  it('a dangling member is skipped in the walk and reported', () => {
    const status = new SupplyStatus()
    const selection = selectChannel(channels, SUPPLY_GROUP_ID, ['ghost', 'b', 'c'])
    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect([selection.channel, ...selection.alternates].map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(walkOneRequest(channels, ['ghost', 'b', 'c'], {}, status)).toEqual(['b', 'c'])
  })
})
