import { describe, expect, it } from 'vitest'
import {
  QuotaCooldown,
  QUOTA_COOLDOWN_MS,
  SupplyStatus,
  canFallBackToGroup,
  canSwitchAttempt,
  orderWithCooldowns,
  shouldCoolDown,
} from '../src/failover.js'
import { groupMembers, selectChannel } from '../src/route.js'
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
      status.noteServed(channel.id, SUPPLY_GROUP_ID)
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

describe('🔴 the 30-minute skip changes the WALK, not the configured order', () => {
  /**
   * One whole request, with the cooldown map carried between calls.
   *
   * This is the integration-level half of the owner's 2026-11-19 decision: the unit cases in
   * `failover.test.ts` prove the map and the ordering function in isolation; these prove that a
   * request which pays a quota refusal actually TEACHES the next request to stop paying it.
   * @param cooldown - the shared map, carried across requests.
   * @param atMs - the clock for this request.
   * @returns the ids attempted, in order.
   */
  function walkWithCooldown(
    cooldown: QuotaCooldown,
    atMs: number,
    answers: Record<string, 'ok' | string> = {},
  ): string[] {
    const cooling = cooldown.coolingIds(atMs)
    const selection = selectChannel(channels, SUPPLY_GROUP_ID, members)
    if (!selection.ok) return []
    const candidates = orderWithCooldowns([selection.channel, ...selection.alternates], cooling).walk
    const tried: string[] = []
    for (const channel of candidates) {
      tried.push(channel.id)
      const answer = answers[channel.id] ?? 'QUOTA'
      if (answer === 'ok') {
        cooldown.clear(channel.id)
        return tried
      }
      if (shouldCoolDown(answer)) cooldown.noteQuota(channel.id, atMs)
    }
    return tried
  }

  it('🔴 the FIRST request pays the toll, every request after it does not', () => {
    // This is the whole point of the feature. Before it, the toll was paid ~179 times in 30 minutes
    // on the live host (the ledger showed a:179, b:177, c:175 — a perfect 1:1:1 split, i.e. every
    // request walking both dry members). After it, exactly once per member per half hour.
    //
    // ⚠️ `c` must be given `ok` explicitly: the default answer for an unlisted member is QUOTA, so
    // leaving it out would make the SECOND request find all three cooling and this assertion would
    // pass for the wrong reason (my first draft did exactly that).
    const cooldown = new QuotaCooldown()
    expect(walkWithCooldown(cooldown, 1_000_000, { c: 'ok' })).toEqual(['a', 'b', 'c'])
    // The second request reaches the healthy member FIRST: the two dry ones are moved to the back.
    expect(walkWithCooldown(cooldown, 1_000_001, { c: 'ok' })).toEqual(['c'])
    expect(walkWithCooldown(cooldown, 1_000_002, { c: 'ok' })).toEqual(['c'])
  })

  it('🔴 the skip expires by itself — no reset action, no button', () => {
    // The property the sticky cursor failed (decision 97): recovery must require nothing from the
    // user. Once the window passes, the configured order is back, including the members that failed.
    const cooldown = new QuotaCooldown()
    walkWithCooldown(cooldown, 0, { c: 'ok' })
    expect(walkWithCooldown(cooldown, QUOTA_COOLDOWN_MS + 1, { c: 'ok' })).toEqual(['a', 'b', 'c'])
  })

  it('🔴 a member that answers successfully clears its own skip immediately', () => {
    // A top-up must take effect on the attempt that follows it — not after the full window.
    // After request 0, `a` and `b` are cooling. Request 1 walks a healthy member FIRST — `c` is
    // still fresh, so it is tried first and (given `QUOTA`) becomes the third cooling member; then
    // `a` (topped up) answers ok and is cleared.
    const cooldown = new QuotaCooldown()
    walkWithCooldown(cooldown, 0, { c: 'ok' })
    expect(walkWithCooldown(cooldown, 1, { c: 'QUOTA', a: 'ok' })).toEqual(['c', 'a'])
    // Now `c` is cooling too — and `a`, having succeeded, is back at the HEAD of the order.
    expect(walkWithCooldown(cooldown, 2, { a: 'ok' })).toEqual(['a'])
  })

  it('⛔ a dry member is skipped, never dropped — an all-dry group still walks everyone', () => {
    // An optimisation that can route to nothing is not an optimisation. If every member is cooling,
    // the order is still complete and a request can still succeed when one of them recovers.
    const cooldown = new QuotaCooldown()
    walkWithCooldown(cooldown, 0, { c: 'ok' })
    expect(walkWithCooldown(cooldown, 1, { c: 'QUOTA' })).toEqual(['c', 'a', 'b'])
    // Everything is cooling now; the walk STILL contains all three, in configured order.
    expect(walkWithCooldown(cooldown, 2, {})).toEqual(['a', 'b', 'c'])
  })

  it('the configured order is unchanged while nothing is cooling', () => {
    expect(walkWithCooldown(new QuotaCooldown(), 0, { a: 'ok' })).toEqual(['a'])
  })
})

