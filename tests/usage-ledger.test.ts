import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addToAggregate,
  appendLedgerEntry,
  asLedgerEntry,
  dayKey,
  emptyAggregate,
  ledgerFileName,
  monthKey,
  parseLedger,
  readLedgerRange,
  summarize,
  totalOf,
  meanContextTokens,
  meanFirstTokenMs,
  outputTokensPerSecond,
  type LedgerEntry,
} from '../src/usage-ledger.js'

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: '2026-10-19T10:00:00+08:00',
    channel: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    ok: true,
    ms: 1000,
    usage: { input: 100, output: 50, cacheRead: 400, cacheWrite: 0, reasoning: 0 },
    ...overrides,
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'any-deepseek-ledger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('aggregation', () => {
  // The counting rule this plugin must never get wrong: counts are disjoint, so the billable
  // input is the sum of three fields. A row showing only `input` reads as under-reporting.
  it('keeps the three input halves separate and exposes their sum', () => {
    const aggregate = addToAggregate(
      emptyAggregate(),
      entry({ usage: { input: 100, output: 50, cacheRead: 400, cacheWrite: 200, reasoning: 7 } }),
    )
    expect(aggregate.input).toBe(100)
    expect(aggregate.cacheRead).toBe(400)
    expect(aggregate.cacheWrite).toBe(200)
    expect(aggregate.billableInput).toBe(700)
    expect(aggregate.total).toBe(750)
  })

  it('counts an unreported request without inventing zeros in the sums', () => {
    const aggregate = addToAggregate(emptyAggregate(), entry({ usage: null }))
    expect(aggregate.requests).toBe(1)
    expect(aggregate.unreported).toBe(1)
    expect(aggregate.input).toBe(0)
    expect(aggregate.total).toBe(0)
  })

  it('counts failures separately from successes', () => {
    const a = addToAggregate(emptyAggregate(), entry())
    const b = addToAggregate(a, entry({ ok: false, code: 'RATE_LIMIT', usage: null }))
    expect(b.requests).toBe(2)
    expect(b.failures).toBe(1)
  })

  it('groups by channel and sorts keys', () => {
    const rows = summarize(
      [entry({ channel: 'b' }), entry({ channel: 'a' }), entry({ channel: 'b' })],
      (e) => e.channel,
    )
    expect(rows.map((row) => row.key)).toEqual(['a', 'b'])
    expect(rows[1]?.aggregate.requests).toBe(2)
  })

  it('totals every group', () => {
    const rows = summarize([entry({ channel: 'a' }), entry({ channel: 'b' })], (e) => e.channel)
    const total = totalOf(rows)
    expect(total.requests).toBe(2)
    expect(total.input).toBe(200)
    expect(total.billableInput).toBe(1000)
  })
})

describe('entry validation', () => {
  it('accepts a well-formed entry', () => {
    expect(asLedgerEntry(entry())?.channel).toBe('opencode-go')
  })

  it('rejects missing required fields', () => {
    expect(asLedgerEntry({ ...entry(), at: '' })).toBeUndefined()
    expect(asLedgerEntry({ ...entry(), channel: 5 })).toBeUndefined()
    expect(asLedgerEntry({ ...entry(), ok: 'yes' })).toBeUndefined()
    expect(asLedgerEntry({ ...entry(), ms: Number.NaN })).toBeUndefined()
    expect(asLedgerEntry(null)).toBeUndefined()
  })

  it('rejects negative or non-finite token counts rather than storing nonsense', () => {
    expect(asLedgerEntry({ ...entry(), usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }))
      .toBeUndefined()
    expect(asLedgerEntry({ ...entry(), usage: { input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }))
      .toBeUndefined()
    // Control: the same shape with a valid count survives, so the rejections above are real.
    expect(asLedgerEntry({ ...entry(), usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } })?.usage?.input)
      .toBe(1)
  })

  it('keeps a null usage as "not reported"', () => {
    expect(asLedgerEntry({ ...entry(), usage: null })?.usage).toBeNull()
  })
})

describe('parsing', () => {
  it('skips a truncated final line and keeps the rest', () => {
    const text = `${JSON.stringify(entry())}\n{"at":"2026-10-19T10:0`
    expect(parseLedger(text)).toHaveLength(1)
  })

  it('ignores blank lines', () => {
    expect(parseLedger(`\n\n${JSON.stringify(entry())}\n\n`)).toHaveLength(1)
  })
})

