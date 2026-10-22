/**
 * balance.ts — reading "how much is left" out of three unrelated account surfaces.
 *
 * ## Why this file is mostly parsing
 *
 * There is no standard. Owner request (2026-10-23): 「其它渠道的查看方式你需要找到并实现它们的」.
 * The three shapes below were each taken from the provider's own documentation, not guessed:
 *
 *  · **DeepSeek** — `GET /user/balance`:
 *      `{ is_available, balance_infos: [{ currency, total_balance, granted_balance,
 *       topped_up_balance }] }`   (api-docs.deepseek.com/api/get-user-balance)
 *  · **Ollama** — `GET /api/balance`:
 *      `{ included: { balance_usd, allowance_usd, period }, purchased: { balance_usd } }`,
 *      or, on legacy plans, `included: { session: {remaining_percent}, weekly: {…} }`
 *      (docs.ollama.com/api/balance)
 *  · **OpenAI-legacy billing** (cloned by new-api / one-api relays):
 *      `GET /v1/dashboard/billing/subscription` → `hard_limit_usd` / `soft_limit_usd`
 *      `GET /v1/dashboard/billing/usage`        → `total_usage` **in cents**
 *
 * ## The rule that shapes every function here
 *
 * 🔴 **A missing number is reported as missing, never as zero.** Three of these surfaces answer
 * with fields that are legitimately absent (a legacy Ollama plan has no `balance_usd`; a relay
 * may omit `hard_limit_usd`). Coercing those to `0` would render as "you are out of credit" —
 * a much worse statement than "not reported", and the one a user would act on.
 *
 * The `1e8` sentinel is the sharpest example: new-api uses `hard_limit_usd: 1e8` to mean
 * *unlimited*, so printing it as dollars would claim a hundred million dollar balance.
 */

import type { BalanceProbe } from './presets.js'

/** One currency-denominated remaining amount. */
export interface BalanceAmount {
  /** ISO-style currency code as the provider spells it (`USD`, `CNY`, …). */
  currency: string
  /** Remaining amount, in that currency's major unit. */
  remaining: number
  /** Total allowance for the period, when the provider reports one. */
  allowance?: number
  /** Gift/promotional part, when the provider splits it out. */
  granted?: number
  /** Topped-up (purchased) part, when the provider splits it out. */
  toppedUp?: number
}

/**
 * A percentage-based limit, used by providers that meter in windows rather than money.
 *
 * Ollama's legacy plans are the real case: `{ remaining_percent: 75, resets_at }`.
 */
export interface BalanceWindow {
  /** Window name as the provider spells it (`session`, `weekly`, …). */
  name: string
  /** Remaining share, 0–100. */
  remainingPercent: number
  /** Next reset, when reported. */
  resetsAt?: string
}

/** One channel's balance reading. */
export interface BalanceReading {
  /** Amounts by currency. Empty when the provider reports percentages instead. */
  amounts: BalanceAmount[]
  /** Percentage windows, when the provider meters that way. */
  windows: BalanceWindow[]
  /** Whether the provider says the account can currently make calls. */
  available?: boolean
  /** Note shown beside the numbers (period, reset, "unlimited", …). */
  note?: string
}

/**
 * The endpoint a probe must call for one shape.
 *
 * 🔴 The path is per shape because the surfaces do not share a base: Ollama infers on `/v1` but
 * reports on `/api`, and DeepSeek reports on the bare origin. This function is the single place
 * that knowledge lives, so a preset cannot disagree with the transport.
 * @param probe - the preset's declared probe.
 * @param channelBaseURL - the channel's inference base URL, used when the probe names none.
 * @returns the absolute URLs to GET, in order.
 */
