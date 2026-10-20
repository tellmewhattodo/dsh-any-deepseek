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
  it('creates a channel with a preset and a credential REFERENCE only', () => {
    const page = pageSource()
    // Pre-filling endpoint fields would freeze today's preset values into the user's document,
    // so later preset fixes would never reach them.
    expect(page).toContain("setField(['channels', id], {")
    expect(page).toContain('apiKeyEnv: newKeyRef.trim()')
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
  // A preset fully determines the endpoint and conventionally determines the credential reference
  // name. Asking the user to retype them is the friction the owner reported; deriving them is the
  // fix, and the derivation is pure so it can be pinned here.
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
    expect(suggestKeyRef('')).toBe('')
  })

  it('derives an UPPER_SNAKE reference name from the preset id', () => {
    expect(suggestKeyRef('open-design')).toBe('OPEN_DESIGN_API_KEY')
    expect(suggestKeyRef('opencode-go')).toBe('OPENCODE_GO_API_KEY')
    expect(suggestKeyRef('deepseek-official')).toBe('DEEPSEEK_OFFICIAL_API_KEY')
  })

  it('🔴 each derived field compares against its OWN last suggestion', () => {
    // Regression guard for a typo that no pure-function test could catch: the id branch read
    // `previous === '' || previous === ''` — the same test twice — so once a preset had filled
    // the id, switching to another preset never replaced it. Measured in the real browser:
    // Open Design → Ollama left the id at "open-design" while the select showed Ollama.
    // A structural check is the honest guard here: the component's decision has to name both
    // refs, and neither comparison may be duplicated.
    const page = pageSource()
    expect(page).toContain('previous === lastSuggestedId.current')
    expect(page).toContain('previous === lastSuggestedKeyRef.current')
    // Check only EXECUTABLE lines: the explanatory comment above quotes the broken form, and a
    // substring test over the whole file cannot tell a comment from code (same lesson as the
    // "设为当前" assertion earlier in this file).
    const code = page
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    expect(code).not.toMatch(/previous === '' \|\| previous === ''/)
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
