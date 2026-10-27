/**
 * screenshot-harness.tsx — renders the REAL panel component for a screenshot.
 *
 * ## Why this exists
 *
 * The panel lives behind the harness's token-gated web UI, so a headless browser cannot reach it
 * (a clean profile gets a blank page). But a README that shows no screenshot asks the reader to
 * install something before they can see what it looks like.
 *
 * ⇒ This mounts the actual `SettingsPage` component with fake props. The CSS, the JSX and every
 * string are the shipped ones — only the data is fake. That is the honest form of a screenshot:
 * it shows the real layout, and it cannot show a real key.
 *
 * 🔴 Nothing here is shipped: this file lives under `scripts/` and is excluded from `files` in
 * package.json. It is a development instrument, not part of the plugin.
 */

import { createRoot } from 'react-dom/client'
import { SettingsPage } from '../src/client/SettingsPage.js'
import type { BalanceRow, ChannelRow, StatsResponse } from '../src/client/panel-api.js'

/** Channel fixtures shaped exactly like `/any-deepseek/channels`. */
const channels: ChannelRow[] = [
  {
    id: 'open-design',
    label: 'Open Design-1',
    model: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    baseURL: 'https://amr-link.open-design.ai/v1',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text', 'image'],
    warnings: [],
    keyConfigured: true,
    keyKind: 'literal',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go-1',
    model: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    baseURL: 'https://opencode.ai/zen/go/v1',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text', 'image'],
    warnings: [],
    keyConfigured: true,
    keyKind: 'literal',
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud-1',
    model: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    baseURL: 'https://ollama.com/v1',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text', 'image'],
    warnings: [],
    keyConfigured: true,
    keyKind: 'literal',
  },
  {
    id: 'deepseek-official',
    label: 'DeepSeek Official',
    model: 'deepseek-flash',
    api: 'openai-responses',
    baseURL: 'https://api.deepseek.com',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text', 'image'],
    warnings: [],
    keyConfigured: true,
    keyKind: 'literal',
  },
]

/** Balance fixtures: the four statuses the panel distinguishes, one channel each. */
const balances: BalanceRow[] = [
  {
    id: 'open-design',
    label: 'Open Design-1',
    status: 'alive',
    ms: 1793,
    responded: 'deepseek-flash',
    detail: 'no balance API',
  },
  {
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
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud-1',
    status: 'ok',
    reading: { amounts: [{ currency: 'USD', remaining: 55.48, allowance: 60 }], windows: [] },
  },
  {
    id: 'deepseek-official',
    label: 'DeepSeek Official',
    status: 'ok',
    reading: {
      amounts: [{ currency: 'CNY', remaining: 642.44, granted: 574.07, toppedUp: 68.37 }],
      windows: [],
      available: true,
    },
  },
]

/** A usage table with plausible rows, so the two groupings have something to show. */
const stats: StatsResponse = {
  range: { from: null, to: null, group: 'channel' },
  rows: [
    {
      key: 'deepseek-official',
      label: 'DeepSeek Official',
      tokensPerSecond: 168.2,
      firstTokenMs: 3145.3,
      // 284.94M total over 994 requests that reported usage.
      meanContext: 286_660,
      aggregate: {
        requests: 994, failures: 2, unreported: 0,
        input: 283_700_000, output: 1_240_000, cacheRead: 96_000_000, cacheWrite: 0,
        reasoning: 0, billableInput: 379_700_000, total: 284_940_000,
      },
    },
    {
      key: 'opencode-go',
      label: 'OpenCode Go-1',
      tokensPerSecond: 142.7,
      firstTokenMs: 1830.4,
      // 141.88M over 611 reporting requests (one did not report).
      meanContext: 232_209,
      aggregate: {
        requests: 612, failures: 0, unreported: 1,
        input: 141_000_000, output: 880_000, cacheRead: 52_000_000, cacheWrite: 0,
        reasoning: 0, billableInput: 193_000_000, total: 141_880_000,
      },
    },
    {
      key: 'ollama',
      label: 'Ollama Cloud-1',
      tokensPerSecond: 121.5,
      firstTokenMs: 1067.0,
      meanContext: 213_029,
      aggregate: {
        requests: 208, failures: 1, unreported: 0,
        input: 44_000_000, output: 310_000, cacheRead: 12_000_000, cacheWrite: 0,
        reasoning: 0, billableInput: 56_000_000, total: 44_310_000,
      },
    },
    {
      key: 'open-design',
      label: 'Open Design-1',
      tokensPerSecond: null,
      firstTokenMs: null,
      /*
       * 🔴 Deliberately NO `meanContext`, `tokensPerSecond` or `firstTokenMs`.
       *
       * This row is the harness's standing example of the unmeasurable case: the panel must render
       * `—` here, never `0`. A screenshot that only ever shows populated cells would let a
       * "zero instead of null" regression look correct, so one row keeps the empty shape on
       * purpose.
       */
      aggregate: {
        requests: 93, failures: 0, unreported: 0,
        input: 5_100_000, output: 94_000, cacheRead: 0, cacheWrite: 0,
        reasoning: 0, billableInput: 5_100_000, total: 5_194_000,
      },
    },
  ],
  total: {
    requests: 1907, failures: 3, unreported: 1,
    input: 473_800_000, output: 2_524_000, cacheRead: 160_000_000, cacheWrite: 0,
    reasoning: 0, billableInput: 633_800_000, total: 476_324_000,
  },
  totalSpeed: 161.4,
  totalFirstTokenMs: 2901.7,
  // 476.32M total over the 1906 requests that reported usage (one did not).
  meanContext: 249_908,
  note: '',
}

