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
import type { ChannelsResponse, StatsResponse } from './panel-api.js'
import { SUPPLY_GROUP_ID, currentProviderLabel, formatTokens } from './panel-api.js'
import './UsageBadge.css'

/**
 * The sidebar footer seat — declared here because the pinned host types do not contain it.
 *
 * 🔴 Why a local declaration is legitimate rather than a fabrication: `SlotMap` in
 * `@deepseek-ai/dsh-client-ui-slots` is an **empty table merged by each slot owner** (its own doc
 * comment says so, `lib/types/index.d.ts:16-18`). The sidebar is declared by
 * `@deepseek-ai/dsh-client-ui-sidebar`, a **host runtime package this repo does not pin** — the
 * profile runs host 1.106.0 while our devDependencies hold 0.2.1-rc.2, so its augmentation is not
 * part of this program.
 *
 * ⚠️ **The shape is measured, not invented**: `specOf('sidebar.footer.action')` in the live browser
 * returned `{ kind: 'list', scope: 'root' }`, with `cordis-panel` as its existing occupant. A `list`
 * slot requires `options.id` at register time (`dsh-client-ui-slots/lib/index.js:181-186`), which is
 * why the registration in `index.ts` passes one.
 *
 * ⛔ **Known staleness risk, stated rather than hidden**: if the host changes this seat's kind or
 * scope, this table goes stale SILENTLY — the type keeps compiling while the runtime rejects the
 * entry. That is exactly why the seat is also verified against the live registry (decision 68), and
 * why a refused registration now logs (decision 66) instead of vanishing.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.footer.action': {
      kind: 'list'
      scope: 'root'
    }
  }
}

/** What the plugin's `apply` hands this component. */
export interface UsageBadgeInjected {
  /** Today's usage, in the counting convention described above. */
  loadToday: () => Promise<StatsResponse>
  /** The channel list, which carries the id currently serving requests (owner 2026-11-03). */
  loadChannels: () => Promise<ChannelsResponse>
}

/**
 * Refresh cadence: **five minutes**.
 *
 * 🔴 Owner set this on 2026-11-01 ("每5分钟刷新一次值"). It replaces the earlier one-minute value,
 * which was my own guess. The trade is stated rather than hidden: a figure can be up to five
 * minutes stale, and in exchange the badge stops being a meaningful load on a route that reads the
 * whole month's ledger files on every call.
 *
 * ⚠️ Why this is a named constant and not a literal at the call site: it is the ONE number that
 * decides how stale the screen is, and a reader asking "how current is this?" must be able to find
 * it without reading the component body. It is asserted in `tests/UsageBadge.test.ts` so that a
 * future edit cannot quietly change the cadence the owner asked for.
 */
export const USAGE_BADGE_REFRESH_MS = 300_000

/**
 * Refresh cadence for the PROVIDER line: **fifteen seconds**.
 *
 * 🔴 Owner report (2026-11-18): 「我设定不用供应组不生效了好像」 — the switch HAD taken effect (the ledger
 * proved it: within a minute the requests were all on the newly chosen channel), but this line still
 * named the old supplier, because it shares the 5-minute refresh above.
 *
 * ⚠️ **Why the two facts cannot share one cadence, stated as the reason the numbers differ**: the
 * usage figure is expensive — `/stats` reads the whole month's ledger files — and it is a DAILY
 * cumulative, so a five-minute lag changes it by a rounding error. The provider name is cheap — one
 * `/channels` read, no ledger — and it is instantaneous: the moment it is wrong, the reader believes
 * their selection did not apply, which is exactly what happened.
 *
 * ⇒ Two facts, two costs, two cadences. Coupling them was the bug; unifying them would only move it.
 *
 * 📌 **Residual staleness: up to 15 seconds, and it is real.** Not "instant": say what is true. A
 * focus / tab-switch also triggers an immediate read, which covers the common "I just changed it,
 * let me look at the corner" path.
 */
export const PROVIDER_REFRESH_MS = 15_000

/**
 * The visible label, in words, so the number is not ambiguous.
 *
 * 🔴 Owner asked for this on 2026-11-01 ("显示的内容多几个字，注明是今日 token 消耗"): a bare
 * `1465.2M` beside an account row could be read as anything — balance, quota, spend, requests.
 * A figure whose meaning has to be guessed is worse than no figure, because it invites a wrong
 * conclusion at a glance.
 *
 * ⚠️ It says 消耗 (consumed) while the tooltip and the ledger say 计费输入 (billable input). Both
 * name the SAME quantity — see the module note: uncached + cache read + cache write. 消耗 is the
 * reader-facing word, 计费输入 is the accounting term; they are not two conventions.
 */
export const USAGE_BADGE_LABEL = '今日 Token 消耗'

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
export type UsageBadgeProps = PropsRuntime<'sidebar.footer.action'> & UsageBadgeInjected

/**
 * The header badge.
 *
 * Renders `null` until a figure exists — see the three-states note above. The title attribute is
 * the one concession to discoverability: it states the convention and the day in words, because a
 * bare `1.38B` in a header is ambiguous about both.
 * @param props - slot runtime share and the injected loader.
 * @returns the badge, or null while there is nothing honest to show.
 */
