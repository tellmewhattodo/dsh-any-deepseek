/**
 * http.test.ts — the panel's data routes.
 *
 * ## Why these routes get their own suite
 *
 * The panel is the only way a user answers "which channel is live", "what is it costing me",
 * and "does this key work". If these routes answer wrongly — or answer 200 with a body the
 * panel cannot read — the panel fails silently, and a silent panel is the failure mode this
 * whole container keeps paying for. So the route handlers are driven directly with a fake
 * request/response pair; no HTTP listener is involved.
 *
 * ## What is asserted
 *
 * The contract the client half actually depends on: status codes, JSON shape, and the two
 * promises that must never be broken — a key value never leaves the server, and a probe that
 * spends tokens never runs implicitly.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ROUTE_PREFIX,
  registerStatsRoutes,
  probeChannel,
  probeRequest,
  reportedName,
  errorFieldValue,
  balanceRow,
  type RouteDeps,
  type WebServerLike,
} from '../src/http.js'
import type { ResolvedChannel } from '../src/channels.js'
import { ADVERTISED_MODEL_ID, ADVERTISED_MODEL_NAME } from '../src/presets.js'
import { PROVIDER_NAME } from '../src/adapter.js'

/** One resolved channel for the fixtures. */
function channel(overrides: Partial<ResolvedChannel> = {}): ResolvedChannel {
  return {
    id: 'go',
    label: 'OpenCode Go',
    api: 'openai-completions',
    baseURL: 'https://relay.example/v1',
    model: 'deepseek-v4.1-flash',
    credential: { kind: 'literal', value: 'sk-secret-value' },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text'],
    warnings: [],
    ...overrides,
  }
}

/** A captured response. */
interface Captured {
  status: number
  body: unknown
  headers: Record<string, string>
}

/** A handler as registered. */
type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Register the routes against a fake server and return a caller that drives one handler.
 *
 * The request is a real async iterable so `readBody` exercises its actual loop instead of a stub.
 */
function mount(deps: Partial<RouteDeps> = {}): {
  call: (path: string, init?: { method?: string; body?: unknown; query?: string }) => Promise<Captured>
  routes: string[]
} {
  const handlers = new Map<string, Handler>()
  const webServer: WebServerLike = {
    register: (route) => {
      handlers.set(route.path, route.handler)
      return () => {}
    },
  }

  const full: RouteDeps = {
    channels: () => [channel()],
    resolveKey: async () => 'sk-secret-value',
    listPresets: () => [{ id: 'opencode-go', displayName: 'OpenCode Go' }],
    // Mirrors what `apply` wires: the MODEL name, not the provider name.
    advertised: () => ({ id: ADVERTISED_MODEL_ID, name: ADVERTISED_MODEL_NAME }),
    describeKey: async () => ({ configured: true, source: 'store' }),
    // Point at a directory that does not exist so the panel's "empty book" branch is exercised
    // without ever touching the real `~/.dsh/any-deepseek` ledger. Tests that need data override it.
    ledgerDir: () => join(tmpdir(), `any-deepseek-http-test-${process.pid}`, 'absent'),
    ...deps,
  }

  registerStatsRoutes({ effect: () => {} }, webServer, full)

  const call = async (
    path: string,
    init: { method?: string; body?: unknown; query?: string } = {},
  ): Promise<Captured> => {
    const handler = handlers.get(path)
    if (handler === undefined) throw new Error(`no handler for ${path}`)
    const payload = init.body === undefined ? '' : JSON.stringify(init.body)
    const req = (async function* () {
      if (payload !== '') yield Buffer.from(payload)
    })() as unknown as IncomingMessage
    req.method = init.method ?? 'GET'
    req.url = init.query === undefined ? path : `${path}?${init.query}`

    const captured: Captured = { status: 0, body: undefined, headers: {} }
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        captured.status = status
        captured.headers = headers
        return res
      },
      end(text: string) {
        captured.body = JSON.parse(text)
        return res
      },
    } as unknown as ServerResponse

    await handler(req, res)
    return captured
  }

  return { call, routes: [...handlers.keys()] }
}

describe('route surface', () => {
  it('registers channels, stats, probe and balance under one prefix', () => {
    const { routes } = mount()
    expect(routes.sort()).toEqual([
      `${ROUTE_PREFIX}/balance`,
      `${ROUTE_PREFIX}/channels`,
      `${ROUTE_PREFIX}/probe`,
      `${ROUTE_PREFIX}/stats`,
    ].sort())
  })
})

