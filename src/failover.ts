/**
 * failover.ts — when the supply group moves on, and what it remembers.
 *
 * ## The routing rule is deliberately the simplest one that works
 *
 * Owner decision 2026-11-12 (revising the first cut, which used a sticky cursor):
 * 「供应组里的就按优先级来，每次切换都从 1~n 过一遍使用首个能用的」.
 *
 * ⇒ **Every request starts at member 1 and walks 1…n, using the first that works.** Position is
 * never remembered for routing; the configured order IS the priority, with no exceptions and no
 * hidden state to reason about.
 *
 * ## What that costs, stated plainly
 *
 * While member 1 is out of quota, every request pays one wasted round-trip to it before reaching
 * the first usable member. The first cut avoided that with a sticky cursor, and the trade was
 * rejected on purpose: a cursor makes "which member serves?" depend on history, so topping up
 * member 1 did not put it back into use until something reset the cursor — and the recovery was
 * invisible. One fast 402 per call is a cheaper price than a priority order that silently stops
 * being the priority order.
 *
 * ⚠️ Measured scale of that cost: a quota refusal returns without generating, so it costs no
 * tokens and is bounded by one HTTP round-trip. It is not a re-prompt of the conversation.
 *
 * ## What is still remembered — for DISPLAY only
 *
 * The panel still needs to answer 「现在在用谁／刚才换了谁／为什么换」, and those are facts about what
 * happened, not inputs to what happens next. They live in {@link SupplyStatus}, which the routing
 * path writes and never reads.
 */

/** Codes that mean "this channel cannot serve", as opposed to "this attempt failed". */
const CHANNEL_UNUSABLE_CODES: ReadonlySet<string> = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
])

/**
 * Whether a failed attempt justifies moving to the next group member.
 *
 * ⚠️ This is only HALF the decision. The other half is "have we already emitted content?" — a
 * switch after the first streamed chunk would splice two suppliers into one message, so the caller
 * must also check that, and `shouldFailover` deliberately cannot know it.
 * @param code - the failure code from the attempt.
 * @returns true when the channel itself is unusable for this request.
 */
export function shouldFailover(code: string | undefined): boolean {
  if (code === undefined) return false
  return CHANNEL_UNUSABLE_CODES.has(code)
}

/** What the dispatch loop knows when deciding whether to move on. */
export interface SwitchDecisionInput {
  /** The failure code from the just-failed attempt. */
  code: string | undefined
  /**
   * Whether ANY chunk reached the consumer.
   *
   * 🔴 The load-bearing input. Once a chunk is yielded it is gone — the harness has written it to
   * the session and the user has seen it. Switching suppliers afterwards would concatenate two
   * different models' output into one message with no way to tell where the seam is.
   */
  emitted: boolean
  /** Whether the candidate list has anything left to try. */
  hasNext: boolean
}

/**
 * Whether one failed attempt may be followed by another attempt on a DIFFERENT channel.
 *
 * Kept as a separate pure function rather than inlined in the dispatch loop for one reason:
 * the `emitted` clause is the most dangerous guard in this feature (dropping it silently corrupts
 * messages), and a pure function can be pinned with a negative control that an integration test
 * against a fake transport could not isolate — a mid-stream failure is hard to stage through
 * pi-ai, but trivial to express as three booleans.
 * @param input - the three facts the decision depends on.
 * @returns true only when a switch is both useful and safe.
 */
export function canSwitchAttempt(input: SwitchDecisionInput): boolean {
  return !input.emitted && input.hasNext && shouldFailover(input.code)
}

/** The most recent switch, for the panel to explain what happened. */
export interface SupplySwitch {
  from: string
  to: string
  code: string
  atMs: number
}

/**
 * Codes that mean "this account has no credit left", as opposed to any other failure.
 *
 * 🔴 Deliberately NARROWER than {@link CHANNEL_UNUSABLE_CODES}, and the difference is the whole
 * point of the safety net this list serves. Owner request 2026-11-19:
 * 「当使用非供应组渠道 用到无费用时 自动切换到供应组。目的是确保 token 供应不中断」.
 *
 * The trigger is 「无费用」 — out of credit. A dead key (`AUTH`) or a channel whose key was never
 * configured (`MISSING_CREDENTIAL`) is ALSO terminal, but falling back into the supply group for
 * those would be answering a question the owner did not ask: a mistyped key is a configuration
 * error to fix, not a reason to silently route elsewhere, and routing around it would hide it.
 * Those two are still fatal for a plain channel selection (decision: no silent fallback), so they
 * stay OUT of this set. If the owner ever wants them in, this comment is where the change starts.
 */
