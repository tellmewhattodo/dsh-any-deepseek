/**
 * client/panel-api.ts — same-origin fetch wrappers for the panel.
 *
 * Kept separate from the component so the component stays about rendering, and so the wire
 * shapes are in one place. Every call degrades to a typed failure rather than throwing into
 * React: a panel that crashes on a missing route is worse than one that says "unavailable".
 */

/** One channel as the panel renders it. */
export interface ChannelRow {
  id: string
  label: string
  model: string
  api: string
  baseURL: string
  contextWindow: number
  maxTokens: number
  input: string[]
  warnings: string[]
  keyConfigured: boolean
  keySource?: string
  /**
   * Where this channel's key lives.
   *
   * `literal` — stored in the channel entry; the panel can read and rewrite it.
   * `reference` — a name resolved by the harness; the panel can only learn whether it exists.
   * `none` — nothing configured yet.
   */
  keyKind: 'literal' | 'reference' | 'none'
  /** The reference name, present only when {@link keyKind} is `reference`. */
  keyRef?: string
}

/**
 * The supply group, as the runtime actually sees it.
 *
 * 🔴 **This is NOT a copy of the settings field.** `members` matches the document, but `serving`,
 * `position` and `lastSwitch` describe what the ROUTER has done — the sticky cursor lives in
 * memory (see `failover.ts` for why it is never persisted). Keeping both in one shape lets the
 * panel say "the group is serving, currently at member 2, because member 1 returned QUOTA" from a
 * single response.
 */
export interface SupplyState {
  /** Configured member ids, in trial order, exactly as stored. */
  members: string[]
  /**
   * Members that name no configured channel.
   *
   * Shown rather than silently dropped: the router skips them to stay online, but a stale id is a
   * configuration the user must fix, and a group that silently shrinks is how a "three-relay group"
   * quietly becomes a one-relay group.
   */
  dangling: string[]
  /** The member the next request starts from; absent when the group has no resolvable members. */
  serving?: string
  /** Zero-based position of {@link serving} within the resolvable members. */
  position: number
  /** The most recent switch since the last reset. */
  lastSwitch?: { from: string; to: string; code: string; atMs: number }
}

/** `/any-deepseek/channels` response. */
export interface ChannelsResponse {
  channels: ChannelRow[]
  presets: Array<{ id: string; displayName: string }>
  model: { id: string; name: string }
  /**
   * The channel id currently serving requests (owner request 2026-11-03), or the
   * {@link SUPPLY_GROUP_ID} sentinel when the supply group is serving.
   *
   * Absent — not empty — when nothing is selected. The sidebar distinguishes "no provider chosen"
   * from "a provider named ''", because the first is a setup state the reader can fix and the
   * second is a malformed config.
   */
  current?: string
  /** The supply group's runtime state; absent on a host build that predates the feature. */
  supply?: SupplyState
}

/**
 * The `current` sentinel meaning "the supply group serves requests".
 *
 * ⚠️ Must match `SUPPLY_GROUP_ID` in `src/config.ts`. It is duplicated rather than imported
 * because that module pulls in schemastery and the node runtime; the client bundle must not carry
 * either. The value is asserted in a test so the two cannot drift silently.
 */
export const SUPPLY_GROUP_ID = '__group__'

/**
 * The label the sidebar shows for the live supplier.
 *
 * 🔴 Owner request 2026-11-03: the sidebar should name the live provider so it does not require
 * opening Settings. Owner constraint the same day: 「左下角空间小，字少点，表意明确即可」 — the seat is
 * 256px wide and already carries a usage figure, so this returns the SHORTEST true sentence:
 * just the channel's own label, with no 「当前供应商：」 prefix on every line.
 *
 * 🟢 Owner request 2026-11-12 extended this to the supply group (「给用户供应组是一种选择的感觉」):
 * when the group is serving, the answer is not one channel but "the group, currently on X". That
 * fact is shown as `供应组 · <label>` — 4 characters of prefix, which fits the 256px seat, and names
 * BOTH truths: a group is in charge, and this is who it is talking to right now.
 *
 * Four states, kept distinct for the same reason the balance row does it:
 *  · `供应组 · 名字` when the group serves and its current member resolves;
 *  · `供应组` alone when the group serves but has no resolvable member yet (a setup state);
 *  · a label when a channel is selected and found;
 *  · `undefined` when nothing is selected — the caller renders nothing, because "no provider" is
 *    already visible as the model picker being unset and a red line here would be noise;
 *  · `未找到` when `current` names a channel that no longer exists. That one IS worth a word: only
 *    the user can fix a dangling selection.
 * @param response - the `/channels` body, or undefined before it loads.
 * @returns the short label, or undefined when there is nothing to say.
 */
