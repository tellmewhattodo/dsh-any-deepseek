/**
 * route.ts — which channel serves the next request.
 *
 * ## History: v1 was deliberately manual, and 2026-11-12 reversed that
 *
 * Owner decision 2026-10-19: select one channel by name, no failover. The stated trade was:
 *
 *  - **no silent re-routing** — a request never lands somewhere the user did not pick;
 *  - **no cache churn** — switching channels invalidates the prompt cache for the conversation.
 *
 * 🟢 **Owner decision 2026-11-12 replaced it with the supply group** (「当遇到余额不足的时候自动切换到
 * 组内下个供应商，确保供应不中断」). Both old costs are now ACCEPTED, and each is contained rather
 * than ignored:
 *
 *  - silent re-routing ⇒ the panel names the group as the live supplier and shows the last switch
 *    with its reason (`groupState` in `/channels`), so a reroute is visible after the fact;
 *  - cache churn ⇒ the sticky cursor means the switch happens ONCE per outage, not once per
 *    request. A group that re-tried from member 0 every time would burn a wasted 402 on the dead
 *    relay before every single request, and invalidate the cache each time.
 *
 * ## The one selection axis
 *
 * `current` holds either a channel id or {@link SUPPLY_GROUP_ID}. There is no separate "group
 * enabled" flag — see that constant for why two axes would be the bug.
 */

import type { ResolvedChannel } from './channels.js'
import { SUPPLY_GROUP_ID } from './config.js'

/** Why no channel could be selected. */
export type RouteFailure =
  | { code: 'NO_CHANNEL_SELECTED'; detail: string }
  | { code: 'CHANNEL_UNKNOWN'; detail: string }
  | { code: 'NO_CHANNELS'; detail: string }
  | { code: 'GROUP_EMPTY'; detail: string }

/**
 * One attempt's channel, in trial order.
 *
 * A group selection resolves to several candidates; a plain channel selection resolves to one
 * using a different code path entirely, so `WINNER` and `MEMBER` stay distinguishable when reading
 * a log.
 */
export type RouteCandidateSource =
  /** `current` names this channel directly. */
  | { kind: 'channel'; index: number }
  /** The supply group serves this request; `index` is its position in `members`. */
  | { kind: 'group'; index: number; of: number; cursorAdvanced: boolean }

/** Selection outcome: exactly one of the two arms is present. */
export type RouteResult =
  | {
      ok: true
      channel: ResolvedChannel
      /** Where the choice came from; the group arm also carries the ordered alternatives. */
      source: RouteCandidateSource
      /** When the group is serving, every remaining member after this one, in order. */
      alternates: readonly ResolvedChannel[]
    }
  | { ok: false; failure: RouteFailure }

/**
 * Select the channel that serves this request.
 *
 * The order of the checks matters for the message the user sees: an empty configuration is a
 * setup problem, an unset `current` is a choice not yet made, and an empty group is a choice made
 * but not finished. Reporting them separately keeps the panel's guidance accurate.
 *
 * @param channels - every resolved channel, in configuration order.
 * @param current - the configured selection (a channel id, or {@link SUPPLY_GROUP_ID}).
 * @param groupMembers - the supply group's ordered member ids.
 * @param cursor - zero-based index of the member to start from (the sticky position).
 * @returns the selected channel plus its ordered alternates, or the reason there is none.
 */
