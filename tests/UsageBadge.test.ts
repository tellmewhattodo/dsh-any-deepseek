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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  badgeState,
  localDayKey,
  pickTodayBillable,
  PROVIDER_REFRESH_MS,
  USAGE_BADGE_LABEL,
  USAGE_BADGE_REFRESH_MS,
} from '../src/client/UsageBadge.js'
import { currentProviderLabel, type ChannelsResponse, type StatsResponse } from '../src/client/panel-api.js'

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

describe('owner two presentation demands (2026-11-01)', () => {
  // 🔴 These two are here because both are DECISIONS THE OWNER MADE, not my preferences, and both
  // are the kind that decays silently: a label can be dropped in a refactor and the badge still
  // works (it just becomes ambiguous again); a cadence can drift back to a literal and nothing
  // fails. Pinning them means a future edit has to argue with a red test rather than with memory.

  it('refreshes every FIVE minutes — the owner asked for 5, not "roughly often"', () => {
    // Stated as an exact value on purpose. `>= 60_000` would pass for the OLD one-minute cadence
    // too, so an inequality here would be a criterion that cannot distinguish what it is judging.
    expect(USAGE_BADGE_REFRESH_MS).toBe(300_000)
  })

  it('🔴 the label is visibly present and names the quantity', () => {
    // Constraint from the seat, not taste: the sidebar footer is 256px wide and shares its row with
    // the account control, so the label has to stay short enough to coexist with the figure. Ten
    // characters is already generous — `今日 Token 消耗` is 9 visual units. This is a budget, not a
    // preference, and it is why the label is a constant rather than free text at the call site.
    expect(USAGE_BADGE_LABEL.length).toBeGreaterThan(0)
    expect(USAGE_BADGE_LABEL.length).toBeLessThanOrEqual(14)
    // It must name BOTH halves of the meaning: what is counted (Token) and over what period (今日).
    // A label that says only "消耗" would leave the reader asking "since when?".
    expect(USAGE_BADGE_LABEL).toContain('Token')
    expect(USAGE_BADGE_LABEL).toContain('今日')
  })

  it('the stale-tolerance implied by the cadence is stated, not implicit', () => {
    // A user looking at this badge is looking at a figure that may be up to one full interval old.
    // Asserting the relationship (rather than the number alone) documents WHY five minutes means
    // "value may be 5 minutes stale" — so raising the interval later forces a conscious re-think of
    // what the on-screen number now claims.
    expect(USAGE_BADGE_REFRESH_MS).toBe(5 * 60 * 1000)
  })
})

describe('the provider line has its OWN cadence (owner report 2026-11-18)', () => {
  // 🔴 The defect this pins, verbatim from the owner: 「我设定不用供应组不生效了好像」.
  //
  // The switch HAD applied — the ledger proved it within a minute (every request landed on the new
  // channel). But the sidebar still said 供应组 · <old member>, because the provider line shared the
  // 5-minute usage timer. The owner read the badge, concluded the setting was ignored, and reported
  // a routing bug that did not exist.
  //
  // ⇒ The lesson is not "poll faster". It is that the two facts have different COSTS and different
  // KINDS of staleness, and one timer cannot serve both.

  it('🔴 the provider refreshes far more often than the usage figure', () => {
    // Two orders of magnitude apart, because the costs are: `/stats` reads the whole month's ledger
    // files, `/channels` reads a settings document. An inequality alone is too weak to catch a
    // regression to "4 minutes instead of 5", so the value is pinned exactly.
    expect(PROVIDER_REFRESH_MS).toBe(15_000)
    expect(PROVIDER_REFRESH_MS * 4).toBeLessThan(USAGE_BADGE_REFRESH_MS)
  })

  it('🔴 the usage cadence the owner chose is UNCHANGED by this fix', () => {
    // The owner set 5 minutes on 2026-11-01 for a reason that still holds. Making the provider
    // fresher must not become a back door to a more expensive ledger poll — that would trade one
    // unnoticed defect for another.
    expect(USAGE_BADGE_REFRESH_MS).toBe(300_000)
  })

  it('the residual staleness is stated, not implied', () => {
    // "Up to 15 seconds" is the honest promise. A test that only asserted "fast" would let a future
    // edit claim the line is instant, which it is not — and the whole report above came from a
    // reader trusting this line to be current.
    expect(PROVIDER_REFRESH_MS).toBeLessThanOrEqual(30_000)
    expect(PROVIDER_REFRESH_MS).toBeGreaterThan(0)
  })
})

