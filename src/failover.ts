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
    this.switchRecord = undefined
    this.exhausted = false
    this.lastTriedId = undefined
  }

  /** Record that `id` served this request successfully. */
  noteServed(id: string): void {
    this.servedId = id
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
    this.exhausted = exhausted
    this.lastTriedId = lastTried
  }

  /** The member that last served, or undefined when nothing has served yet / the last request failed. */
  get serving(): string | undefined {
    return this.servedId
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