describe('GET /channels', () => {
  it('reports key state but never the key value', async () => {
    const { call } = mount({ describeKey: async () => ({ configured: true, source: 'store' }) })
    const response = await call(`${ROUTE_PREFIX}/channels`)

    expect(response.status).toBe(200)
    const body = response.body as {
      channels: Array<Record<string, unknown>>
      presets: unknown[]
      model: { id: string }
    }
    expect(body.channels).toHaveLength(1)
    expect(body.channels[0]).toMatchObject({ id: 'go', keyConfigured: true })
    // The single promise this route makes: a value never crosses it.
    expect(JSON.stringify(body)).not.toContain('sk-secret-value')
    expect(body.presets).toHaveLength(1)
    expect(body.model.id).toBe('deepseek-v4.1-flash')
  })

  it('reports the MODEL name, not the provider name', async () => {
    // The panel prints this inside "一个模型（…）". Handing it the provider name there read as
    // a copy-paste slip on screen ("一个模型（Any DeepSeek）").
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/channels`)
    const model = (response.body as { model: { id: string; name: string } }).model
    expect(model.name).not.toBe(PROVIDER_NAME)
    expect(model.name).toBe(ADVERTISED_MODEL_NAME)
  })

  it('marks an unconfigured key as absent rather than failing the route', async () => {
    const { call } = mount({ channels: () => [channel({ credential: { kind: 'none' } })] })
    const response = await call(`${ROUTE_PREFIX}/channels`)
    expect(response.status).toBe(200)
    expect((response.body as { channels: Array<{ keyConfigured: boolean }> }).channels[0]?.keyConfigured).toBe(false)
  })

  it('reports WHERE the key lives, so the panel knows if it can rewrite it', async () => {
    // `literal` — the panel may overwrite it in place.
    // `reference` — a name; the panel cannot read the value, and must not pretend it can.
    const literal = await mount().call(`${ROUTE_PREFIX}/channels`)
    expect((literal.body as { channels: Array<Record<string, unknown>> }).channels[0])
      .toMatchObject({ keyKind: 'literal', keyConfigured: true })

    const reference = await mount({
      channels: () => [channel({ credential: { kind: 'reference', ref: 'GO_KEY' } })],
      describeKey: async () => ({ configured: true, source: 'store' }),
    }).call(`${ROUTE_PREFIX}/channels`)
    expect((reference.body as { channels: Array<Record<string, unknown>> }).channels[0])
      .toMatchObject({ keyKind: 'reference', keyRef: 'GO_KEY', keyConfigured: true })
  })

  it('🔴 answers a literal key WITHOUT consulting the credential seam', async () => {
    // A channel that stores its own key must not depend on the harness credential service being
    // composed — that dependency is exactly what the store-the-key-on-the-channel change removed.
    const describeKey = vi.fn(async () => ({ configured: false }))
    const { call } = mount({ describeKey })
    await call(`${ROUTE_PREFIX}/channels`)
    expect(describeKey).not.toHaveBeenCalled()
  })

  it('sets no-store so a stale key state is never served from cache', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/channels`)
    expect(response.headers['cache-control']).toBe('no-store')
  })
})

