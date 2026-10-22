/**
 * usage-ledger.ts — per-channel token accounting.
 *
 * ## Why not `ctx.tokenMeter`
 *
 * The harness meter answers "how much context is in this session", replayed from the session
 * log, and its own documentation says the number is a reference figure rather than a billing
 * record. What we need is the opposite question: *which relay served which request, and what
 * did it report*. That answer only exists at the adapter boundary, so it is recorded there.
 *
 * ## File shape
 *
 * Append-only JSONL, split by month:
 *
 *     <home>/any-deepseek/usage-2026-10.jsonl
 *
 * One line per finished request. Appending keeps the write path O(1) and makes a truncated
 * tail recoverable: a malformed last line is skipped on read rather than poisoning the file.
 * Splitting by month keeps each file small enough to scan when the panel asks for a range.
 *
 * ## Counting convention
 *
 * Harness `TokenUsage` counts are DISJOINT: `input` excludes cache hits, so the billable input
 * is `input + cacheRead + cacheWrite`. Every aggregate below keeps the three separate and
 * exposes the sum explicitly, because a table that showed only `input` would read as if input
 * were being under-reported.
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Token counts exactly as the upstream reported them; every field is disjoint. */
export interface LedgerUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total?: number
}

/** One finished request. */
export interface LedgerEntry {
  /** ISO-8601 local timestamp with offset. */
  at: string
  /** Channel id that served the request. */
  channel: string
  /** Upstream model id the relay received. */
  model: string
  /** Session that issued the request, when the loop supplied one. */
  sessionId?: string
  /** Provider-neutral call purpose, when the loop supplied one. */
  purpose?: string
  ok: boolean
  /** Wall-clock duration of the whole call. */
  ms: number
  /** Time to the first token, when observed. */
  firstTokenMs?: number
  /** Null when the relay reported no usage at all — never zero, which would read as free. */
  usage: LedgerUsage | null
  /** Stable failure code for a failed request. */
  code?: string
}

/** Aggregated figures for one group (a channel, a day, …). */
export interface LedgerAggregate {
  requests: number
  failures: number
  /** Requests that reported no usage; excluded from the token sums. */
  unreported: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** `input + cacheRead + cacheWrite` — the billable input. */
  billableInput: number
  /** `billableInput + output`. */
  total: number
  /**
   * Requests carrying a first-token measurement — the denominator for both speed figures.
   *
   * Kept separate from `requests` on purpose: not every request has one (an error before the
   * first block has no first token, and ledger lines written before this field existed do not
   * either). Dividing by `requests` would silently understate every average.
   */
  timed: number
  /** Sum of observed time-to-first-token, over `timed` requests only. */
  ttftMs: number
  /** Sum of generation time (`ms - firstTokenMs`), over `timed` requests only. */
  generationMs: number
  /** Sum of `output` over `timed` requests — the numerator for generation throughput. */
  timedOutput: number
}

/**
 * Output tokens per second generated, or null when unmeasurable.
 *
 * 🔴 **Why not `output / total` (owner request 2026-10-22: 「能加上 token 速度统计吗」).**
 * One ratio collapses queueing and generation together, so a relay that thinks for 3s and then
 * streams fast looks identical to a uniformly slow one — and those two call for different fixes
 * (switch relay vs. shrink the prompt). The split is measured per request and this divides only
 * by the generating half.
 *
 * Averaged as a RATIO OF SUMS rather than a mean of per-request speeds: a mean lets one
 * five-token reply dominate, while the sum ratio answers "across this group, how fast did tokens
 * actually come out".
 * @param aggregate - one group's figures.
 * @returns tokens per second, or null when nothing was timed or nothing was generated.
 */
export function outputTokensPerSecond(aggregate: LedgerAggregate): number | null {
  if (aggregate.generationMs <= 0 || aggregate.timedOutput <= 0) return null
  return (aggregate.timedOutput * 1000) / aggregate.generationMs
}

/**
 * Mean time to first token, in ms, or null when nothing was timed.
 * @param aggregate - one group's figures.
 */
export function meanFirstTokenMs(aggregate: LedgerAggregate): number | null {
  if (aggregate.timed <= 0) return null
  return aggregate.ttftMs / aggregate.timed
}