export function balanceUrls(probe: BalanceProbe, channelBaseURL: string): string[] {
  const root = stripTrailingSlash(probe.baseURL ?? channelBaseURL)
  switch (probe.shape) {
    case 'deepseek':
      return [`${root}/user/balance`]
    case 'ollama':
      return [`${root}/api/balance`]
    case 'opencode-windows':
      // The Go subscription's usage windows. Note it is a sibling of the inference path, not a
      // child of it: inference is `/zen/go/v1/{chat/completions}` and this is `/zen/go/v1/usage`.
      return [`${root}/usage`]
    case 'openai-billing':
      // Two calls: the limit and the consumption live on different endpoints in this shape.
      return [`${root}/dashboard/billing/subscription`, `${root}/dashboard/billing/usage`]
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * The URL a channel's balance lives at, when its preset declares a shape.
 * @param probe - declared probe, or undefined for "no balance API".
 * @param channelBaseURL - the channel's inference base URL.
 * @returns the URLs, or an empty array when this endpoint has no balance surface.
 */
export function probeUrlsFor(
  probe: BalanceProbe | undefined,
  channelBaseURL: string,
): string[] {
  return probe === undefined ? [] : balanceUrls(probe, channelBaseURL)
}

/** Read a finite number, or undefined. Strings are accepted: these APIs quote decimals as text. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse DeepSeek's `GET /user/balance`.
 *
 * `total_balance` is a STRING in their example (`"110.00"`), so it is read as a number rather
 * than trusted as one — printing a string into a numeric column is how a panel ends up showing
 * `"110.00"` next to arithmetic that silently treats it as NaN.
 * @param body - the parsed JSON body.
 * @returns the reading, or undefined when the body is not this shape.
 */
export function parseDeepSeekBalance(body: unknown): BalanceReading | undefined {
  const root = asRecord(body)
  if (root === undefined) return undefined
  const infos = root.balance_infos
  if (!Array.isArray(infos)) return undefined
  const amounts: BalanceAmount[] = []
  for (const item of infos) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    const remaining = num(entry.total_balance)
    if (remaining === undefined) continue
    amounts.push({
      currency: text(entry.currency) ?? 'CNY',
      remaining,
      ...num(entry.granted_balance) === undefined ? {} : { granted: num(entry.granted_balance) },
      ...num(entry.topped_up_balance) === undefined ? {} : { toppedUp: num(entry.topped_up_balance) },
    })
  }
  if (amounts.length === 0) return undefined
  const available = root.is_available
  return {
    amounts,
    windows: [],
    ...typeof available === 'boolean' ? { available } : {},
  }
}

/**
 * Parse Ollama's `GET /api/balance`.
 *
 * Two plan generations answer this endpoint:
 *  · current — `included.balance_usd` / `allowance_usd` + `purchased.balance_usd`;
 *  · legacy   — `included.session.remaining_percent` / `included.weekly.remaining_percent`.
 * Both are handled because a user on an old plan must still see something true. `remaining` is
 * the sum of included + purchased: both are spendable, so reporting only one understates.
 * @param body - the parsed JSON body.
 * @returns the reading, or undefined when the body is not this shape.
 */
export function parseOllamaBalance(body: unknown): BalanceReading | undefined {
  const root = asRecord(body)
  if (root === undefined) return undefined
  const included = asRecord(root.included)
  const purchased = asRecord(root.purchased)
  if (included === undefined) return undefined

  const windows: BalanceWindow[] = []
  for (const name of ['session', 'weekly'] as const) {
    const window = asRecord(included[name])
    if (window === undefined) continue
    const remainingPercent = num(window.remaining_percent)
    if (remainingPercent === undefined) continue
    windows.push({
      name,
      remainingPercent,
      ...text(window.resets_at) === undefined ? {} : { resetsAt: text(window.resets_at) as string },
    })
  }

  const includedBalance = num(included.balance_usd)
  const purchasedBalance = num(purchased?.balance_usd)
  const amounts: BalanceAmount[] = []
  if (includedBalance !== undefined || purchasedBalance !== undefined) {
    amounts.push({
      currency: 'USD',
      remaining: (includedBalance ?? 0) + (purchasedBalance ?? 0),
      ...includedBalance === undefined ? {} : { allowance: num(included.allowance_usd) },
      ...purchasedBalance === undefined ? {} : { toppedUp: purchasedBalance },
    })
  }

  const period = asRecord(included.period)
  const note = period === undefined
    ? undefined
    : `period ${text(period.from) ?? '?'} → ${text(period.until) ?? '?'}`

  if (amounts.length === 0 && windows.length === 0) return undefined
  return {
    amounts,
    windows,
    ...note === undefined ? {} : { note },
  }
}

/**
 * Parse the OpenAI-legacy billing pair.
 *
 * 🔴 Two conversions here are load-bearing, and both are the kind of thing that reads correctly
 * while being wrong:
 *  · `total_usage` is in **CENTS**, while `hard_limit_usd` is in **dollars**. Comparing them
 *    directly divides the limit by 100 in effect — a balance that looks 99% consumed.
 *  · `hard_limit_usd: 1e8` is new-api's **"unlimited" sentinel**, not a hundred million dollars.
 *    It is reported as no allowance rather than as a number.
 * @param subscription - body of `/dashboard/billing/subscription`.
 * @param usage - body of `/dashboard/billing/usage`.
 * @returns the reading, or undefined when neither body is this shape.
 */
export function parseOpenAIBilling(
  subscription: unknown,
  usage: unknown,
): BalanceReading | undefined {
  const sub = asRecord(subscription)
  const use = asRecord(usage)
  if (sub === undefined && use === undefined) return undefined

  const hardLimit = num(sub?.hard_limit_usd)
  const softLimit = num(sub?.soft_limit_usd)
  const usedCents = num(use?.total_usage)

  /** new-api's sentinel for "no cap". */
  const UNLIMITED = 1e8
  const allowance = hardLimit !== undefined && hardLimit < UNLIMITED
    ? hardLimit
    : softLimit !== undefined && softLimit < UNLIMITED ? softLimit : undefined

  // Cents → dollars. Only after this conversion may the two be subtracted.
  const used = usedCents === undefined ? undefined : usedCents / 100

  const amounts: BalanceAmount[] = []
  if (allowance !== undefined && used !== undefined) {
    amounts.push({ currency: 'USD', remaining: Math.max(0, allowance - used), allowance })
  } else if (allowance !== undefined) {
    // Limit known, consumption not: the limit is still the honest fact to show.
    amounts.push({ currency: 'USD', remaining: allowance, allowance })
  } else if (used !== undefined) {
    // Consumption known, limit not (the unlimited sentinel): report spend, not a fake balance.
    amounts.push({ currency: 'USD', remaining: 0, allowance: undefined })
    return {
      amounts: [],
      windows: [],
      note: `used $${used.toFixed(2)}; this relay reports no cap (unlimited)`,
    }
  }

  if (amounts.length === 0) return undefined
  return {
    amounts,
    windows: [],
    note: allowance === undefined ? 'no cap reported' : undefined,
  }
}

/**
 * Parse OpenCode Go's `GET /zen/go/v1/usage`.
 *
 * 🔴 **This surface reports WINDOWS, never money.** The owner remembered correctly that OpenCode
 * exposes a usage query — and it does; what it does not expose (to an API key) is the credit
 * wallet, which lives behind a logged-in browser session. The only key-authenticated money signal
 * is the error thrown at $0 (anomalyco/opencode#44189), which is why the feature request asks for
 * a `balance` object to be added to this very endpoint.
 *
 * Two response shapes are accepted, because a monitor should not break when the provider ships
 * the requested addition:
 *  · `{ usage: { rolling: {percent, resetsAt}, weekly: … , monthly: … } }`
 *  · the same keys hoisted to the top level.
 * A `balance` object is read IF PRESENT — so the day they merge that request, the number appears
 * with no code change here.
 * @param body - the parsed JSON body.
 * @returns the reading, or undefined when the body carries no recognizable window.
 */
export function parseOpencodeWindows(body: unknown): BalanceReading | undefined {
  const root = asRecord(body)
  if (root === undefined) return undefined
  const usage = asRecord(root.usage) ?? root

  const windows: BalanceWindow[] = []
  for (const name of ['rolling', 'weekly', 'monthly'] as const) {
    const window = asRecord(usage[name])
    if (window === undefined) continue
    // Percent-of-limit consumed → remaining. The API names it `percent`; its direction is
    // "used", which is the opposite of what this module reports, so it is inverted here and
    // labelled accordingly rather than passed through and misread.
    const used = num(window.percent)
    if (used === undefined) continue
    windows.push({
      name,
      remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      ...text(window.resetsAt) === undefined ? {} : { resetsAt: text(window.resetsAt) as string },
    })
  }

  const amounts: BalanceAmount[] = []
  const balance = asRecord(root.balance)
  const usd = num(balance?.usd)
  if (usd !== undefined) {
    amounts.push({ currency: text(balance?.currency) ?? 'USD', remaining: usd })
  }

  if (windows.length === 0 && amounts.length === 0) return undefined
  return {
    amounts,
    windows,
    note: amounts.length === 0
      ? 'subscription usage windows; the credit balance is not readable with an API key'
      : undefined,
  }
}

/**
 * Map one channel's raw bodies onto a reading, dispatching on the declared shape.
 * @param probe - the preset's declared probe.
 * @param bodies - response bodies in the order {@link balanceUrls} returned URLs.
 * @returns the reading, or undefined when the bodies do not match the declared shape.
 */
export function readBalance(
  probe: BalanceProbe,
  bodies: readonly unknown[],
): BalanceReading | undefined {
  switch (probe.shape) {
    case 'deepseek':
      return parseDeepSeekBalance(bodies[0])
    case 'ollama':
      return parseOllamaBalance(bodies[0])
    case 'opencode-windows':
      return parseOpencodeWindows(bodies[0])
    case 'openai-billing':
      return parseOpenAIBilling(bodies[0], bodies[1])
  }
}