describe('GET /stats', () => {
  it('returns aggregates with the counting convention attached', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/stats`)

    expect(response.status).toBe(200)
    const body = response.body as {
      range: { group: string; from: string | null; to: string | null }
      rows: unknown[]
      total: { requests: number }
      note: string
    }
    // Disjoint counters mean a reader who sums the wrong columns concludes input is
    // under-reported; the note travels with the payload so no consumer invents its own.
    expect(body.note).toContain('cacheRead')
    expect(body.range.group).toBe('channel')
    expect(Array.isArray(body.rows)).toBe(true)
    expect(body.total.requests).toBe(0)
  })

  it('accepts the day grouping and an explicit range', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/stats`, {
      query: 'group=day&from=2026-10-01T00:00:00Z&to=2026-10-19T00:00:00Z',
    })
    const body = response.body as { range: { group: string; from: string; to: string } }
    expect(body.range.group).toBe('day')
    expect(body.range.from).toBe('2026-10-01T00:00:00.000Z')
  })

  it('🔴 defaults to the last 7 days when no range is given (owner 2026-10-24: 「只保留近一周」)', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/stats`)
    const body = response.body as { range: { from: string | null; to: string | null } }
    // The default view is a week. This is a DISPLAY default, not data deletion — the ledger files
    // are untouched and an explicit range still reads anything (assertions below).
    expect(body.range.from).not.toBeNull()
    expect(body.range.to).not.toBeNull()
    const spanDays = (new Date(body.range.to as string).getTime() - new Date(body.range.from as string).getTime()) / 86_400_000
    expect(spanDays).toBeCloseTo(7, 5)
  })

  it('🔴 an explicit range still overrides the 7-day default (older data stays readable)', async () => {
    // Narrowing the VIEW must not narrow the DATA. If this ever fails, the "last 7 days" change
    // has silently become a retention policy on history — which nobody asked for.
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/stats`, {
      query: 'from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z',
    })
    const body = response.body as { range: { from: string; to: string } }
    expect(body.range.from).toBe('2026-01-01T00:00:00.000Z')
    expect(body.range.to).toBe('2026-01-31T00:00:00.000Z')
  })

  it('ignores an unparseable date rather than returning 400', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/stats`, { query: 'from=not-a-date' })
    // The panel refreshes on a timer; a malformed range must degrade to the default window,
    // not to an error the user cannot act on.
    expect(response.status).toBe(200)
    // Still the 7-day default rather than null: an unparseable bound falls back, it does not open
    // the range to all time (which would silently show the whole history under a "近一周" heading).
    expect((response.body as { range: { from: string | null } }).range.from).not.toBeNull()
  })

  describe('🔴 rows carry the channel DISPLAY NAME (owner: 「统计要按显示名称来」)', () => {
    /** Write one ledger entry for `channelId` into a temp dir and serve stats from it. */
    const withLedger = async (
      channelId: string,
      channels: ResolvedChannel[],
    ): Promise<Array<{ key: string; label?: string }>> => {
      const dir = mkdtempSync(join(tmpdir(), 'any-deepseek-stats-'))
      // 🔴 The entry time must be RELATIVE to now, not a frozen literal.
      //
      // This fixture used a hard-coded `2026-10-22T10:00:00+08:00` while `/stats` defaults to a
      // ROLLING seven-day window (`http.ts`: `now - 7 * 24h`). The entry therefore sat just inside
      // the window until wall-clock time passed 2026-10-29T10:00 — at which moment these three
      // assertions turned red with a message that pointed at display names, i.e. at nothing.
      //
      // It failed for the first time at 2026-10-29T10:22, ~22 minutes after the entry aged out.
      // Nothing in the repo had changed; a green suite silently carried a deadline.
      //
      // A literal chosen "recently enough" just moves the deadline. Anchoring to `now` removes it:
      // the fixture states the only thing the assertions actually need — an entry INSIDE the
      // default window.
      const at = new Date(Date.now() - 60_000).toISOString()
      const month = at.slice(0, 7)
      writeFileSync(
        join(dir, `usage-${month}.jsonl`),
        `${JSON.stringify({
          at,
          channel: channelId,
          model: 'deepseek-v4.1-flash',
          ok: true,
          ms: 100,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        })}\n`,
        'utf8',
      )
      const { call } = mount({ ledgerDir: () => dir, channels: () => channels })
      const response = await call(`${ROUTE_PREFIX}/stats`)
      return (response.body as { rows: Array<{ key: string; label?: string }> }).rows
    }

    it('prints the label, while keeping the id as the row key', async () => {
      // The id is the channel's identity (renaming must never touch it), but it is an
      // implementation handle: showing it made the usage table disagree with the channel list
      // directly above it about the very same channel.
      const rows = await withLedger('open-design', [channel({ id: 'open-design', label: 'Open Design-1' })])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.key).toBe('open-design')
      expect(rows[0]?.label).toBe('Open Design-1')
    })

    it('🔴 a rename shows up in HISTORICAL rows without rewriting the ledger', async () => {
      // Resolution happens at read time from the live channel list, which is what makes this
      // free: the old entry still says `open-design`, the panel says the new name.
      const rows = await withLedger('open-design', [channel({ id: 'open-design', label: 'Renamed Relay' })])
      expect(rows[0]?.label).toBe('Renamed Relay')
    })

    it('falls back to the id when the channel is gone — real usage must stay visible', async () => {
      const rows = await withLedger('deleted-one', [])
      expect(rows[0]?.key).toBe('deleted-one')
      expect(rows[0]?.label).toBe('deleted-one')
    })
  })
})

describe('POST /probe', () => {
  it('refuses a non-POST method', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/probe`)
    expect(response.status).toBe(405)
  })

  it('requires an id', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/probe`, { method: 'POST', body: {} })
    expect(response.status).toBe(400)
  })

  it('404s for an unknown channel', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/probe`, { method: 'POST', body: { id: 'nope' } })
    expect(response.status).toBe(404)
  })

  it('reports MISSING_CREDENTIAL instead of sending an unauthenticated request', async () => {
    const { call } = mount({ channels: () => [channel({ credential: { kind: 'none' } })] })
    const response = await call(`${ROUTE_PREFIX}/probe`, { method: 'POST', body: { id: 'go' } })
    expect(response.status).toBe(409)
    expect((response.body as { code: string }).code).toBe('MISSING_CREDENTIAL')
  })

  it('resolves a legacy reference exactly as the request path would', async () => {
    // A probe that read the key differently from the adapter would certify a channel the plugin
    // cannot actually use. Reference channels therefore go through `resolveKey` here too.
    const resolveKey = vi.fn(async () => 'sk-from-store')
    const { call } = mount({
      channels: () => [channel({ credential: { kind: 'reference', ref: 'GO_KEY' } })],
      resolveKey,
    })
    // The probe will fail to reach the network, which is fine — what matters is that it tried
    // with a resolved key rather than short-circuiting to 409.
    await call(`${ROUTE_PREFIX}/probe`, { method: 'POST', body: { id: 'go' } })
    expect(resolveKey).toHaveBeenCalledWith('GO_KEY')
  })

  it('never probes implicitly — only when an id is posted', async () => {
    // A probe spends real tokens. GETs on the other routes must not trigger one.
    const resolveKey = vi.fn(async () => 'sk-secret-value')
    const { call } = mount({
      channels: () => [channel({ credential: { kind: 'reference', ref: 'GO_KEY' } })],
      resolveKey,
    })
    await call(`${ROUTE_PREFIX}/channels`)
    await call(`${ROUTE_PREFIX}/stats`)
    expect(resolveKey).not.toHaveBeenCalled()
  })
})

