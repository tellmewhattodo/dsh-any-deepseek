/**
 * client/UsageBadge.tsx — today's input tokens, in the header's leading seat.
 *
 * ## What it is for
 *
 * Owner request 2026-11-01: 「在 dsh 左上角合适的地方放个用量图标，显示当天的输入统计，单位 M」.
 * The panel answers "what did each relay cost" but you have to open Settings to ask it. This puts
 * ONE number where it is seen without asking — the header, before the Session title.
 *
 * ## The counting convention is a decision, not an accident
 *
 * 🔴 **`billableInput`, not `input`.** The ledger carries three input figures and on a real day
 * (2026-10-27) they differ by two orders of magnitude: `input` 13.0M, `cacheRead` 1369M,
 * `billableInput` 1382M. Owner chose BILLABLE (uncached + cache read + cache write) on 2026-11-01.
 *
 * This is the same number the panel's footer describes as 「三者相加才是计费输入」, so the badge and
 * the panel cannot disagree about what "input" means. A second convention invented here would be
 * the failure this plugin has already paid for twice (decision 19: docs said default, code said
 * required; decision 51: a preset claimed text-only while the record said otherwise).
 *
 * ## Three states, and why `0.0M` is never one of them
 *
 *  · **loading** — nothing rendered yet. Rendering `0.0M` first and correcting it later makes the
 *    reader believe a number that was never read.
 *  · **unknown** — the request failed. `—`, never `0.0M`: decision 45/47 discipline — a missing
 *    reading must not render as a zero, because "zero spend" and "could not ask" look identical
 *    and only one of them is actionable.
 *  · **value** — the real figure, e.g. `1.38B`.
 *
 * ## Why it is not interactive
 *
 * Owner chose 「只要一个数字，不要任何交互」. So this is a `<span>`, not a button: no click target,
 * no hover card, no focus ring. The cost is stated in the docs — the badge answers "how much
 * today", and any further question still needs theSettings page.
 *
 * ## Why it does not depend on the settings service
 *
 * The panel registers inside `configForms.whileServed` (decision 22: without the settings document
 * the panel used to vanish silently). The badge must NOT inherit that coupling: it reads its own
 * HTTP route and has nothing to do with the settings form. A deployment whose settings service is
 * late, absent, or refused would otherwise lose the badge with no trace — the exact silent shape
 * decision 22 was written to remove.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 🔴 The `conversation.header.leading` slot name exists in the SlotMap only when this package's
// client entry is in the program. See the longer note in `index.ts`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StatsResponse } from './panel-api.js'
import { formatTokens } from './panel-api.js'
import './UsageBadge.css'

/** What the plugin's `apply` hands this component. */
export interface UsageBadgeInjected {
  /** Today's usage, in the counting convention described above. */
  loadToday: () => Promise<StatsResponse>
}

/** Refresh cadence. Slow on purpose — see the note at the call site. */
export const USAGE_BADGE_REFRESH_MS = 60_000

/**
 * Extract today's billable input from a stats response.
 *
 * The response groups by day, so the row whose key is today's `YYYY-MM-DD` carries it. Matching on
 * the key rather than taking `rows[0]` matters: the ordering is newest-first but that is a display
 * decision that may change, and "first row" would silently start meaning yesterday.
 *
 * @param stats - the response, or null while loading.
 * @param today - `YYYY-MM-DD` in the browser's own offset.
 * @returns the figure, or undefined when the response has no such row.
 */
export function pickTodayBillable(
  stats: StatsResponse | null,
  today: string,
): number | undefined {
  if (stats === null) return undefined
  const row = stats.rows.find((candidate) => candidate.key === today)
  return row?.aggregate.billableInput
}

/**
 * Today's date as `YYYY-MM-DD`, in this browser's timezone.
 *
 * Built from local getters, NOT `toISOString().slice(0, 10)`: the latter is UTC, so for a user at
 * UTC+8 it would report yesterday until 08:00 and today's spend would be attributed to the wrong
 * day for eight hours every morning. The ledger writes its keys with the same local-offset rule
 * (`usage-ledger.ts` {@link dayKey}), so this is the matching reader.
 * @param now - clock, injectable for tests.
 * @returns e.g. `2026-11-01`.
 */
