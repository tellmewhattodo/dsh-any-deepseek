/**
 * client/index.ts — browser half of dsh-any-deepseek.
 *
 * Registers one settings page under the `settings.section` slot, keyed by this plugin's settings
 * namespace. Data comes from two places, and the split is deliberate:
 *
 *  - **configuration** (channel table, selection) goes through `ctx.configForms`, the harness's
 *    own form surface — it carries schema validation and write-conflict detection, and it is the
 *    same path the official Models page uses;
 *  - **credentials** (whether a key is set) goes through `ctx.remote.credentials.describe`, which
 *    answers "configured?" and never the value;
 *  - **usage** comes from this plugin's own `/any-deepseek/stats` route, because the ledger is an
 *    artifact no other part of the harness knows about.
 *
 * Registration goes through `configForms.whileServed`, so a deployment that never composed this
 * plugin shows no trace of the page.
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// `Context.slots` is declared by the renderer package's *client* entry (module augmentation),
// so that exact subpath must be imported for the client half to compile — a `paths` entry alone
// does not bring an augmentation into the program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SettingsPage, SettingsPageInjected, type JsonValue } from './SettingsPage.js'
import {
  fetchChannels,
  fetchStats,
  probeChannel,
  type ChannelRow,
  type StatsResponse,
} from './panel-api.js'

/**
 * Settings namespace — the PROFILE ENTRY id, not the plugin's bare name.
 *
 * The host keys the settings document by the cordis entry id declared in `cordis.patch.yml`
 * (`dsh-any-deepseek`). `configForms.get()` and `whileServed()` both match on THAT string, so
 * using `'any-deepseek'` here meant the watch never resolved and the panel registered nothing —
 * silently, with no console error, while the bundle was fetched and executed normally. Verified
 * against the host: `--dump-config-schema` reports the namespace as `dsh-any-deepseek`, and
 * official plugins follow the same rule (`configForms.get('ui-settings')`, `get('ui-chat')`).
 */
export const SETTINGS_NS = 'dsh-any-deepseek'

/** Services this half waits for. */
export const inject = ['slots', 'configForms']

/** Channel configuration as the settings document stores it. */
export interface ChannelWire {
  label?: string
  preset?: string
  api?: string
  baseURL?: string
  model?: string
  apiKeyEnv?: string
  enabled?: boolean
}

/** The plugin's settings section value. */
export interface SettingsWire {
  channels?: Record<string, ChannelWire>
  current?: string
}

export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'configForms'], (scope: ClientContext) => {
    const form = scope.configForms.get<SettingsWire>(SETTINGS_NS)

    scope.effect(
      () =>
        scope.configForms.whileServed([SETTINGS_NS], () =>
          scope.slots.inject('settings.section', () =>
            scope.slots.register(
              {
                name: 'settings.section',
                id: SETTINGS_NS,
                order: 95,
                label: () => 'Any DeepSeek',
                inject: (): SettingsPageInjected => ({
                  hooks: { settings: form },
                  loadChannels: (): Promise<{ channels: ChannelRow[]; presets: Array<{ id: string; displayName: string }>; model: { id: string; name: string } }> =>
                    fetchChannels(),
                  loadStats: (group: 'channel' | 'day', from?: string, to?: string): Promise<StatsResponse> =>
                    fetchStats(group, from, to),
                  probe: (id: string) => probeChannel(id),
                  setField: (path: readonly string[], value: JsonValue): Promise<boolean> => {
                    // 🔴 `ConfigForm.set(field, value)` builds `path: [field]` — ONE segment. A
                    // dotted string therefore writes a literal key named "channels.go.enabled"
                    // instead of toggling the switch, and the host accepts it silently. Only
                    // `mutate` carries a real path, so every nested write goes through it.
                    //
                    // The promise is RETURNED, not swallowed: a refused write (read-only
                    // deployment, unavailable settings service, revision conflict) is a fact the
                    // user must see. Swallowing it made a dead panel look like a working one.
                    return form.mutate([{ op: 'set', path: [...path], value }])
                  },
                  removeField: (path: readonly string[]): Promise<boolean> => {
                    return form.mutate([{ op: 'unset', path: [...path] }])
                  },
                }),
              },
              SettingsPage,
            ),
          ),
        ),
      'any-deepseek settings section',
    )
  })
}