/** Aggregation result for one grouping. */
export interface LedgerSummary {
  /** Group key (channel id, or `YYYY-MM-DD`). */
  key: string
  aggregate: LedgerAggregate
}

/** Empty aggregate, used both as an accumulator seed and as a zero row. */
export function emptyAggregate(): LedgerAggregate {
  return {
    requests: 0,
    failures: 0,
    unreported: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    billableInput: 0,
    total: 0,
    timed: 0,
    ttftMs: 0,
    generationMs: 0,
    timedOutput: 0,
  }
}

/** Fold one entry into an aggregate accumulator (mutates and returns it, for cheap loops). */
export function addToAggregate(into: LedgerAggregate, entry: LedgerEntry): LedgerAggregate {
  into.requests += 1
  if (!entry.ok) into.failures += 1
  const usage = entry.usage
  if (usage === null) {
    into.unreported += 1
    return into
  }
  into.input += usage.input
  into.output += usage.output
  into.cacheRead += usage.cacheRead
  into.cacheWrite += usage.cacheWrite
  into.reasoning += usage.reasoning
  into.billableInput += usage.input + usage.cacheRead + usage.cacheWrite
  into.total += usage.input + usage.cacheRead + usage.cacheWrite + usage.output
  recordSpeed(into, entry)
  return into
}

/**
 * Fold one entry's speed measurement into the accumulators.
 *
 * Extraction is a bare subtraction, which can go negative when a relay reports a `ms` shorter
 * than its first token (clock granularity, or a resume counted differently). A negative
 * generation time would poison the ratio, so such an entry contributes to `timed`/`ttftMs` but
 * not to `generationMs`/`timedOutput` — the honest reading is "we measured a start, not a rate".
 * @param into - the group accumulator.
 * @param entry - one finished request.
 */
function recordSpeed(into: LedgerAggregate, entry: LedgerEntry): void {
  const firstTokenMs = entry.firstTokenMs
  if (firstTokenMs === undefined) return
  into.timed += 1
  into.ttftMs += firstTokenMs
  const generationMs = entry.ms - firstTokenMs
  if (generationMs <= 0 || entry.usage === null) return
  into.generationMs += generationMs
  into.timedOutput += entry.usage.output
}

/** `YYYY-MM` for a timestamp, in the timestamp's own offset. */
export function monthKey(at: Date): string {
  const year = at.getFullYear()
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  return `${year}-${month}`
}

/** `YYYY-MM-DD` for a timestamp, in the timestamp's own offset. */
export function dayKey(at: Date): string {
  return `${monthKey(at)}-${`${at.getDate()}`.padStart(2, '0')}`
}

/** Filename for one month's ledger. */
export function ledgerFileName(month: string): string {
  return `usage-${month}.jsonl`
}

/**
 * Validate a parsed line before trusting it.
 *
 * A truncated final line is a normal outcome of a process dying mid-append, so the reader
 * skips what it cannot parse instead of failing the whole request for the panel.
 * @param value - `JSON.parse` output.
 * @returns the entry, or `undefined` when the line is not usable.
 */
export function asLedgerEntry(value: unknown): LedgerEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.at !== 'string' || raw.at === '') return undefined
  if (typeof raw.channel !== 'string' || raw.channel === '') return undefined
  if (typeof raw.model !== 'string') return undefined
  if (typeof raw.ok !== 'boolean') return undefined
  if (typeof raw.ms !== 'number' || !Number.isFinite(raw.ms)) return undefined
  const usageRaw = raw.usage
  let usage: LedgerUsage | null = null
  if (usageRaw !== null && usageRaw !== undefined) {
    if (typeof usageRaw !== 'object') return undefined
    const u = usageRaw as Record<string, unknown>
    const nums = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
    for (const field of nums) {
      const v = u[field]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
    }
    usage = {
      input: u.input as number,
      output: u.output as number,
      cacheRead: u.cacheRead as number,
      cacheWrite: u.cacheWrite as number,
      reasoning: u.reasoning as number,
      ...typeof u.total === 'number' && Number.isFinite(u.total) ? { total: u.total } : {},
    }
  }
  return {
    at: raw.at,
    channel: raw.channel,
    model: raw.model,
    ok: raw.ok,
    ms: raw.ms,
    usage,
    ...typeof raw.sessionId === 'string' && raw.sessionId !== '' ? { sessionId: raw.sessionId } : {},
    ...typeof raw.purpose === 'string' && raw.purpose !== '' ? { purpose: raw.purpose } : {},
    ...typeof raw.firstTokenMs === 'number' && Number.isFinite(raw.firstTokenMs)
      ? { firstTokenMs: raw.firstTokenMs }
      : {},
    ...typeof raw.code === 'string' && raw.code !== '' ? { code: raw.code } : {},
  }
}

