/**
 * route.ts — which channel serves the next request.
 *
 * ## v1 is deliberately manual
 *
 * Owner decision (2026-10-19): the first version selects one channel by name and does not
 * fail over. That is a real trade — a dead channel means the user switches manually — and it
 * buys two things that automatic routing would cost:
 *
 *  - **No silent re-routing.** A request never lands somewhere the user did not pick, so a
 *    relay that starts returning garbage cannot quietly become the one serving traffic.
 *  - **No cache churn.** Switching channels invalidates the prompt cache for the running
 *    conversation, so the switch should be an explicit, visible act.
 *
 * `fallback` exists in the schema but nothing reads it yet; adding failover later is then a
 * behaviour change, not a configuration migration.
 */

import type { ResolvedChannel } from './channels.js'

/** Why no channel could be selected. */
export type RouteFailure =
  | { code: 'NO_CHANNEL_SELECTED'; detail: string }
  | { code: 'UNKNOWN_CHANNEL'; detail: string }
  | { code: 'CHANNEL_DISABLED'; detail: string }
  | { code: 'NO_CHANNELS'; detail: string }

/** Selection outcome: exactly one of the two arms is present. */
export type RouteResult =
  | { ok: true; channel: ResolvedChannel }
  | { ok: false; failure: RouteFailure }

/**
 * Select the channel that serves this request.
 *
 * The order of the checks matters for the message the user sees: an empty configuration is a
 * setup problem, while an unset `current` is a choice not yet made. Reporting them separately
 * keeps the panel's guidance accurate.
 * @param channels - enabled, resolved channels in configuration order.
 * @param current - the configured channel id.
 * @returns the selected channel, or the reason there is none.
 */
export function selectChannel(
  channels: readonly ResolvedChannel[],
  current: string | undefined,
): RouteResult {
  if (channels.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'NO_CHANNELS',
        detail: 'no channel is configured and enabled; add one in Settings → any-deepseek',
      },
    }
  }

  const wanted = typeof current === 'string' ? current.trim() : ''
  if (wanted === '') {
    return {
      ok: false,
      failure: {
        code: 'NO_CHANNEL_SELECTED',
        detail: 'no channel is selected; pick one in Settings → any-deepseek',
      },
    }
  }

  const found = channels.find((channel) => channel.id === wanted)
  if (found !== undefined) return { ok: true, channel: found }

  // Distinguish "that channel exists but is switched off" from "there is no such channel":
  // the two have different fixes, and a merged message would send the user to the wrong one.
  return {
    ok: false,
    failure: {
      code: 'CHANNEL_DISABLED',
      detail: `selected channel "${wanted}" is not among the enabled channels; `
        + `enabled: ${channels.map((channel) => channel.id).join(', ')}`,
    },
  }
}

/**
 * Whether `current` names a channel that exists at all (enabled or not).
 *
 * The panel uses this to explain a dangling selection instead of silently falling back.
 * @param allIds - every configured channel id, including disabled ones.
 * @param current - the configured selection.
 * @returns false when `current` is empty or names nothing.
 */
export function currentIsDangling(allIds: readonly string[], current: string | undefined): boolean {
  const wanted = typeof current === 'string' ? current.trim() : ''
  return wanted !== '' && !allIds.includes(wanted)
}
