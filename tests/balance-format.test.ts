/**
 * balance-format.test.ts — how a balance row becomes words on screen.
 *
 * ## Why this is a suite of its own
 *
 * The panel has exactly one line of text per channel to say "how much is left". Every wrong
 * version of that sentence causes a real action: a fabricated `0.00` makes someone stop using a
 * healthy channel, and a fabricated large number makes someone keep using a dead one.
 *
 * 🔴 The case this file exists for is `alive` — the owner's directive (2026-10-23) that a channel
 * with no balance API be checked with one minimal live request and shown if it answers. The whole
 * value of that check is that it is **narrow**: it proves the endpoint serves and the credit is
 * not exhausted, and it proves NOTHING about the remaining amount. So the rendering must say
 * 「余额未尽」 and must never contain a currency figure.
 */

import { describe, expect, it } from 'vitest'

import {
  describeNote,
  formatBalance,
  formatTimeUntil,
  type BalanceRow,
} from '../src/client/panel-api.js'

describe('formatBalance — alive is a liveness verdict, never a number', () => {
  const alive: BalanceRow = {
    id: 'open-design-1',
    label: 'Open Design-1',
    status: 'alive',
    ms: 1448,
    responded: 'deepseek-flash',
    detail: 'this endpoint publishes no balance API; a minimal live request succeeded',
  }

  it('🔴 says the credit is not exhausted, with the evidence that proves it', () => {
    const text = formatBalance(alive)
    expect(text).toContain('余额未尽')
    // The relay's own model name and the round-trip time ARE the evidence — a bare "it works"
    // is an assertion; "deepseek-flash · 1448ms" is something the reader can check.
    expect(text).toContain('deepseek-flash')
    expect(text).toContain('1448ms')
  })

  it('🔴 contains NO currency amount and no zero', () => {
    // The single most important assertion in this file: a figure here is a number nobody
    // measured. `0.00` would read as "you are out of credit" — the opposite of what `alive` means.
    const text = formatBalance(alive)
    expect(text).not.toMatch(/CNY|USD|\$|¥/)
    expect(text).not.toMatch(/\b0\.00\b/)
    expect(text).not.toMatch(/\d+\.\d{2}\s/)
  })

  it('still says the right thing when the relay reports no model name', () => {
    // A gateway may omit `model`. Dropping the whole verdict would lose the fact that it answered.
    const text = formatBalance({ ...alive, responded: undefined })
    expect(text).toContain('余额未尽')
    expect(text).toContain('1448ms')
  })
})

describe('formatBalance — the other statuses stay distinct', () => {
  it('a quota refusal is reported as out of credit, not as a read failure', () => {
    // The liveness check found the exact fact it was run to discover. Calling it 读取失败 would
    // discard the answer and send the user looking for a network problem.
    const row: BalanceRow = {
      id: 'x',
      label: 'X',
      status: 'unavailable',
      detail: 'liveness failed',
      code: 'QUOTA',
    }
    expect(formatBalance(row)).toContain('余额不足')
  })

  it('a 404 is 不支持查询, an unexpected status is 读取失败', () => {
    // These lead to different next steps: "stop looking" versus "try again".
    expect(formatBalance({ id: 'x', label: 'X', status: 'unavailable', detail: '', code: 'HTTP_404' }))
      .toBe('不支持查询')
    expect(formatBalance({ id: 'x', label: 'X', status: 'unavailable', detail: '', code: 'HTTP_500' }))
      .toBe('读取失败')
  })

  it('no key is its own answer, not a failure', () => {
    expect(formatBalance({ id: 'x', label: 'X', status: 'no-key', detail: '' })).toBe('未配置密钥')
  })

  it('a real amount renders with its currency and two decimals', () => {
    const row: BalanceRow = {
      id: 'official',
      label: 'DeepSeek Official',
      status: 'ok',
      reading: {
        amounts: [{ currency: 'CNY', remaining: 642.44, granted: 574.07, toppedUp: 68.37 }],
        windows: [],
        available: true,
      },
    }
    expect(formatBalance(row)).toBe('642.44 CNY')
  })

  it('windows render as percentages when the provider reports no reset instant', () => {
    const row: BalanceRow = {
      id: 'opencode-go',
      label: 'OpenCode Go-1',
      status: 'ok',
      reading: {
        amounts: [],
        windows: [
          { name: 'rolling', remainingPercent: 100 },
          { name: 'weekly', remainingPercent: 81 },
          { name: 'monthly', remainingPercent: 75 },
        ],
      },
    }
    // No `resetsAt` on any window ⇒ no time text, and crucially no 「还有 0 分钟」 invented from
    // an absent instant (see the formatTimeUntil suite for that distinction in isolation).
    expect(formatBalance(row)).toBe('rolling 100% · weekly 81% · monthly 75%')
  })

  it('an unavailable account is called out rather than left ambiguous', () => {
    const row: BalanceRow = {
      id: 'official',
      label: 'DeepSeek Official',
      status: 'ok',
      reading: { amounts: [{ currency: 'CNY', remaining: 0 }], windows: [], available: false },
    }
    expect(formatBalance(row)).toContain('余额不足')
  })
})

