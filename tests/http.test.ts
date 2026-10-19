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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ROUTE_PREFIX,
  registerStatsRoutes,
  probeChannel,
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
    apiKeyEnv: 'GO_KEY',
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
  it('registers channels, stats and probe under one prefix', () => {
    const { routes } = mount()
    expect(routes.sort()).toEqual([
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
    const { call } = mount({ describeKey: async () => ({ configured: false }) })
    const response = await call(`${ROUTE_PREFIX}/channels`)
    expect(response.status).toBe(200)
    expect((response.body as { channels: Array<{ keyConfigured: boolean }> }).channels[0]?.keyConfigured).toBe(false)
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

  it('ignores an unparseable date rather than returning 400', async () => {
    const { call } = mount()
    const response = await call(`${ROUTE_PREFIX}/stats`, { query: 'from=not-a-date' })
    // The panel refreshes on a timer; a malformed range must degrade to "all time", not to an
    // error the user cannot act on.
    expect(response.status).toBe(200)
    expect((response.body as { range: { from: string | null } }).range.from).toBeNull()
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
    const { call } = mount({ resolveKey: async () => undefined })
    const response = await call(`${ROUTE_PREFIX}/probe`, { method: 'POST', body: { id: 'go' } })
    expect(response.status).toBe(409)
    expect((response.body as { code: string }).code).toBe('MISSING_CREDENTIAL')
  })

  it('never probes implicitly — only when an id is posted', async () => {
    // A probe spends real tokens. GETs on the other routes must not trigger one.
    const resolveKey = vi.fn(async () => 'sk-secret-value')
    const { call } = mount({ resolveKey })
    await call(`${ROUTE_PREFIX}/channels`)
    await call(`${ROUTE_PREFIX}/stats`)
    expect(resolveKey).not.toHaveBeenCalled()
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
