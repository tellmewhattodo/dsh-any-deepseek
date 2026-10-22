/**
 * balance.test.ts — reading three unrelated account surfaces.
 *
 * ## Why the shapes here are transcribed rather than invented
 *
 * Each fixture below is the example from the provider's own documentation, because the whole
 * point of this module is that **there is no common shape to guess at**:
 *  · DeepSeek `GET /user/balance`      — api-docs.deepseek.com/api/get-user-balance
 *  · Ollama   `GET /api/balance`       — docs.ollama.com/api/balance
 *  · new-api / one-api billing pair    — the OpenAI-legacy `/dashboard/billing/*` clone
 *
 * ## The rule every test here defends
 *
 * **A missing number is reported as missing, never as zero.** "We could not read it" and "it is
 * empty" lead to opposite actions, and only one of them is true. The `1e8` sentinel case is the
 * sharpest: new-api uses it to mean *unlimited*, so a naive reader would display a hundred
 * million dollars.
 */

import { describe, expect, it } from 'vitest'

import {
  balanceUrls,
  parseDeepSeekBalance,
  parseOllamaBalance,
  parseOpencodeWindows,
  parseOpenAIBilling,
  probeUrlsFor,
  readBalance,
} from '../src/balance.js'

describe('balanceUrls — the path is per shape, because the surfaces do not share a base', () => {
  it('DeepSeek reports on the bare origin, not under /v1', () => {
    expect(balanceUrls({ shape: 'deepseek' }, 'https://api.deepseek.com')).toEqual([
      'https://api.deepseek.com/user/balance',
    ])
  })

  it('🔴 Ollama reports on /api even though it infers on /v1', () => {
    // The inference baseURL is `https://ollama.com/v1`; appending `/balance` to it 404s. This is
    // exactly why `balance.baseURL` exists as an override.
    expect(balanceUrls({ shape: 'ollama', baseURL: 'https://ollama.com' }, 'https://ollama.com/v1'))
      .toEqual(['https://ollama.com/api/balance'])
  })

  it('the billing shape needs TWO calls — limit and usage live apart', () => {
    expect(balanceUrls({ shape: 'openai-billing' }, 'https://relay.example/v1')).toEqual([
      'https://relay.example/v1/dashboard/billing/subscription',
      'https://relay.example/v1/dashboard/billing/usage',
    ])
  })

  it('tolerates a trailing slash on the base', () => {
    expect(balanceUrls({ shape: 'deepseek' }, 'https://api.deepseek.com/')).toEqual([
      'https://api.deepseek.com/user/balance',
    ])
  })

  it('🔴 an undeclared shape yields NO urls — "no balance API" is a real answer', () => {
    // OpenCode Go is this case today (anomalyco/opencode#44189): the balance exists but is not
    // reachable with an API key. Returning a speculative URL would produce a misleading failure.
    expect(probeUrlsFor(undefined, 'https://opencode.ai/zen/go/v1')).toEqual([])
  })
})

describe('parseDeepSeekBalance', () => {
  /** The documented example, verbatim. */
  const body = {
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    }],
  }

  it('🔴 reads totals that are quoted as STRINGS', () => {
    // Their example quotes money as strings. Trusting the type would put "110.00" into a numeric
    // column and make every downstream sum NaN.
    const reading = parseDeepSeekBalance(body)
    expect(reading?.amounts).toHaveLength(1)
    expect(reading?.amounts[0]).toEqual({
      currency: 'CNY',
      remaining: 110,
      granted: 10,
      toppedUp: 100,
    })
  })

  it('carries is_available through, because false means calls are about to fail', () => {
    expect(parseDeepSeekBalance({ ...body, is_available: false })?.available).toBe(false)
  })

  it('handles multiple currencies', () => {
    const reading = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '5.00' },
        { currency: 'CNY', total_balance: '36.00' },
      ],
    })
    expect(reading?.amounts.map((a) => a.currency)).toEqual(['USD', 'CNY'])
  })

  it('returns undefined for a body of another shape', () => {
    expect(parseDeepSeekBalance({ error: 'nope' })).toBeUndefined()
    expect(parseDeepSeekBalance(null)).toBeUndefined()
  })
})

describe('parseOllamaBalance', () => {
  it('🔴 sums included and purchased — both are spendable', () => {
    // The documented example: included 72.5, purchased 25. Reporting only `included` would
    // understate by the purchased half.
    const reading = parseOllamaBalance({
      included: {
        balance_usd: 72.5,
        allowance_usd: 100,
        period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' },
      },
      purchased: { balance_usd: 25 },
    })
    expect(reading?.amounts[0]).toMatchObject({ currency: 'USD', remaining: 97.5, allowance: 100 })
    expect(reading?.note).toContain('2026-09-15')
  })

  it('reads legacy plans, which meter in PERCENTAGES rather than money', () => {
    // Same endpoint, older plan shape. A parser that only knows `balance_usd` would show an empty
    // row for a perfectly healthy account.
    const reading = parseOllamaBalance({
      included: {
        session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
        weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
      },
      purchased: { balance_usd: 25 },
    })
    expect(reading?.windows).toEqual([
      { name: 'session', remainingPercent: 75, resetsAt: '2026-10-01T07:00:00Z' },
      { name: 'weekly', remainingPercent: 40, resetsAt: '2026-10-05T00:00:00Z' },
    ])
    // The purchased credit is still real money, so it is still reported as an amount.
    expect(reading?.amounts[0]?.remaining).toBe(25)
  })

  it('returns undefined when `included` is missing', () => {
    expect(parseOllamaBalance({ purchased: { balance_usd: 1 } })).toBeUndefined()
  })
})

