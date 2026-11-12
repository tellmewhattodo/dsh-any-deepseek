/**
 * route.ts — which channel serves the next request.
 *
 * ## History: manual → sticky group → priority order
 *
 *  - **2026-10-19 (decision 7)**: select one channel by name, no failover. Cost stated then: a dead
 *    relay means the user switches by hand.
 *  - **2026-11-12 (first cut of the group)**: a sticky cursor remembered the last position, so an
 *    outage cost one wasted attempt in total rather than one per request.
 *  - **2026-11-12 (owner revision, current)**: 「供应组里的就按优先级来，每次切换都从 1~n 过一遍使用首个
 *    能用的」 ⇒ **every request starts at member 1**. The cursor is gone from the routing path.
 *
 * The revision is deliberate, not a simplification for its own sake: a cursor makes "who serves?"
 * depend on history, so topping up member 1 did not put it back to work until something reset the
 * cursor — and nothing did. A priority order that silently stops being the priority order is worse
 * than one wasted quota refusal per call (which costs no tokens).
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
 * Where a selection came from.
 *
 * The group arm carries the ordinary membership facts so a caller can report "member 2 of 3"
 * without re-deriving them — but ⛔ nothing here describes a remembered position, because none is
 * remembered.
 */
export type RouteCandidateSource =
  /** `current` names this channel directly. */
  | { kind: 'channel'; index: number }
  /** The supply group serves this request; `index` is the ALWAYS-ZERO starting position. */
  | { kind: 'group'; index: number; of: number }

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
 * 🔴 **There is no `cursor` parameter any more.** The owner's rule is "always start at member 1",
 * and the most reliable way to guarantee that is for the function to have no way to express
 * anything else — a parameter the caller could pass would invite the behaviour back.
 * @param channels - every resolved channel, in configuration order.
 * @param current - the configured selection (a channel id, or {@link SUPPLY_GROUP_ID}).
 * @param groupMembers - the supply group's ordered member ids.
 * @returns the selected channel plus its ordered alternates, or the reason there is none.
 */
export function selectChannel(
  channels: readonly ResolvedChannel[],
  current: string | undefined,
  groupMembers: readonly string[] = [],
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

  if (wanted === SUPPLY_GROUP_ID) return selectFromGroup(channels, groupMembers)

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
 * Resolve the supply group into an ordered candidate list, highest priority first.
 *
 * ## Why dangling members are SKIPPED rather than fatal
 *
 * A member id that no longer resolves (renamed id, half-written entry, deleted channel whose id
 * stayed in the list) is a repairable inconsistency. Failing the whole route would take the
 * provider offline over one stale string, which is the opposite of what a supply group is FOR.
 * The skip is not silent: `/channels` reports the dangling ids and the panel lists them.
 *
 * Empty-after-resolution IS fatal (`GROUP_EMPTY`): a group with nothing usable cannot serve, and
 * answering with a made-up fallback would hide a configuration the user must fix.
 * @param channels - every resolved channel.
 * @param members - the configured ordered member ids; index 0 is the highest priority.
 * @returns the ordered candidates, or a failure.
 */
function selectFromGroup(
  channels: readonly ResolvedChannel[],
  members: readonly string[],
): RouteResult {
  const byId = new Map(channels.map((channel) => [channel.id, channel]))
  // Keep the CONFIGURED order — it IS the priority — and drop ids nothing resolves to.
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

  const [head, ...rest] = resolvable
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
    source: { kind: 'group', index: 0, of: resolvable.length },
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
