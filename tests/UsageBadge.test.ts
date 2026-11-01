/**
 * UsageBadge.test.ts — the header badge's counting convention and its refusal to invent a zero.
 *
 * Two classes of assertion here, and the second is the one worth keeping:
 *
 *  1. **Which figure it reads.** Owner chose 计费输入 (uncached + cache read + cache write) on
 *     2026-11-01. On a real day the three input columns differ by ~100×, so reading the wrong one
 *     is not a rounding difference — it is a different claim about what the month cost.
 *  2. **What it does when it cannot read.** A missing reading must never render as `0.0M`. This is
 *     the decision 45/47 discipline applied to a badge: "spent nothing" and "could not ask" look
 *     identical on screen and only one of them is actionable.
 *
 * Both are pinned at the pure-function layer (`pickTodayBillable`, `localDayKey`) because the
 * badge is a thin renderer over them; the render itself is verified in a real browser, which is
 * the only place a header ornament's actual appearance can be judged.
 */

import { describe, expect, it } from 'vitest'
import { badgeState, localDayKey, pickTodayBillable } from '../src/client/UsageBadge.js'
import type { StatsResponse } from '../src/client/panel-api.js'

/** A stats response with one day row, built so the three input columns are far apart. */
function statsWith(rows: Array<{ key: string; input: number; cacheRead: number; cacheWrite: number }>): StatsResponse {
  return {
    range: { from: null, to: null, group: 'day' },
    rows: rows.map((row) => ({
      key: row.key,
      label: row.key,
      aggregate: {
        requests: 1,
        failures: 0,
        unreported: 0,
        input: row.input,
        output: 0,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        reasoning: 0,
        billableInput: row.input + row.cacheRead + row.cacheWrite,
        total: row.input + row.cacheRead + row.cacheWrite,
      },
    })),
    total: {
      requests: 0, failures: 0, unreported: 0, input: 0, output: 0,
      cacheRead: 0, cacheWrite: 0, reasoning: 0, billableInput: 0, total: 0,
    },
  }
}

describe('pickTodayBillable — the counting convention', () => {
  it('🔴 reads BILLABLE input (uncached + cacheRead + cacheWrite), not the bare `input` column', () => {
    // The real 2026-10-27 row: input 13.0M, cacheRead 1369.1M ⇒ billable 1382.2M. Reading `input`
    // would show 13.0M, a figure 100× too small, while looking entirely plausible.
    const stats = statsWith([{ key: '2026-10-27', input: 13_032_583, cacheRead: 1_369_142_528, cacheWrite: 0 }])
    expect(pickTodayBillable(stats, '2026-10-27')).toBe(13_032_583 + 1_369_142_528)
  })

  it('picks the row by DATE KEY, not by position — first row is not necessarily today', () => {
    // Ordering is newest-first today, but that is a display decision (decision on 2026-10-27),
    // not a contract this badge may lean on. If it took rows[0], a change to the ordering would
    // silently make the badge report yesterday.
    const stats = statsWith([
      { key: '2026-10-27', input: 10, cacheRead: 0, cacheWrite: 0 },
      { key: '2026-11-01', input: 42, cacheRead: 8, cacheWrite: 2 },
    ])
    expect(pickTodayBillable(stats, '2026-11-01')).toBe(52)
  })

  it('🔴 returns undefined when today has no row — the caller must render "unknown", not 0', () => {
    const stats = statsWith([{ key: '2026-10-31', input: 10, cacheRead: 0, cacheWrite: 0 }])
    expect(pickTodayBillable(stats, '2026-11-01')).toBeUndefined()
  })

  it('returns undefined while still loading (null response)', () => {
    expect(pickTodayBillable(null, '2026-11-01')).toBeUndefined()
  })

  it('a genuine zero day is a real 0, not undefined — the two are different facts', () => {
    // A day that had traffic but reported zero billable input is a reading. The badge shows `0`.
    // A day with NO row is unread, and the badge shows an em dash. Collapsing these would make
    // the failure state indistinguishable from a quiet day.
    const stats = statsWith([{ key: '2026-11-01', input: 0, cacheRead: 0, cacheWrite: 0 }])
    expect(pickTodayBillable(stats, '2026-11-01')).toBe(0)
  })
})

describe('badgeState — the three-state rule', () => {
  // 🔴 These exist because of a MEASURED gap. The three-state rule was first written only inside
  // the component; injecting "unknown renders as 0" left all eight tests green. The badge's most
  // important promise had nothing standing on it.

  it('🔴 an unreadable figure is `unknown`, never `value: 0`', () => {
    // The whole point: "could not ask" and "spent nothing" must not look the same.
    expect(badgeState(null, true)).toEqual({ kind: 'unknown' })
  })

  it('🔴 a genuine zero IS a value — 0 is a reading, absence is not', () => {
    // The mirror image of the test above. If this ever collapses into `unknown`, a real quiet day
    // would report as unmeasurable, and the reader would go looking for a broken route.
    expect(badgeState(0, false)).toEqual({ kind: 'value', tokens: 0 })
  })

  it('renders nothing before the first read completes', () => {
    // Not `unknown`: nothing has been attempted yet, so an em dash would claim a failure that has
    // not happened. This is the state that made `0.0M` flash on load in the first draft.
    expect(badgeState(null, false)).toEqual({ kind: 'hidden' })
  })

  it('a stale-but-good value outranks a later failure', () => {
    // If a refresh fails after a successful read, the last known figure stays on screen. Replacing
    // a real reading with an em dash because one poll failed would make the badge flicker for a
    // transient network blip.
    expect(badgeState(1234, true)).toEqual({ kind: 'value', tokens: 1234 })
  })
})

describe('localDayKey — the offset rule', () => {
  it('🔴 uses the LOCAL date, not the UTC date', () => {
    // The trap: `toISOString().slice(0,10)` is UTC. For a user at UTC+8, 07:00 local on 11-01 is
    // 23:00 UTC on 10-31, so the UTC form would name the previous day and today's spend would be
    // attributed to yesterday for the first eight hours of every single day.
    const morning = new Date(2026, 10, 1, 7, 0, 0) // local 2026-11-01 07:00
    expect(localDayKey(morning)).toBe('2026-11-01')
  })

  it('pads month and day to two digits so keys compare as strings', () => {
    expect(localDayKey(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05')
  })

  it('handles the late-evening edge that the UTC form gets wrong', () => {
    const late = new Date(2026, 10, 1, 23, 30, 0) // local 2026-11-01 23:30
    expect(localDayKey(late)).toBe('2026-11-01')
  })
})
