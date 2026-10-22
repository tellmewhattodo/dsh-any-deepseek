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

try {
  const root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(
    <SettingsPage
      /* The real component's props, faked: this is the entire point of the harness. */
      {...({
        useSettings: (selector: (snapshot: unknown) => unknown) => selector(settingsSnapshot),
        loadChannels: async () => ({ channels, presets: [], model: { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' } }),
        loadStats: async () => stats,
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
   */
  window.setTimeout(() => {
    const buttons = [...document.querySelectorAll('button')]
    const target = buttons.find((button) => button.textContent?.includes('查询余额'))
    target?.click()
    void byId
  }, 60)
} catch (cause) {
  fail(cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause))
}