/**
 * Owner request 2026-11-03: 「对于有时间限的渠道，opencode go 和 ollama 显示 还有多久」.
 *
 * 🔴 Why these cases are unit-tested rather than eyeballed in the panel: the whole feature is a
 * COUNTDOWN, and a countdown's failure mode is silence, not an exception. An absent `resetsAt`,
 * an already-passed instant, and a malformed one all produce *some* string; only explicit cases
 * can tell the three apart from a correct reading.
 */
describe('formatTimeUntil — how long until the allowance returns', () => {
  /** Fixed clock so every case is arithmetically checkable by hand. */
  const NOW = new Date('2026-11-03T20:00:00Z')

  it('hours, when the horizon is under a day', () => {
    expect(formatTimeUntil('2026-11-03T23:00:00Z', NOW)).toBe('还有 3 小时')
  })

  it('minutes, when the horizon is under an hour', () => {
    expect(formatTimeUntil('2026-11-03T20:12:00Z', NOW)).toBe('还有 12 分钟')
  })

  it('days, when the horizon is beyond a day — not "57 小时"', () => {
    // Granularity follows what the reader does with the answer. 57 hours is arithmetic homework;
    // "2 天" is a decision input. This is exactly the OpenCode weekly/monthly window case.
    expect(formatTimeUntil('2026-11-05T21:00:00Z', NOW)).toBe('还有 2 天')
  })

  it('🔴 an already-passed instant says 已重置, never 「还有 0 分钟」', () => {
    // A past `resetsAt` means the window rolled AFTER this reading was taken — the percentage on
    // screen describes a cycle that has ended. "0 minutes left" would be permanently, silently
    // wrong; 「已重置」 tells the reader to re-query instead.
    expect(formatTimeUntil('2026-11-03T19:00:00Z', NOW)).toBe('已重置')
  })

  it('🔴 an absent instant yields undefined, NOT 已重置 and NOT a zero countdown', () => {
    // The load-bearing distinction: "the provider did not tell us" must not render as either
    // "it already reset" or "it resets in 0 minutes". Both are claims nobody measured.
    expect(formatTimeUntil(undefined, NOW)).toBeUndefined()
  })

  it('🔴 a malformed instant is unknown, not "now"', () => {
    // `Date.parse` returns NaN on garbage. Coercing that to the current time would make every
    // unreadable timestamp look like "just reset".
    expect(formatTimeUntil('not-a-date', NOW)).toBeUndefined()
    expect(formatTimeUntil('', NOW)).toBeUndefined()
  })

  it('sub-minute remaining gets its own words rather than rounding to zero', () => {
    expect(formatTimeUntil('2026-11-03T20:00:30Z', NOW)).toBe('不到 1 分钟')
  })
})

