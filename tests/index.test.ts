/**
 * index.test.ts — the assembly layer.
 *
 * ## Why this file exists
 *
 * Everything else in this repo is a pure function with its own test. The assembly in `index.ts`
 * was the one module with NO test — which is exactly where "the plugin loaded but wired nothing"
 * hides: `apply()` can return cleanly while `registerAdapter` was never reached, and no other
 * test would notice. The host would show a plugin that is installed, enabled, and serving no
 * models.
 *
 * ## What is actually asserted
 *
 * Not "it did not throw" (that is the failure mode above). Each test asserts the OBSERVABLE
 * effect on the fake context:
 *  - a provider id was handed to `registerAdapter`;
 *  - a directory entry was handed to `registerConfigurableProviders`;
 *  - the web routes were registered under the documented prefix;
 *  - a missing service degrades instead of throwing;
 *  - the resolved credential seam is consulted with the reference, never the value.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'

import { apply, inject, ledgerDirectory, name, Config, DEFAULT_LEDGER_DIR } from '../src/index.js'
import type { PluginConfigValue } from '../src/config.js'
import { PROVIDER_ID, PROVIDER_NAME } from '../src/adapter.js'
import { ADVERTISED_MODEL_ID } from '../src/presets.js'

/** Captured calls on the fake host. */
interface Spy {
  adapters: Array<{ providers: string[]; adapter: unknown }>
  configurable: Array<readonly Record<string, unknown>>
  routes: Array<{ kind: string; path: string }>
  credentialRefs: string[]
}

/**
 * A fake cordis context exposing only what `apply` reads.
 *
 * `services` decides which host services exist — that is the axis every degradation test moves.
 */
function fakeContext(
  options: {
    services?: Array<'llm' | 'credentials' | 'webServer'>
    keyValue?: string | undefined
    describe?: { configured: boolean; source?: string }
  } = {},
): { ctx: Context; spy: Spy } {
  const services = new Set(options.services ?? ['llm', 'credentials', 'webServer'])
  const spy: Spy = { adapters: [], configurable: [], routes: [], credentialRefs: [] }

  const llm = {
    registerAdapter: (providers: string[], adapter: unknown) => {
      spy.adapters.push({ providers, adapter })
      return { dispose: () => {} }
    },
    registerConfigurableProviders: (entries: readonly Record<string, unknown>[]) => {
      spy.configurable.push(...entries)
      return { dispose: () => {} }
    },
  }

  const credentials = {
    resolve: async (ref: unknown) => {
      spy.credentialRefs.push(String(ref))
      return options.keyValue === undefined ? undefined : { value: options.keyValue }
    },
    describe: async (ref: unknown) => {
      spy.credentialRefs.push(String(ref))
      return options.describe ?? { configured: false }
    },
  }

  const webServer = {
    register: (route: { kind: string; path: string }) => {
      spy.routes.push({ kind: route.kind, path: route.path })
      return () => {}
    },
  }

  const store: Record<string, unknown> = {}
  if (services.has('llm')) store.llm = llm
  if (services.has('credentials')) store.credentials = credentials
  if (services.has('webServer')) store.webServer = webServer

  const ctx = {
    ...store,
    // Real cordis throws on an undeclared service; mirror that so the fallback path is exercised.
    get(this: unknown, key: string) {
      if (!services.has(key)) throw new Error(`service "${key}" is not declared in inject`)
      return store[key]
    },
    effect: (fn: () => () => void) => {
      void fn
      return () => {}
    },
  } as unknown as Context

  return { ctx, spy }
}

/** A parsed configuration with one keyed channel. */
function config(overrides: Partial<PluginConfigValue> = {}): PluginConfigValue {
  return {
    channels: {
      go: {
        label: 'OpenCode Go',
        model: 'deepseek-v4.1-flash',
        baseURL: 'https://relay.example/v1',
        apiKeyEnv: 'GO_KEY',
      },
    },
    current: 'go',
    usage: { enabled: true },
    fallback: [],
    ...overrides,
  } as PluginConfigValue
}

describe('assembly identity', () => {
  it('declares the llm service as a hard requirement', () => {
    // Without `llm` there is nothing to register; making it optional would let the plugin
    // activate into a state where every request is refused for a reason nobody can see.
    expect(inject).toContain('llm')
  })

  it('exposes a Config schema the host can parse', () => {
    const parsed = Config({ channels: { a: { model: 'm', baseURL: 'https://x/v1' } }, current: 'a' })
    expect(parsed.current).toBe('a')
  })

  it('names the plugin stably (the name is the settings namespace)', () => {
    expect(name).toBe('any-deepseek')
  })
})