export function currentProviderLabel(response: ChannelsResponse | undefined): string | undefined {
  if (response === undefined) return undefined
  const id = response.current
  if (id === undefined || id === '') return undefined

  if (id === SUPPLY_GROUP_ID) {
    const serving = response.supply?.serving
    if (serving === undefined) return '供应组'
    const channel = response.channels.find((candidate) => candidate.id === serving)
    // A member the router serves but the list does not describe is a transient read skew; naming
    // the group alone is still true, so do not fall through to `未找到` (that would blame the
    // group for a channel-level problem that does not exist).
    return channel === undefined ? '供应组' : `供应组 · ${channel.label}`
  }

  const channel = response.channels.find((candidate) => candidate.id === id)
  // A dangling selection is a real, fixable problem, so it gets one short word rather than
  // silence — silence would look identical to "nothing configured".
  return channel === undefined ? '未找到' : channel.label
}

/** One aggregate row. Mirrors the ledger's disjoint counting convention. */
export interface StatsRow {
  /**
   * The group key: the channel **id** (or a `YYYY-MM-DD` date).
   *
   * Kept as the row's identity — it is stable across renames — but never rendered on its own:
   * {@link label} is what the reader sees.
   */
  key: string
  /**
   * Human-readable row name, resolved by the server from the live channel list.
   *
   * 🔴 The panel used to print `key` directly, so the usage table showed channel ids (`open-design`)
   * while the channel list above it showed display names (`Open Design-1`) — the same channel under
   * two different names on one screen. Owner report (2026-10-22): 「统计要按显示名称来」.
   *
   * Optional only so an older server response still renders; the panel falls back to `key`.
   */
  label?: string
  /**
   * Output tokens per second over GENERATION time only (total minus time-to-first-token).
   *
   * Owner request (2026-10-22): 「能加上 token 速度统计吗」. The generating half is separated
   * because one combined ratio cannot tell "slow to start" from "slow to generate", and those
   * two call for different fixes.
   *
   * `null`/absent means unmeasurable (nothing in the group carried a first-token measurement).
   * The panel renders an em dash for that, never `0`, which would read as "instant".
   */
  tokensPerSecond?: number | null
  /** Mean tokens per usage-reporting request — the average context size (cost reference). */
  meanContext?: number | null
  /** Mean time to first token, in ms; `null`/absent when nothing was timed. */
  firstTokenMs?: number | null
  aggregate: {
    requests: number
    failures: number
    unreported: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    billableInput: number
    total: number
  }
}

/** `/any-deepseek/stats` response. */
export interface StatsResponse {
  range: { from: string | null; to: string | null; group: string }
  rows: StatsRow[]
  total: StatsRow['aggregate']
  /** Footer throughput, computed server-side from the summed aggregate. */
  totalSpeed?: number | null
  /** Footer mean time to first token, computed server-side from the summed aggregate. */
  totalFirstTokenMs?: number | null
  /** Footer mean context size, computed server-side from the summed aggregate. */
  meanContext?: number | null
  note?: string
}

/** Probe verdict. */
export interface ProbeResult {
  ok: boolean
  ms: number
  code?: string
  message?: string
  responded?: string
}

/** One currency amount, as a balance surface reports it. */
export interface BalanceAmount {
  currency: string
  remaining: number
  allowance?: number
  granted?: number
  toppedUp?: number
}

/** A percentage window (Ollama's legacy plans meter this way instead of money). */
export interface BalanceWindow {
  name: string
  remainingPercent: number
  resetsAt?: string
}

/**
 * One channel's balance row.
 *
 * 🔴 The statuses are deliberately distinct because they call for different actions:
 *  · `ok`          — a number was read;
 *  · `alive`       — no balance API, but a minimal live request succeeded ⇒ the endpoint serves
 *                    and the credit is NOT exhausted. Says nothing about how much is left;
 *  · `unsupported` — this endpoint has no balance API and the liveness check did not run (older
 *                    server, or the channel was skipped);
 *  · `unavailable` — a read was attempted and did not answer as expected;
 *  · `no-key`      — we never got to ask.
 * Collapsing any of them into "0" would claim the account is empty, which is the one reading
 * that would make someone stop using a channel that is fine.
 */
export type BalanceRow =
  | {
    id: string
    label: string
    status: 'ok'
    reading: {
      amounts: BalanceAmount[]
      windows: BalanceWindow[]
      available?: boolean
      note?: string
    }
  }
  | { id: string; label: string; status: 'unsupported' | 'unavailable' | 'no-key'; detail: string; code?: string }
  | {
    id: string
    label: string
    status: 'alive'
    ms: number
    responded?: string
    detail: string
  }