describe('parseOpenAIBilling', () => {
  it('🔴 converts total_usage from CENTS before subtracting', () => {
    // The classic silent error: `hard_limit_usd` is dollars, `total_usage` is cents. Subtracting
    // them raw makes a 100-dollar plan with 5 dollars spent look 95% consumed.
    const reading = parseOpenAIBilling(
      { hard_limit_usd: 100 },
      { total_usage: 500 },
    )
    expect(reading?.amounts[0]).toMatchObject({ currency: 'USD', remaining: 95, allowance: 100 })
  })

  it('🔴 treats the 1e8 sentinel as UNLIMITED, not as a hundred million dollars', () => {
    const reading = parseOpenAIBilling({ hard_limit_usd: 1e8 }, { total_usage: 320 })
    // No amount is fabricated; the spend is reported as the fact we actually have.
    expect(reading?.amounts).toEqual([])
    expect(reading?.note).toContain('3.20')
    expect(reading?.note).toContain('unlimited')
  })

  it('never reports a negative remainder', () => {
    const reading = parseOpenAIBilling({ hard_limit_usd: 5 }, { total_usage: 1000 })
    expect(reading?.amounts[0]?.remaining).toBe(0)
  })

  it('shows the limit when consumption is unreadable, rather than nothing', () => {
    const reading = parseOpenAIBilling({ hard_limit_usd: 20 }, undefined)
    expect(reading?.amounts[0]).toMatchObject({ remaining: 20, allowance: 20 })
  })

  it('returns undefined when neither body is usable', () => {
    expect(parseOpenAIBilling(undefined, undefined)).toBeUndefined()
    expect(parseOpenAIBilling({ nope: 1 }, { nope: 2 })).toBeUndefined()
  })
})

describe('parseOpencodeWindows — windows, never money', () => {
  /**
   * 🔴 The owner's memory was right and my first draft was wrong: OpenCode DOES expose a usage
   * query. What it does not expose (to an API key) is the credit wallet.
   *
   * Proof the route exists, obtained WITHOUT a key by discriminating on status code:
   *   /zen/go/v1/usage                    → 401  (route present, auth required)
   *   /zen/go/v1/totally-made-up-path-xyz → 404  (no such route)
   *   /zen/v1/balance                     → 404  (the endpoint #44189 is still asking for)
   * A blanket "401 means nothing is there" reading would have been wrong here.
   */

  it('🔴 inverts `percent`, which the API reports as USED', () => {
    // Passing it through unchanged would tell a user who has used 12% that 12% REMAINS — off by
    // 88 points, and wrong in the alarming direction.
    const reading = parseOpencodeWindows({
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: '2026-10-23T05:00:00Z' },
        weekly: { status: 'ok', percent: 34 },
        monthly: { status: 'ok', percent: 56 },
      },
    })
    expect(reading?.windows.map((w) => [w.name, w.remainingPercent])).toEqual([
      ['rolling', 88],
      ['weekly', 66],
      ['monthly', 44],
    ])
    expect(reading?.windows[0]?.resetsAt).toBe('2026-10-23T05:00:00Z')
  })

  it('reports NO currency amount, and says why', () => {
    const reading = parseOpencodeWindows({ usage: { weekly: { percent: 10 } } })
    expect(reading?.amounts).toEqual([])
    expect(reading?.note).toContain('not readable with an API key')
  })

  it('🔴 picks up a balance object the day they ship it — no code change here', () => {
    // #44189 asks for exactly this object. When it lands, the number appears by itself.
    const reading = parseOpencodeWindows({
      usage: { weekly: { percent: 10 } },
      balance: { usd: 4.1, currency: 'USD', asOf: '2026-08-22T17:00:00Z' },
    })
    expect(reading?.amounts).toEqual([{ currency: 'USD', remaining: 4.1 }])
  })

  it('accepts the keys hoisted to the top level', () => {
    const reading = parseOpencodeWindows({ rolling: { percent: 5 } })
    expect(reading?.windows[0]).toMatchObject({ name: 'rolling', remainingPercent: 95 })
  })

  it('returns undefined when nothing recognizable is present', () => {
    expect(parseOpencodeWindows({ error: 'nope' })).toBeUndefined()
  })
})

describe('readBalance — dispatch', () => {
  it('routes each shape to its own parser', () => {
    expect(readBalance({ shape: 'deepseek' }, [{ balance_infos: [{ currency: 'CNY', total_balance: '1' }] }]))
      .toMatchObject({ amounts: [{ remaining: 1 }] })
    expect(readBalance({ shape: 'ollama' }, [{ included: { balance_usd: 2 } }]))
      .toMatchObject({ amounts: [{ remaining: 2 }] })
    expect(readBalance({ shape: 'openai-billing' }, [{ hard_limit_usd: 10 }, { total_usage: 100 }]))
      .toMatchObject({ amounts: [{ remaining: 9 }] })
    expect(readBalance({ shape: 'opencode-windows' }, [{ usage: { weekly: { percent: 20 } } }]))
      .toMatchObject({ windows: [{ name: 'weekly', remainingPercent: 80 }] })
  })
})
