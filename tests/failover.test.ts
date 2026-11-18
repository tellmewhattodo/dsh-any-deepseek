import { describe, expect, it } from 'vitest'
import { SupplyStatus, canFallBackToGroup, canSwitchAttempt, shouldFailover } from '../src/failover.js'

describe('shouldFailover — the switch set', () => {
  it('🔴 switches when the channel itself cannot serve', () => {
    // Each of these means "this channel will fail identically on every later attempt", so the next
    // member is a strictly better answer than an error.
    for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
      expect(shouldFailover(code), code).toBe(true)
    }
  })

  it('🔴 does NOT switch for transient failures — the retry layer owns those', () => {
    // Switching here is actively worse: a new channel means a cold prompt cache, so a one-second
    // network blip would cost a full re-prime of the conversation.
    for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'EMPTY_RESPONSE']) {
      expect(shouldFailover(code), code).toBe(false)
    }
  })

  it('🔴 NEVER switches on CONTEXT_WINDOW_EXCEEDED', () => {
    // Two independent reasons, and either alone is enough:
    //  1. it cannot help — every member serves the same model with the same window;
    //  2. it is dangerous — the harness reads that code as proof of a real overflow and runs the
    //     destructive compaction path (whole range, retain=0, threshold skipped: 0.0.32).
    // Walking the group on it would turn one error into N trips through a path that deletes
    // conversation history.
    expect(shouldFailover('CONTEXT_WINDOW_EXCEEDED')).toBe(false)
  })

  it('does not switch on an aborted request or an unknown code', () => {
    // ABORTED = the caller cancelled; switching would ignore their intent. An unknown code is an
    // unknown cause, and guessing "this relay is broken" on an unknown cause is how a healthy
    // supplier gets cycled out during a blip.
    expect(shouldFailover('ABORTED')).toBe(false)
    expect(shouldFailover('SOMETHING_NEW_FROM_A_RELAY')).toBe(false)
    expect(shouldFailover(undefined)).toBe(false)
  })
})

describe('canSwitchAttempt — the "may we even try another supplier" gate', () => {
  const base = { code: 'QUOTA', emitted: false, hasNext: true }

  it('switches on a switchable code with nothing emitted and someone left', () => {
    expect(canSwitchAttempt(base)).toBe(true)
  })

  it('🔴 REFUSES once anything has been streamed, even for a switchable code', () => {
    // 🔴 The most dangerous guard in this feature, and the reason this function exists at all.
    // A chunk that has been yielded is already in the session and on the user's screen; switching
    // suppliers afterwards would append another model's output to the same message with nothing
    // marking the seam. Dropping this clause must turn a test red — `emitted: true` here is that
    // negative control, expressed as the case that must stay false for every code.
    for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
      expect(canSwitchAttempt({ code, emitted: true, hasNext: true }), code).toBe(false)
    }
  })

  it('refuses when the candidate list is exhausted', () => {
    expect(canSwitchAttempt({ ...base, hasNext: false })).toBe(false)
  })

  it('refuses for a non-switchable code even with nothing emitted and members left', () => {
    // The transient/threshold classes belong to the retry layer (or, for overflow, to nobody —
    // see the CONTEXT_WINDOW_EXCEEDED note above).
    for (const code of ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED']) {
      expect(canSwitchAttempt({ ...base, code }), code).toBe(false)
    }
  })
})