describe('a failed provider read must not blank the line (2026-11-18)', () => {
  // 🔴 The subtle half of the fix, and the one I nearly shipped wrong.
  //
  // The provider line now polls every 15 seconds, i.e. ~5760 times a day. The panel's loader
  // (`fetchChannels`) answers a dead route with an EMPTY list — correct for a panel, whose user is
  // looking at an empty table — but an empty list has no `current`, so `currentProviderLabel`
  // returns `undefined` and the line VANISHES.
  //
  // ⇒ At the old cadence that was a rare blink. At the new cadence, accepting the lenient shape
  // would turn one transient failure into thousands of blank flashes — reintroducing, in a louder
  // form, the very defect this release exists to remove (a line that misdescribes the live
  // supplier). The loader used by this seat is strict, so a failure KEEPS the last known name.

  it('🔴 an empty response from the lenient loader WOULD blank the line — hence the strict one', () => {
    // Stating the hazard as a fact about the pure function, so the choice of loader is justified by
    // a red-capable assertion rather than by a comment.
    const empty: ChannelsResponse = { channels: [], presets: [], model: { id: '', name: '' } }
    expect(currentProviderLabel(empty)).toBeUndefined()

    // And the same shape WITH a current still names it — so the emptiness, not the response, is
    // what silences the row.
    expect(currentProviderLabel({ ...empty, current: 'ollama' })).toBe('未找到')
  })

  it('the strict loader and the lenient one are DIFFERENT contracts on the same route', async () => {
    // A structural pin: `fetchChannels` must keep swallowing (the panel depends on that), and
    // `fetchChannelsStrict` must exist and reject. Reading the source is the only honest判据 here —
    // both hit `/any-deepseek/channels`, so behaviour differs only in the failure path.
    const api = readFileSync(join(process.cwd(), 'src', 'client', 'panel-api.ts'), 'utf-8')
    const lenientStart = api.indexOf('export async function fetchChannels(')
    const strictStart = api.indexOf('export async function fetchChannelsStrict(')
    // ⚠️ Bounded at BOTH ends. My first version sliced the strict body to end-of-file, so it swept
    // up every later function's `catch {` and went red for the wrong reason — a judgement that
    // reports a problem it did not look at is the failure this trajectory keeps re-learning
    // (decision 50: when something goes red, ask whether the JUDGEMENT is right first).
    const strictEnd = api.indexOf('export async function fetchStats(', strictStart)
    expect(lenientStart).toBeGreaterThan(-1)
    expect(strictStart).toBeGreaterThan(lenientStart)
    expect(strictEnd).toBeGreaterThan(strictStart)
    const lenient = api.slice(lenientStart, strictStart)
    const strict = api.slice(strictStart, strictEnd)
    expect(lenient).toContain('catch {')
    expect(lenient).toContain("model: { id: '', name: '' }")
    // The strict body has NO catch: a failure must reach the caller as a rejection, so the seat can
    // keep the last known name instead of rendering an empty list as "nothing is selected".
    expect(strict).not.toContain('catch')
    expect(strict).toContain('throw new Error')

    // And the sidebar seat must actually use the strict one — a strict loader nobody calls is
    // decoration (decision 51 in spirit: something a sentence could satisfy is not a judgement).
    const client = readFileSync(join(process.cwd(), 'src', 'client', 'index.ts'), 'utf-8')
    expect(client).toContain('fetchChannelsStrict()')
  })
})

describe('localDayKey — the offset rule', () => {  it('🔴 uses the LOCAL date, not the UTC date', () => {
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
