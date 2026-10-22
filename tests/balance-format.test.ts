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

import { formatBalance, type BalanceRow } from '../src/client/panel-api.js'

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

  it('windows render as percentages, which is what OpenCode actually provides', () => {
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