const OUT_OF_CREDIT_CODES: ReadonlySet<string> = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
])

/** What the adapter knows when deciding whether a dead channel may fall back into the group. */
export interface FallbackDecisionInput {
  /** The failure code from the attempt on the DIRECTLY selected channel. */
  code: string | undefined
  /**
   * Whether ANY chunk reached the consumer.
   *
   * 🔴 Same load-bearing guard as {@link canSwitchAttempt}, and for the identical reason: once a
   * chunk is yielded it is in the session and on screen, so continuing on another supplier would
   * splice two models into one message with no seam.
   */
  emitted: boolean
  /**
   * Whether `current` names a CHANNEL rather than the supply group.
   *
   * ⛔ When the group is already serving, its own walk owns this decision (`canSwitchAttempt`).
   * Two mechanisms acting on one failure would double-attempt the same member.
   */
  selectionIsChannel: boolean
  /** How many resolvable members the group has, EXCLUDING the channel that just failed. */
  groupCandidates: number
}

/**
 * Whether a plain-channel request may fall back into the supply group.
 *
 * ## Why this is a separate decision from the group's own walk
 *
 * The group walk answers "which OTHER member serves this request"; this answers "should a request
 * that was NOT walking the group start walking it, because the chosen channel ran out of money".
 * They share the emitted guard and the switch set's philosophy, but they differ in the trigger set
 * (narrower — {@link OUT_OF_CREDIT_CODES}) and in what they must leave alone: this one never
 * applies when the group is already the selection.
 *
 * ⚠️ **It is a per-request decision, not a persisted mode change.** `current` stays what the user
 * chose. That is not timidity — writing settings from a request path is a revision bump in the
 * middle of a request, which is the exact shape of the「保存时好时坏」defect (decision 85). The
 * consequence is stated rather than hidden: while the chosen channel has no credit, EVERY request
 * pays one wasted quota refusal on it first, then serves from the group. Same price as the priority
 * order (decision 97), and the same benefit: topping the channel up restores it with no action.
 * @param input - the four facts the decision depends on.
 * @returns true only when the fallback is both useful and safe.
 */
export function canFallBackToGroup(input: FallbackDecisionInput): boolean {
  if (input.emitted) return false
  if (!input.selectionIsChannel) return false
  if (input.groupCandidates <= 0) return false
  if (input.code === undefined) return false
  return OUT_OF_CREDIT_CODES.has(input.code)
}

/**
 * What the last request did, for the panel only.
 *
 * 🔴 **Nothing here is an input to routing.** The owner's rule is "always start at 1", so a value
 * in this class can never change which member serves the next request — that is the whole point of
 * replacing the sticky cursor. If a future edit starts reading `serving` to choose a starting
 * index, the priority order has quietly become history-dependent again.
 */
export class SupplyStatus {
  /** The member that last served successfully. */
  private servedId: string | undefined
  /**
   * The `current` value in force when {@link servedId} was recorded.
   *
   * 🔴 Why a reading needs its own provenance (2026-11-19). `serving` answers "which channel served
   * the last successful request", and that is only meaningful against the selection that request
   * ran under. Without this, a user who switches from a channel to another channel would keep
   * seeing the previous name rendered as if it were live — the 2026-11-18 wrong-name defect, one
   * layer down. The panel now reports `serving` ONLY when this still matches the live `current`;
   * otherwise the reading is stale and saying nothing is the honest answer.
   */
  private servedFor: string | undefined
  /**
   * Whether the last successful request reached that channel by falling back into the group.
   *
   * 🔴 This is the fact that makes the safety net VISIBLE (owner request 2026-11-19). With a plain
   * channel selected, a request can now be served by a group MEMBER after the chosen channel runs
   * out of credit. Without this flag the sidebar would print the member's own label as though the
   * user had selected it — a confident wrong answer about where the request went, which is exactly
   * the defect of 2026-11-18 one layer down.
   */
  private servedViaFallback = false
  /** The last switch, if any since the process started (or since the group was re-read). */
  private switchRecord: SupplySwitch | undefined
  /** Whether the most recent request found no usable member at all. */
  private exhausted = false
  /** The member the most recent failed request gave up on. */
  private lastTriedId: string | undefined
  /** The member list these readings belong to; a change discards them. */
  private signature = ''