describe('canFallBackToGroup — the out-of-credit safety net (2026-11-19)', () => {
  // Owner request: 「当使用非供应组渠道 用到无费用时 自动切换到供应组。目的是确保 token 供应不中断」.
  // These cases pin the FOUR conditions separately, because a single combined case would stay green
  // when any one of them was dropped — and each one that gets dropped changes behaviour in a
  // different, user-visible way.
  const base = { code: 'QUOTA', emitted: false, selectionIsChannel: true, groupCandidates: 2 }

  it('fires for the owner\'s case: chosen channel out of credit, group has members', () => {
    expect(canFallBackToGroup(base)).toBe(true)
    expect(canFallBackToGroup({ ...base, code: 'ACCOUNT_QUOTA' })).toBe(true)
  })

  it('🔴 REFUSES once anything has been streamed', () => {
    // The same guard as `canSwitchAttempt`, and for the same reason: a chunk already yielded is in
    // the session and on screen, so continuing elsewhere would splice two models into one message.
    expect(canFallBackToGroup({ ...base, emitted: true })).toBe(false)
  })

  it('🔴 REFUSES when the group is already the selection', () => {
    // The group's own walk owns that decision. Two mechanisms on one failure would attempt the same
    // member twice.
    expect(canFallBackToGroup({ ...base, selectionIsChannel: false })).toBe(false)
  })

  it('🔴 REFUSES when the group has nothing usable', () => {
    // `groupCandidates` counts resolvable members EXCLUDING the failed channel. Zero means there is
    // nowhere to go, so the failure must be reported as before — no invented supplier.
    expect(canFallBackToGroup({ ...base, groupCandidates: 0 })).toBe(false)
  })

  it('🔴 REFUSES for anything that is not "out of credit"', () => {
    // The trigger is 「无费用」, not "anything terminal". AUTH/MISSING_CREDENTIAL are also terminal
    // but are CONFIGURATION errors: routing around them would hide a typo. Transient codes belong to
    // the retry layer — switching on them throws away a warm prompt cache for a blip that fixes
    // itself, and hides a flaky relay behind someone else's bill.
    for (const code of [
      'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
      'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED',
      'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'SOMETHING_NEW',
    ]) {
      expect(canFallBackToGroup({ ...base, code }), code).toBe(false)
    }
    expect(canFallBackToGroup({ ...base, code: undefined })).toBe(false)
  })
})