/** `/any-deepseek/balance` response. */
export interface BalanceResponse {
  channels: BalanceRow[]
}

/**
 * Load per-channel balances.
 *
 * Degrades to an empty list rather than throwing: the panel must still render the channel table
 * when this route is missing (an older server, or a deployment without it).
 */
export async function fetchBalances(): Promise<BalanceResponse> {
  try {
    const response = await fetch(`${BASE}/balance`, { headers: { accept: 'application/json' } })
    if (!response.ok) return { channels: [] }
    return (await response.json()) as BalanceResponse
  } catch {
    return { channels: [] }
  }
}

/**
 * How long until an instant, in words a person reads at a glance.
 *
 * 🔴 **Owner request 2026-11-03**: 「对于有时间限的渠道，opencode go 和 ollama 显示 还有多久」.
 * Both channels meter against a clock, but they expose it differently: OpenCode Go attaches
 * `resetsAt` to each of its three windows, Ollama puts the cycle end inside `period.until`. Until
 * now the panel showed `rolling 95%` and `46.76 USD` — a percentage and a dollar figure that say
 * nothing about WHEN the allowance comes back. The reset instant was already in the payload and
 * already parsed into `resetsAt`; it was simply never rendered.
 *
 * ## The three distinctions this function refuses to collapse
 *
 *  1. **Past vs future.** A `resetsAt` in the past means the window has already rolled over and
 *     this reading is a snapshot from before the roll — the number on screen is stale, not zero.
 *     Saying 「已重置」 is honest; saying 「还有 0 分钟」 would claim a reset is imminent forever.
 *  2. **Unknown vs absent.** An unparseable or missing instant is `undefined`, which the caller
 *     renders as nothing. It must not become 「还有 0 分钟」 — that is a reading nobody took.
 *  3. **Granularity by magnitude.** `还有 3 天` is useful; `还有 2,847 分钟` is arithmetic homework.
 *     Days for long horizons, hours for a day, minutes under an hour — the unit follows what the
 *     reader would actually do with the answer.
 *
 * @param resetsAt - the instant the allowance returns, as the provider spelled it.
 * @param now - clock, injectable for tests.
 * @returns e.g. `还有 3 天`, `还有 4 小时`, `还有 12 分钟`, `已重置`; or `undefined` when the
 *          instant is absent or unparseable.
 */
