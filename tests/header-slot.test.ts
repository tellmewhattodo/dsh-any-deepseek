/**
 * header-slot.test.ts — WHY the header badge did not render for three releases.
 *
 * ## The defect this file exists to prevent
 *
 * 0.0.24, 0.0.25 and 0.0.26 all shipped a badge that never appeared, while every install check
 * stayed green. The cause was one wrong argument: `slots.inject()` was given the PARENT key
 * (`conversation.header`) instead of the key the registration targets
 * (`conversation.header.leading`).
 *
 * `inject(key, fn)` runs `fn` as soon as THAT key is declared. The host declares the two keys in
 * two separate calls, one `yield` apart:
 *
 *   registerConversationRoot()  → registers `main.conversation`, children: `conversation.header`
 *   registerHeader()            → registers `conversation.header`,  children: `conversation.header.leading`
 *
 * So when `conversation.header` becomes declared, its child `conversation.header.leading` does NOT
 * exist yet. Waiting on the parent fires one step too early and `SlotCore.register` throws:
 *
 *   slot "conversation.header.leading" is not declared
 *   (a parent entry's children table must declare it)
 *
 * ## Why the existing suite could not catch it
 *
 * Two independent reasons, and both are recorded here because either one alone would have kept the
 * suite green:
 *
 *  1. **No test ever touched `apply()`.** `UsageBadge.test.ts` covers the pure functions
 *     (`pickTodayBillable`, `localDayKey`, `badgeState`) — real and worth keeping, but not one of
 *     them exercises slot registration.
 *  2. **`src/client/**` is excluded from the coverage include list** (`vitest.config.ts:11`), so no
 *     threshold could ever complain that the badge's registration had zero coverage.
 *
 * These tests run against the REAL `SlotCore` from `@deepseek-ai/dsh-client-ui-slots`, not a hand
 * written fake. A fake would have been written by the same mind that got the ordering wrong, and
 * would therefore agree with the bug.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * The declaration chain the host actually walks, reduced to the keys this plugin cares about.
 *
 * Every step below is a separate `register()` call in the host, because a child key can only be
 * declared by an entry that is itself already declared — so the whole chain has to be built up in
 * order, from the seeded `root`:
 *
 *   root            (seeded by SlotCore)
 *     └ main                               ← a layout plugin declares this
 *         └ main.conversation              ← `registerConversationRoot()`
 *             └ conversation.header        ← the same call, as its children table
 *
 * `conversation.header.leading` is NOT declared by any of the above — it arrives one call later,
 * in {@link declareHeaderSlot}. That gap is the entire defect.
 */
function declareHostSlots(core: SlotCore): void {
  // A layout plugin puts `main` on the tree. (In the real host this is the shell/layout package.)
  core.register(
    { name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } },
    () => null,
  )
  // `registerConversationRoot()` step 1: the keyed `main` entry that owns the conversation panel.
  core.register(
    {
      name: 'main',
      key: 'conversation',
      children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } },
    },
    () => null,
  )
  // `registerConversationRoot()` step 2 — declares `conversation.header`.
  core.register(
    {
      name: 'main.conversation',
      children: { 'conversation.header': { kind: 'single', scope: 'session-maybe' } },
    },
    () => null,
  )
}

/** `registerHeader()` — declares the key this plugin registers into. A LATER, separate call. */
function declareHeaderSlot(core: SlotCore): void {
  core.register(
    {
      name: 'conversation.header',
      children: { 'conversation.header.leading': { kind: 'single', scope: 'root' } },
    },
    () => null,
  )
}

/** Stand-in component — the registry never calls it, it only stores it. */
const Component = () => null

