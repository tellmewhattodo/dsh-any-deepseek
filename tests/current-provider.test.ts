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

function response(current: string | undefined, channels: ChannelsResponse['channels']): ChannelsResponse {
  return {
    channels,
    presets: [],
    model: { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ...current === undefined ? {} : { current },
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