export function selectChannel(
  channels: readonly ResolvedChannel[],
  current: string | undefined,
  groupMembers: readonly string[] = [],
  cursor = 0,
): RouteResult {
  if (channels.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'NO_CHANNELS',
        detail: 'no channel is configured; add one in Settings → Any DeepSeek',
      },
    }
  }

  const wanted = typeof current === 'string' ? current.trim() : ''
  if (wanted === '') {
    return {
      ok: false,
      failure: {
        code: 'NO_CHANNEL_SELECTED',
        detail: 'no supplier is selected; pick a channel or the supply group in Settings → Any DeepSeek',
      },
    }
  }

  if (wanted === SUPPLY_GROUP_ID) return selectFromGroup(channels, groupMembers, cursor)

  const found = channels.find((channel) => channel.id === wanted)
  if (found !== undefined) return { ok: true, channel: found, source: { kind: 'channel', index: 0 }, alternates: [] }

  // A dangling selection: the id exists in the settings document but no channel resolves to it.
  // The fix is "pick another one", so the message names the ones that WOULD work.
  return {
    ok: false,
    failure: {
      code: 'CHANNEL_UNKNOWN',
      detail: `selected channel "${wanted}" does not exist; `
        + `available: ${channels.map((channel) => channel.id).join(', ')}`,
    },
  }
}

/**
 * Resolve the supply group into an ordered candidate list.
 *
 * ## Why dangling members are SKIPPED rather than fatal
 *
 * A member id that no longer resolves (renamed id, half-written entry, deleted channel whose id
 * stayed in the list) is a repairable inconsistency. Failing the whole route would take the
 * provider offline over one stale string, which is the opposite of what a supply group is FOR.
 * The skip is not silent: the surviving candidates carry their real ids, `/channels` reports the
 * dangling ones, and the panel shows them so the user can remove them.
 *
 * Empty-after-resolution IS fatal (`GROUP_EMPTY`): a group with nothing usable cannot serve, and
 * answering with a made-up fallback would hide a configuration the user must fix.
 * @param channels - every resolved channel.
 * @param members - the configured ordered member ids.
 * @param cursor - zero-based starting index, clamped into range.
 * @returns the ordered candidates from `cursor` onward, or a failure.
 */
function selectFromGroup(
  channels: readonly ResolvedChannel[],
  members: readonly string[],
  cursor: number,
): RouteResult {
  const byId = new Map(channels.map((channel) => [channel.id, channel]))
  // Keep the CONFIGURED order; drop ids nothing resolves to.
  const resolvable = members.filter((id) => byId.has(id))

  if (resolvable.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'GROUP_EMPTY',
        detail: members.length === 0
          ? 'the supply group has no members; add channels to it in Settings → Any DeepSeek'
          : `the supply group names no channel that exists (${members.join(', ')}); fix it in Settings → Any DeepSeek`,
      },
    }
  }

  // Clamp rather than wrap: a cursor past the end means the group was exhausted in a previous
  // request, and restarting at member 0 would re-attempt a relay already known to be exhausted
  // (a wasted round-trip before every request). Starting at the LAST member keeps the fallback
  // alive while staying inside the range.
  const start = Math.max(0, Math.min(Math.trunc(cursor), resolvable.length - 1))
  const ordered = [...resolvable.slice(start), ...resolvable.slice(0, start)]
  const [head, ...rest] = ordered
  const headChannel = byId.get(head!)
  if (headChannel === undefined) {
    // Unreachable: `resolvable` was built from `byId` keys. Kept as a structural guard so a future
    // edit cannot turn the invariant into a `!` assertion.
    return {
      ok: false,
      failure: { code: 'GROUP_EMPTY', detail: 'the supply group resolved to nothing usable' },
    }
  }

  return {
    ok: true,
    channel: headChannel,
    source: { kind: 'group', index: start, of: resolvable.length, cursorAdvanced: start > 0 },
    alternates: rest.flatMap((id) => byId.get(id) ?? []),
  }
}

/**
 * Whether `current` names a channel that exists at all.
 *
 * The panel uses this to explain a dangling selection instead of silently falling back.
 * @param allIds - every configured channel id.
 * @param current - the configured selection.
 * @returns false when `current` is empty, names the supply group, or names nothing.
 */
export function currentIsDangling(allIds: readonly string[], current: string | undefined): boolean {
  const wanted = typeof current === 'string' ? current.trim() : ''
  if (wanted === '' || wanted === SUPPLY_GROUP_ID) return false
  return !allIds.includes(wanted)
}