export function formatTimeUntil(resetsAt: string | undefined, now: Date = new Date()): string | undefined {
  if (resetsAt === undefined) return undefined
  const target = Date.parse(resetsAt)
  // A provider that ships a malformed instant is a fact to report as *unknown*, never as *now*.
  if (!Number.isFinite(target)) return undefined
  const deltaMs = target - now.getTime()
  // Already elapsed ⇒ the window rolled. Reporting "0 minutes left" would be permanently wrong;
  // the reading on screen belongs to a cycle that has ended.
  if (deltaMs <= 0) return '已重置'
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `还有 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    // Hours alone under 2 days: "还有 1 天 23 小时" invites the reader to do subtraction to find
    // out that it is basically tomorrow.
    return `还有 ${hours} 小时`
  }
  const days = Math.floor(hours / 24)
  return `还有 ${days} 天`
}

/**
 * Render one balance row as the text a person reads.
 *
 * Deliberately total: every status produces words, never an empty string. A blank cell beside a
 * working channel is indistinguishable from "zero balance" — the one thing this must never imply.
 *
 * 🔴 **`alive` is worded as 「余额未尽」, never as a number.** The check behind it is one minimal
 * live request, which proves the endpoint serves and the account is not blocked for lack of
 * credit. It does not measure an amount, so printing one — or printing `0.00` — would invent the
 * very figure this status exists to avoid inventing (owner directive 2026-10-23: 「不支持查余额的，
 * 改成直接测通，通则说明余额还是有的，没用完」).
 * @param row - one row from `/balance`.
 * @param now - clock, injectable so the time-remaining text can be pinned in tests.
 * @returns a short human label.
 */
export function formatBalance(row: BalanceRow, now: Date = new Date()): string {
  // Narrow on the discriminant FIRST. The non-`ok` arms carry no `reading`, and separate early
  // returns for them do not narrow the union for TypeScript — it still sees `reading` as
  // possibly-absent further down.
  if (row.status === 'alive') {
    // The relay's own model name and the round-trip time are the evidence, so they travel with
    // the verdict: "it answered" is a claim, "it answered as deepseek-flash in 1448ms" is proof.
    const evidence = row.responded === undefined
      ? `${Math.round(row.ms)}ms`
      : `${row.responded} · ${Math.round(row.ms)}ms`
    return `余额未尽（无余额接口，实测可用：${evidence}）`
  }
  if (row.status !== 'ok') {
    if (row.status === 'no-key') return '未配置密钥'
    // 🔴 A quota failure is an ANSWER, not an error: it is the liveness check reporting that the
    // account is out of credit. Rendering it as 「读取失败」 would hide the one fact the check
    // was run to discover.
    if (row.code === 'QUOTA') return '余额不足（实测被拒）'
    if (row.status === 'unavailable') return row.code === 'HTTP_404' ? '不支持查询' : '读取失败'
    return '不支持查询'
  }
  const { amounts, windows, available } = row.reading
  const parts: string[] = []
  for (const amount of amounts) {
    // Two decimals for money: these surfaces quote cents, and rounding to whole units hides the
    // exact margin a low-balance warning exists to show.
    parts.push(`${amount.remaining.toFixed(2)} ${amount.currency}`)
  }
  for (const window of windows) {
    // 🔴 Owner request 2026-11-03: the reset instant travels WITH the percentage. A bare
    // `rolling 95%` answers "how much" and silently drops "until when", which is the half that
    // decides whether the reader can wait it out or must top up now.
    const until = formatTimeUntil(window.resetsAt, now)
    const suffix = until === undefined ? '' : `（${until}）`
    parts.push(`${window.name} ${Math.round(window.remainingPercent)}%${suffix}`)
  }
  // `is_available:false` is the provider saying calls will begin failing — worth one word.
  if (available === false) parts.push('（余额不足）')
  /**
   * The note — but only when it adds something the line does not already say.
   *
   * 🔴 **This guard was missing in the first cut of 0.0.29, and the live payload caught it.**
   * Rendering the note unconditionally made OpenCode Go's line
   * `rolling 93%（还有 2 小时） · weekly 50%（还有 5 天） · monthly 23%（还有 2 天） ·
   *  subscription usage windows; the credit balance is not readable with an API key`
   * — three windows that already answer the question, followed by a sentence explaining a
   * limitation the reader did not ask about. The panel has ONE line per channel.
   *
   * The rule: a note that only *explains why a field is absent* is redundant once that field's
   * absence is already visible (no amounts shown ⇒ obviously no amount). A note that carries a
   * FACT — Ollama's `period … → …` is the only source of its cycle end — must be rendered.
   * `describeNote` reports which kind it is, so the decision lives in one place rather than as a
   * string comparison here.
   */
  if (row.reading.note !== undefined && row.reading.note !== '') {
    const described = describeNote(row.reading.note, now)
    if (described !== undefined) parts.push(described)
    /**
     * 🔴 Last-resort fallback: if the note was dropped AND nothing else rendered, show the note
     * after all. This is the ONE case where a "redundant" note is not redundant — dropping it
     * would turn a channel that reported something into a cell reading 「无可读数值」, which is a
     * worse lie than a long line. Measured shape: `parseOpenAIBilling` returns
     * `used $3.20; this relay reports no cap (unlimited)` with NO amounts, so the unconditional
     * drop would leave the cell empty.
     */
    else if (parts.length === 0) parts.push(row.reading.note)
  }
  if (parts.length === 0) return '无可读数值'
  return parts.join(' · ')
}

/**
 * Turn a provider note into something worth a place on the one-line balance cell — or nothing.
 *
 * Only one note shape carries a FACT the line cannot otherwise show: Ollama's
 * `period <from> → <until>`, which is the sole source of that channel's cycle end. It is rewritten
 * to 「周期至 <date>（还有 N 天）」.
 *
 * 🔴 Everything else returns `undefined`, i.e. is DROPPED. That is the measured correction from the
 * first cut of 0.0.29: OpenCode Go's note is `subscription usage windows; the credit balance is not
 * readable with an API key`, which explains why a field is missing — a fact the reader can already
 * see (no amount is rendered). Appending it turned a clean three-window line into a wall of text in
 * a 256px-wide panel.  ⚠️ It is NOT lost: the same string still travels in `/balance`, and the
 * panel's own documentation covers it, so a reader who wants the explanation can still find it.
 *
 * @param note - the reading's note, verbatim from the parser.
 * @param now - clock, injectable for tests.
 * @returns the rewritable sentence, or `undefined` when the note adds nothing to the line.
 */
export function describeNote(note: string, now: Date = new Date()): string | undefined {
  const period = /^period\s+(\S+)\s+→\s+(\S+)$/.exec(note)
  if (period === null) return undefined
  // Indexed rather than destructured: `noUncheckedIndexedAccess` types every group as possibly
  // absent, and an assertion here would be hiding the very case the regex already guarantees.
  const from = period[1] ?? ''
  const until = period[2] ?? ''
  const untilText = formatTimeUntil(until, now)
  if (untilText === undefined) return `周期 ${from} → ${until}`
  return `周期至 ${until.slice(0, 10)}（${untilText}）`
}

const BASE = '/any-deepseek'

/**
 * Load the channel list.
 *
 * Returns an empty list rather than throwing when the route is absent: the panel can still show
 * the settings table from `configForms`, and an empty channel list is a truthful rendering of a
 * deployment whose HTTP surface did not come up.
 */
export async function fetchChannels(): Promise<ChannelsResponse> {
  try {
    const response = await fetch(`${BASE}/channels`, { headers: { accept: 'application/json' } })
    if (!response.ok) return { channels: [], presets: [], model: { id: '', name: '' } }
    return (await response.json()) as ChannelsResponse
  } catch {
    return { channels: [], presets: [], model: { id: '', name: '' } }
  }
}

/**
 * Load aggregates.
 * @param group - `channel` for the per-relay table, `day` for the timeline.
 * @param from - inclusive ISO lower bound.
 * @param to - inclusive ISO upper bound.
 * @returns rows plus the stated counting convention; empty on failure.
 */
export async function fetchStats(
  group: 'channel' | 'day',
  from?: string,
  to?: string,
): Promise<StatsResponse> {
  const params = new URLSearchParams({ group })
  if (from !== undefined) params.set('from', from)
  if (to !== undefined) params.set('to', to)
  const empty: StatsResponse = {
    range: { from: from ?? null, to: to ?? null, group },
    rows: [],
    total: {
      requests: 0, failures: 0, unreported: 0, input: 0, output: 0,
      cacheRead: 0, cacheWrite: 0, reasoning: 0, billableInput: 0, total: 0,
    },
  }
  try {
    const response = await fetch(`${BASE}/stats?${params.toString()}`, { headers: { accept: 'application/json' } })
    if (!response.ok) return empty
    return (await response.json()) as StatsResponse
  } catch {
    return empty
  }
}

/**
 * Return the supply group to its first member.
 *
 * 🔴 The sticky cursor lives in the host's memory, so topping up the first relay is not enough to
 * get back onto it — this is the button that does it. POST because it mutates state that outlives
 * the request (a prefetched GET would silently undo a fallback the user was relying on).
 * @returns true when the host accepted the reset.
 */
export async function resetSupplyGroup(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/supply/reset`, { method: 'POST' })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Spend one real request to check a channel.
 *
 * This is the only panel action that costs tokens, which is why it is a button rather than
 * something that happens on render.
 * @param id - channel id.
 * @returns the verdict, including the failure code when it fails.
 */