export function UsageBadge({ loadToday, loadChannels }: UsageBadgeProps): React.ReactElement | null {
  const [value, setValue] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [day, setDay] = useState<string>(() => localDayKey())
  const [channels, setChannels] = useState<ChannelsResponse | undefined>(undefined)
  const alive = useRef(true)

  /** One read of the usage figure. Failures land in `failed`, never in `value`. */
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

  /**
   * One read of the PROVIDER line, on its own faster cadence.
   *
   * 🔴 Split from {@link read} on 2026-11-18 (owner report). The two facts used to share one timer
   * and that is exactly how the sidebar came to name a supplier that had already been switched away
   * from: the selection is instantaneous, the usage figure is a daily cumulative.
   *
   * ⚠️ **A failure keeps the last known name; it does not blank the line.** This is why the loader
   * is strict (`fetchChannelsStrict`) rather than the lenient `fetchChannels` the panel uses: that
   * one answers a dead route with an EMPTY list, which has no `current`, which renders as nothing.
   * At a 15-second cadence the lenient shape would make the line disappear thousands of times a day
   * — turning the fix into the same class of defect it was written to remove.
   */
  const readProvider = useCallback(async (): Promise<void> => {
    try {
      const response = await loadChannels()
      if (alive.current) setChannels(response)
    } catch {
      // Deliberately silent: the last known name stays on screen. Unlike the figure there is no
      // "unknown" state that would be MORE honest here — a name that was true 15 seconds ago is
      // still far better than a blank row, and `currentProviderLabel` handles the genuinely empty
      // configuration cases on its own.
    }
  }, [loadChannels])

  useEffect(() => {
    alive.current = true
    void read()
    void readProvider()
    // 🔴 Two timers, deliberately (see PROVIDER_REFRESH_MS): the figure is expensive and cumulative,
    // the provider name is cheap and instantaneous. A single timer necessarily serves one of them
    // badly — and it served the provider badly first, which is what the owner saw.
    const usageTimer = setInterval(() => { void read() }, USAGE_BADGE_REFRESH_MS)
    const providerTimer = setInterval(() => { void readProvider() }, PROVIDER_REFRESH_MS)
    return () => {
      alive.current = false
      clearInterval(usageTimer)
      clearInterval(providerTimer)
    }
  }, [read, readProvider])

  /**
   * Re-read the provider the moment the tab regains attention.
   *
   * 📌 This is the path that actually covers the owner's workflow: switch the channel in Settings,
   * come back to the conversation, glance at the corner. Waiting up to 15 seconds for a timer would
   * still look like "the switch did not take" — the same misreading, just shorter.
   *
   * ⚠️ It refreshes the PROVIDER only. Re-reading the ledger on every focus would turn a cosmetic
   * seat into a file-reading poll driven by the user's tab switching.
   */
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void readProvider()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [readProvider])

  // One place decides the state; the markup only renders it. Splitting the judgement across the
  // JSX is how the "unknown renders as 0" defect would sneak back in untested.
  const state = badgeState(value, failed)

  /**
   * The provider line, or nothing.
   *
   * 🔴 Owner request 2026-11-03 (with the screenshot): show the current provider here so switching
   * relays does not require opening Settings. Owner constraint the same day: 「左下角空间小，字少点，
   * 表意明确即可」 — so this renders the channel's OWN LABEL and nothing else. No 「当前供应商：」
   * prefix: that phrase would eat 6 of the row's ~20 characters to say what the position already
   * says, and the row would then truncate the part the reader actually needs.
   *
   * Silence when nothing is selected — the model picker above already shows an unset state, and a
   * second red line about it would be noise. It is NOT silence for a dangling id: that one is a
   * selection pointing at a channel that no longer exists (see `currentProviderLabel`).
   */
  const provider = currentProviderLabel(channels)

  if (state.kind === 'hidden' && provider === undefined) return null
  return (
    <span className="ad-usageBadge">
      {state.kind === 'hidden'
        ? null
        : (
          <span
            className="ad-usageRow"
            title={state.kind === 'unknown'
              ? '今天还没有读到用量（或用量接口暂时不可用）'
              : `${day} 计费输入 ${state.tokens.toLocaleString()} tokens（未命中 + 缓存读 + 缓存写）`}
          >
            <span className="ad-usageDot" aria-hidden="true" />
            {/* Label BEFORE the figure: the owner reads "今日 Token 消耗 1465.2M" left to right,
                and a label after the number would read as a unit suffix. */}
            <span className="ad-usageLabel">{USAGE_BADGE_LABEL}</span>
            <span className="ad-usageNum">
              {state.kind === 'unknown' ? '—' : formatTokens(state.tokens)}
            </span>
          </span>
        )}
      {provider === undefined
        ? null
        : (
          <span
            className="ad-usageRow ad-providerRow"
            title={
              channels?.supply?.viaFallback === true && channels.current !== SUPPLY_GROUP_ID
                ? '当前供应商：你选的渠道没有余额了，请求已自动改由供应组承担。'
                  + '把那个渠道充值后它会立刻回到使用（不用任何操作）。'
                : '当前供应商（请求正在走的那个渠道）。最多 15 秒延迟；切换渠道后回到本窗口会立刻重读。'
            }
          >
            <span className="ad-usageDot ad-providerDot" aria-hidden="true" />
            <span className="ad-providerName">{provider}</span>
          </span>
        )}
    </span>
  )
}