describe('probeRequest — a probe must speak the channel\'s protocol', () => {
  /**
   * 🔴 The probe hardcoded `/chat/completions`. With the Responses API selectable per channel
   * (owner directive 2026-10-22), that would have probed the wrong endpoint and reported a
   * verdict about a protocol the channel never uses — an answer that describes something other
   * than the channel being tested.
   */
  it('🔴 a Responses channel is probed at /responses with max_output_tokens', () => {
    const request = probeRequest(channel({ api: 'openai-responses', model: 'deepseek-flash' }))
    expect(request.path).toBe('/responses')
    const body = request.body as Record<string, unknown>
    expect(body.input).toBe('ping')
    // `max_tokens` is a completions spelling and is rejected on the Responses surface.
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_output_tokens).toBeTypeOf('number')
  })

  it('🔴 leaves room for the THINKING block, so the probe is not always truncated', () => {
    // Measured on the first real probe: with a cap of 16, deepseek-flash returned a `reasoning`
    // item and `status:"incomplete"` / `reason:"max_output_tokens"` with no visible answer — the
    // probe could never distinguish "works" from "works only until asked anything".
    const body = probeRequest(channel({ api: 'openai-responses' })).body as Record<string, number>
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(256)
  })

  it('a completions channel keeps /chat/completions and max_tokens', () => {
    const request = probeRequest(channel({ api: 'openai-completions' }))
    expect(request.path).toBe('/chat/completions')
    expect((request.body as Record<string, unknown>).max_tokens).toBe(1)
  })

  it('an Anthropic channel goes to /messages with the required max_tokens', () => {
    const request = probeRequest(channel({ api: 'anthropic-messages' }))
    expect(request.path).toBe('/messages')
    expect((request.body as Record<string, unknown>).max_tokens).toBeTypeOf('number')
  })
})