describe('provider registration', () => {
  it('registers exactly one provider id with the adapter', () => {
    const { ctx, spy } = fakeContext()
    apply(ctx, config())

    expect(spy.adapters).toHaveLength(1)
    // One route is the product promise: the picker must not grow a second entry.
    expect(spy.adapters[0]?.providers).toEqual([PROVIDER_ID])
    expect(spy.adapters[0]?.adapter).toBeDefined()
  })

  it('also registers a configurable-provider directory entry', () => {
    // Without this the model is selectable but has no address on the official Models page —
    // the documented limitation of routes that skip the directory.
    const { ctx, spy } = fakeContext()
    apply(ctx, config())

    expect(spy.configurable).toHaveLength(1)
    expect(spy.configurable[0]).toMatchObject({ provider: PROVIDER_ID, displayName: PROVIDER_NAME })
  })

  it('degrades instead of throwing when the llm service is absent', () => {
    const { ctx } = fakeContext({ services: ['credentials', 'webServer'] })
    // A composition without `llm` is a wiring error, not a crash: throwing here would take the
    // whole profile down over one plugin.
    expect(() => apply(ctx, config())).not.toThrow()
  })
})

describe('http routes', () => {
  it('registers the three panel routes under one prefix', () => {
    const { ctx, spy } = fakeContext()
    apply(ctx, config())

    expect(spy.routes.map((route) => route.path).sort()).toEqual([
      '/any-deepseek/channels',
      '/any-deepseek/probe',
      '/any-deepseek/stats',
    ])
  })

  it('skips route registration when no web server is composed', () => {
    const { ctx, spy } = fakeContext({ services: ['llm', 'credentials'] })
    expect(() => apply(ctx, config())).not.toThrow()
    expect(spy.routes).toHaveLength(0)
  })
})

describe('credential seam', () => {
  it('resolves keys lazily — no credential read happens during apply()', () => {
    // apply() must not touch the credential store: it runs at profile boot, before the user has
    // had a chance to configure anything, and a blocking read there would delay every start.
    const { ctx, spy } = fakeContext({ keyValue: 'sk-from-seam' })
    apply(ctx, config())
    expect(spy.credentialRefs).toHaveLength(0)
  })

  it('consults the seam by reference (never by value) when the adapter asks', async () => {
    const { ctx, spy } = fakeContext({ keyValue: 'sk-from-seam' })
    apply(ctx, config())

    const adapter = spy.adapters[0]?.adapter as { listModels: (p: string) => Promise<unknown[]> }
    await adapter.listModels(PROVIDER_ID)

    // The reference is the channel's apiKeyEnv; the value never enters the argument.
    expect(spy.credentialRefs).toEqual(['GO_KEY'])
  })

  it('falls back to process.env when no credential seam exists', async () => {
    process.env.ANY_DEEPSEEK_TEST_KEY = 'sk-from-env'
    try {
      const { ctx, spy } = fakeContext({ services: ['llm'], keyValue: undefined })
      apply(ctx, config({ channels: { go: { apiKeyEnv: 'ANY_DEEPSEEK_TEST_KEY', model: 'm', baseURL: 'https://x/v1' } } } as never))
      const adapter = spy.adapters[0]?.adapter as { listModels: (p: string) => Promise<unknown[]> }
      // Reading the environment is the keyless-deployment path (container `-e`); it must not
      // require the credentials package to be composed.
      expect(await adapter.listModels(PROVIDER_ID)).toHaveLength(1)
    } finally {
      delete process.env.ANY_DEEPSEEK_TEST_KEY
    }
  })
})

describe('ledger directory', () => {
  it('prefers an explicit path, then DSH_HOME, then HOME', () => {
    expect(ledgerDirectory('/explicit/place')).toBe('/explicit/place')
  })

  it('uses DSH_HOME when the configuration names none', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/custom/home'
    try {
      expect(ledgerDirectory(undefined)).toBe('/custom/home/any-deepseek')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('falls back to the default under HOME', () => {
    const previousHome = process.env.HOME
    const previousDsh = process.env.DSH_HOME
    process.env.HOME = '/home/someone'
    delete process.env.DSH_HOME
    try {
      // A ledger written to one home and read from another is invisible usage, so the fallback
      // has to be the same `~/.dsh` the host itself uses.
      expect(ledgerDirectory(undefined)).toBe(`/home/someone/${DEFAULT_LEDGER_DIR}`)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousDsh !== undefined) process.env.DSH_HOME = previousDsh
    }
  })

  it('treats a blank configured path as absent', () => {
    expect(ledgerDirectory('   ')).not.toBe('   ')
  })
})

describe('model catalogue', () => {
  it('advertises the single model once a key resolves', async () => {
    const { ctx, spy } = fakeContext({ keyValue: 'sk-live', describe: { configured: true } })
    apply(ctx, config())

    const adapter = spy.adapters[0]?.adapter as { listModels: (p: string) => Promise<unknown[]> }
    const models = await adapter.listModels(PROVIDER_ID)
    // One model, not one per channel: that is the whole reason this plugin exists.
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: ADVERTISED_MODEL_ID })
  })

  it('hides the model when no channel has a key (the harness dormant-provider convention)', async () => {
    const { ctx, spy } = fakeContext({ keyValue: undefined, describe: { configured: false } })
    apply(ctx, config())

    const adapter = spy.adapters[0]?.adapter as { listModels: (p: string) => Promise<unknown[]> }
    expect(await adapter.listModels(PROVIDER_ID)).toEqual([])
  })
})
