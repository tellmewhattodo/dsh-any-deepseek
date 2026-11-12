/**
 * current-provider.test.ts — the sidebar line that names the live provider.
 *
 * Owner request 2026-11-03 (sent with a screenshot of the sidebar footer): 「在这里加个当前供应商，
 * 更方便，加一行」, then narrowed the same day: 「左下角空间小，字少点，表意明确即可」.
 *
 * 🔴 Why these cases exist rather than a visual check: the line has exactly two ways to be wrong,
 * and neither throws.
 *   1. **It says nothing while a provider IS selected** — the reader concludes they must open
 *      Settings, which is the behaviour the request was meant to remove. A blank render is
 *      indistinguishable from "the feature was never built".
 *   2. **It names a provider that is not the one serving requests** — worse than silence, because
 *      it is a confident wrong answer about where money is going.
 * Only cases that assert the returned string can tell those apart from a correct implementation.
 */

import { describe, expect, it } from 'vitest'

import { currentProviderLabel, type ChannelsResponse } from '../src/client/panel-api.js'

/** Minimal channel row — only the fields the label reads are meaningful. */
function channel(id: string, label: string): ChannelsResponse['channels'][number] {
  return {
    id,
    label,
    model: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    baseURL: 'https://example.invalid/v1',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text'],
    warnings: [],
    keyConfigured: true,
    keyKind: 'literal',
  }
}

function response(
  current: string | undefined,
  channels: ChannelsResponse['channels'],
  supply?: ChannelsResponse['supply'],
): ChannelsResponse {
  return {
    channels,
    presets: [],
    model: { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ...current === undefined ? {} : { current },
    ...supply === undefined ? {} : { supply },
  }
}

const CHANNELS = [channel('opencode-go', 'OpenCode Go-1'), channel('ollama', 'Ollama Cloud-1')]

describe('currentProviderLabel — names the channel that is actually serving', () => {
  it('returns the selected channel label', () => {
    // The real config on 2026-11-03 had `current: opencode-go`; the reader should see its label,
    // not the raw id, because the panel and every other surface use the label.
    expect(currentProviderLabel(response('opencode-go', CHANNELS))).toBe('OpenCode Go-1')
  })

  it('follows the selection rather than the first channel in the list', () => {
    // A "just show channels[0]" implementation passes the case above and fails this one. Order is
    // configuration order, not priority — nothing in the data says the first entry is live.
    expect(currentProviderLabel(response('ollama', CHANNELS))).toBe('Ollama Cloud-1')
  })

  it('🔴 returns undefined before the list loads — renders nothing, not an error', () => {
    // The badge mounts before the fetch resolves. Showing 「未找到」 here would flash a false
    // problem on every page load.
    expect(currentProviderLabel(undefined)).toBeUndefined()
  })

  it('🔴 returns undefined when nothing is selected — not an empty string', () => {
    // An empty string would render an empty flex row (a stray dot with no text). `undefined` is
    // what makes the caller skip the line entirely.
    expect(currentProviderLabel(response(undefined, CHANNELS))).toBeUndefined()
    expect(currentProviderLabel(response('', CHANNELS))).toBeUndefined()
  })

  it('🔴 a dangling selection says 未找到 rather than going silent', () => {
    // This is the one case where silence is wrong: `current` names a channel that no longer
    // exists, so the router falls back to something else while the user believes their choice
    // still applies. Only the user can fix it, and only if they are told.
    expect(currentProviderLabel(response('deleted-channel', CHANNELS))).toBe('未找到')
  })

  it('keeps the label short enough for a 256px footer row', () => {
    // Owner constraint: 「左下角空间小，字少点」. The function returns the channel's own label and
    // deliberately adds no 「当前供应商：」 prefix — this case pins that decision by asserting the
    // output equals the label verbatim, so a future edit that decorates it fails here.
    const label = currentProviderLabel(response('opencode-go', CHANNELS))
    expect(label).toBe('OpenCode Go-1')
    expect(label).not.toContain('当前')
    expect(label).not.toContain('：')
    expect(label?.length).toBeLessThanOrEqual(20)
  })
})

describe('currentProviderLabel — the supply group', () => {
  const groupSupply = (over: Partial<NonNullable<ChannelsResponse['supply']>>): NonNullable<ChannelsResponse['supply']> => ({
    members: ['opencode-go', 'ollama'],
    dangling: [],
    position: -1,
    exhausted: false,
    ...over,
  })

  it('🔴 names BOTH truths when the group is serving: a group is in charge, and this is who', () => {
    // Owner request 2026-11-12: 「给用户供应组是一种选择的感觉」. `供应组` alone would answer "which
    // supplier?" with "the group", which is true but useless while a request is being billed to a
    // specific relay — and the relay's name alone would hide that the group decides.
    const label = currentProviderLabel(
      response('__group__', CHANNELS, groupSupply({ serving: 'ollama', position: 1 })),
    )
    expect(label).toBe('供应组 · Ollama Cloud-1')
  })

  it('🔴 exhaustion is a SEPARATE state, checked before `serving`', () => {
    // The defect this pins, seen on a real screen in the first cut: the group had walked off the end
    // of the list, nothing was serving, and the panel still printed 「正在使用：C」 from a stale
    // reading. "Nobody can serve" and "here is who served" are different facts.
    const label = currentProviderLabel(
      response('__group__', CHANNELS, groupSupply({ serving: 'ollama', position: 1, exhausted: true })),
    )
    expect(label).toBe('供应组 · 全部不可用')
  })

  it('says just 供应组 before anything has served — not an alarm', () => {
    // A fresh install has no serving member and is NOT broken. Rendering 「全组均不可用」 on it would
    // be a false alarm that sends the user hunting for a problem that does not exist.
    expect(currentProviderLabel(response('__group__', CHANNELS, groupSupply({})))).toBe('供应组')
  })

  it('falls back to 供应组 when the serving id is not in the channel list', () => {
    // A transient read skew between the two fields of one response. Naming a channel that the same
    // response does not describe would be worse than naming the group alone — and 未找到 would blame
    // the group for a channel-level problem that does not exist.
    expect(currentProviderLabel(
      response('__group__', CHANNELS, groupSupply({ serving: 'ghost', position: 0 })),
    )).toBe('供应组')
  })
})
