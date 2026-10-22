/**
 * http.ts — the panel's data routes.
 *
 * ## Why these are HTTP and not a Remote namespace
 *
 * Everything the panel reads about *configuration* goes through the harness's own settings and
 * credential surfaces — those exist, are versioned, and carry the write-conflict machinery. What
 * does not exist anywhere is the usage ledger: it is this plugin's own artifact. Serving it over
 * a same-origin route is the smallest thing that works; a generated Remote namespace would add a
 * build step and a peer dependency to serve one read-only table.
 *
 * ## What these routes deliberately do not return
 *
 * No key value, ever — only whether a reference is configured. The ledger route returns
 * aggregates, not per-entry records, because the panel never needs a request-by-request view and
 * a smaller surface is a smaller thing to get wrong.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ResolvedChannel } from './channels.js'
import { PROVIDER_ID, requestHeadersFor } from './adapter.js'
import {
  readLedgerRange,
  summarize,
  totalOf,
  dayKey,
  type LedgerEntry,
} from './usage-ledger.js'

/** Prefix every route in this module lives under. */
export const ROUTE_PREFIX = '/any-deepseek'

/** What the routes need from the plugin. */
export interface RouteDeps {
  /** Every resolved channel, in configuration order. */
  channels: () => readonly ResolvedChannel[]
  /** Resolve a credential REFERENCE to its value (legacy entries only). */
  resolveKey: (ref: string) => Promise<string | undefined>
  /** Preset ids and labels for the "add channel" picker. */
  listPresets: () => Array<{ id: string; displayName: string }>
  /** The single advertised model. */
  advertised: () => { id: string; name: string }
  /** Describe a credential reference (never its value). */
  describeKey: (ref: string) => Promise<{ configured: boolean; source?: string }>
  /**
   * The ledger directory the plugin actually WRITES to.
   *
   * 🔴 This must be passed in, not recomputed. The reader used to call
   * `ledgerDirectory(undefined)` — which silently dropped the configured `usage.path` — while the
   * writer used `ledgerDirectory(usage.path)`. Whenever a user set a custom ledger directory the
   * two pointed at different places, so the panel read an empty book forever and reported
   * "no usage yet" as though no request had ever run. Read and write must resolve one directory.
   */
  ledgerDir: () => string
}

