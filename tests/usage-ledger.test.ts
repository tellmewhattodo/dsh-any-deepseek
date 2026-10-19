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
