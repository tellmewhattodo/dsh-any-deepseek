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
    expect(page).toContain("setField(['channels', id], {")
    expect(page).toContain('apiKey: newSecret.trim()')
    // No invented reference name may reappear: that was the design the owner rejected.
    expect(page).not.toContain('suggestKeyRef')
    expect(page).not.toContain('apiKeyEnv:')
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
    expect(page).toContain('<span>密钥</span>')
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