describe('the slot declaration order that broke the badge', () => {
  let core: SlotCore

  beforeEach(() => {
    core = new SlotCore()
    declareHostSlots(core)
  })

  it('🔴 the PARENT is declared while the CHILD is not — this is the trap', () => {
    // The exact intermediate state that `inject("conversation.header", …)` fires in.
    expect(core.spec('conversation.header')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(core.spec('conversation.header.leading')).toBeUndefined()
  })

  it('🔴 registering into the not-yet-declared child THROWS — it is not silently dropped', () => {
    // The handover note for 0.0.24-0.0.26 said registration was "accepted and DROPPED … silently,
    // no console error". That was wrong in a way that cost three releases: it is not dropped, it
    // THROWS — and because the throw escapes a cordis effect it never reaches console.error, so a
    // console-intercept probe reports "no error at all".
    expect(() =>
      core.register({ name: 'conversation.header.leading' }, Component),
    ).toThrowError(/conversation\.header\.leading.*is not declared/)
  })

  it('after the header declares its children, the same registration SUCCEEDS', () => {
    declareHeaderSlot(core)
    expect(core.spec('conversation.header.leading')).toEqual({ kind: 'single', scope: 'root' })
    core.register({ name: 'conversation.header.leading' }, Component)
    expect(core.entries('conversation.header.leading')).toHaveLength(1)
  })
})

describe('slots.inject fires on the declaration of the key it names', () => {
  let core: SlotCore

  beforeEach(() => {
    core = new SlotCore()
    declareHostSlots(core)
  })

  it('🔴 injecting the PARENT runs too early — child is still undeclared when it fires', () => {
    // This reproduces the shipped bug without needing a browser. The callback runs on the parent's
    // declaration, and its registration then throws — which is why 0.0.24-0.0.26 rendered nothing.
    let childDeclaredWhenFired: unknown = 'never fired'
    const registerInside = () => {
      childDeclaredWhenFired = core.spec('conversation.header.leading')
      // Recorded rather than thrown so the assertion below reports the STATE, which is the actual
      // finding: the callback ran while the child did not exist.
    }

    // Mirrors the renderer's `inject`: run now if declared, else subscribe to the declaration.
    let unsubscribe = (): void => {}
    const reconcile = () => {
      if (core.spec('conversation.header') === undefined) return
      registerInside()
    }
    unsubscribe = core.subscribeDeclaration('conversation.header', reconcile)
    reconcile()

    expect(childDeclaredWhenFired).toBeUndefined() // ran, and the child was missing
    unsubscribe()
  })

  it('🔴 injecting the CHILD waits — it fires only once the child is declared', () => {
    let fired = false
    let childSpecAtFire: unknown = 'never fired'

    const reconcile = () => {
      if (core.spec('conversation.header.leading') === undefined) return
      fired = true
      childSpecAtFire = core.spec('conversation.header.leading')
    }
    const unsubscribe = core.subscribeDeclaration('conversation.header.leading', reconcile)
    reconcile()

    // Parent is declared, child is not ⇒ must NOT have fired yet.
    expect(fired).toBe(false)

    // The host's next step: declare the header, which declares the child.
    declareHeaderSlot(core)

    expect(fired).toBe(true)
    expect(childSpecAtFire).toEqual({ kind: 'single', scope: 'root' })
    unsubscribe()
  })

  it('🔴 end-to-end: waiting on the child lets the registration land in the ledger', () => {
    // The positive control for the whole defect. Same sequence as production: parent first, then
    // the header, then our registration — and the ledger must end up with exactly one occupant.
    const KEY = 'conversation.header.leading'
    const reconcile = () => {
      if (core.specDynamic(KEY) === undefined) return
      core.register({ name: KEY }, Component)
    }
    const unsubscribe = core.subscribeDeclaration(KEY, reconcile)
    reconcile()

    expect(core.entries(KEY)).toHaveLength(0) // not registered while undeclared

    declareHeaderSlot(core)

    expect(core.entries(KEY)).toHaveLength(1)
    expect(core.entriesOfSlot(KEY)).toHaveLength(1) // it is a RENDERED occupant, not just a row
    unsubscribe()
  })
})

describe('"container present" is not "occupant present"', () => {
  it('🔴 a declared single slot with no entries is exactly the state that fooled the checks', () => {
    // The three failed investigations each confirmed the `<div data-slot="conversation.header.leading">`
    // element existed and read that as "the slot is fine". It is a DIFFERENT fact: the spec is
    // declared (so the outlet renders) while the entries array is empty (so it renders nothing).
    const core = new SlotCore()
    declareHostSlots(core)
    declareHeaderSlot(core)

    expect(core.spec('conversation.header.leading')).toEqual({ kind: 'single', scope: 'root' })
    expect(core.entries('conversation.header.leading')).toHaveLength(0)
    expect(core.entriesOfSlot('conversation.header.leading')).toHaveLength(0)
  })
})

describe('the inject contract in src/client/index.ts', () => {
  it('🔴 must name the key it registers into — not the parent key', async () => {
    // Source-level assertion, deliberately kept: the browser failure mode is a silent empty slot,
    // and this line is the whole defect. Reading the file makes the intent checkable in CI, where
    // no browser exists. It is a guard against REGRESSION of a known bug, not a substitute for the
    // real-browser verification recorded in the trajectory.
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')

    // Every `slots.inject(` call must be handed the same key its `register(` targets.
    const injectKeys = [...source.matchAll(/slots\.inject\(\s*'([^']+)'/g)].map((m) => m[1])
    const registerNames = [...source.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])

    // The badge's seat, per owner decision 2026-11-01: global, root-scoped, not session-attached.
    expect(injectKeys).toContain('sidebar.footer.action')
    expect(registerNames).toContain('sidebar.footer.action')

    // 🔴 The exact regression: injecting a parent declared one step before the child.
    expect(injectKeys).not.toContain('conversation.header')

    // Every injected key must correspond to a slot this file actually registers into. This is the
    // general form of the bug — the parent key was injected while a different key was registered.
    for (const key of injectKeys) expect(registerNames).toContain(key)
  })

  it('🔴 the badge must NOT be attached to the Session title (owner ruling 2026-11-01)', async () => {
    // Measured reason, not taste: `conversation.header.leading` sits at x=300,y=10, immediately
    // right of the Session title, while the figure it shows counts the WHOLE machine's day. Beside a
    // Session title it reads as THAT Session's usage. Owner: 「放会话标题了不太合适」.
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    // Strip comments first: the seat's removal is explained in prose, and that prose must not be
    // read as a live registration.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    expect(code).not.toMatch(/name:\s*'conversation\.header\.leading'/)
  })

  it('🔴 a `list` seat must be registered with an id — without one the host throws', () => {
    // `sidebar.footer.action` is `kind:'list'` (measured in the live registry), and SlotCore rejects
    // a list registration that omits `id` (`dsh-client-ui-slots/lib/index.js:181-186`). Pinning it
    // here means a future edit that drops the id fails in CI, not in a browser.
    const core = new SlotCore()
    core.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, Component)
    core.register(
      {
        name: 'main',
        key: 'sidebar',
        children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
      },
      Component,
    )

    expect(() => core.register({ name: 'sidebar.footer.action' }, Component)).toThrowError(
      /requires options\.id/,
    )

    core.register({ name: 'sidebar.footer.action', id: 'any-deepseek-usage', order: 90 }, Component)
    expect(core.entriesOfSlot('sidebar.footer.action')).toHaveLength(1)
  })
})
