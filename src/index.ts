/**
 * index.ts — plugin assembly.
 *
 * ## What this file owns
 *
 * Exactly three things: the configuration surface, the adapter's dependencies (wired to the
 * harness through narrow structural reads), and the HTTP routes the panel talks to. Everything
 * that can be a pure function has been pushed into its own module so this one stays small
 * enough to audit.
 *
 * ## Why host services are read structurally
 *
 * The plugin is published standalone: a deployment may compose it without `credentials` or
 * without `webServer`. Importing those packages for their types is fine (it erases), but
 * depending on their runtime presence would make the whole plugin fail to activate in a profile
 * that simply does not use them. Every read here degrades to `undefined` and the caller decides.
 */

import type { Context } from 'cordis'
import { join } from 'node:path'

import { PluginConfigSchema, unwrapChannels, type PluginConfigValue } from './config.js'
import { ADVERTISED_MODEL_ID, CHANNEL_PRESETS, presetIds } from './presets.js'
import { enabledChannels, resolveChannels } from './channels.js'
import { AnyDeepSeekAdapter, PROVIDER_ID, PROVIDER_NAME } from './adapter.js'
import { appendLedgerEntry, type LedgerEntry } from './usage-ledger.js'
import { registerStatsRoutes, type WebServerLike } from './http.js'

/** Plugin name, used by the host for diagnostics. */
export const name = 'any-deepseek'

/** Services this plugin waits for. `llm` is mandatory: without it there is nothing to register. */
export const inject = ['llm']

/** The configuration schema (see config.ts for the volatile/annotation constraints). */
export const Config = PluginConfigSchema

/** Directory holding the ledger when the configuration does not name one. */
export const DEFAULT_LEDGER_DIR = join('.dsh', 'any-deepseek')

/**
 * Resolve the harness home without importing a host package at runtime.
 *
 * `$DSH_HOME` wins over `~/.dsh`, matching the host's own precedence; the plugin must agree with
 * it, because a ledger written to one home and read from another is invisible usage.
 */
export function ledgerDirectory(configured: string | undefined): string {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') return explicit
  const home = process.env.DSH_HOME?.trim()
  if (home !== undefined && home !== '') return join(home, 'any-deepseek')
  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return join(userHome, DEFAULT_LEDGER_DIR)
}

/** Structural view of the harness credential seam (only the two members used here). */
interface CredentialsLike {
  resolve?: (ref: unknown) => Promise<{ value: string } | undefined>
  describe?: (ref: unknown) => Promise<{ configured: boolean; source?: string }>
}

/** Structural view of the harness `llm` service. */
interface LlmLike {
  registerAdapter?: (providers: string[], adapter: AnyDeepSeekAdapter) => unknown
  registerConfigurableProviders?: (entries: readonly Record<string, unknown>[]) => unknown
}

/**
 * Read a service without requiring it in `inject`.
 *
 * Real cordis throws when a service name is not declared in `inject`, so the direct property
 * read is wrapped and `ctx.get` is the fallback. Both failures mean "not available".
 */
function service<T>(ctx: unknown, serviceName: string): T | undefined {
  const holder = ctx as Record<string, unknown> | undefined
  try {
    const direct = holder?.[serviceName]
    if (direct !== undefined) return direct as T
  } catch {
    // Not declared in inject — fall through to the store read.
  }
  try {
    const get = (ctx as { get?: (n: string) => unknown } | undefined)?.get
    return typeof get === 'function' ? (get.call(ctx, serviceName) as T | undefined) : undefined
  } catch {
    return undefined
  }
}

/** Build the ledger recorder bound to one configuration generation. */
function makeRecorder(ctx: unknown, config: PluginConfigValue): (entry: LedgerEntry) => Promise<void> {
  return async (entry: LedgerEntry): Promise<void> => {
    const usage = config.usage ?? {}
    if (usage.enabled === false) return
    const directory = ledgerDirectory(usage.path)
    // Accounting must never fail a model call: the append reports success as a boolean and
    // `appendLedgerEntry` already swallows its own errors. A `false` stays silent on purpose —
    // there is no one to tell mid-stream, and a warning per failed write would be noise.
    await appendLedgerEntry(directory, entry)
    void ctx
  }
}

/**
 * Assemble the plugin.
 * @param ctx - the plugin context.
 * @param config - the parsed configuration.
 */
export function apply(ctx: Context, config: PluginConfigValue): void {
  const credentials = () => service<CredentialsLike>(ctx, 'credentials')

  /** Resolve a credential reference, distinguishing "absent" from "not configured". */
  const resolveKey = async (ref: string): Promise<string | undefined> => {
    const seam = credentials()
    if (seam?.resolve === undefined) {
      // No credential seam composed: fall back to the process environment, which is what a
      // keyless deployment (or a container passing -e) actually uses.
      return process.env[ref]
    }
    try {
      const hit = await seam.resolve(ref)
      return hit?.value
    } catch {
      return undefined
    }
  }

  /**
   * The current channel set.
   *
   * Read fresh on every call rather than captured at apply time: the settings document can be
   * edited while the plugin runs, and `fiber.config` is updated in place by the loader.
   */
  const channels = () => {
    const live = (ctx as unknown as { fiber?: { config?: PluginConfigValue } }).fiber?.config ?? config
    const map = unwrapChannels(live.channels)
    const resolution = resolveChannels(map)
    return enabledChannels(resolution, map)
  }

  const current = () => {
    const live = (ctx as unknown as { fiber?: { config?: PluginConfigValue } }).fiber?.config ?? config
    return typeof live.current === 'string' ? live.current : undefined
  }

  const deps = {
    channels,
    current,
    resolveKey,
    record: makeRecorder(ctx, config),
    now: () => new Date(),
    elapsed: () => Number(process.hrtime.bigint() / 1_000_000n),
  }

  const adapter = new AnyDeepSeekAdapter(deps)
  const llm = service<LlmLike>(ctx, 'llm')

  if (typeof llm?.registerAdapter === 'function') {
    llm.registerAdapter([PROVIDER_ID], adapter)
  } else {
    // A missing `llm` service means the host composition is wrong, not a degraded mode: say so
    // rather than streaming into nowhere.
    console.warn('[any-deepseek] the `llm` service is unavailable; the provider was not registered')
  }

  // Give the route an address on the Models page. Without this the model is selectable but has
  // nowhere to be configured — a documented limitation of routes that skip the directory.
  //
  // `settingsNs` is the PROFILE ENTRY id (`dsh-any-deepseek`), the same string the client half
  // watches; the bare plugin name is not a settings namespace and pointing at it makes the
  // directory row dead.
  if (typeof llm?.registerConfigurableProviders === 'function') {
    llm.registerConfigurableProviders([{
      provider: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      settingsNs: 'dsh-any-deepseek',
      settingsPath: [],
    }])
  }

  // The panel's data routes. Only registered when the harness actually has a web server.
  const webServer = service<WebServerLike>(ctx, 'webServer')
  if (typeof webServer?.register === 'function') {
    registerStatsRoutes(ctx, webServer, {
      channels,
      resolveKey,
      listPresets: () => presetIds().map((id) => ({ id, displayName: CHANNEL_PRESETS[id]?.displayName ?? id })),
      advertised: () => ({ id: ADVERTISED_MODEL_ID, name: PROVIDER_NAME }),
      describeKey: async (ref: string) => {
        const seam = credentials()
        if (seam?.describe === undefined) return { configured: process.env[ref] !== undefined, source: 'env' }
        try {
          return await seam.describe(ref)
        } catch {
          return { configured: false }
        }
      },
    })
  }
}
