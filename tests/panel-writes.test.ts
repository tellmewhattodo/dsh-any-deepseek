/**
 * panel-writes.test.ts — the panel's write path.
 *
 * ## The bug this file exists to prevent
 *
 * The panel used to write nested settings with a dotted STRING:
 *
 *     form.set('channels.go.enabled', true)
 *
 * `ConfigForm.set(field, value)` builds `path: [field]` — ONE segment. So that call did not
 * toggle the switch; it created a key literally named `channels.go.enabled` in the settings
 * document, and the host ACCEPTED it. No error, no visible effect, a document quietly filling
 * with garbage keys. It was only found by reading the harness's client source.
 *
 * The fix routes every nested write through `mutate`, which carries a real path array. These
 * tests pin that shape, because "it type-checks" never would have caught the original.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { suggestId, suggestKeyRef } from '../src/client/SettingsPage.js'

/** The panel's write helper, read from source (see the note in the last test). */
function clientSource(): string {
  return readFileSync(join(process.cwd(), 'src', 'client', 'index.ts'), 'utf-8')
}

/** The page source. */
function pageSource(): string {
  return readFileSync(join(process.cwd(), 'src', 'client', 'SettingsPage.tsx'), 'utf-8')
}

describe('settings writes use real paths', () => {
  it('nested writes go through mutate, never through the single-segment set()', () => {
    const source = clientSource()

    // `mutate` is the only API that carries a multi-segment path.
    expect(source).toContain('form.mutate(')
    // The old, silently-wrong call must not come back.
    expect(source).not.toContain('form.set(')
  })

  it('the write helper takes path SEGMENTS, so a caller cannot smuggle in a dotted string', () => {
    const source = clientSource()
    // `path: readonly string[]`, not `field: string`.
    expect(source).toMatch(/setField:\s*\(path:\s*readonly string\[\]/)
    expect(source).toMatch(/path:\s*\[\s*\.\.\.path\s*\]/)
  })

  it('does NOT swallow a refused write', () => {
    // The original helper ended in `.catch(() => undefined)`. A refusal (read-only deployment,
    // settings service not composed, revision conflict) then looked identical to success: the
    // panel stayed up, nothing was saved, and no one could tell. The promise must escape.
    const source = clientSource()
    expect(source).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/)
    expect(source).toMatch(/return form\.mutate\(/)
  })

  it('surfaces a refusal in the panel instead of dropping it', () => {
    const page = pageSource()
    // Every mutation goes through one `write(...)` wrapper that reports failure.
    expect(page).toContain('const write = (run: () => Promise<boolean>')
    expect(page).toContain('宿主拒绝了这个修改')
    // No mutation may bypass it.
    expect(page).not.toMatch(/^\s*(?:void\s+)?(?:setField|removeField)\(/m)
  })

  it('supports clearing a value, so a channel can be removed', () => {
    const source = clientSource()
    expect(source).toContain("op: 'unset'")
    expect(source).toContain('removeField')
  })

  it('the page never passes a dotted string to setField', () => {
    const page = pageSource()
    // A dotted literal like setField('channels.x.enabled') would reintroduce the bug through a
    // different door — the helper takes arrays now, so any quoted string is a mistake.
    const dotted = page.match(/setField\(\s*['"][^'"]*\./)
    expect(dotted).toBeNull()
    expect(page).toContain("setField(['current'], id)")
  })

  it('🔴 selection is the ONLY channel-level write — there is no `enabled` toggle', () => {
    // `enabled` was a second on/off axis for the same question `current` already answers, so it
    // was removed (a channel could be enabled-but-not-current, or current-but-disabled — both
    // meaningless). A resurrected toggle would bring back the contradiction.
    const page = pageSource()
    expect(page).not.toContain("'enabled'")
    expect(page).not.toMatch(/\bToggle\b/)
  })

  it('🔴 renders channels as a radio group, not per-row action buttons', () => {
    // "Which relay is live" is single-choice. A radio expresses that in the affordance; a
    // "设为当前" button made the same fact look like an action the panel performs.
    const page = pageSource()
    expect(page).toContain('role="radiogroup"')
    expect(page).toContain('type="radio"')
    // Assert on the JSX text node, not the whole file: the phrase may legitimately appear in a
    // comment or in an error message, and a substring check over all source cannot tell them
    // apart from a rendered button label.
    expect(page).not.toMatch(/>\s*设为当前\s*</)
  })
})

describe('add-channel form', () => {
  it('creates a channel with a preset and the key itself', () => {
    const page = pageSource()
    // Pre-filling endpoint fields would freeze today's preset values into the user's document,
    // so later preset fixes would never reach them. The key, by contrast, is exactly what the
    // user has and the panel cannot derive — so it goes straight into the entry.
    expect(page).toContain("setField(['channels', id], entry)")
    expect(page).toContain('apiKey: newSecret.trim()')
    // No invented reference name may reappear: that was the design the owner rejected.
    expect(page).not.toContain('suggestKeyRef')
    expect(page).not.toContain('apiKeyEnv:')
  })

  it('🔴 writes the display name only when the user changed it', () => {
    // Leaving `label` out lets the preset's name apply and keep tracking preset changes; writing
    // the same string back would freeze today's name into the user's document.
    const page = pageSource()
    expect(page).toContain('if (label !== \'\') entry.label = label')
  })

  it('makes the first added channel current', () => {
    const page = pageSource()
    // Otherwise every request fails with NO_CHANNEL_SELECTED and the plugin looks broken.
    expect(page).toMatch(/if \(current === ''\) write\(\(\) => setField\(\['current'\], id\)/)
  })

  it('validates the id before writing', () => {
    const page = pageSource()
    // A channel id is a configuration key; an awkward one (spaces, dots, leading symbol) is
    // unaddressable from the path-based write API.
    expect(page).toContain('/^[a-z0-9][a-z0-9_-]*$/')
    expect(page).toContain('这个 id 已经有了')
  })

  it('clears the selection when the current channel is removed', () => {
    const page = pageSource()
    // A `current` pointing at a deleted channel leaves a dangling selection that reads as a
    // configured-but-broken plugin rather than as "nothing selected".
    expect(page).toMatch(/if \(current === id\) write\(\(\) => removeField\(\['current'\]\)/)
  })
})

describe('the add form derives what the preset already answers', () => {
  // A preset fully determines the endpoint, so asking the user to retype it is the friction the
  // owner reported. The derivation is pure, so it is pinned here.
  it('suggests the preset id as the channel id when it is free', () => {
    expect(suggestId('open-design', [])).toBe('open-design')
  })

  it('de-duplicates so two relays on the same preset do not collide', () => {
    // The second Open Design channel must not overwrite the first: the id is a configuration key.
    expect(suggestId('open-design', [{ id: 'open-design' }])).toBe('open-design-2')
    expect(suggestId('open-design', [{ id: 'open-design' }, { id: 'open-design-2' }])).toBe('open-design-3')
  })

  it('suggests nothing when no preset is chosen', () => {
    expect(suggestId('', [])).toBe('')
  })

  it('🔴 the derived id compares against the PREVIOUS suggestion, captured as a local', () => {
    // Two distinct bugs lived here, both invisible to a pure-function test:
    //  ① the branch once read `previous === '' || previous === ''` — the same test twice;
    //  ② even with the ref named, reading it INSIDE the updater compares against the value the
    //     handler already overwrote, because a React state updater runs later.
    // Measured in the real browser both times: Open Design → Ollama kept id "open-design"
    // while the select showed Ollama.
    const page = pageSource()
    // The handler captures the previous suggestion before scheduling any update…
    expect(page).toContain('const previousId = lastSuggestedId.current')
    // …and the updater compares against that local, never against a live ref.
    expect(page).toContain('current === previousId')
    // Check only EXECUTABLE lines: comments quote the broken forms, and a substring test over
    // the whole file cannot tell a comment from code.
    const code = page
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    expect(code).not.toMatch(/previous === '' \|\| previous === ''/)
    // The updater body must not read a ref: that is bug ②.
    for (const updater of code.match(/setNewId\(\(current\) => [^\n]*/g) ?? []) {
      expect(updater).not.toContain('.current')
    }
  })
})

describe('the panel takes the KEY and stores it on the channel', () => {
  // 🔴 The design this pins out of existence: the panel used to ask for a "credential reference
  // name" and tell the user to set the secret "in the credential centre" — a place that does not
  // exist in this UI, so the key the user actually held had nowhere to go. Owner decision
  // 2026-10-21: store the key in the channel entry. One field, one store, one write.

  it('writes the key into the channel entry, not into a second store', () => {
    const source = clientSource()
    // Strip comments first: this file's own header explains WHY the credential namespace was
    // dropped, and a raw substring test cannot tell that explanation from a call.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    // The credential namespace must be gone from the client half's executable code.
    expect(code).not.toContain('remote.credentials')
    expect(code).not.toContain('storeCredential')
    // And the only write shape is the settings mutate the rest of the panel already uses.
    expect(code).toContain('form.mutate(')
  })

  it('asks for the key itself, in a masked field', () => {
    const page = pageSource()
    // The field is labelled 密钥 and marked REQUIRED. The marker is asserted too, because "which
    // fields can I skip?" was previously unanswerable from the form — and the one field that
    // could not be skipped looked exactly like the two that could.
    expect(page).toContain('<em className="ad-req">必选</em>')
    expect(page).toMatch(/<span>密钥<em className="ad-req">必选<\/em><\/span>/)
    expect(page).toContain('type="password"')
    // The old wording must not come back: one named a place that does not exist, the other asked
    // the user to invent an identifier for something they only have a value for.
    expect(page).not.toContain('凭据中心')
    expect(page).not.toContain('凭据引用名')
    expect(page).not.toContain('引用名')
  })

  it('re-keys an existing channel with a single settings write', () => {
    const page = pageSource()
    // The "I have the key / mine changed" path: one write to channels.<id>.apiKey, through the
    // same `write()` wrapper as every other mutation so a refusal is visible.
    const saveKey = page.slice(page.indexOf('const saveKey = async (row: ChannelRow)'))
    const body = saveKey.slice(0, saveKey.indexOf('\n  }\n'))
    expect(body).toContain("await setField(['channels', row.id, 'apiKey'], keyDraft.trim())")
    expect(body).toContain('宿主拒绝了这个修改')
    // Re-read afterwards: the dot must reflect what is stored, not our hope.
    expect(body).toContain('await refresh()')
  })

  it('tells the user where the key ends up', () => {
    const page = pageSource()
    // Since the key now lives in the profile document, the panel must not imply it is hidden
    // somewhere else — the accepted cost is stated at the point of entry, not in a changelog.
    expect(page).toContain('channels.&lt;id&gt;.apiKey')
    expect(page).not.toContain('不会</strong>写进 profile 配置文件')
  })

  it('every channel row says where its key lives', () => {
    // Without `keyKind` the panel cannot tell a key it may rewrite from a reference name whose
    // value it can never read — so it would offer an edit box that cannot work for one of them.
    const api = readFileSync(join(process.cwd(), 'src', 'client', 'panel-api.ts'), 'utf-8')
    const row = api.slice(api.indexOf('export interface ChannelRow'))
    const body = row.slice(0, row.indexOf('\n}'))
    expect(body).toMatch(/keyKind:\s*'literal' \| 'reference' \| 'none'/)
    // `keyRef` survives only for the reference case, and is therefore optional.
    expect(body).toMatch(/keyRef\?:\s*string/)
  })
})

describe('what the owner reported, pinned as assertions', () => {
  // Four complaints came in at once (2026-10-22), and none of them had a test. Each one is a
  // behaviour the panel claimed to have and did not, which is exactly the class of defect a
  // source-reading test can hold still.

  it('🔴 a successful write RE-READS — adding or removing must show up without reopening', () => {
    // The rows come from `/any-deepseek/channels`, computed from the configuration, not pushed.
    // Any write that does not re-read leaves the panel showing the document from BEFORE the
    // write. The fix is centralised in `write()` so a new write path inherits it, instead of
    // depending on each call site remembering.
    const page = pageSource()
    const write = page.slice(page.indexOf('const write = (run: () => Promise<boolean>'))
    const body = write.slice(0, write.indexOf('\n  }'))
    expect(body).toContain('void refresh()')
    // …and only on the ACCEPTED branch: a refused write has nothing to re-read.
    const acceptedBranch = body.slice(0, body.indexOf('(cause: unknown)'))
    expect(acceptedBranch).toContain('void refresh()')
    // The delete path must not have to remember anything of its own.
    const remove = page.slice(page.indexOf('const removeChannel = (id: string)'))
    const removeBody = remove.slice(0, remove.indexOf('\n  }'))
    expect(removeBody).not.toContain('refresh()')
  })

  it('🔴 the current channel is marked beyond a small badge', () => {
    const page = pageSource()
    // Three signals: the class carries a left colour bar and a fill (pinned in the CSS test
    // below), plus `aria-current` so the same fact reaches assistive tech.
    expect(page).toContain('aria-current={isCurrent')
    expect(page).toContain('data-current={isCurrent')

    const css = readFileSync(join(process.cwd(), 'src', 'client', 'SettingsPage.css'), 'utf-8')
    const current = css.slice(css.indexOf('.ad-row-current {'))
    const block = current.slice(0, current.indexOf('}'))
    expect(block).toContain('border-left-color')
    expect(block).toContain('background')
    // Every row reserves the edge, so selecting one does not shift the row's content.
    const row = css.slice(css.indexOf('.ad-row {'))
    expect(row.slice(0, row.indexOf('}'))).toContain('border-left: 3px solid transparent')
  })

  it('🔴 the active channel is GREEN, and every mark reads from one token', () => {
    /*
     * Owner 2026-10-25: 「激活的样式用绿色」.
     *
     * The prior marks were all derived from `currentColor` — a neutral bar, a stronger border, a
     * grey tint. They were technically distinguishable and practically invisible: the live row
     * looked like any hovered row.
     *
     * 🔴 What makes this assertion worth having is not "is it green" (a colour is trivially
     * changeable) but "can the marks DRIFT apart". Four separate rules apply the colour — border,
     * left bar, fill, badge — and if one of them keeps `currentColor` while others go green, the
     * row is half-recoloured and looks broken. So: the token must exist, and every mark must read
     * FROM it rather than from `currentColor`.
     */
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'SettingsPage.css'), 'utf-8')
    expect(css).toContain('--ad-active:')
    const current = css.slice(css.indexOf('.ad-row-current {'))
    const block = current.slice(0, current.indexOf('}'))
    expect(block).toContain('var(--ad-active)')
    // The old neutral wiring must be gone from the active-state block, or the row is half-marked.
    expect(block).not.toContain('--ad-fill-current')
    // The badge and the name are the two remaining marks; both must follow the token.
    const badge = css.slice(css.indexOf('.ad-row-current .ad-badge {'))
    expect(badge.slice(0, badge.indexOf('}'))).toContain('var(--ad-active)')
    const title = css.slice(css.indexOf('.ad-row-current .ad-rowTitle {'))
    expect(title.slice(0, title.indexOf('}'))).toContain('var(--ad-active)')
    // And the retired token must not linger, or a future edit may resurrect it.
    expect(css).not.toContain('--ad-fill-current')

    /*
     * 🔴 The DRIFT check, and it is the only part of this assertion that can actually fail for the
     * interesting reason.
     *
     * The first version of this test asserted "some mark uses `--ad-active`" — then a negative
     * control recoloured the badge's border back to `currentColor` and the suite stayed GREEN,
     * because the other marks still satisfied it. A judgement that any one of four marks can
     * satisfy is not a judgement about the row; it is a judgement about the most compliant line
     * in it.
     *
     * So: NO active-state rule may read `currentColor`. Every selector that targets `.ad-row-current`
     * (the row, its badge, its title, anything added later) must take its colour from the token,
     * which is exactly the property that keeps the four marks from disagreeing.
     */
    const currentRules = [...css.matchAll(/\.ad-row-current[^{]*\{[^}]*\}/g)].map((match) => match[0])
    expect(currentRules.length).toBeGreaterThanOrEqual(3)
    for (const rule of currentRules) {
      expect(rule, `active-state rule must not fall back to currentColor:\n${rule}`)
        .not.toContain('currentColor')
    }
  })

  it('🔴 the display name is editable, and renaming never touches the channel id', () => {
    const page = pageSource()
    // Adding: a name field exists, is derived from the preset, and is marked OPTIONAL — the
    // marker matters because leaving it blank is a real choice (the preset's name applies).
    expect(page).toMatch(/<span>显示名<em className="ad-opt">可空<\/em><\/span>/)
    expect(page).toContain('lastSuggestedLabel.current')
    /*
     * 🔴 The per-row 改名 button was REMOVED (owner 2026-11-06), and the assertion had to be
     * re-anchored rather than deleted — the requirement it protects did not change one bit:
     * renaming must write `label` and must never touch the channel id (that would be a different
     * channel, with a different key and a different `current` target).
     *
     * It is now the ONLY rename path, so it is the only place the write can happen: the add form
     * submits `label` as part of a new channel ENTRY, keyed by `channels.<id>`. What must remain
     * true, and is checked here, is that the entry's key is the channel id and that the name
     * travels in the `label` member — never as the id.
     */
    const add = page.slice(page.indexOf('const addChannel = (): void =>'))
    const body = add.slice(0, add.indexOf('\n  }'))
    expect(body).toContain("setField(['channels', id]")
    expect(body).toContain('entry.label = label')
    expect(body).not.toContain("setField(['label'")
    // And the button that used to do it is gone, not merely hidden: no rename handler, no state.
    expect(page).not.toContain('renameChannel')
    expect(page).not.toContain('setRenaming')
  })

  it('🔴 no action button may live inside a radio label — the supply group included', () => {
    /*
     * 🔴 This protected a button that no longer exists (改名, removed 2026-11-06). Kept as an
     * assertion because the HAZARD outlives the button: a control inside a radio's `<label>` has
     * its clicks forwarded to the radio, so a button placed there silently makes its row current.
     *
     * 🟢 **2026-11-12 made this check MORE important, not less.** The supply group's row is now the
     * first `<label className="ad-rowPick">` in the page, and its member editor (§↑ ↓ 移出) is a
     * dense cluster of buttons. Putting that editor inside the label would mean every click on
     * 「↑」 also re-selects the group — a side effect on an unrelated action, exactly the defect
     * this test exists for. So the check now walks EVERY `ad-rowPick` label rather than the first.
     *
     * ⚠️ **What is allowed inside a label, and why**: 更换密钥's inline form (password input +
     * 保存密钥 button) lives in the channel label inside `{keying === row.id && …}`. That button
     * acts on the key, not the selection, and typing in it does not fire the radio. Excluding
     * exactly that subtree keeps this judgement about ACTIONS rather than about markup that
     * happens to look like one.
     */
    const page = pageSource()
    const labels: string[] = []
    let cursor = 0
    for (;;) {
      const start = page.indexOf('className="ad-rowPick"', cursor)
      if (start < 0) break
      const end = page.indexOf('</label>', start)
      if (end < 0) break
      labels.push(page.slice(start, end))
      cursor = end + 1
    }
    // The group row added one label; a run that finds none would make every assertion below vacuous.
    expect(labels.length).toBeGreaterThanOrEqual(2)

    for (const [index, raw] of labels.entries()) {
      /*
       * 🔴 Strip comments before matching. A substring test cannot tell prose from code, and notes
       * in this very subtree mention buttons — the first version of this assertion fired on its
       * own documentation.
       */
      const withoutComments = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      // Strip ONLY the known-safe subtree, then assert it was actually there (otherwise the strip
      // regex silently matched nothing and the check below stops meaning anything).
      const withoutKeyForm = withoutComments
        .replace(/\{keying === row\.id && \([\s\S]*?\n {20}\)\}/, '')
        .replace(/\{keySaving \? '保存中…' : '保存密钥'\}/, '')
      if (withoutComments.includes('{keying === row.id && (')) {
        expect(withoutKeyForm, `label #${index}`).not.toContain('保存密钥')
      }
      expect(withoutKeyForm, `label #${index} must not carry an action button`).not.toContain('<button')
      // Every slice must still BE a radio's label — otherwise the checks above are vacuous.
      expect(withoutComments, `label #${index}`).toContain('name="ad-current-channel"')
    }
  })

  it('🔴 the supply group is ONE radio option, not a switch beside them', () => {
    /*
     * Owner requirement 2026-11-12: 「当开启供应组的时候，相当于选中了供应组作为当前使用，则下方就没有选中
     * 模型了…给用户供应组是一种选择的感觉」.
     *
     * The mechanism that delivers that feeling is structural, so it is asserted structurally:
     *  · the group's control is `type="radio"` in the SAME `name` group as the channels, so the
     *    browser enforces "exactly one" and unselects every channel when the group is picked;
     *  · selecting it writes the SAME field (`current`) the channel radios write, with the group
     *    sentinel — there is no second flag to fall out of step.
     *
     * A checkbox/switch would satisfy the *words* "可开启的" while breaking the *feeling*: two
     * independent axes could then disagree, which is the defect that retired per-channel `enabled`.
     */
    const page = pageSource()
    const groupRow = page.slice(page.indexOf('ad-groupRow'), page.indexOf('ad-groupEditor'))
    expect(groupRow).toContain('type="radio"')
    expect(groupRow).toContain('name="ad-current-channel"')
    expect(groupRow).toContain('onChange={() => selectGroup()}')
    // ⛔ Not a checkbox, not a `role="switch"`.
    expect(groupRow).not.toContain('type="checkbox"')
    expect(page).not.toContain('role="switch"')
    // The selection is written through the SAME field the channels use.
    expect(page).toContain("setField(['current'], SUPPLY_GROUP_ID)")
    // And the sentinel is not duplicated as a literal anywhere in the component.
    expect(page).not.toContain("'__group__'")
  })
})

describe('what the rules demand of the wire', () => {
  it('🔴 the thinking level selected by the harness reaches pi-ai', () => {
    // The feature was absent, not broken: `reasoning` was a boolean with no value, so every
    // request used the relay default and the picker's choice was discarded. Two halves have to
    // be present — the map on the model, and the level on the request.
    const adapter = readFileSync(join(process.cwd(), 'src', 'adapter.ts'), 'utf-8')
    expect(adapter).toContain('thinkingLevelMap')
    expect(adapter).toContain('options.reasoningEffort')
    expect(adapter).toContain('reasoning: options.reasoningEffort')
  })

  it('🔴 an OpenCode request carries a PER-SESSION id and this client\'s own user agent', () => {
    const adapter = readFileSync(join(process.cwd(), 'src', 'adapter.ts'), 'utf-8')
    // The session id comes from the harness, not from a literal: a constant shared by every
    // conversation is what the header exists to avoid.
    expect(adapter).toContain('options.sessionId')
    expect(adapter).toContain('OPENCODE_SESSION_HEADER')
    expect(adapter).toContain('CLIENT_USER_AGENT')
    // The upstream asks clients not to send a generic SDK user agent.
    const presets = readFileSync(join(process.cwd(), 'src', 'presets.ts'), 'utf-8')
    expect(presets).toContain('export const CLIENT_USER_AGENT')
  })

  it('🔴 the provider dispatches per protocol — NOT one hardcoded implementation', () => {
    /**
     * 🔴 This is the shape that made `channel.api` decorative.
     *
     * `createProvider` treats a SINGLE implementation as "serves every model"
     * (`pi-ai/dist/models.js:529-532`: `single = input.api && typeof input.api.stream ===
     * 'function'`). So passing `api: openAICompletionsApi()` meant `model.api` was never
     * consulted and every channel went out over the completions wire, no matter what its `api`
     * field said. The setting was accepted, shown in the panel, and silently ignored.
     *
     * ⚠️ **Asserted structurally, and that is deliberate.** Reverting the fix to the single
     * implementation left every other test GREEN, because the transport is faked in tests and
     * the wrong protocol still "works" against a mock. The dispatch decision itself is therefore
     * the thing to pin: it must be a map keyed by protocol.
     */
    const adapter = readFileSync(join(process.cwd(), 'src', 'adapter.ts'), 'utf-8')
    expect(adapter).toContain('api: apiImplementations()')
    // The old broken form must not come back. Matched WITH the trailing comma so this pins the
    // code line, not the prose that explains why it was wrong (the comment quotes the old shape).
    expect(adapter).not.toContain('api: openAICompletionsApi(),')
    // And the map must actually cover every protocol the schema accepts, or a channel naming
    // one of them fails at dispatch with "no API implementation for …".
    for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      expect(adapter, protocol).toContain(`'${protocol}'`)
    }
  })
})

describe('布局：分 tab，让用户不必滚动', () => {
  /**
   * Owner request (2026-10-23): 「这两个用分tab页面panel方式做 … 可以让用户不用滚动鼠标滚轮」.
   *
   * The panel answers two questions asked at DIFFERENT TIMES — "which relay serves me and does
   * its key work" (setup) vs "what has each relay cost" (review). Stacked on one scroll, reading
   * the cost table meant scrolling past every channel row.
   */
  it('🔴 the two panels are mutually exclusive — never both rendered', () => {
    const page = pageSource()
    // Each panel is guarded by its own flag. If both render, the page scrolls again and the tabs
    // become decoration — exactly the state this change exists to leave.
    expect(page).toContain("{tab === 'channels' && (")
    expect(page).toContain("{tab === 'usage' && (")
  })

  it('the tabs are real tabs: role, selected state, and labels', () => {
    const page = pageSource()
    // `role="tablist"` + `aria-selected` is what makes this announce as tabs rather than as two
    // buttons that happen to sit next to each other.
    expect(page).toContain('role="tablist"')
    expect(page).toContain('role="tab"')
    expect(page).toContain('aria-selected={tab === ')
    // The panels they control are labelled, so "which panel is this?" is answerable by a reader
    // who is not looking at the tab strip.
    expect(page).toContain('role="tabpanel"')
  })

  it('渠道 is the default tab, because it is the question a new user must answer first', () => {
    const page = pageSource()
    // An empty install showing an empty usage table answers nothing; it should land on the list
    // where "add a channel" is.
    expect(page).toContain("useState<PanelTab>('channels')")
  })

  it('the channel tab carries a count, so "how many do I have" needs no click', () => {
    expect(pageSource()).toContain('ad-tabCount')
  })
})

describe('面板里附上仓库地址（owner 2026-10-23）', () => {
  it('🔴 the source URL is in the panel, and it is the real one', () => {
    const page = pageSource()
    const url = page.match(/REPO_URL\s*=\s*'([^']+)'/)?.[1]
    expect(url).toBe('https://github.com/tellmewhattodo/dsh-any-deepseek')
    // …and it is actually RENDERED, not merely defined: a constant nobody prints helps nobody.
    expect(page).toContain('href={REPO_URL}')
  })

  it('the link opens in a new tab and cannot reach back through window.opener', () => {
    const page = pageSource()
    // A settings panel navigating itself away would lose the user's place mid-edit.
    expect(page).toContain('target="_blank"')
    expect(page).toContain('rel="noreferrer"')
  })

  it('the footer says the thing an improver needs to know: it is MIT and forkable', () => {
    expect(pageSource()).toContain('MIT')
  })
})

describe('面板文案 (EAP rewrite, owner 2026-10-23)', () => {
  /**
   * The text is part of the product here: the panel is the only place most users will ever read
   * about this plugin. Each assertion below pins a FACT the panel must state, because leaving it
   * out means the reader infers something else.
   */
  it('states which provider this page configures, and that there is exactly one model', () => {
    const page = pageSource()
    expect(page).toContain('any-deepseek 这一个 provider')
    // The one-model fact is the plugin's entire shape; a reader who misses it thinks this is a
    // multi-model switcher.
    expect(page).toContain('只提供一个模型')
  })

  it('🔴 says selecting a channel does NOT fail over — the cost of that silently missing is a wrong expectation', () => {
    expect(pageSource()).toContain('不会自动切换')
  })

  it('names the exact config key where the secret lands', () => {
    // "Stored securely" is not a fact a reader can verify; a path is.
    expect(pageSource()).toContain('channels.&lt;id&gt;.apiKey')
  })

  it('🔴 warns that a liveness check spends tokens, on the button that spends them', () => {
    // A button that quietly costs money is worse than one that cannot be clicked.
    const page = pageSource()
    expect(page).toContain('消耗一两个 token')
  })

  it('states the counting convention next to the numbers, not in a document', () => {
    const page = pageSource()
    // Disjoint counters: summing the wrong columns makes input look under-reported.
    expect(page).toContain('计费输入')
    expect(page).toContain('未命中缓存')
  })

  it('🔴 says that a dash means unmeasured — and that it is not zero', () => {
    // `0` would claim the relay produced nothing, which is a much stronger and usually false claim.
    expect(pageSource()).toContain('表示没测到，不是 0')
  })

  it('🔴 shows at most 10 usage rows, with 查看更多 to reveal the rest (owner 2026-10-27)', () => {
    /*
     * Owner: 「倒序排列，只展示前10 支持查看更多」.
     *
     * The half of this that is easy to get WRONG is the footer: if 合计 summed only the visible
     * rows it would shrink as the range grew, and a partial sum is indistinguishable from a total.
     * So the assertions below cover both — the cap exists, and the total does NOT come from the
     * capped list.
     */
    const page = pageSource()
    // The limit is a named constant, not a magic number scattered through the render.
    expect(page).toContain('USAGE_ROW_LIMIT = 10')
    // Truncation applies to the RENDERED rows only...
    expect(page).toContain('allRows.slice(0, USAGE_ROW_LIMIT)')
    // ...while the footer keeps reading the server's total, summed over every row it computed.
    expect(page).toContain('stats.total.requests')
    expect(page).not.toContain('totalOf(visibleRows)')
    // Both directions of the control exist.
    expect(page).toContain('查看更多')
    expect(page).toContain('收起')
    // The hidden count is stated, so the click is informed rather than a guess.
    expect(page).toContain('hiddenRowCount')
    // And the limit is DISCLOSED in prose — an undisclosed cap reads as a complete table.
    expect(page).toContain('合计')
    expect(page).toMatch(/整个范围[^]*?全部/)
  })

  it('🔴 day rows are newest-first, and the order is a property of the grouping', () => {
    /*
     * 「倒序排列」. Asserted at the route, where the direction is chosen, so a future edit that
     * flips it back to the default `asc` fails here rather than silently reordering the table.
     *
     * 🔴 The anchor is `summarize(entries, …)`, NOT `group === 'day'` — that string also appears
     * in the label-resolution line further down, so slicing from the first hit produced an empty
     * window and the test reported a failure about ITSELF rather than about the code. (Same family
     * as the prose-vs-code trap in the rename test: a judgement must anchor on the thing it is
     * judging.)
     */
    const server = readFileSync(join(process.cwd(), 'src', 'http.ts'), 'utf-8')
    const dayCall = server.slice(server.indexOf('summarize(entries, (entry) => dayKey('))
    expect(dayCall.slice(0, 80)).toContain("'desc'")
    // Channel rows keep the ascending default — an identity key is scanned by name, not by time.
    const channelCall = server.slice(server.indexOf('summarize(entries, (entry) => entry.channel)'))
    expect(channelCall.slice(0, 60)).not.toContain("'desc'")
  })
})

describe('what stays forbidden', () => {
  it('no key value is ever rendered', () => {
    const page = pageSource()
    // The page may show "configured?", never the secret.
    expect(page).not.toMatch(/apiKey\s*[:=]\s*['"`]/)
    expect(page).not.toContain('apiKeyEnv}')
  })
})

describe('settings namespace identity', () => {
  /** The entry id the host keys the document by (declared in cordis.patch.yml). */
  function patchEntryId(): string {
    const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf-8')
    const id = patch.match(/^\s*-?\s*id:\s*(\S+)\s*$/m)?.[1]
    if (id === undefined) throw new Error('cordis.patch.yml declares no entry id')
    return id
  }

  it('the client watches the PROFILE ENTRY id, not the bare plugin name', () => {
    // The documented trap: `whileServed([ns])` never resolves when `ns` is not a settings
    // namespace the host serves, so the panel registers NOTHING — silently. The bundle is still
    // fetched and executed, so every "is it delivered?" check stays green while no UI appears.
    const source = clientSource()
    const declared = source.match(/SETTINGS_NS\s*=\s*'([^']+)'/)?.[1]
    expect(declared).toBe(patchEntryId())
  })

  it('the server half points the Models-page directory at the same namespace', () => {
    // A dead `settingsNs` makes the provider row unconfigurable — the model is selectable but
    // has nowhere to be set up.
    const server = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf-8')
    const ns = server.match(/settingsNs:\s*'([^']+)'/)?.[1]
    expect(ns).toBe(patchEntryId())
  })

  it('the entry id is stable (it keys the user\'s stored configuration)', () => {
    // Renaming it moves every saved channel; the patch file says so explicitly. Pin it.
    expect(patchEntryId()).toBe('dsh-any-deepseek')
  })
})
