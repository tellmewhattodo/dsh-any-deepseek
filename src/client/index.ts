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
  type ChannelsResponse,
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
  // ── The sidebar usage badge ─────────────────────────────────────────────────────────────────
  //
  // 🔴 Registered OUTSIDE `whileServed`, and that is the whole point of this block.
  //
  // The panel below waits for the settings document, because it edits that document (decision 22:
  // without it the panel used to vanish with no trace). The badge has nothing to do with settings —
  // it reads this plugin's own `/stats` route. Putting it inside `whileServed` would make a late,
  // absent or refused settings service take the badge down too, and the failure would be invisible.
  //
  // ## Why `sidebar.footer.action` and not the conversation header (owner decision 2026-11-01)
  //
  // The first seat was `conversation.header.leading` (`kind:'single'`, `scope:'root'`). Owner's
  // ruling: 「你这个放会话标题了不太合适，能不能放全局一些的地方，数量没问题」 — measured, that seat
  // sits at x=300,y=10, immediately right of the Session title. The number counts the WHOLE
  // machine's day, but sitting beside a Session title it reads as THAT Session's usage. The figure
  // was never wrong; the seat said the wrong thing about it.
  //
  // The replacement is a genuine global seat, verified against the live registry rather than a doc:
  // `specOf('sidebar.footer.action')` → `{ kind:'list', scope:'root' }`, one existing occupant
  // (`cordis-panel`, a host plugin) ⇒ it is a real, additive, root-scoped seat that does not depend
  // on a Session being open. Being a `list`, it needs `id` + `order`; without an `id` the register
  // call throws (`dsh-client-ui-slots/lib/index.js:181-186`).
  //
  // ⚠️ Rejected alternatives, with the measurement that rejected each:
  //  · `shell.bottom` — also global and `single`/`root`, and a probe showed it does NOT push the
  //    frame (813→813), but it is the window's bottom edge with no current occupant and no proven
  //    precedent. Kept as the fallback if this seat is ever removed.
  //  · `sidebar.brand.mark` / `sidebar.brand.name` — the literal top-left corner, but both are
  //    `single` and already occupied by the host's own logo and wordmark. Taking either would mean
  //    shadowing host UI, which this plugin must not do.
  //
  // ## 🔴 `slots.inject(<the key we register INTO>)` — never the parent key
  //
  // This is the fix for 0.0.24/0.0.25/0.0.26 all rendering nothing while every install check stayed
  // green. Waiting on a parent that is declared one step EARLIER means `fn` runs while the child key
  // still does not exist, and `register()` throws:
  //
  //   Uncaught Error: slot "conversation.header.leading" is not declared
  //     (a parent entry's children table must declare it)
  //
  // ⚠️ **Why three releases missed it**: that throw escapes a cordis effect, so it is UNCAUGHT — it
  // never reaches `console.error`/`console.warn`. A console-intercept probe therefore stays silent
  // and reads as "no error at all". Only `window.onerror` sees it; only reading the live registry
  // shows the truth: the slot's spec EXISTS (so the `<div data-slot>` renders) while its entries
  // array is EMPTY. "Container present" and "occupant present" are two different facts, and three
  // investigations mistook the first for proof of the second.
  //
  // The rule is uniform in the host: all 47 `slots.inject(` call sites inject the very key they then
  // register into (e.g. `dsh-client-ui-settings-plugins/lib/client.js:201`). Same discipline as
  // decision 23 (declare the service so cordis waits instead of racing), applied to SLOTS.
  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.effect(
      () =>
        scope.slots.inject('sidebar.footer.action', () => {
          try {
            return scope.slots.register(
              {
                name: 'sidebar.footer.action',
                // `list` slots are addressed by id; `order` keeps us at the end of the row.
                id: 'any-deepseek-usage',
                order: 90,
                inject: (): UsageBadgeInjected => ({
                  loadToday: (): Promise<StatsResponse> => {
                    // Ask for TODAY only, explicitly. Relying on the route's 7-day default and then
                    // picking the row out of it would make the badge change meaning if that default
                    // ever moved — and the default exists for the panel's table, not for this.
                    const start = new Date()
                    start.setHours(0, 0, 0, 0)
                    return fetchStats('day', start.toISOString())
                  },
                  // Same-origin, same route the panel already calls. The provider line needs the
                  // live `current`, which the server reads from the settings document it actually
                  // routes with (owner request 2026-11-03).
                  loadChannels: (): Promise<ChannelsResponse> => fetchChannels(),
                }),
              },
              UsageBadge,
            )
          } catch (error) {
            // 🔴 A refused registration must be VISIBLE. Each of the three failed releases cost a
            // publish-install-restart cycle precisely because this failure was silent: cordis throws
            // the effect error as uncaught, no console line is printed, the bundle executes normally,
            // and the UI simply has one fewer ornament. This does not fix anything — it makes the
            // next occurrence diagnosable in one look instead of four restarts.
            console.error('[dsh-any-deepseek] sidebar usage badge registration refused:', error)
            throw error
          }
        }),
      'any-deepseek sidebar usage badge',
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
                  loadChannels: (): Promise<ChannelsResponse> => fetchChannels(),
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