export function localDayKey(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * What the badge should show for one read.
 *
 * 🔴 Extracted to a pure function because of a MEASURED gap: the three-state rule was first
 * written only inside the component, and injecting "unknown renders as 0" left all eight tests
 * green. The most important promise this file makes had no test standing on it — decision 57 in
 * the trajectory, met again here: a case must live on the layer that is the only thing able to
 * fail.
 *
 * @param value - the figure from {@link pickTodayBillable}, or null when absent.
 * @param failed - whether the read itself failed.
 * @returns which of the three states the badge is in.
 */
export type BadgeState =
  | { kind: 'hidden' }
  | { kind: 'unknown' }
  | { kind: 'value'; tokens: number }

export function badgeState(value: number | null, failed: boolean): BadgeState {
  if (value !== null) return { kind: 'value', tokens: value }
  // No figure. The read failed, or today has no row — either way there is no reading, and the
  // badge says so with an em dash. It must NEVER say `0`: see the module note.
  if (failed) return { kind: 'unknown' }
  return { kind: 'hidden' }
}

/** Badge props: the slot's runtime share plus this plugin's injected face. */
export type UsageBadgeProps = PropsRuntime<'conversation.header.leading'> & UsageBadgeInjected

/**
 * The header badge.
 *
 * Renders `null` until a figure exists — see the three-states note above. The title attribute is
 * the one concession to discoverability: it states the convention and the day in words, because a
 * bare `1.38B` in a header is ambiguous about both.
 * @param props - slot runtime share and the injected loader.
 * @returns the badge, or null while there is nothing honest to show.
 */
export function UsageBadge({ loadToday }: UsageBadgeProps): React.ReactElement | null {
  const [value, setValue] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [day, setDay] = useState<string>(() => localDayKey())
  const alive = useRef(true)

  /** One read. Failures land in `failed`, never in `value`. */
  const read = useCallback(async (): Promise<void> => {
    const today = localDayKey()
    try {
      const stats = await loadToday()
      if (!alive.current) return
      setDay(today)
      const figure = pickTodayBillable(stats, today)
      // 🔴 `undefined` (no row for today) stays unknown rather than becoming 0: a day with no
      // requests and a failed read are different facts, and the badge cannot tell them apart from
      // an empty response alone. The route returns a real zero row for a day that had traffic.
      if (figure === undefined) {
        setValue(null)
        setFailed(true)
        return
      }
      setValue(figure)
      setFailed(false)
    } catch {
      if (!alive.current) return
      setFailed(true)
    }
  }, [loadToday])

  useEffect(() => {
    alive.current = true
    void read()
    // 🔴 One minute, not one second: this is a header ornament, and every tick is a request
    // against a route that reads the whole month's ledger files. A number that is at most a
    // minute stale is worth far more than four hundred extra file reads an hour.
    const timer = setInterval(() => { void read() }, USAGE_BADGE_REFRESH_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [read])

  // One place decides the state; the markup only renders it. Splitting the judgement across the
  // JSX is how the "unknown renders as 0" defect would sneak back in untested.
  const state = badgeState(value, failed)
  if (state.kind === 'hidden') return null
  if (state.kind === 'unknown') {
    return (
      <span className="ad-usageBadge" title="今天还没有读到用量（或用量接口暂时不可用）">
        <span className="ad-usageDot" aria-hidden="true" />
        <span className="ad-usageNum">—</span>
      </span>
    )
  }
  return (
    <span
      className="ad-usageBadge"
      title={`${day} 计费输入 ${state.tokens.toLocaleString()} tokens（未命中 + 缓存读 + 缓存写）`}
    >
      <span className="ad-usageDot" aria-hidden="true" />
      <span className="ad-usageNum">{formatTokens(state.tokens)}</span>
    </span>
  )
}