/** A settings snapshot as `useSettings(selector)` would hand it over. */
const settingsSnapshot = {
  value: { current: 'open-design' },
  status: 'ready',
}

const byId = new Map(balances.map((row) => [row.id, row]))

/*
 * 🔴 Render inside a try/catch that WRITES THE FAILURE INTO THE PAGE.
 *
 * The first run of this harness produced a fully blank page with no console message captured —
 * a bundle that is present, parsed, and does nothing is the worst failure shape here, because the
 * screenshot would silently be a picture of nothing. A caught error printed into #root turns that
 * into a readable fact.
 */
function fail(message: string): void {
  const root = document.getElementById('root')
  if (root !== null) root.textContent = `HARNESS FAILED: ${message}`
}

/**
 * Which state to render.
 *
 * `?variant=add` shows a two-channel install with the add form open, so the form fits inside one
 * viewport — the four-channel list plus the form is 1154px tall, taller than the 813px window.
 * Two channels is a real state, not a mock-up; the README says so beside the image.
 */
const variant = new URLSearchParams(window.location.search).get('variant') ?? 'list'
const visibleChannels = variant === 'add' ? channels.slice(0, 2) : channels

/**
 * A 13-day usage table, newest-first, for verifying the row limit and 「查看更多」.
 *
 * 🔴 Why this fixture has to be LONGER than the limit: with the four-row fixture the cap never
 * engages, so both the truncation and the button are unreachable — a screenshot would show the
 * happy path and prove nothing about the feature. 13 rows is also deliberately 3 over the limit:
 * 11 would test the same branch, but 13 makes the "还有 N 天" count awkward enough that an
 * off-by-one is visible rather than plausible.
 *
 * Days are generated NEWEST-FIRST to match what the server now returns, so the fixture cannot
 * disagree with the code about ordering.
 */
const dayStats: StatsResponse = (() => {
  const rows = []
  for (let i = 0; i < 13; i++) {
    const day = 27 - i
    const requests = 1000 + i * 137
    rows.push({
      key: `2026-10-${String(day).padStart(2, '0')}`,
      label: `2026-10-${String(day).padStart(2, '0')}`,
      tokensPerSecond: 150 + i,
      firstTokenMs: 2900 + i * 10,
      meanContext: 280_000 - i * 1000,
      aggregate: {
        requests,
        failures: i,
        unreported: i,
        input: requests * 3000,
        output: requests * 400,
        cacheRead: requests * 30000,
        cacheWrite: 0,
        reasoning: requests * 200,
        billableInput: requests * 33000,
        total: requests * 33400,
      },
    })
  }
  return {
    range: { from: null, to: null, group: 'day' },
    rows,
    total: {
      requests: 31057, failures: 347, unreported: 347,
      input: 136_900_000, output: 19_900_000, cacheRead: 7_831_900_000, cacheWrite: 0,
      reasoning: 0, billableInput: 7_968_800_000, total: 7_988_800_000,
    },
    totalSpeed: 165.2,
    totalFirstTokenMs: 2900,
    meanContext: 260_000,
    note: '',
  }
})()

/** The stats the panel receives; `variant=days` swaps in a table long enough to hit the cap. */
const activeStats = variant === 'days' ? dayStats : stats

try {
  const root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(
    <SettingsPage
      /* The real component's props, faked: this is the entire point of the harness. */
      {...({
        useSettings: (selector: (snapshot: unknown) => unknown) => selector(settingsSnapshot),
        loadChannels: async () => ({ channels: visibleChannels, presets: [], model: { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' } }),
        loadStats: async () => activeStats,
        probe: async () => ({ ok: true, ms: 117, responded: 'deepseek-flash' }),
        loadBalances: async () => ({ channels: balances }),
        setField: async () => true,
        removeField: async () => true,
      } as never)}
    />,
  )

  /*
   * The balances are only fetched when the user clicks 查询余额 — by design (each call reaches a
   * provider's account surface). For a screenshot the click has to happen, so it is dispatched
   * once the list has painted.
   *
   * `variant=add` opens the add form instead, and skips the balance check (that screenshot is
   * about the form, and a balance row would push the buttons off screen).
   */
  window.setTimeout(() => {
    const buttons = [...document.querySelectorAll('button')]
    if (variant === 'add') {
      buttons.find((button) => button.textContent?.includes('添加渠道'))?.click()
      return
    }
    if (variant === 'days') {
      // The 用量 tab, then the 按天 grouping: the row limit only applies to a long day table, so
      // the screenshot is only about the cap once both are selected.
      buttons.find((button) => button.textContent?.includes('用量'))?.click()
      window.setTimeout(() => {
        const later = [...document.querySelectorAll('button')]
        later.find((button) => button.textContent?.trim() === '按天')?.click()
      }, 80)
      return
    }
    buttons.find((button) => button.textContent?.includes('查询余额'))?.click()
    void byId
  }, 80)
} catch (cause) {
  fail(cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause))
}
