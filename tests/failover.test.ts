import { describe, expect, it } from 'vitest'
import { SupplyCursor, canSwitchAttempt, shouldFailover } from '../src/failover.js'

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

describe('SupplyCursor — the sticky position', () => {
  it('starts at the first member', () => {
    const cursor = new SupplyCursor()
    expect(cursor.startIndex(['a', 'b', 'c'])).toBe(0)
  })

  it('🔴 remembers the position across requests', () => {
    // The whole point: after member 0 runs out, later requests must NOT re-attempt it first —
    // that would cost one wasted round-trip and one cache invalidation per request, forever.
    const cursor = new SupplyCursor()
    cursor.startIndex(['a', 'b', 'c'])
    cursor.advance('a', 'b', 'QUOTA', 1000, 1)
    expect(cursor.startIndex(['a', 'b', 'c'])).toBe(1)
  })

  it('🔴 resets when the member list changes', () => {
    // An index is only meaningful against one list. Adding, removing or reordering members must
    // not leave the cursor pointing at a different channel than the one that failed.
    const cursor = new SupplyCursor()
    cursor.startIndex(['a', 'b', 'c'])
    cursor.advance('a', 'b', 'QUOTA', 1000, 1)
    expect(cursor.startIndex(['a', 'b', 'c'])).toBe(1)

    // Reordered: same members, different meaning for index 1.
    expect(cursor.startIndex(['b', 'a', 'c'])).toBe(0)
    // Added.
    cursor.advance('b', 'a', 'QUOTA', 2000, 1)
    expect(cursor.startIndex(['b', 'a', 'c', 'd'])).toBe(0)
  })

  it('records the last switch for the panel to explain', () => {
    const cursor = new SupplyCursor()
    cursor.startIndex(['a', 'b'])
    cursor.advance('a', 'b', 'QUOTA', 4242, 1)
    expect(cursor.last).toEqual({ from: 'a', to: 'b', code: 'QUOTA', atMs: 4242 })
    expect(cursor.index).toBe(1)
  })

  it('reset() returns to the first member and forgets the switch', () => {
    // Owner-facing 「从第 1 位重新开始」: topping up a relay should not require a host restart.
    const cursor = new SupplyCursor()
    cursor.startIndex(['a', 'b'])
    cursor.advance('a', 'b', 'QUOTA', 1000, 1)
    cursor.reset()
    expect(cursor.index).toBe(0)
    expect(cursor.last).toBeUndefined()
    expect(cursor.startIndex(['a', 'b'])).toBe(0)
  })

  it('an empty member list is inert rather than throwing', () => {
    const cursor = new SupplyCursor()
    expect(cursor.startIndex([])).toBe(0)
  })
})