describe('🔴 the safety net: a plain channel out of credit falls back into the group', () => {
  /**
   * One whole request against a PLAIN channel selection, mirroring the adapter's loop.
   *
   * This is the same walk as above with one new step between "the chosen channel failed" and
   * "report the error": if the failure is out-of-credit and the group has anything usable, the
   * group's members are appended and the ordinary walk continues inside them.
   * @param current - the channel the user selected.
   * @param answers - per-channel outcome; missing = `QUOTA`.
   * @param status - the shared recorder.
   * @returns the ids attempted, in order.
   */
  function walkPlainChannel(
    current: string,
    answers: Record<string, 'ok' | string> = {},
    status = new SupplyStatus(),
  ): { tried: string[]; served: boolean } {
    status.bind(members)
    const selection = selectChannel(channels, current, members)
    if (!selection.ok) return { tried: [], served: false }
    const fromGroup = selection.source.kind === 'group'
    const candidates: ResolvedChannel[] = [selection.channel, ...selection.alternates]
    const groupFallback = fromGroup
      ? []
      : groupMembers(channels, members).ordered.filter((channel) => channel.id !== selection.channel.id)
    let fellBack = false

    const tried: string[] = []
    for (let position = 0; position < candidates.length; position++) {
      const channel = candidates[position]!
      tried.push(channel.id)
      const answer = answers[channel.id] ?? 'QUOTA'
      if (answer === 'ok') {
        status.noteServed(channel.id, current, fellBack)
        return { tried, served: true }
      }
      const emitted = false
      if (canSwitchAttempt({ code: answer, emitted, hasNext: position + 1 < candidates.length })) continue
      if (!fellBack && canFallBackToGroup({
        code: answer,
        emitted,
        selectionIsChannel: !fromGroup,
        groupCandidates: groupFallback.length,
      })) {
        fellBack = true
        candidates.push(...groupFallback)
        status.noteSwitch(channel.id, groupFallback[0]!.id, answer, 1000)
        continue
      }
      status.noteFailure(channel.id, position + 1 >= candidates.length)
      return { tried, served: false }
    }
    return { tried, served: false }
  }

  it('🔴 the owner\'s case: chosen channel out of credit ⇒ served by the group, request does NOT fail', () => {
    // Owner request 2026-11-19: 「当使用非供应组渠道 用到无费用时 自动切换到供应组。目的是确保 token 供应
    // 不中断」. Before this, the request simply failed with QUOTA even though three healthy relays
    // were configured in the group.
    const status = new SupplyStatus()
    const result = walkPlainChannel('a', { b: 'ok' }, status)
    expect(result.tried).toEqual(['a', 'b'])
    expect(result.served).toBe(true)
    // The panel must be able to explain WHY: served by a member, while `current` is still 'a'.
    expect(status.servingUnder('a')).toBe('b')
    expect(status.servedByFallback).toBe(true)
    expect(status.isMember('b')).toBe(true)
    // And the failed attempt is still recorded as a switch, so 「最近切换」 has the real cause.
    expect(status.lastSwitch).toEqual({ from: 'a', to: 'b', code: 'QUOTA', atMs: 1000 })
  })

  it('🔴 with nothing in the group, the failure is reported as before — no invented supplier', () => {
    const status = new SupplyStatus()
    // `a` is the only channel; the group is empty ⇒ there is nowhere to fall back to.
    const result = walkOnePlain([channel('a')], 'a', {}, status)
    expect(result).toEqual(['a'])
    expect(status.servedByFallback).toBe(false)
  })

  it('🔴 AUTH and MISSING_CREDENTIAL do NOT trigger the safety net', () => {
    // The trigger is 「无费用」 (out of credit), not "anything terminal". A dead key is a
    // configuration error to fix; silently routing around it would hide a typo. Those two stay fatal
    // for a plain selection, exactly as before this feature.
    for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
      expect(walkPlainChannel('a', { a: code, b: 'ok' }), code).toEqual({ tried: ['a'], served: false })
    }
    // QUOTA does trigger it — that is the whole point.
    expect(walkPlainChannel('a', { a: 'QUOTA', b: 'ok' }).served).toBe(true)
  })

  it('🔴 transient codes do NOT trigger it either — the retry layer owns those', () => {
    // Switching a plain channel on a network blip would throw away a warm prompt cache for a
    // failure that fixes itself, and would hide a flaky relay behind someone else's bill.
    for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'CONTEXT_WINDOW_EXCEEDED']) {
      expect(walkPlainChannel('a', { a: code, b: 'ok' }), code).toEqual({ tried: ['a'], served: false })
    }
  })

  it('🔴 the failed channel is never re-attempted even when it is also a member', () => {
    // `current` is often ALSO in the group. Appending the whole member list would spend a guaranteed
    // second refusal on the same dead account — that is a loop, not "供应不中断".
    const status = new SupplyStatus()
    const result = walkPlainChannel('b', {}, status)
    expect(result.tried.filter((id) => id === 'b')).toHaveLength(1)
    expect(result.tried).toEqual(['b', 'a', 'c'])
  })

  it('ignores the group entirely when the group IS the selection', () => {
    // Two mechanisms on one failure would double-attempt members; the group's own walk owns it.
    expect(walkPlainChannel(SUPPLY_GROUP_ID, { a: 'ok' })).toEqual({ tried: ['a'], served: true })
  })
})

/** Minimal harness for the empty-group case, where there are no fallback candidates at all. */
function walkOnePlain(
  only: ResolvedChannel[],
  current: string,
  answers: Record<string, string>,
  status: SupplyStatus,
): string[] {
  status.bind([])
  const selection = selectChannel(only, current, [])
  if (!selection.ok) return []
  const selected = selection.channel
  const answer = answers[selected.id] ?? 'QUOTA'
  if (answer === 'ok') {
    status.noteServed(selected.id, current)
    return [selected.id]
  }
  status.noteFailure(selected.id, true)
  return [selected.id]
}

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