describe('SupplyStatus — the display-only readings', () => {
  it('starts empty: nothing has served, no switch, not exhausted', () => {
    const status = new SupplyStatus()
    expect(status.serving).toBeUndefined()
    expect(status.lastSwitch).toBeUndefined()
    expect(status.isExhausted).toBe(false)
    expect(status.lastTried).toBeUndefined()
  })

  it('records who served last', () => {
    const status = new SupplyStatus()
    status.noteServed('b')
    expect(status.serving).toBe('b')
    expect(status.isExhausted).toBe(false)
  })

  it('🔴 a served member is cleared by a later failure', () => {
    // Otherwise the panel prints 「正在使用：B」 while nothing is serving — the exact false statement
    // the exhausted flag was added to stop (owner-visible: the sidebar named a dead relay).
    const status = new SupplyStatus()
    status.noteServed('b')
    status.noteFailure('b', true)
    expect(status.serving).toBeUndefined()
    expect(status.isExhausted).toBe(true)
    expect(status.lastTried).toBe('b')
  })

  it('🔴 "the group ran out" and "this request failed" are separate facts', () => {
    // A mid-stream failure on member 1 of 3, or a SERVER error the group cannot switch on, fails the
    // REQUEST without exhausting the GROUP: members 2 and 3 are perfectly usable next time.
    // Rendering 「全组均不可用」 there is a false alarm that also hides the healthy members.
    const partial = new SupplyStatus()
    partial.noteFailure('a', false)
    expect(partial.isExhausted).toBe(false)
    expect(partial.lastTried).toBe('a')

    const walked = new SupplyStatus()
    walked.noteFailure('c', true)
    expect(walked.isExhausted).toBe(true)
  })

  it('🔴 resets when the member list changes, and keeps readings when it does not', () => {
    // A name only means something against one list. Adding, removing or reordering members must not
    // leave the panel naming a member that is no longer where it was — or, worse, one that is gone.
    const status = new SupplyStatus()
    status.bind(['a', 'b', 'c'])
    status.noteServed('b')
    status.noteSwitch('a', 'b', 'QUOTA', 1000)
    // Same list again: readings survive, which is what lets the panel explain a switch at all.
    status.bind(['a', 'b', 'c'])
    expect(status.serving).toBe('b')
    expect(status.lastSwitch).toEqual({ from: 'a', to: 'b', code: 'QUOTA', atMs: 1000 })

    // Reordered: same members, different meaning for "position 1".
    status.bind(['b', 'a', 'c'])
    expect(status.serving).toBeUndefined()
    expect(status.lastSwitch).toBeUndefined()
    expect(status.isExhausted).toBe(false)
  })

  it('records the last switch for the panel to explain', () => {
    const status = new SupplyStatus()
    status.bind(['a', 'b'])
    status.noteSwitch('a', 'b', 'QUOTA', 4242)
    expect(status.lastSwitch).toEqual({ from: 'a', to: 'b', code: 'QUOTA', atMs: 4242 })
  })

  it('🔴 nothing it holds can change which member serves next', () => {
    // The load-bearing property of the whole revision. `SupplyStatus` has no method that answers
    // "where do I start?" — the only starting position in the codebase is the literal 0 in
    // `selectFromGroup`. This test pins the SHAPE: no routing-shaped accessor exists. If a future
    // edit adds one, the panel's readings have quietly become a cursor again, and the priority order
    // stops being the priority order.
    //
    // ⚠️ The allowed set grew on 2026-11-19 (`servingUnder`, `servedByFallback`, `isMember`) — all
    // three are READS that answer "is this reading still current / did it come from the fallback",
    // none of them answers "where do I start". The judgement is not "the surface is frozen"; it is
    // "no member of this surface may influence the starting index".
    const status = new SupplyStatus()
    status.bind(['a', 'b', 'c'])
    status.noteServed('c', 'a')
    status.noteFailure('c', false)
    const surface = Object.getOwnPropertyNames(SupplyStatus.prototype).filter((name) => name !== 'constructor')
    expect(surface.sort()).toEqual(
      [
        'bind', 'isExhausted', 'isMember', 'lastSwitch', 'lastTried',
        'noteFailure', 'noteServed', 'noteSwitch',
        'servedByFallback', 'serving', 'servingUnder',
      ].sort(),
    )
  })

  it('🔴 a reading from BEFORE a selection change is not reported as live', () => {
    // The 2026-11-18 wrong-name defect, one layer down. `serving` alone cannot tell "this is who is
    // serving now" from "this is who served before the user changed the selection", so the panel
    // reads `servingUnder(current)` and a stale reading answers `undefined`.
    const status = new SupplyStatus()
    status.bind(['a', 'b'])
    status.noteServed('b', 'a')
    expect(status.servingUnder('a')).toBe('b')
    expect(status.servingUnder('other')).toBeUndefined()
    expect(status.servingUnder(undefined)).toBeUndefined()
  })

  it('🔴 the fallback flag travels with the reading, and dies with it', () => {
    // `servedByFallback` says a chosen channel ran out of credit and a member took over. It must
    // never outlive the reading it describes: a later failure, or a member-list change, clears it.
    const status = new SupplyStatus()
    status.bind(['a', 'b'])
    status.noteServed('b', 'chosen', true)
    expect(status.servedByFallback).toBe(true)
    expect(status.isMember('b')).toBe(true)
    expect(status.isMember('chosen')).toBe(false)

    status.noteFailure('b', false)
    expect(status.servedByFallback).toBe(false)

    status.noteServed('b', 'chosen', true)
    status.bind(['a', 'b', 'c'])
    expect(status.servedByFallback).toBe(false)
  })

  it('an empty member list is inert rather than throwing', () => {
    const status = new SupplyStatus()
    status.bind([])
    expect(status.serving).toBeUndefined()
    expect(status.isExhausted).toBe(false)
  })
})