/** Parse a whole ledger file, skipping unusable lines. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const entry = asLedgerEntry(JSON.parse(trimmed))
      if (entry !== undefined) out.push(entry)
    } catch {
      // A truncated tail line is expected after a crash; skip it and keep the rest.
    }
  }
  return out
}

/**
 * Append one entry to the month's ledger.
 *
 * Failure to write is reported to the caller, never thrown into the request path: accounting
 * must not be able to fail a model call.
 * @param dir - directory holding the ledger files.
 * @param entry - the finished request.
 * @param now - timestamp deciding which month file receives the line.
 * @returns whether the write landed.
 */
export async function appendLedgerEntry(
  dir: string,
  entry: LedgerEntry,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, ledgerFileName(monthKey(now))), `${JSON.stringify(entry)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Read every ledger file that could contain entries in `[from, to]`.
 *
 * Files are chosen by name (month), then entries are filtered by timestamp, so a wide range
 * never parses months it does not need.
 * @param dir - directory holding the ledger files.
 * @param from - inclusive lower bound, or `undefined` for no lower bound.
 * @param to - inclusive upper bound, or `undefined` for no upper bound.
 * @returns usable entries in file order.
 */
export async function readLedgerRange(
  dir: string,
  from?: Date,
  to?: Date,
): Promise<LedgerEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const months = new Set<string>()
  if (from !== undefined) months.add(monthKey(from))
  if (to !== undefined) months.add(monthKey(to))
  const files = names
    .filter((name) => name.startsWith('usage-') && name.endsWith('.jsonl'))
    .filter((name) => {
      if (months.size === 0) return true
      const month = name.slice('usage-'.length, -'.jsonl'.length)
      // A range spanning weeks can cover months not named by its endpoints, so fall back to
      // a string comparison against the endpoint months instead of exact membership.
      if (months.has(month)) return true
      if (from !== undefined && to !== undefined) {
        return month >= monthKey(from) && month <= monthKey(to)
      }
      if (from !== undefined) return month >= monthKey(from)
      return month <= monthKey(to as Date)
    })
    .sort()

  const entries: LedgerEntry[] = []
  for (const name of files) {
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const entry of parseLedger(text)) {
      const at = new Date(entry.at)
      if (Number.isNaN(at.getTime())) continue
      if (from !== undefined && at < from) continue
      if (to !== undefined && at > to) continue
      entries.push(entry)
    }
  }
  return entries
}

/**
 * Group entries by a key and aggregate each group.
 * @param entries - ledger entries already filtered to the range of interest.
 * @param by - grouping function (`channel`, `day`, …).
 * @returns one row per group, sorted by key for stable rendering.
 */
export function summarize(
  entries: readonly LedgerEntry[],
  by: (entry: LedgerEntry) => string,
): LedgerSummary[] {
  const groups = new Map<string, LedgerAggregate>()
  for (const entry of entries) {
    const key = by(entry)
    const existing = groups.get(key) ?? emptyAggregate()
    groups.set(key, addToAggregate(existing, entry))
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, aggregate]) => ({ key, aggregate }))
}

/** Sum every group into one row (the table's footer). */
export function totalOf(rows: readonly LedgerSummary[]): LedgerAggregate {
  const total = emptyAggregate()
  for (const row of rows) {
    total.requests += row.aggregate.requests
    total.failures += row.aggregate.failures
    total.unreported += row.aggregate.unreported
    total.input += row.aggregate.input
    total.output += row.aggregate.output
    total.cacheRead += row.aggregate.cacheRead
    total.cacheWrite += row.aggregate.cacheWrite
    total.reasoning += row.aggregate.reasoning
    total.billableInput += row.aggregate.billableInput
    total.total += row.aggregate.total
    total.timed += row.aggregate.timed
    total.ttftMs += row.aggregate.ttftMs
    total.generationMs += row.aggregate.generationMs
    total.timedOutput += row.aggregate.timedOutput
  }
  return total
}
