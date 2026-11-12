import { describe, expect, it } from 'vitest'
import { SupplyStatus, canSwitchAttempt, shouldFailover } from '../src/failover.js'

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
    const status = new SupplyStatus()
    status.bind(['a', 'b', 'c'])
    status.noteServed('c')
    status.noteFailure('c', false)
    const surface = Object.getOwnPropertyNames(SupplyStatus.prototype).filter((name) => name !== 'constructor')
    expect(surface.sort()).toEqual(
      ['bind', 'isExhausted', 'lastSwitch', 'lastTried', 'noteFailure', 'noteServed', 'noteSwitch', 'serving'].sort(),
    )
  })

  it('an empty member list is inert rather than throwing', () => {
    const status = new SupplyStatus()
    status.bind([])
    expect(status.serving).toBeUndefined()
    expect(status.isExhausted).toBe(false)
  })
})