describe('file layout', () => {
  it('names files by month', () => {
    expect(monthKey(new Date('2026-10-19T10:00:00+08:00'))).toBe('2026-10')
    expect(ledgerFileName('2026-10')).toBe('usage-2026-10.jsonl')
    expect(dayKey(new Date('2026-10-19T10:00:00+08:00'))).toBe('2026-10-19')
  })

  it('creates the directory on first write and appends one line', async () => {
    const nested = join(dir, 'deep', 'nested')
    expect(await appendLedgerEntry(nested, entry())).toBe(true)
    const text = await readFile(join(nested, ledgerFileName('2026-10')), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
  })

  it('appends across calls', async () => {
    await appendLedgerEntry(dir, entry({ channel: 'a' }))
    await appendLedgerEntry(dir, entry({ channel: 'b' }))
    const all = await readLedgerRange(dir)
    expect(all.map((e) => e.channel)).toEqual(['a', 'b'])
  })

  it('splits by month using the supplied clock', async () => {
    await appendLedgerEntry(dir, entry({ at: '2026-09-30T10:00:00+08:00' }), new Date('2026-09-30T10:00:00+08:00'))
    await appendLedgerEntry(dir, entry({ at: '2026-10-01T10:00:00+08:00' }), new Date('2026-10-01T10:00:00+08:00'))
    const files = (await readFile(join(dir, ledgerFileName('2026-09')), 'utf8')).trim()
    expect(files.split('\n')).toHaveLength(1)
    expect(await readLedgerRange(dir)).toHaveLength(2)
  })

  it('returns an empty list for a directory that does not exist', async () => {
    expect(await readLedgerRange(join(dir, 'missing'))).toEqual([])
  })
})

describe('range filtering', () => {
  it('filters entries by timestamp, inclusive', async () => {
    await appendLedgerEntry(dir, entry({ at: '2026-10-01T00:00:00+08:00', channel: 'early' }), new Date('2026-10-01T00:00:00+08:00'))
    await appendLedgerEntry(dir, entry({ at: '2026-10-15T00:00:00+08:00', channel: 'mid' }), new Date('2026-10-15T00:00:00+08:00'))
    await appendLedgerEntry(dir, entry({ at: '2026-10-31T00:00:00+08:00', channel: 'late' }), new Date('2026-10-31T00:00:00+08:00'))

    const rows = await readLedgerRange(
      dir,
      new Date('2026-10-10T00:00:00+08:00'),
      new Date('2026-10-20T00:00:00+08:00'),
    )
    expect(rows.map((e) => e.channel)).toEqual(['mid'])
  })

  it('reads months that fall inside a range without being either endpoint', async () => {
    for (const month of ['01', '02', '03']) {
      await appendLedgerEntry(dir, entry({ at: `2026-${month}-10T00:00:00+08:00`, channel: month }), new Date(`2026-${month}-10T00:00:00+08:00`))
    }
    const rows = await readLedgerRange(
      dir,
      new Date('2026-01-15T00:00:00+08:00'),
      new Date('2026-03-31T00:00:00+08:00'),
    )
    expect(rows.map((e) => e.channel)).toEqual(['02', '03'])
  })

  it('skips an unreadable month file and keeps the readable ones', async () => {
    await appendLedgerEntry(dir, entry({ channel: 'ok' }), new Date('2026-10-10T00:00:00+08:00'))
    await writeFile(join(dir, ledgerFileName('2026-09')), 'not json at all\n', 'utf8')
    const rows = await readLedgerRange(dir)
    expect(rows.map((e) => e.channel)).toEqual(['ok'])
  })
})

describe('token speed (owner: 「能加上 token 速度统计吗」)', () => {
  /**
   * 🔴 The distinction this suite protects: throughput must be computed over GENERATION time
   * only. `output / totalMs` folds in the wait for the first token, so a relay that thinks for
   * 3s then streams fast would look identical to a uniformly slow one — and those two call for
   * completely different fixes.
   */

  it('🔴 divides by generation time, NOT by total time', () => {
    // The fixture emits 50 output tokens; 400ms to first token, then 600ms generating
    // ⇒ 50 tokens / 0.6s. A total-time ratio would have said 50/1.0 = 50 tok/s — understating
    // the true generation rate by 40%, and misreporting "slow to start" as "slow overall".
    const aggregate = addToAggregate(emptyAggregate(), entry({ ms: 1000, firstTokenMs: 400 }))
    expect(outputTokensPerSecond(aggregate)).toBeCloseTo(50 / 0.6, 5)
    // The two numbers are genuinely different, which is the whole point of splitting them.
    expect(outputTokensPerSecond(aggregate)).not.toBeCloseTo(50 / 1.0, 5)
    expect(meanFirstTokenMs(aggregate)).toBe(400)
  })

  it('averages as a ratio of sums, so one tiny reply cannot dominate', () => {
    // Two requests: a 5-token fast one and a 500-token slower one. A mean of per-request speeds
    // would weight them equally; the honest answer is "across the group, this is the rate".
    const accumulator = emptyAggregate()
    addToAggregate(accumulator, entry({ ms: 100, firstTokenMs: 50, usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }))
    addToAggregate(accumulator, entry({ ms: 550, firstTokenMs: 50, usage: { input: 0, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }))
    // 505 tokens over 50+500=550ms of generation.
    expect(outputTokensPerSecond(accumulator)).toBeCloseTo(505 / 0.55, 5)
  })

  it('🔴 reports null (not zero) when nothing was timed', () => {
    // No `firstTokenMs` anywhere — e.g. every entry predates the field. Zero would claim the
    // relay produced nothing, which is a different and much worse statement than "not measured".
    const aggregate = addToAggregate(emptyAggregate(), entry())
    expect(outputTokensPerSecond(aggregate)).toBeNull()
    expect(meanFirstTokenMs(aggregate)).toBeNull()
  })

  it('🔴 ignores a generation time that came out negative or zero', () => {
    // Guards the ratio: a relay reporting ms <= firstTokenMs (clock granularity, resumed call)
    // must not produce a negative denominator.
    const aggregate = addToAggregate(emptyAggregate(), entry({ ms: 300, firstTokenMs: 300 }))
    expect(outputTokensPerSecond(aggregate)).toBeNull()
    // The first-token measurement itself is still real and still averaged.
    expect(meanFirstTokenMs(aggregate)).toBe(300)
  })

  it('counts only timed requests in the denominator', () => {
    const accumulator = emptyAggregate()
    addToAggregate(accumulator, entry({ ms: 1000, firstTokenMs: 200 }))
    addToAggregate(accumulator, entry({ ms: 1000 })) // no measurement
    expect(accumulator.requests).toBe(2)
    expect(accumulator.timed).toBe(1)
    // 50 tokens over 800ms — NOT 50 tokens over 1800ms.
    expect(outputTokensPerSecond(accumulator)).toBeCloseTo(50 / 0.8, 5)
  })

  it('sums speed fields into the footer total', () => {
    const total = totalOf(summarize([entry({ ms: 1000, firstTokenMs: 200 })], () => 'k'))
    expect(total.timed).toBe(1)
    expect(total.ttftMs).toBe(200)
    expect(total.generationMs).toBe(800)
    expect(outputTokensPerSecond(total)).toBeCloseTo(50 / 0.8, 5)
  })
})

describe('mean context size (owner 2026-10-24: 「希望统计平均的上下文窗口大小」)', () => {
  /**
   * 🔴 What this number must be: tokens carried by ONE request — not the model's capacity.
   *
   * The capacity is a constant 1M on every channel, so echoing it back would be a fact about the
   * preset, not about usage. The actionable reading is the gap: a mean well below the window
   * means cost is driven by conversation length rather than by the window.
   */

  it('divides total tokens by the requests that actually reported usage', () => {
    // One fixture entry: 100 input + 400 cacheRead + 50 output = 550 tokens carried.
    const aggregate = addToAggregate(emptyAggregate(), entry())
    expect(aggregate.total).toBe(550)
    expect(meanContextTokens(aggregate)).toBe(550)
  })

  it('🔴 counts CACHE HITS in the numerator — they occupy the window even when billed cheaper', () => {
    // The trap: dropping cacheRead would report 150 tokens for a request that really carried 550.
    const aggregate = addToAggregate(emptyAggregate(), entry())
    const withoutCache = aggregate.total - aggregate.cacheRead
    expect(meanContextTokens(aggregate)).toBeGreaterThan(withoutCache)
  })

  it('🔴 excludes unreported requests from the DENOMINATOR (not from the total)', () => {
    // A request the relay answered without reporting usage contributed 0 to `total`, so counting
    // it in the divisor would deflate the mean. 550 tokens over ONE reporting request.
    const accumulator = emptyAggregate()
    addToAggregate(accumulator, entry())
    addToAggregate(accumulator, entry({ usage: null }))
    expect(accumulator.requests).toBe(2)
    expect(accumulator.unreported).toBe(1)
    expect(meanContextTokens(accumulator)).toBe(550)
  })

  it('🔴 does NOT subtract failures a second time', () => {
    // `addToAggregate` increments BOTH `failures` and `unreported` for a failed usage-less call,
    // so `requests - unreported - failures` would remove it twice and overstate the mean.
    const accumulator = emptyAggregate()
    addToAggregate(accumulator, entry())
    addToAggregate(accumulator, entry({ ok: false, usage: null, code: 'QUOTA' }))
    expect(accumulator.failures).toBe(1)
    expect(accumulator.unreported).toBe(1)
    expect(meanContextTokens(accumulator)).toBe(550)
  })

  it('🔴 reports null (not zero) when no request reported usage', () => {
    // Zero would claim every request carried nothing — a different, false statement.
    const aggregate = addToAggregate(emptyAggregate(), entry({ usage: null }))
    expect(meanContextTokens(aggregate)).toBeNull()
    expect(meanContextTokens(emptyAggregate())).toBeNull()
  })

  it('sums into the footer total', () => {
    const total = totalOf(summarize([entry(), entry()], () => 'k'))
    // 550 + 550 over two reporting requests.
    expect(meanContextTokens(total)).toBe(550)
  })
})
