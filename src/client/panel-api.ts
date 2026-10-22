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

/** `/any-deepseek/channels` response. */
export interface ChannelsResponse {
  channels: ChannelRow[]
  presets: Array<{ id: string; displayName: string }>
  model: { id: string; name: string }
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