  /**
   * Bind the readings to one member list, discarding them when the list changes.
   *
   * Keyed on the list's content, not on a counter: after the user adds, removes or reorders
   * members, "the member that last served" may no longer exist, and a stale name in the panel is
   * worse than a blank line.
   * @param members - the configured ordered member ids.
   */
  bind(members: readonly string[]): void {
    const signature = members.join('\u0000')
    if (signature === this.signature) return
    this.signature = signature
    this.servedId = undefined
    this.servedFor = undefined
    this.servedViaFallback = false
    this.switchRecord = undefined
    this.exhausted = false
    this.lastTriedId = undefined
  }

  /**
   * Record that `id` served this request successfully.
   * @param id - the channel that actually produced the response.
   * @param forCurrent - the `current` value this request was routed under.
   * @param viaFallback - whether it served after a plain-channel selection fell back into the group.
   */
  noteServed(id: string, forCurrent: string, viaFallback = false): void {
    this.servedId = id
    this.servedFor = forCurrent
    this.servedViaFallback = viaFallback
    this.exhausted = false
    this.lastTriedId = undefined
  }

  /** Record one move from a member that could not serve to the one tried next. */
  noteSwitch(from: string, to: string, code: string, atMs: number): void {
    this.switchRecord = { from, to, code, atMs }
  }

  /**
   * Record that a request ended without a serving member.
   *
   * 🔴 `exhausted` is NOT the same as "the request failed". A request that fails on member 1 of 4
   * with an error the group cannot switch on (a mid-stream error, a SERVER error) has failed, but
   * the group is not out of members — rendering 「全组均不可用」 then would be a false alarm that
   * hides a healthy member 2..4. Only walking off the END of the list earns the exhausted flag.
   * @param lastTried - the final member attempted, so the panel can name it.
   * @param exhausted - whether the list ran out (true) or the request failed with members left.
   */
  noteFailure(lastTried: string | undefined, exhausted: boolean): void {
    this.servedId = undefined
    this.servedFor = undefined
    this.servedViaFallback = false
    this.exhausted = exhausted
    this.lastTriedId = lastTried
  }

  /**
   * Whether the last successful request reached its supplier by falling back into the group.
   *
   * ⛔ Only meaningful together with {@link servingUnder}: a stale reading from before a selection
   * change must not be reported as a live fallback.
   */
  get servedByFallback(): boolean {
    return this.servedViaFallback
  }

  /**
   * Whether the member that last served belongs to the currently bound group list.
   *
   * 🔴 This is what makes the safety net VISIBLE (owner request 2026-11-19). With a plain channel
   * selected, a request can now be served by a group member after the chosen channel runs out of
   * credit. Saying so requires two facts together — "who served" and "is that one of the group's
   * members" — and neither alone is enough: the same channel may be both `current` and a member.
   * @param id - a channel id, typically {@link servingUnder}.
   * @returns true when `id` is in the bound member list.
   */
  isMember(id: string | undefined): boolean {
    if (id === undefined || this.signature === '') return false
    return this.signature.split('\u0000').includes(id)
  }

  /** The member that last served, or undefined when nothing has served yet / the last request failed. */
  get serving(): string | undefined {
    return this.servedId
  }

  /**
   * The member that last served, but only if that reading still applies to `current`.
   *
   * 🔴 This is what a reader should use. {@link serving} alone cannot distinguish "this is who is
   * serving now" from "this is who served before the user changed the selection".
   * @param current - the live `current` value.
   * @returns the serving channel id, or undefined when the reading is stale or absent.
   */
  servingUnder(current: string | undefined): string | undefined {
    const live = current ?? ''
    return this.servedFor === live ? this.servedId : undefined
  }

  /** The most recent switch, or undefined when none has happened. */
  get lastSwitch(): SupplySwitch | undefined {
    return this.switchRecord
  }

  /** Whether the most recent request found no usable member. */
  get isExhausted(): boolean {
    return this.exhausted
  }

  /** The member the last failed request gave up on; undefined when that request succeeded. */
  get lastTried(): string | undefined {
    return this.lastTriedId
  }
}