describe('formatBalance — time-limited channels show how long is left', () => {
  const NOW = new Date('2026-11-03T20:00:00Z')

  it('🔴 OpenCode Go windows carry their reset countdown beside the percentage', () => {
    // Real shape as returned by `/any-deepseek/balance` on 2026-11-03: three windows, each with a
    // `resetsAt`. Before this change the panel printed `rolling 95%` and dropped the instant —
    // the half of the answer that says whether you can wait it out.
    const row: BalanceRow = {
      id: 'opencode-go',
      label: 'OpenCode Go-1',
      status: 'ok',
      reading: {
        amounts: [],
        windows: [
          { name: 'rolling', remainingPercent: 95, resetsAt: '2026-11-03T20:12:00Z' },
          { name: 'weekly', remainingPercent: 51, resetsAt: '2026-11-09T00:00:00Z' },
        ],
      },
    }
    const text = formatBalance(row, NOW)
    expect(text).toContain('rolling 95%（还有 12 分钟）')
    expect(text).toContain('weekly 51%（还有 5 天）')
  })

  it('🔴 Ollama period is shown even though it also reports an amount', () => {
    // The measured Ollama reading (2026-11-03) carries BOTH an amount and a period note. The old
    // renderer returned early on the amount list and dropped the note entirely ⇒ its renewal date
    // was invisible. That is the second half of the owner's request.
    const row: BalanceRow = {
      id: 'ollama',
      label: 'Ollama Cloud-1',
      status: 'ok',
      reading: {
        amounts: [{ currency: 'USD', remaining: 46.75642, allowance: 60, toppedUp: 0 }],
        windows: [],
        note: 'period 2026-10-19T13:07:35Z → 2026-11-19T13:07:35Z',
      },
    }
    const text = formatBalance(row, NOW)
    expect(text).toContain('46.76 USD')
    // Fixed clock 11-03T20:00Z → 11-19T13:07Z is 15 days 17 hours ⇒ floor is 15, and flooring is
    // the RIGHT choice: rounding up to 16 would claim a renewal that has not happened yet.
    expect(text).toContain('还有 15 天')
    // The absolute date stays: a horizon with no anchor cannot be checked against a calendar.
    expect(text).toContain('2026-11-19')
  })

  it('🔴 a prose note is DROPPED, not appended — it would double the line length', () => {
    // Measured regression from the first cut of 0.0.29: rendering the note unconditionally made
    // OpenCode Go's live line
    //   `rolling 93%（还有 2 小时） · weekly 50%（还有 5 天） · monthly 23%（还有 2 天） ·`
    //   ` subscription usage windows; the credit balance is not readable with an API key`
    // That trailing sentence explains why no amount appears — which the reader can already see.
    // The panel has ONE line per channel, in a 256px panel.
    const row: BalanceRow = {
      id: 'opencode-go',
      label: 'OpenCode Go-1',
      status: 'ok',
      reading: {
        amounts: [],
        windows: [{ name: 'rolling', remainingPercent: 93, resetsAt: '2026-11-03T22:00:00Z' }],
        note: 'subscription usage windows; the credit balance is not readable with an API key',
      },
    }
    const text = formatBalance(row, NOW)
    expect(text).toBe('rolling 93%（还有 2 小时）')
    expect(text).not.toContain('not readable with an API key')
  })
})

describe('describeNote — only period statements earn a place on the line', () => {
  const NOW = new Date('2026-11-03T20:00:00Z')

  it('turns a raw ISO span into an anchored horizon', () => {
    // 15 days 17 hours, floored — see the note in the formatBalance case above.
    expect(describeNote('period 2026-10-19T13:07:35Z → 2026-11-19T13:07:35Z', NOW))
      .toBe('周期至 2026-11-19（还有 15 天）')
  })

  it('🔴 keeps the raw span when the end is unreadable', () => {
    // Dropping the dates here would leave the reader with neither a horizon NOR the provider's
    // own words — strictly less information than before the change.
    expect(describeNote('period 2026-10-19T13:07:35Z → garbage', NOW))
      .toBe('周期 2026-10-19T13:07:35Z → garbage')
  })

  it('🔴 a non-period note yields undefined — dropped, not passed through', () => {
    // The first cut returned the note verbatim, which is what put an English paragraph after
    // OpenCode Go's three windows. Returning `undefined` makes "this note earns no space" a
    // decision the renderer can act on, instead of a string it cannot tell from a useful one.
    const note = 'subscription usage windows; the credit balance is not readable with an API key'
    expect(describeNote(note, NOW)).toBeUndefined()
  })

  it('🔴 an "unlimited" note is dropped from a populated line, but KEPT when it is all there is', () => {
    // Two different rows, two different answers — this is the boundary the fallback exists for.
    // `parseOpenAIBilling` returns this note with NO amounts, so dropping it unconditionally would
    // render 「无可读数值」 for a channel that did report something. A long line is a worse-looking
    // truth; an empty cell is a better-looking lie.
    expect(describeNote('used $3.20; this relay reports no cap (unlimited)', NOW)).toBeUndefined()

    const emptyButExplained: BalanceRow = {
      id: 'relay',
      label: 'Relay',
      status: 'ok',
      reading: {
        amounts: [],
        windows: [],
        note: 'used $3.20; this relay reports no cap (unlimited)',
      },
    }
    expect(formatBalance(emptyButExplained, NOW))
      .toBe('used $3.20; this relay reports no cap (unlimited)')

    // And it does NOT come back when there IS something else to show: the drop is contextual.
    const populated: BalanceRow = {
      id: 'opencode-go',
      label: 'OpenCode Go-1',
      status: 'ok',
      reading: {
        amounts: [],
        windows: [{ name: 'rolling', remainingPercent: 93 }],
        note: 'subscription usage windows; the credit balance is not readable with an API key',
      },
    }
    expect(formatBalance(populated, NOW)).toBe('rolling 93%')
  })
})