describe('errorFieldValue — a field being PRESENT is not it being an ERROR', () => {
  /**
   * 🔴 Measured on a real 200 from api.deepseek.com/responses:
   *   {"object":"response","status":"incomplete","error":null,"output":[{"type":"reasoning"}…]}
   * The probe's test was `text.includes('"error"')`, so that SUCCESS was reported as `SERVER`
   * while the channel was working perfectly. A substring cannot tell a null from a value.
   */
  it('🔴 treats `"error": null` as NO error (the real success shape)', () => {
    const text = JSON.stringify({
      object: 'response',
      status: 'incomplete',
      error: null,
      output: [{ type: 'reasoning' }],
    })
    expect(errorFieldValue(text)).toBeUndefined()
  })

  it('treats a missing error field as no error', () => {
    expect(errorFieldValue(JSON.stringify({ choices: [] }))).toBeUndefined()
  })

  it('reports a REAL error object', () => {
    const text = JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } })
    expect(errorFieldValue(text)).toContain('bad key')
  })

  it('reports a real error string', () => {
    expect(errorFieldValue(JSON.stringify({ error: 'boom' }))).toBe('boom')
  })

  it('falls back to the presence test for a non-JSON body', () => {
    expect(errorFieldValue('<html>bad gateway</html>')).toBeUndefined()
    expect(errorFieldValue('something "error" happened')).toBeDefined()
  })
})

describe('reportedName — reading all three response shapes', () => {
  it('🔴 reads a Responses payload (output[].content[].text)', () => {
    // The old reader understood only `choices[0].message.content`, so a Responses 200 came back
    // with an empty verdict and the panel showed a blank success.
    const text = JSON.stringify({
      model: 'deepseek-flash',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
    })
    expect(reportedName(text)).toBe('deepseek-flash')
  })

  it('falls back to the output text when the gateway omits `model`', () => {
    const text = JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
    })
    expect(reportedName(text)).toBe('pong')
  })

  it('still reads a completions payload', () => {
    expect(reportedName(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }))).toBe('pong')
  })

  it('returns empty rather than throwing on a non-JSON body', () => {
    expect(reportedName('<html>not json</html>')).toBe('')
  })
})