export async function probeChannel(id: string): Promise<ProbeResult> {
  try {
    const response = await fetch(`${BASE}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = (await response.json()) as ProbeResult & { error?: string }
    if (body.error !== undefined) {
      return { ok: false, ms: 0, code: 'PANEL_ERROR', message: body.error }
    }
    return body
  } catch (error) {
    return {
      ok: false,
      ms: 0,
      code: 'PANEL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Format a token count the way the panel shows it (compact, never rounded to a lie). */
export function formatTokens(value: number): string {
  if (value === 0) return '0'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`
}

/**
 * Format a mean-context figure, or an em dash when nothing reported usage.
 *
 * 🔴 Same discipline as {@link formatSpeed}: `null` is not `0`. "No request reported usage" and
 * "every request carried zero tokens" are different statements, and only the first one is true
 * here — so the unmeasurable case renders as an em dash.
 * @param value - mean tokens per request, or null/undefined.
 * @returns e.g. `28.1K`, or `—`.
 */
export function formatMeanContext(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  return formatTokens(Math.round(value))
}

/**
 * Format a throughput figure, or an em dash when it is unmeasurable.
 *
 * 🔴 `null` is NOT zero: a group with no first-token measurement has no speed, and printing `0`
 * would claim the relay produced nothing — a different and much worse statement. The em dash
 * says "not measured", which is the truth.
 * @param value - tokens per second, or null/undefined.
 * @returns e.g. `42 tok/s`, or `—`.
 */
export function formatSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} tok/s`
}

/**
 * Format a duration in ms compactly.
 * @param value - milliseconds, or null/undefined.
 * @returns e.g. `820ms` / `1.4s` / `2m 05s`, or `—`.
 */
export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}
