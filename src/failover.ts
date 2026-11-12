/**
 * failover.ts — when the supply group moves to its next member.
 *
 * ## The one question this file answers
 *
 * Given a failed attempt's code, should the group try the next channel? That is a judgement about
 * the RELAY, not about this request, so it lives here as data rather than as an `if` inside the
 * dispatch loop where it would be invisible and untestable in isolation.
 *
 * ## The asymmetry that orders the set
 *
 * Switching has a real cost: a new channel means new headers, a different upstream, and a
 * **cold prompt cache** for the conversation. Switching for a transient fault therefore makes
 * things worse, because the retry layer (`providerRetryPolicy`, 100 attempts) is already the right
 * instrument for "this attempt happened to fail".
 *
 * So the test is narrow on purpose: **switch when the channel structurally cannot serve, not when
 * this attempt did not.**
 *
 * | code | switch | why |
 * |---|---|---|
 * | `QUOTA`, `ACCOUNT_QUOTA` | ✅ | the balance is gone; every later attempt fails identically |
 * | `AUTH` | ✅ | the key was rejected; it will be rejected again |
 * | `INVALID_CREDENTIAL` | ✅ | malformed key, structurally unfixable at request time |
 * | `MISSING_CREDENTIAL` | ✅ | this channel has no key at all — it cannot serve, ever |
 * | `RATE_LIMIT` | ❌ | transient by definition; retry is the correct instrument |
 * | `SERVER`, `TIMEOUT`, `TRANSPORT`, `STREAM_CLOSED` | ❌ | transient; see above |
 * | `CONTEXT_WINDOW_EXCEEDED` | ❌ **never** | see the note below |
 * | `ABORTED` | ❌ | the caller cancelled; switching would ignore their intent |
 *
 * 🔴 **`CONTEXT_WINDOW_EXCEEDED` must never trigger a switch, and this is the load-bearing
 * exclusion.** Two independent reasons:
 *
 *  1. **It cannot help.** Every group member serves the same advertised model with the same
 *     window, so the next member faces the same oversized request and fails the same way — N
 *     failures instead of one.
 *  2. **It is dangerous.** The harness treats that code as proof of a real overflow and answers
 *     with the destructive recovery path (`compactIfNeeded(…, 'context-overflow')`, whole range,
 *     retain=0, threshold skipped — the 0.0.32 incident). Switching on it turns one error into
 *     repeated trips through a path that deletes conversation history.
 *
 * Anything not listed is treated as non-switching, which is the safe default: an unknown code is
 * an unknown cause, and guessing "this relay is broken" on an unknown cause is how a healthy
 * supplier gets cycled out during a blip.
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

/**
 * The sticky position inside the supply group.
 *
 * ## Why sticky rather than "always start at member 0"
 *
 * The group exists because a member runs out of balance. Once that happens, member 0 stays
 * exhausted for hours or days — so re-trying it before every single request costs one wasted
 * round-trip and one cache invalidation per request, forever. The cursor records "we already know
 * member 0 is dead" and starts after it.
 *
 * ## Why it lives in memory and is NOT persisted
 *
 * Persisting it would mean writing the settings document on every switch, and every write is a
 * revision bump — the exact mechanism behind the owner-reported 「保存时好时坏」 (decision 85).
 * A cursor is also genuinely per-process state: after a host restart, re-probing from the top is
 * the correct behaviour, because the outage may have ended.
 *
 * ## What invalidates it
 *
 * The member list itself. If the user adds, removes or reorders members, the old index no longer
 * refers to the same channel, so it is reset to 0. This is keyed on the member list's identity
 * (joined string), not on a counter — the cursor cannot silently point at a different channel.
 */
export class SupplyCursor {
  /** The member list the cursor belongs to; a change resets the position. */
  private signature = ''
  /** Zero-based index of the member to start from. */
  private position = 0
  /** The last switch, for the panel to explain what happened. */
  private lastSwitch: { from: string; to: string; code: string; atMs: number } | undefined

  /**
   * The index to start this request from, resetting when the member list changed.
   * @param members - the configured ordered member ids.
   * @returns the zero-based starting index.
   */
  startIndex(members: readonly string[]): number {
    const signature = members.join('\u0000')
    if (signature !== this.signature) {
      this.signature = signature
      this.position = 0
      this.lastSwitch = undefined
    }
    return this.position
  }

  /**
   * Record that we moved past a member.
   * @param from - the channel that failed.
   * @param to - the channel that will be tried next.
   * @param code - why it failed.
   * @param atMs - wall clock, injected for testability.
   * @param nextIndex - the absolute index of `to` within the member list.
   */
  advance(from: string, to: string, code: string, atMs: number, nextIndex: number): void {
    this.position = nextIndex
    this.lastSwitch = { from, to, code, atMs }
  }

  /** Return to the first member (owner-facing 「重置到第一个」). */
  reset(): void {
    this.position = 0
    this.lastSwitch = undefined
  }

  /** The most recent switch, or undefined when the group has served from its first member only. */
  get last(): { from: string; to: string; code: string; atMs: number } | undefined {
    return this.lastSwitch
  }

  /** The current zero-based position, for the panel's readout. */
  get index(): number {
    return this.position
  }
}