describe('probeChannel', () => {
  it('classifies an auth failure from a relay', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"bad key"}', { status: 401 }),
    )
    try {
      const verdict = await probeChannel(channel(), 'sk-x')
      expect(verdict.ok).toBe(false)
      expect(verdict.code).toBe('AUTH')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('treats a 200 carrying an error body as a failure', async () => {
    // Relays do this; reporting it as success would make a broken channel look healthy.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"quota"}}', { status: 200 }),
    )
    try {
      const verdict = await probeChannel(channel(), 'sk-x')
      expect(verdict.ok).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('reports a transport failure without throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      const verdict = await probeChannel(channel(), 'sk-x')
      expect(verdict.ok).toBe(false)
      expect(verdict.code).toBe('TRANSPORT')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('asks for exactly one output token (a probe must be cheap)', async () => {
    let sent: Record<string, unknown> = {}
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return new Response('{"model":"deepseek-v4.1-flash","choices":[{"message":{"content":"pong"}}]}', { status: 200 })
    })
    try {
      const verdict = await probeChannel(channel(), 'sk-x')
      expect(verdict.ok).toBe(true)
      expect(sent.max_tokens).toBe(1)
      // The channel's own upstream spelling goes on the wire, not our advertised id.
      expect(sent.model).toBe('deepseek-v4.1-flash')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('balanceRow — a liveness check stands in for a balance that cannot be read', () => {
  /**
   * Owner directive (2026-10-23): 「对于不支持查余额的，改成直接测通，通则说明余额还是有的，没用完，
   * 显示出来（消耗一两个token）」.
   *
   * 🔴 The whole point is that these are DIFFERENT claims, and the tests keep them apart:
   *   · a balance number  = how much is left (requires a balance API);
   *   · a live 200        = it serves and the credit is not exhausted (proves only the second).
   * A 200 proves the account is not at zero, because an exhausted account answers 402/quota.
   * It must never be rendered as an amount — that is the failure these tests exist to prevent.
   */
  const noBalance = (): ResolvedChannel => channel({ balance: undefined })

  it('🔴 a channel with no balance API that ANSWERS becomes `alive`, not `unsupported`', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"model":"deepseek-flash","choices":[{"message":{"content":"p"}}]}', { status: 200 }),
    )
    try {
      const row = await balanceRow(noBalance(), 'sk-x')
      expect(row.status).toBe('alive')
      // The evidence travels with the verdict: "it answered" is a claim, "it answered as
      // deepseek-flash" is proof.
      expect(row).toMatchObject({ responded: 'deepseek-flash' })
      expect(row.status === 'alive' ? row.ms : -1).toBeGreaterThanOrEqual(0)
      // 🔴 No amount is fabricated on this path.
      expect(JSON.stringify(row)).not.toMatch(/"amounts"|"remaining"/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('🔴 a QUOTA refusal is the answer "out of credit", not a generic read failure', async () => {
    // This is the one failure that is really an ANSWER: the liveness check discovered the exact
    // fact it was run to discover. Reporting it as `TRANSPORT`/`读取失败` would throw that away.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"insufficient quota"}}', { status: 402 }),
    )
    try {
      const row = await balanceRow(noBalance(), 'sk-x')
      expect(row.status).toBe('unavailable')
      expect(row.status !== 'ok' && 'code' in row ? row.code : undefined).toBe('QUOTA')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('🔴 does NOT spend a probe when the balance API already answered', async () => {
    // The fallback costs tokens. A channel that just reported a real number must not also be
    // charged for a live request — "the read worked" is not a reason to buy a second answer.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const target = String(url)
      if (target.includes('/user/balance')) {
        return new Response(JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '12.00' }],
        }), { status: 200 })
      }
      // Any inference call here would mean the fallback ran when it should not have.
      return new Response('{"model":"should-not-be-called"}', { status: 200 })
    })
    try {
      const row = await balanceRow(channel({ balance: { shape: 'deepseek' } }), 'sk-x')
      expect(row.status).toBe('ok')
      const calls = fetchSpy.mock.calls.map((call) => String(call[0]))
      expect(calls.some((url) => url.includes('/chat/completions'))).toBe(false)
      expect(calls.some((url) => url.includes('/responses'))).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('🔴 does NOT probe a channel whose balance API exists but FAILED', async () => {
    // `unavailable` means "try again" — the surface is there. Replacing a transient read error
    // with a different-looking success would hide a real outage behind a green row.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const target = String(url)
      if (target.includes('/user/balance')) return new Response('boom', { status: 500 })
      return new Response('{"model":"should-not-be-called"}', { status: 200 })
    })
    try {
      const row = await balanceRow(channel({ balance: { shape: 'deepseek' } }), 'sk-x')
      expect(row.status).toBe('unavailable')
      const calls = fetchSpy.mock.calls.map((call) => String(call[0]))
      expect(calls.some((url) => url.includes('/chat/completions'))).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('a transport failure during liveness stays `unavailable`, never `alive`', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      const row = await balanceRow(noBalance(), 'sk-x')
      expect(row.status).toBe('unavailable')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('GET /balance', () => {
  it('🔴 a channel with no balance API comes back `alive` through the ROUTE, not just the helper', async () => {
    // Driving `balanceRow` directly proves the rule; this proves the route is wired to it. The
    // two are different failures — the panel reads the route.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"model":"deepseek-flash","choices":[{"message":{"content":"p"}}]}', { status: 200 }),
    )
    try {
      const { call } = mount({ channels: () => [channel({ balance: undefined })] })
      const response = await call(`${ROUTE_PREFIX}/balance`)
      expect(response.status).toBe(200)
      const row = (response.body as { channels: Array<{ status: string }> }).channels[0]
      expect(row?.status).toBe('alive')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps `no-key` ahead of any network call', async () => {
    // Nothing to ask with: this must not fall through to the liveness check and report a 401
    // as though the account were broken.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const { call } = mount({ channels: () => [channel({ credential: { kind: 'none' } })] })
      const response = await call(`${ROUTE_PREFIX}/balance`)
      const row = (response.body as { channels: Array<{ status: string }> }).channels[0]
      expect(row?.status).toBe('no-key')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('client half contract', () => {
  it('the panel calls exactly the paths these routes register', () => {
    // A path typo between the halves is a silent 404 the panel would render as "加载失败".
    // Reading the source is crude, but it is the only place the two halves meet at build time.
    const client = readFileSync(join(process.cwd(), 'src', 'client', 'panel-api.ts'), 'utf-8')

    // The client hoists the prefix into one constant; assert that FIRST, then that all three
    // routes are built from it. Checking for the joined literal would fail on a correct file.
    const base = client.match(/const\s+BASE\s*=\s*'([^']+)'/)?.[1]
    expect(base).toBe(ROUTE_PREFIX)

    for (const route of ['/channels', '/stats', '/probe']) {
      expect(client).toContain(`\${BASE}${route}`)
    }
  })
})
