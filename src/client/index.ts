/**
 * client/index.ts — browser half of dsh-any-deepseek.
 *
 * Registers one settings page under the `settings.section` slot, keyed by this plugin's settings
 * namespace. Data comes from two places, and the split is deliberate:
 *
 *  - **configuration and keys** (channel table, selection, each channel's key) go through
 *    `ctx.configForms`, the harness's own form surface — it carries schema validation and
 *    write-conflict detection, and it is the same path the official Models page uses. A key is a
 *    field of its channel, so it is written by the same mechanism that writes everything else;
 *  - **usage** comes from this plugin's own `/any-deepseek/stats` route, because the ledger is an
 *    artifact no other part of the harness knows about.
 *
 * There is deliberately no dependency on `remote.credentials`. An earlier version stored keys
 * behind a reference name through that namespace, which required inventing a name the user does
 * not have and pointed at a "credential centre" that does not exist in this UI. Owner decision
 * 2026-10-21: the panel takes the key and keeps it on the channel.
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
// 🔴 Same rule, one level down: `conversation.header.leading` — and every other
// `conversation.*` slot — enters the SlotMap ONLY through this package's *client* entry. Without
// this line the slot name fails to typecheck with a list of `settings.*` names and `root`, which
// reads like "that slot does not exist" when in fact it is merely undeclared in this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SettingsPage, SettingsPageInjected, type JsonValue } from './SettingsPage.js'
import { UsageBadge, type UsageBadgeInjected } from './UsageBadge.js'
import {
  fetchBalances,
  fetchChannels,
  fetchStats,
  probeChannel,
  type BalanceResponse,
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

/**
 * Services this half waits for.
 *
 * 🔴 `configForms` is deliberately NOT here, and that is a correction measured in a real browser
 * (2026-11-01). It used to be, which meant the module waited for BOTH services before `apply` ran
 * at all — so a settings service that was late or absent would take the header badge down with it,
 * silently. That is exactly the coupling the badge's own doc comment says must not exist, made one
 * level up where the comment could not see it.
 *
 * `configForms` is now awaited inside the panel branch only (`ctx.inject(['slots', 'configForms'])`
 * below), so the two surfaces wait for their own dependencies and neither can strand the other.
 */
export const inject = ['slots']

/** Channel configuration as the settings document stores it. */
export interface ChannelWire {
  label?: string
  preset?: string
  api?: string
  baseURL?: string
  model?: string
  /** The key itself, written by the panel. */
  apiKey?: string
  /** Legacy reference name; only read by the plugin, never produced here. */
  apiKeyEnv?: string
}

/** The plugin's settings section value. */
export interface SettingsWire {
  channels?: Record<string, ChannelWire>
  current?: string
}

export function apply(ctx: ClientContext): void {
  // ── The header badge ────────────────────────────────────────────────────────────────────────
  //
  // 🔴 Registered OUTSIDE `whileServed`, and that is the whole point of this block.
  //
  // The panel below waits for the settings document, because it edits that document (decision 22:
  // without it the panel used to vanish with no trace). The badge has nothing to do with settings —
  // it reads this plugin's own `/stats` route. Putting it inside `whileServed` would make a late,
  // absent or refused settings service take the badge down too, and the failure would be invisible:
  // the bundle executes, no error is logged, and the header simply has one fewer ornament.
  //
  // `conversation.header.leading` is the host's own seat for exactly this: `kind:'single'`,
  // `scope:'root'`, documented as "Global navigation before the Session title, available without a
  // Session" (`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:242-247`). Nothing
  // else in this profile occupies it.
  //
  // 🔴 `slots.inject('conversation.header', …)` FIRST — and this is the fix for 0.0.24/0.0.25 both
  // rendering nothing while every install check stayed green.
  //
  // A slot key only exists once its PARENT registration declared it as a child: the host declares
  // `conversation.header.leading` inside `registerHeader()`'s `children` table
  // (`dsh-client-ui-conversation/lib/client.js:19834-19846`). Calling `slots.register` for a key the
  // registry has not seen yet is accepted and DROPPED — silently, no console error, and the slot's
  // `<div data-slot>` still renders (empty) because the parent exists. That is why every check I ran
  // first passed: the container was there, only its occupant was missing.
  //
  // `slots.inject(name, fn)` is the wait: `fn` runs once that slot is registered. It is the same
  // discipline as decision 23 (declare the service so cordis waits instead of racing), applied to
  // SLOTS rather than services — and the host's own `settings-plugins` does exactly this
  // (`ctx.slots.inject("settings.section", () => ctx.slots.register(…))`,
  // `dsh-client-ui-settings-plugins/lib/client.js:201`). Copying a proven host pattern beats
  // inventing an order.
  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.effect(
      () =>
        scope.slots.inject('conversation.header', () =>
          scope.slots.register(
            {
              name: 'conversation.header.leading',
              inject: (): UsageBadgeInjected => ({
                loadToday: (): Promise<StatsResponse> => {
                  // Ask for TODAY only, explicitly. Relying on the route's 7-day default and then
                  // picking the row out of it would make the badge change meaning if that default
                  // ever moved — and the default exists for the panel's table, not for this.
                  const start = new Date()
                  start.setHours(0, 0, 0, 0)
                  return fetchStats('day', start.toISOString())
                },
              }),
            },
            UsageBadge,
          ),
        ),
      'any-deepseek header usage badge',
    )
  })

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
                  loadBalances: (): Promise<BalanceResponse> => fetchBalances(),
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