/** Structural view of the harness web server (only `register` is used). */
export interface WebServerLike {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => unknown
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read a JSON request body with a small ceiling; the panel sends tiny payloads. */
async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Parse an ISO date from a query parameter; undefined when absent or unparseable. */
function queryDate(value: string | null): Date | undefined {
  if (value === null || value === '') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * Probe one channel with a minimal real request.
 *
 * This spends tokens, which is why it is an explicit route rather than something the panel does
 * on render. The request asks for one output token, so the cost is a prompt plus a token.
 *
 * 🔴 **The headers come from `requestHeadersFor`, the same function the runtime uses.** They used
 * to be built here separately, which meant this probe sent no OpenCode session header while real
 * requests did — so "测试" reported 400 `MissingSessionID` on a channel that worked in use. A
 * probe that does not send what a real request sends is not testing the channel.
 * @param channel - the channel to probe.
 * @param key - its resolved credential.
 * @param sessionId - session identity for per-request headers (the probe has no conversation of
 *   its own, so callers pass the selected channel's own stable value).
 * @param signal - cancellation.
 * @returns a verdict and, on success, what the relay reported.
 */
export async function probeChannel(
  channel: ResolvedChannel,
  key: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; ms: number; code?: string; message?: string; responded?: string }> {
  const started = Date.now()
  const url = `${channel.baseURL.replace(/\/+$/, '')}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...channel.headers,
        ...requestHeadersFor(channel, sessionId),
      },
      body: JSON.stringify({
        model: channel.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      ...signal === undefined ? {} : { signal },
    })
    const ms = Date.now() - started
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        ms,
        code: probeCode(response.status, text),
        message: text.slice(0, 400),
      }
    }
    // A relay that answers 200 with a body error is still a failed probe.
    if (text.includes('"error"')) {
      return { ok: false, ms, code: 'SERVER', message: text.slice(0, 400) }
    }
    let responded = ''
    try {
      const parsed = JSON.parse(text) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
      responded = typeof parsed.model === 'string'
        ? parsed.model
        : typeof parsed.choices?.[0]?.message?.content === 'string'
          ? parsed.choices[0].message.content
          : ''
    } catch {
      responded = ''
    }
    return { ok: true, ms, responded }
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      code: 'TRANSPORT',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Map an HTTP status from a probe onto the same codes the runtime uses. */
function probeCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NO_SUCH_MODEL'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 402 || body.toLowerCase().includes('quota')) return 'QUOTA'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Register the panel's routes.
 * @param ctx - plugin context (only used to bind the disposer when the host offers one).
 * @param webServer - the harness web server.
 * @param deps - plugin accessors.
 */
export function registerStatsRoutes(ctx: unknown, webServer: WebServerLike, deps: RouteDeps): void {
  const holder = ctx as { effect?: (fn: () => () => void, label?: string) => unknown } | undefined

  const routes: Array<{
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }> = [
    {
      // Channel list as the panel should render it: label, upstream model, key state.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/channels`,
      handler: async (_req, res) => {
        const rows = await Promise.all(deps.channels().map(async (channel) => {
          /**
           * 🔴 The key is a property of the CHANNEL now, so "is one configured?" is answered
           * without consulting any credential store. A legacy reference still asks the harness,
           * and that answer is the only thing the panel ever learns about a reference: whether
           * it exists.
           */
          const key = channel.credential.kind === 'literal'
            ? { configured: channel.credential.value !== '', source: 'channel' }
            : channel.credential.kind === 'reference'
              ? await deps.describeKey(channel.credential.ref)
              : { configured: false, source: undefined }
          return {
            id: channel.id,
            label: channel.label,
            model: channel.model,
            api: channel.api,
            baseURL: channel.baseURL,
            contextWindow: channel.contextWindow,
            maxTokens: channel.maxTokens,
            input: [...channel.input],
            warnings: [...channel.warnings],
            keyConfigured: key.configured,
            ...key.source === undefined ? {} : { keySource: key.source },
            // WHERE the key lives, never what it is. `literal` = the panel can rewrite it in
            // place; `reference` = a name to resolve, whose value the panel cannot read.
            keyKind: channel.credential.kind,
            ...channel.credential.kind === 'reference' ? { keyRef: channel.credential.ref } : {},
          }
        }))
        json(res, 200, { channels: rows, presets: deps.listPresets(), model: deps.advertised() })
      },
    },
    {
      // Aggregates over a time range. `group` selects the only two dimensions the panel shows:
      // overall (default) or per channel. There is no per-session view by design.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stats`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const from = queryDate(url.searchParams.get('from'))
        const to = queryDate(url.searchParams.get('to'))
        const group = url.searchParams.get('group') ?? 'channel'
        const entries: LedgerEntry[] = await readLedgerRange(deps.ledgerDir(), from, to)
        const rows = group === 'day'
          ? summarize(entries, (entry) => dayKey(new Date(entry.at)))
          : summarize(entries, (entry) => entry.channel)
        /**
         * 🔴 Label each row with the channel's DISPLAY NAME, not its id.
         *
         * Owner report (2026-10-22): 「统计要按显示名称来」. The ledger keys rows by the channel
         * id because that is the channel's identity — it must not change when a user renames a
         * channel (decision 37: renaming touches `label`, never `id`). But the id is an
         * implementation handle, and showing it makes the table disagree with the list above it,
         * where the same channel appears under its display name.
         *
         * Resolution is done here, at read time, from the LIVE channel list — so a rename is
         * reflected immediately in historical rows too, with no ledger rewrite. A row whose
         * channel no longer exists keeps its raw id: that usage is real and must stay visible,
         * and inventing a name for a channel that is gone would be worse than the id.
         */
        const labels = new Map(deps.channels().map((channel) => [channel.id, channel.label]))
        const named = rows.map((row) => ({
          ...row,
          label: group === 'day' ? row.key : labels.get(row.key) ?? row.key,
        }))
        json(res, 200, {
          range: {
            from: from?.toISOString() ?? null,
            to: to?.toISOString() ?? null,
            group,
          },
          rows: named,
          total: totalOf(rows),
          // Stated in the payload so any consumer repeats it rather than inventing its own.
          note: 'input is uncached input only; billable input = input + cacheRead + cacheWrite',
        })
      },
    },
    {
      // Explicit, costly: performs one real request against the named channel.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/probe`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST required' })
          return
        }
        let body: unknown
        try {
          body = await readBody(req)
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const id = (body as { id?: unknown } | undefined)?.id
        if (typeof id !== 'string' || id === '') {
          json(res, 400, { error: 'id is required' })
          return
        }
        const channel = deps.channels().find((candidate) => candidate.id === id)
        if (channel === undefined) {
          json(res, 404, { error: `no channel named "${id}"` })
          return
        }
        // Same key order as the runtime path: a literal key never consults the credential seam,
        // and a legacy reference is resolved exactly as a real request would resolve it. A probe
        // that read the key differently from the request path would certify a channel the
        // adapter cannot actually use.
        const key = channel.credential.kind === 'literal'
          ? channel.credential.value
          : channel.credential.kind === 'reference'
            ? await deps.resolveKey(channel.credential.ref)
            : undefined
        if (key === undefined || key === '') {
          json(res, 409, { error: `channel "${id}" has no key configured`, code: 'MISSING_CREDENTIAL' })
          return
        }
        // A probe has no conversation of its own, so it uses the channel's own stable identity:
        // the same channel always probes under the same affinity key, which is what makes two
        // consecutive probes comparable.
        const verdict = await probeChannel(channel, key, `probe:${channel.id}`)
        json(res, verdict.ok ? 200 : 502, verdict)
      },
    },
  ]

  for (const route of routes) {
    const dispose = webServer.register(route)
    if (typeof dispose === 'function' && typeof holder?.effect === 'function') {
      // Tie the registration to the plugin's lifetime when the host hands back a disposer.
      holder.effect(() => dispose as () => void, `any-deepseek route ${route.path}`)
    }
  }

  void PROVIDER_ID
}
