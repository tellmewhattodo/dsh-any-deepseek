/**
 * client/SettingsPage.tsx — the panel.
 *
 * ## One page, two tabs
 *
 * The panel answers exactly two questions, and they are asked at different times:
 *
 *  1. **渠道** — which relay is live, and is its key usable? (asked when configuring)
 *  2. **用量** — what has each relay actually cost in tokens? (asked when reviewing)
 *
 * They used to be stacked on one scroll, so reading the cost table meant scrolling past every
 * channel row. They are now two tabs: each answer gets the full panel height, and the reader
 * never scrolls to reach the second question.
 *
 * ## What the text is doing
 *
 * Every sentence on this page states a fact the reader can verify on the page itself — which
 * provider this belongs to, which model is exposed, what selecting a channel does, where the key
 * is stored, what a liveness check does and does not prove. That is deliberate: the panel is the
 * only place most users will ever read about this plugin, so a sentence that merely sounds
 * reassuring is worse than no sentence.
 *
 * The page never displays a key. It displays whether a key is configured, which is the fact the
 * harness credential surface is willing to expose.
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BalanceResponse, BalanceRow, ChannelRow, ProbeResult, StatsResponse, SupplyState } from './panel-api.js'
import type { SettingsWire } from './index.js'
import {
  formatBalance,
  formatDuration,
  formatMeanContext,
  formatSpeed,
  formatTokens,
  SUPPLY_GROUP_ID,
} from './panel-api.js'
import './SettingsPage.css'

/** What the plugin's `apply` hands this component. */
export interface SettingsPageInjected {
  hooks: { settings: ConfigForm<SettingsWire> }
  loadChannels: () => Promise<{
    channels: ChannelRow[]
    presets: Array<{ id: string; displayName: string }>
    model: { id: string; name: string }
    /** The supply group's live state; absent on a build that predates the feature. */
    supply?: SupplyState
  }>
  loadStats: (group: 'channel' | 'day', from?: string, to?: string) => Promise<StatsResponse>
  probe: (id: string) => Promise<ProbeResult>
  /**
   * Read every channel's remaining balance.
   *
   * Separate from {@link loadChannels} because it hits the PROVIDERS' account surfaces, which can
   * be slow or absent; keeping it out of the channel load means a dead billing endpoint cannot
   * delay the list the user actually came to edit.
   */
  loadBalances: () => Promise<BalanceResponse>
  /**
   * Write one value at a real path.
   *
   * Path SEGMENTS, not a dotted string: the harness's `ConfigForm.set` builds `path: [field]`,
   * i.e. one segment, so `'channels.go.enabled'` would create a key with dots in its name rather
   * than toggling the switch. Only `mutate` carries a genuine multi-segment path.
   *
   * Resolves `true` on host acceptance. A refusal is NOT swallowed — see {@link write}.
   */
  setField: (path: readonly string[], value: JsonValue) => Promise<boolean>
  /** Clear one value at a real path (re-inherits the composition layer). */
  removeField: (path: readonly string[]) => Promise<boolean>
}

/** The JSON value shapes a settings write accepts. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Where this plugin's source lives.
 *
 * Shown in the panel footer because the panel is where a user decides whether to keep, fork or
 * improve this thing — and the answer to "can I change it?" should not require a search. Kept as
 * a constant so the footer text and any future link cannot disagree.
 */
export const REPO_URL = 'https://github.com/tellmewhattodo/dsh-any-deepseek'

/** Which tab is showing. */
type PanelTab = 'channels' | 'usage'

/**
 * How many usage rows are shown before 「查看更多」 (owner request 2026-10-27: 「只展示前10」).
 *
 * 🔴 This is a DISPLAY limit, not a data limit: `/stats` still returns every row it computed, and
 * the 合计 footer is summed server-side over ALL of them. Both halves matter:
 *  · showing 10 rows while summing all of them is the honest reading — "these are the 10 newest
 *    days; this is the total across the whole range";
 *  · summing only the visible 10 would silently shrink 合计 as the range grew, which turns a
 *    total into a partial sum that looks exactly like a total.
 *
 * The number is 10 because the default range is 7 days, so the table normally shows everything
 * and the limit only engages when the reader widens the range — which is exactly when a cap
 * helps.
 */
const USAGE_ROW_LIMIT = 10

/**
 * A channel id derived from a preset id, made unique against what already exists.
 *
 * The id is a configuration key, so it must match `^[a-z0-9][a-z0-9_-]*$`. Preset ids already do,
 * so the only work is de-duplication: adding two Open Design relays is legitimate, and the second
 * must not silently overwrite the first.
 * @param presetId - the chosen preset.
 * @param existing - rows already configured.
 * @returns a free id like `open-design`, `open-design-2`, …
 */
export function suggestId(presetId: string, existing: ReadonlyArray<{ id: string }>): string {
  if (presetId === '') return ''
  const taken = new Set(existing.map((row) => row.id))
  if (!taken.has(presetId)) return presetId
  for (let n = 2; n < 1000; n++) {
    const candidate = `${presetId}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${presetId}-${Date.now()}`
}

type SettingsPageProps = PropsRuntime<'settings.section'> & InjectFace<SettingsPageInjected>

/** A status dot: filled when confirmed configured, hollow when confirmed absent, half otherwise. */
function KeyDot(props: { configured: boolean; known: boolean }): React.JSX.Element {
  const state = props.known ? (props.configured ? 'on' : 'off') : 'unknown'
  const title = props.known
    ? (props.configured ? '已配置密钥' : '未配置密钥')
    : '密钥状态未确认'
  return <span className={`ad-dot ad-dot-${state}`} title={title} aria-label={title} />
}

export function SettingsPage(props: SettingsPageProps): React.JSX.Element {
  // The inject face is SPREAD onto the component props, not nested under `props.inject`
  // (`ui-renderer/lib/client.js` renderEntry: `...kit, ...injected, ...ownerProps`).
  // The reserved `hooks` compartment never reaches us either: the renderer strips it and
  // re-emits each member as a bound `use<Name>` selector hook (`bindInjectSources`).
  // So `hooks: { settings: form }` arrives here as `useSettings`.
  const { useSettings, loadChannels, loadStats, probe, loadBalances, setField, removeField } = props
  const settings = useSettings((snapshot) => snapshot)

  const [rows, setRows] = useState<ChannelRow[]>([])
  const [presets, setPresets] = useState<Array<{ id: string; displayName: string }>>([])
  const [model, setModel] = useState<{ id: string; name: string }>({ id: '', name: '' })
  const [stats, setStats] = useState<StatsResponse | null>(null)
  /**
   * Per-channel balance, keyed by channel id.
   *
   * Loaded separately from the channel list (see `loadBalances`): the balances hit each provider's
   * own account surface, so one slow or dead endpoint must not hold up the table the user came to
   * edit. An empty map simply means "not loaded yet", and the cell renders as such.
   */
  const [balances, setBalances] = useState<Record<string, BalanceRow>>({})
  const [balancesLoading, setBalancesLoading] = useState(false)
  const [group, setGroup] = useState<'channel' | 'day'>('channel')
  /**
   * Whether the usage table shows every row or only the newest {@link USAGE_ROW_LIMIT}.
   *
   * Collapsed by default so opening 用量 answers "how much lately" at a glance instead of
   * starting with a long scroll. Reset whenever the grouping changes: "expanded" was a decision
   * about one specific table, and carrying it into a different grouping would silently show a
   * different amount of data than the reader last chose.
   */
  const [showAllRows, setShowAllRows] = useState(false)
  /**
   * Which of the panel's two questions is on screen.
   *
   * 渠道 is the default because it is the one a new user must answer first — an empty panel
   * showing a usage table with no rows answers nothing.
   */
  const [tab, setTab] = useState<PanelTab>('channels')
  const [probing, setProbing] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<Record<string, ProbeResult>>({})
  const [error, setError] = useState<string | null>(null)
  /**
   * The supply group's live state from `/channels` (members, who served last, last switch).
   *
   * 🔴 Kept SEPARATE from `rows` and from the settings document on purpose. `rows` is "what
   * channels exist"; `supplyGroup.members` in the settings document is "what the user configured";
   * this is "what the router is actually doing". The panel needs all three to explain a fallback
   * ("member 1 ran out of quota, so requests now go to member 2") — merge any two and the third
   * question becomes unanswerable.
   *
   * ⚠️ There is no cursor and therefore no reset: every request starts at member 1 (owner rule
   * 2026-11-12), so a position is derived from the priority list and never remembered.
   */
  const [supply, setSupply] = useState<SupplyState | undefined>(undefined)
  /** Which channel id the group editor is offering to append (empty = picker closed). */
  const [addingMember, setAddingMember] = useState('')

  /** The "add a channel" form. Collapsed until asked for — an empty panel is not a form. */
  const [adding, setAdding] = useState(false)
  const [newId, setNewId] = useState('')
  const [newPreset, setNewPreset] = useState('')
  /**
   * The key the user typed in the add form.
   *
   * One field, one meaning: the value goes into the channel entry as `apiKey`. There is no
   * separate "reference name" any more — that pairing (a name the user had to invent, plus a
   * second store to hold the value) was the design the owner rejected.
   */
  const [newSecret, setNewSecret] = useState('')
  /**
   * The channel's display name, as typed.
   *
   * Empty means "use the preset's name". It is a real field (`label`) that the runtime has always
   * honoured — the panel simply never exposed it, which made "two accounts on the same relay"
   * impossible to tell apart.
   */
  const [newLabel, setNewLabel] = useState('')

  /** Which channel currently has its inline key field open (null = none). */
  const [keying, setKeying] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  /**
   * 🔴 There is no rename state any more (owner 2026-11-06). The per-row 改名 button was removed
   * together with its inline field; renaming now happens through the add form's 显示名 field. The
   * `channels.<id>.label` setting it wrote is unchanged, so bringing the button back needs nothing
   * from this file beyond the button itself.
   */
  /** The channel id and the label the form last derived from a preset (see the select). */
  const lastSuggestedId = useRef('')
  const lastSuggestedLabel = useRef('')

  const refresh = useCallback(async (): Promise<void> => {
    const [loaded, statsNow] = await Promise.all([loadChannels(), loadStats(group)])
    setRows(loaded.channels)
    setPresets(loaded.presets)
    setModel(loaded.model)
    setSupply(loaded.supply)
    setStats(statsNow)
  }, [loadChannels, loadStats, group])

  /**
   * Load balances on demand, never on render.
   *
   * Each call reaches out to every provider's account surface, so it is a button rather than
   * something that fires on mount: opening the panel to rename a channel should not spend a
   * round-trip per relay, and one unreachable billing endpoint would otherwise hold the table.
   */
  const refreshBalances = useCallback(async (): Promise<void> => {
    setBalancesLoading(true)
    try {
      const loaded = await loadBalances()
      const byId: Record<string, BalanceRow> = {}
      for (const row of loaded.channels) byId[row.id] = row
      setBalances(byId)
    } finally {
      setBalancesLoading(false)
    }
  }, [loadBalances])

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [refresh])

  const current = settings.value?.current ?? ''
  /** Whether the supply group is the selected supplier — ONE fact, read from ONE field. */
  const groupSelected = current === SUPPLY_GROUP_ID
  /** The configured member list, as this panel last read it from the settings document. */
  const members: string[] = ((): string[] => {
    const wire = settings.value as { supplyGroup?: { members?: unknown } } | undefined
    const raw = wire?.supplyGroup?.members
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  })()

  const select = (id: string): void => {
    write(() => setField(['current'], id))
  }

  /**
   * Write the whole member list.
   *
   * One write per edit, and the list is replaced WHOLE rather than patched index by index:
   * `members` is an ordered array, so a per-index write could interleave with a concurrent read
   * (the same revision-conflict shape that produced decision 85) and leave the order scrambled.
   * @param next - the complete new order.
   */
  const writeMembers = (next: readonly string[]): void => {
    write(() => setField(['supplyGroup', 'members'], [...next]), '保存供应组失败')
  }

  /** Move one member one position earlier or later. */
  const moveMember = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= members.length) return
    const next = [...members]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item!)
    writeMembers(next)
  }

  /**
   * Switch the supplier: the group, or one channel.
   *
   * 🔴 Both arms write the SAME field (`current`) — that is the whole point of the sentinel design.
   * Writing the group means "the group serves", and every channel row stops being the selection in
   * exactly the way it already does when a different channel is picked.
   */
  const selectGroup = (): void => {
    write(() => setField(['current'], SUPPLY_GROUP_ID), '启用供应组失败')
  }

  /** Put the supplier back to a single channel, leaving the member list intact for next time. */
  const selectSingle = (id: string): void => {
    select(id)
  }

  /**
   * Run one settings write and surface a refusal.
   *
   * A write can be refused for reasons the user can act on (read-only deployment, the settings
   * service not composed, a revision conflict, a field the host considers non-volatile) and for
   * reasons they cannot (transport). Both are facts, and silently discarding them is what makes
   * a panel look alive while nothing is saved.
   *
   * 🔴 **A successful write RE-READS, right here.** The rows the panel renders come from
   * `/any-deepseek/channels`, which is computed from the configuration — not a live push. So a
   * write that does not re-read leaves the panel showing the document as it was BEFORE the write,
   * and the only way to see the result was to close and reopen the panel. Reported by the owner
   * as "adding or removing a channel does not show up until I reopen".
   *
   * Doing it centrally matters: the previous code had `refresh()` at one call site and not at the
   * others, so correctness depended on remembering. A new write path now inherits it.
   *
   * 🔴 **The refusal message must NOT name causes we have not checked.** This used to read
   * "只读部署，或设置服务未启用" — and the one time it actually fired, the real cause was
   * neither: `current` was missing `.volatile()` in the schema, three layers away. Naming two
   * unchecked causes sent the investigation in the wrong direction. A refusal is a refusal:
   * say that, and let the host's own error speak for itself.
   * @param run - the write.
   * @param context - what the user was trying to do.
   */
  const write = (run: () => Promise<boolean>, context = '保存失败'): void => {
    void run().then(
      (accepted) => {
        if (!accepted) {
          setError(`${context}：宿主拒绝了这个修改`)
          return
        }
        setError(null)
        // Read back what the host now stores. Failure here is reported but does not undo the
        // write: the change landed, and saying otherwise would be a second lie.
        void refresh().catch((cause: unknown) => {
          setError(`已写入，但重新读取失败：${cause instanceof Error ? cause.message : String(cause)}`)
        })
      },
      (cause: unknown) => {
        setError(`${context}：${cause instanceof Error ? cause.message : String(cause)}`)
      },
    )
  }

  const runProbe = async (id: string): Promise<void> => {
    setProbing(id)
    try {
      const result = await probe(id)
      setVerdict((previous) => ({ ...previous, [id]: result }))
    } finally {
      setProbing(null)
    }
  }

  /** Whether the add-form's id is usable as a channel key. */
  const newIdProblem = ((): string | null => {
    const id = newId.trim()
    if (id === '') return null
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return '只能用小写字母、数字、- 和 _，且不能以符号开头'
    // Read the ids from the same list the panel renders, so "already exists" can never disagree
    // with what is on screen.
    if (rows.some((row) => row.id === id)) return '这个 id 已经有了'
    return null
  })()

  /**
   * Create one channel from the form.
   *
   * ONE write, one store. The key goes into the channel entry as `apiKey`, beside the preset id —
   * there is no second store to keep in step, so there is no ordering to get wrong and no way for
   * "channel exists but its key does not" to be a reachable state. Pre-filling endpoint fields is
   * still avoided: a preset-backed channel records the preset, so later preset fixes reach it.
   *
   * `label` is only written when the user changed it. Leaving it out lets the preset's display
   * name apply and keep tracking preset changes; writing the same string back would freeze
   * today's name into the document.
   */
  const addChannel = (): void => {
    const id = newId.trim()
    if (newPreset === '' || id === '' || newIdProblem !== null || newSecret.trim() === '') return
    const label = newLabel.trim()
    const entry: Record<string, JsonValue> = { preset: newPreset, apiKey: newSecret.trim() }
    if (label !== '') entry.label = label

    write(() => setField(['channels', id], entry), '添加渠道失败')
    // The first channel added to an empty document becomes current: leaving `current` empty
    // means every request fails with NO_CHANNEL_SELECTED, which reads as a broken plugin.
    if (current === '') write(() => setField(['current'], id), '设为当前渠道失败')
    // The plaintext leaves component state as soon as the host has it: keeping it around would
    // leave the key sitting in memory (and in React DevTools) for no benefit.
    setNewSecret('')
    setNewId('')
    setNewLabel('')
    setNewPreset('')
    lastSuggestedId.current = ''
    lastSuggestedLabel.current = ''
    setAdding(false)
  }

  /**
   * Remove one channel.
   *
   * The row disappears because `write()` re-reads on success; there is nothing to remember here.
   */
  const removeChannel = (id: string): void => {
    write(() => removeField(['channels', id]), '移除渠道失败')
    if (current === id) write(() => removeField(['current']), '清除当前选择失败')
  }

  /**
   * Store one channel's key from the inline field.
   *
   * The "I have the key / mine changed" path. It is a plain settings write to
   * `channels.<id>.apiKey`, which means it inherits everything the rest of the panel already
   * relies on: a real path (not a dotted string), a visible refusal, and the host's own
   * validation. Nothing is consulted, resolved or named.
   *
   * A legacy entry whose key lives in `apiKeyEnv` is handled by the runtime, not here: that field
   * is read as a literal key when it cannot be a reference name, so the user's first typed key
   * simply supersedes it.
   * @param row - the channel whose key is being set.
   */
  const saveKey = async (row: ChannelRow): Promise<void> => {
    setKeySaving(true)
    try {
      const accepted = await setField(['channels', row.id, 'apiKey'], keyDraft.trim())
      if (!accepted) {
        setError('保存密钥失败：宿主拒绝了这个修改')
        return
      }
      setError(null)
      setKeyDraft('')
      setKeying(null)
      // Re-read so the dot and the "configured" line reflect what is stored, not our hope.
      await refresh()
    } catch (cause: unknown) {
      setError(`保存密钥失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setKeySaving(false)
    }
  }

  /**
   * The usage rows actually rendered.
   *
   * Truncation happens HERE, in the component, and not in `/stats` — the server keeps returning
   * the full set so that (a) 合计 can be summed over everything, and (b) 「查看更多」 is instant
   * rather than a second round-trip that might answer with a different range.
   */
  const allRows = stats?.rows ?? []
  const visibleRows = showAllRows ? allRows : allRows.slice(0, USAGE_ROW_LIMIT)
  /** Rows held back by the display limit; `0` means the table is complete. */
  const hiddenRowCount = allRows.length - visibleRows.length

  return (
    <div className="ad-page">
      <header className="ad-head">
        <h2 className="ad-title">Any DeepSeek</h2>
        <p className="ad-intro">
          本页设置的是 <strong>any-deepseek 这一个 provider</strong>，与 DSH 其它设置无关。
          它对外只提供一个模型：<span className="ad-mono">{model.name || 'DeepSeek V4.1 Flash'}</span>。
          下面选中哪个渠道，请求就发到哪个——<strong>不会自动切换</strong>。
        </p>
      </header>

      {error !== null && (
        <div className="ad-error" role="alert">操作未完成：{error}</div>
      )}

      {/*
        Two tabs, because the panel answers two questions asked at different times: "which relay
        serves me, and does its key work" (setup) and "what has each relay cost" (review).
        Stacked on one scroll, reading the cost table meant scrolling past every channel row.
      */}
      <div className="ad-tabs" role="tablist" aria-label="面板分页">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'channels'}
          className={`ad-tab${tab === 'channels' ? ' ad-tab-on' : ''}`}
          onClick={() => setTab('channels')}
        >
          渠道
          {rows.length > 0 && <span className="ad-tabCount">{rows.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'usage'}
          className={`ad-tab${tab === 'usage' ? ' ad-tab-on' : ''}`}
          onClick={() => setTab('usage')}
        >
          用量
        </button>
      </div>

      {tab === 'channels' && (
      <section className="ad-section" role="tabpanel" aria-label="渠道">
        <div className="ad-sectionBar">
          <h3 className="ad-sectionTitle">渠道</h3>
          {/*
            On demand, because it calls out to every provider's account surface. The label says
            余额 rather than 刷新 so it is clear this may spend a round-trip per relay.

            🔴 It may also spend TOKENS: a channel with no balance API is checked with one minimal
            live request instead (owner directive 2026-10-23). The title says so, because a button
            that quietly costs money is worse than one that cannot be clicked.
          */}
          <button
            type="button"
            className="ad-link"
            disabled={balancesLoading || rows.length === 0}
            title="无余额接口的渠道会用一次最小真实请求测通（消耗一两个 token）"
            onClick={() => { void refreshBalances() }}
          >
            {balancesLoading ? '查询余额中…' : '查询余额'}
          </button>
        </div>
        {rows.length === 0 && (
          <p className="ad-empty">
            还没有渠道。点下面的「添加渠道」，选一个规格、粘一个 key 就能用。
          </p>
        )}
        <ul className="ad-rows" role="radiogroup" aria-label="选择当前供应商">
          {/*
            🔴 THE SUPPLY GROUP IS A MEMBER OF THIS RADIO GROUP — the first one.

            Owner requirement 2026-11-12: 「当开启供应组的时候，相当于选中了供应组作为当前使用，则下方就没有
            选中模型了…给用户供应组是一种选择的感觉」.

            Why it lives here rather than in its own separate card above: "the group" and "channel X"
            are ALTERNATIVES for the same slot. Rendering them in two different visual languages —
            a switch above, radios below — would make them look like two independent settings, and
            the reader would then have to work out which one wins. Inside this list, the browser's
            own radio semantics enforce "exactly one" for free, and selecting the group visibly
            UNSELECTS every channel below it, which is the feeling the owner asked for.

            The row is taller than a channel row because it is a container as well as a choice: its
            members, their order, and the live cursor belong where the decision is made.
          */}
          <li
            className={`ad-row ad-groupRow${groupSelected ? ' ad-row-current' : ''}`}
            aria-current={groupSelected ? 'true' : undefined}
            data-current={groupSelected ? 'true' : 'false'}
          >
            <label className="ad-rowPick">
              <input
                type="radio"
                name="ad-current-channel"
                checked={groupSelected}
                onChange={() => selectGroup()}
              />
              <span className="ad-rowMain">
                <span className="ad-rowTitleLine">
                  <span className="ad-rowTitle">供应组</span>
                  {groupSelected && <span className="ad-badge">当前</span>}
                  <span className="ad-groupCount">{members.length > 0 ? `${members.length} 个渠道` : '未配置'}</span>
                </span>
                {/*
                  The one-line explanation, always present. A user who has never used the group
                  needs to know what selecting it DOES before selecting it.

                  🔴 2026-11-12 revision: the sentence now states the PRIORITY rule, not just
                  "switches automatically". The previous wording described a rotation, which is what
                  the sticky cursor actually did — the panel was describing the old algorithm.
                */}
                <span className="ad-rowDetail">
                  按下面的顺序使用：每次请求都从第 1 位开始试，遇到余额不足或密钥失效才换下一位
                </span>
                {/*
                  🔴 The live reading, shown only when the group is actually serving.

                  This is the answer to "which relay is my request going to right now?" — and it is
                  only knowable from the ROUTER (who served last is host memory, never in the
                  settings document), which is why `supply` comes from `/channels` and not from the
                  config.

                  ⚠️ `position + 1` because `position` is zero-based and `-1` when nobody serves.
                  The `serving !== undefined` guard below is what keeps `-1` from rendering as
                  「第 0 位」 — the two conditions are one fact, so they are checked together.
                */}
                {groupSelected && supply?.exhausted === true && (
                  <span className="ad-rowDetail ad-groupLive ad-groupLiveBad">
                    全组均不可用（最后一个试的是
                    {supply.lastTried === undefined
                      ? '—'
                      : (rows.find((row) => row.id === supply.lastTried)?.label ?? supply.lastTried)}
                    ）
                  </span>
                )}
                {groupSelected && supply?.exhausted !== true && supply?.serving !== undefined && supply.position >= 0 && (
                  <span className="ad-rowDetail ad-groupLive">
                    正在使用：
                    <strong>{rows.find((row) => row.id === supply.serving)?.label ?? supply.serving}</strong>
                    （第 {supply.position + 1} 位）
                  </span>
                )}
                {groupSelected && supply?.lastSwitch !== undefined && (
                  <span className="ad-rowDetail ad-groupSwitch">
                    最近切换：
                    {rows.find((row) => row.id === supply.lastSwitch!.from)?.label ?? supply.lastSwitch!.from}
                    {' → '}
                    {rows.find((row) => row.id === supply.lastSwitch!.to)?.label ?? supply.lastSwitch!.to}
                    （{supply.lastSwitch!.code}）
                  </span>
                )}
                {/*
                  Dangling members are LISTED, not silently dropped. The router skips them to stay
                  online, but a member naming a channel that no longer exists is a configuration
                  the user must fix — and a group that quietly shrinks is how "three relays" becomes
                  "one relay" without anyone noticing (decision 26/31 in spirit).
                */}
                {supply !== undefined && supply.dangling.length > 0 && (
                  <span className="ad-rowDetail ad-groupDangling">
                    找不到这些渠道：{supply.dangling.join('、')}（已跳过）
                  </span>
                )}
              </span>
            </label>
            {/*
              The member editor.

              ⛔ Rendered OUTSIDE the `<label>` (see the `ad-rowPick` note above): a button inside a
              radio's label has its clicks forwarded to the radio, so "move up" would also select the
              group. The tests pin this structurally.
            */}
            <div className="ad-groupEditor">
              {members.length === 0 && (
                <p className="ad-empty">还没放渠道进来。选一个渠道加进来，就会按下面的顺序依次使用。</p>
              )}
              {members.length > 0 && (
                <ol className="ad-groupMembers">
                  {members.map((id, index) => {
                    const row = rows.find((candidate) => candidate.id === id)
                    const live = groupSelected && supply?.serving === id
                    return (
                      <li key={id} className={`ad-groupMember${live ? ' ad-groupMemberLive' : ''}`}>
                        <span className="ad-groupRank">{index + 1}</span>
                        <span className="ad-groupName">{row?.label ?? `${id}（找不到）`}</span>
                        {/*
                          The ↑/↓ buttons are disabled at the ends rather than hidden: a control
                          that disappears makes the list reflow under the pointer, so the next click
                          lands on a different row.
                        */}
                        <button
                          type="button"
                          className="ad-btn ad-btn-quiet"
                          disabled={index === 0}
                          title="往上移（更优先）"
                          onClick={() => moveMember(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="ad-btn ad-btn-quiet"
                          disabled={index === members.length - 1}
                          title="往下移（更靠后）"
                          onClick={() => moveMember(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="ad-btn ad-btn-danger"
                          title="移出供应组（不删除渠道本身）"
                          onClick={() => writeMembers(members.filter((candidate) => candidate !== id))}
                        >
                          移出
                        </button>
                      </li>
                    )
                  })}
                </ol>
              )}
              {/*
                Adding a member: a picker of channels that are NOT already in the group, plus a
                disabled hint when there are none. Showing only addable channels keeps "already in
                the group" from being an error the user discovers by trying.
              */}
              {(() => {
                const addable = rows.filter((row) => !members.includes(row.id))
                if (addable.length === 0) {
                  return <p className="ad-hint">所有渠道都已在供应组里。</p>
                }
                return (
                  <div className="ad-groupAdd">
                    <select
                      className="ad-input"
                      value={addingMember}
                      onChange={(event) => setAddingMember(event.target.value)}
                    >
                      <option value="">选一个渠道加进来…</option>
                      {addable.map((row) => (
                        <option key={row.id} value={row.id}>{row.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ad-btn"
                      disabled={addingMember === ''}
                      onClick={() => {
                        writeMembers([...members, addingMember])
                        setAddingMember('')
                      }}
                    >
                      加进来
                    </button>
                  </div>
                )
              })()}
              {/*
                ⛔ NO reset button any more (owner rule 2026-11-12). It existed for one reason: the
                sticky cursor lived in host memory, so after a member ran out the group stayed parked
                on the later one and topping up the first relay did not bring traffic back on its
                own. Every request now starts at member 1, so topping up IS the reset — there is no
                hidden state to clear, and a button that clears nothing is a mystery control.
              */}
            </div>
          </li>
          {rows.map((row) => {
            const isCurrent = current === row.id
            const probeResult = verdict[row.id]
            return (
              <li
                key={row.id}
                className={`ad-row${isCurrent ? ' ad-row-current' : ''}`}
                /*
                 * The current channel is marked three ways on purpose: a colour bar down the
                 * left edge, a stronger border, and a tinted background. The owner's complaint
                 * was that a small badge was not enough to tell at a glance which relay is live,
                 * and a glance is exactly how this list is read.
                 *
                 * `aria-current` carries the same fact to assistive tech — the visual weight is
                 * for people who scan, and this is for people who do not.
                 */
                aria-current={isCurrent ? 'true' : undefined}
                data-current={isCurrent ? 'true' : 'false'}
              >
                {/*
                  The channel list is a RADIO GROUP, not a row of action buttons.

                  "Which relay serves requests" is single-choice — exactly one channel is live, and
                  there is no second on/off axis (see `channels.ts`: `enabled` is retired). A radio
                  says that in the affordance itself; a "设为当前" button made the same fact look
                  like an action, and a separate toggle let the two disagree.
                */}
                <label className="ad-rowPick">
                  <input
                    type="radio"
                    name="ad-current-channel"
                    checked={isCurrent}
                    onChange={() => select(row.id)}
                  />
                  <span className="ad-rowMain">
                    <span className="ad-rowTitleLine">
                      <KeyDot configured={row.keyConfigured} known={row.keySource !== undefined || row.keyConfigured} />
                      <span className="ad-rowTitle">{row.label}</span>
                      {isCurrent && <span className="ad-badge">当前</span>}
                      {row.warnings.length > 0 && (
                        <span className="ad-warn" title={row.warnings.join('\n')}>⚠</span>
                      )}
                      {/*
                        🔴 改名 used to sit here, then moved to `.ad-rowActions`, then was REMOVED
                        (2026-10-25 placement complaint → 2026-11-06 「删掉改名这个功能吧」).
                        The title line now carries only what identifies the channel and what is
                        true about it right now — nothing that acts on it. See the note on
                        `.ad-rowActions` for why this one went and the other three stayed.
                      */}
                    </span>
                    {/*
                      🔴 The detail line is GONE (owner request 2026-10-25: 「这部分不要了」,
                      pointing at the whole 模型·协议·地址 + 密钥态 row).

                      What it carried was: model id · api · baseURL · key state · probe verdict ·
                      balance. Removing it as-is would have removed the ONLY way to change a key,
                      so that one control moved into the action group on the right (更换密钥) and
                      the probe verdict / balance moved beside the name — both are live state about
                      THIS channel, which is what the title line is for.

                      What is genuinely gone: model / api / baseURL. Justification, not laziness —
                      all six presets serve the same model through the same provider, so the id is
                      constant text on every row, and api+baseURL are fixed by the preset the user
                      picked from a dropdown. They are still one fetch away at `/any-deepseek/channels`
                      for anyone debugging, but they earned no permanent line in a list whose job is
                      "which relay is live".

                      🔴 The probe verdict and the balance are NOT cosmetic and did not get deleted:
                      they are the answer to "is this channel actually working", which is the second
                      question this list answers.
                    */}
                    {(probeResult !== undefined || balances[row.id] !== undefined) && (
                      <span className="ad-rowDetail">
                        {probeResult !== undefined && (
                          <span className={`ad-probe ad-probe-${probeResult.ok ? 'ok' : 'bad'}`}>
                            {probeResult.ok
                              ? `通（${probeResult.ms}ms）`
                              : `不通：${probeResult.code ?? 'ERROR'}${probeResult.message === undefined ? '' : ` — ${probeResult.message}`}`}
                          </span>
                        )}
                        {/*
                          Remaining balance, when this endpoint exposes one.

                          🔴 Four different silences, kept distinct: `undefined` = not fetched yet
                          (nothing shown), `unsupported` = no balance API and no liveness check ran,
                          `alive` = no balance API but a minimal live request SUCCEEDED ⇒ the account
                          still has credit (no amount is claimed), `unavailable` = it was tried and did
                          not answer. None of them is rendered as a number, because "0.00" would read
                          as "you are out of credit".

                          Fetched on demand via the 查询余额 button — not on mount — so opening the panel
                          to rename something does not fan out a request to every relay.
                        */}
                        {balances[row.id] !== undefined && (
                          <span className="ad-balance">{formatBalance(balances[row.id] as BalanceRow)}</span>
                        )}
                      </span>
                    )}
                    {keying === row.id && (
                      <span className="ad-keyForm">
                        <input
                          className="ad-input"
                          type="password"
                          autoComplete="off"
                          value={keyDraft}
                          placeholder="粘贴 key 本体"
                          onChange={(event) => setKeyDraft(event.target.value)}
                        />
                        <button
                          type="button"
                          className="ad-btn"
                          disabled={keyDraft.trim() === '' || keySaving}
                          onClick={() => { void saveKey(row) }}
                        >
                          {keySaving ? '保存中…' : '保存密钥'}
                        </button>
                      </span>
                    )}
                  </span>
                </label>
                {/*
                  Every control that ACTS ON this channel, in one place (owner 2026-10-25:
                  「改名这个按钮实现的很突兀」).

                  🔴 Why this fixes that complaint rather than just moving pixels: the offending
                  button sat inside the text column with `margin-left: auto`, so it was pushed to
                  that column's far right — floating in mid-row, belonging neither to the name it
                  edits nor to the buttons it resembles. Grouping all channel actions here makes
                  the row read as "what it is (left) | what you can do to it (right)".

                  Order is by how often a real setup reaches for it:
                    更换密钥 — key rotated, or a channel that never had one
                    测试    — costs a real request, so it is not first
                    移除    — destructive, so it is last

                  🔴 改名 is NOT here any more (owner 2026-11-06: 「删掉改名这个功能吧，能让移动端
                  看起来正常点」). Read the two halves separately:

                  · **Why it went**: on a phone the panel was unusable, and this group was the
                    cause (see the CSS note). The 改名 button was the one member of this group
                    whose job was already available elsewhere — the add form's 显示名 field —
                    so it was the one to give up. 更换密钥 and 移除 have NO other entry point
                    (removing them would make a key unchangeable and a channel undeletable), and
                    测试 is the only way to answer "is this relay working".
                  · **What is lost, said plainly**: discovering that a channel can be renamed now
                    depends on reading the add form's help text (which says so explicitly), and
                    renaming means re-submitting an existing channel through that form. Adding
                    it back is a single `<button>` in this group — the setting it writes
                    (`channels.<id>.label`) is untouched, and the runtime still reads `label`.
                */}
                <div className="ad-rowActions">
                  <button
                    type="button"
                    className="ad-btn ad-btn-quiet"
                    title={row.keyConfigured ? '更换这个渠道的密钥' : '为这个渠道填写密钥'}
                    onClick={() => setKeying(keying === row.id ? null : row.id)}
                  >
                    {keying === row.id ? '取消' : '更换密钥'}
                  </button>
                  <button
                    type="button"
                    className="ad-btn ad-btn-quiet"
                    disabled={probing === row.id}
                    onClick={() => { void runProbe(row.id) }}
                  >
                    {probing === row.id ? '测试中…' : '测试'}
                  </button>
                  <button
                    type="button"
                    className="ad-btn ad-btn-danger"
                    title="移除此渠道（不删除凭据本身）"
                    onClick={() => removeChannel(row.id)}
                  >
                    移除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        {/*
          Adding is a form, not a JSON editor — and it asks only for what only the user knows.
          Choosing a preset determines the endpoint; the id is derived from it. The key is the one
          thing the panel cannot know, so it is the one thing the form asks for.
        */}
        {adding ? (
          <div className="ad-addForm">
            <label className="ad-field">
              <span>规格<em className="ad-req">必选</em></span>
              <select
                className="ad-input"
                value={newPreset}
                onChange={(event) => {
                  const next = event.target.value
                  setNewPreset(next)
                  // Derive the channel id AND the display name — but only replace a value that is
                  // EMPTY or was itself derived by a previous preset choice. A value the user
                  // typed is theirs: switching presets must not silently discard it.
                  //
                  // 🔴 Read the previous suggestions into LOCALS before scheduling the updates. A
                  // React state updater runs LATER, so comparing against `lastSuggestedId.current`
                  // inside one compares with the value this handler already overwrote — the test
                  // could never succeed and a derived id was never refreshed. Measured in the real
                  // browser: Open Design then Ollama kept id "open-design" while the select showed
                  // Ollama. (An earlier version also read `previous === '' || previous === ''` —
                  // the same test twice.)
                  const previousId = lastSuggestedId.current
                  const previousLabel = lastSuggestedLabel.current
                  const nextId = suggestId(next, rows)
                  const nextLabel = presets.find((preset) => preset.id === next)?.displayName ?? ''
                  setNewId((current) => (current === '' || current === previousId) ? nextId : current)
                  setNewLabel((current) => (current === '' || current === previousLabel) ? nextLabel : current)
                  lastSuggestedId.current = nextId
                  lastSuggestedLabel.current = nextLabel
                }}
              >
                <option value="">选择规格…</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.displayName}</option>
                ))}
              </select>
              <span className="ad-fieldHelp">
                规格决定三件事：请求发到哪个地址、用哪个上游模型名、走哪种协议。选它就不用再填这些。
              </span>
            </label>
            <label className="ad-field">
              <span>渠道 id</span>
              <input
                className="ad-input"
                value={newId}
                placeholder={newPreset === '' ? '先选上面的规格' : suggestId(newPreset, rows)}
                onChange={(event) => setNewId(event.target.value)}
              />
              <span className="ad-fieldHelp">
                配置里的键名，只能用小写字母、数字、<code className="ad-mono">-</code>、
                <code className="ad-mono">_</code>。同一个规格可以加多次，第二个会自动变成
                <code className="ad-mono"> -2</code>。
              </span>
            </label>
            {newIdProblem !== null && <p className="ad-fieldError">{newIdProblem}</p>}
            {/*
              The display name — editable, and derived from the preset by default.

              This is what makes "the same relay, two accounts" readable: the entries differ only
              by which key they carry, so the name is the only thing that can tell them apart. The
              runtime has honoured `label` since the beginning; the panel simply never asked.

              🔴 It is ALSO the only way to rename a channel (2026-11-06). The per-row 改名 button
              used to be the way, and it was removed at the owner's request — see the note on
              `.ad-rowActions` — so this field has to say that it can rename, and name the filter
              by which a preset channel appears in this list.
            */}
            <label className="ad-field">
              <span>显示名<em className="ad-opt">可空</em></span>
              <input
                className="ad-input"
                value={newLabel}
                placeholder={newPreset === '' ? '先选上面的规格' : '例如「Open Design（主号）」'}
                onChange={(event) => setNewLabel(event.target.value)}
              />
              <span className="ad-fieldHelp">
                这一格也是<strong>改名</strong>的唯一入口：选回同一个规格、名字照写、粘上门已有 key
                的<strong>占位值</strong>（确认那几个字符的点，不会覆盖原有 key），保存即可。
                留空或原样提交，它就保持现在的名字。
              </span>
            </label>
            {/*
              🔴 The key, and nothing but the key.

              This field used to ask for a "credential reference name" and tell the user to set
              the secret "in the credential centre" — a place that does not exist in this UI, so
              the value the user actually held had nowhere to go. It now takes the key itself and
              stores it on the channel; there is no name to invent and no second store to visit.
            */}
            <label className="ad-field">
              <span>密钥<em className="ad-req">必选</em></span>
              <input
                className="ad-input"
                type="password"
                autoComplete="off"
                value={newSecret}
                placeholder={newPreset === '' ? '先选上面的规格' : 'sk-…'}
                onChange={(event) => setNewSecret(event.target.value)}
              />
              <span className="ad-fieldHelp">
                就是服务商给你的那串 key 本体，不需要先起个名字。
              </span>
            </label>
            <p className="ad-hint ad-hint-warn">
              保存位置：本机 profile 配置里的 <code className="ad-mono">channels.&lt;id&gt;.apiKey</code>。
              它不联网外传，但会以明文出现在配置文件和 <code className="ad-mono">--dump-config</code> 输出里
              ——<strong>别把这份 profile 发给别人</strong>。
            </p>
            <div className="ad-rowActions">
              <button
                type="button"
                className="ad-btn"
                disabled={newPreset === '' || newId.trim() === '' || newIdProblem !== null || newSecret.trim() === ''}
                onClick={addChannel}
              >
                添加
              </button>
              <button type="button" className="ad-btn ad-btn-quiet" onClick={() => setAdding(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="ad-btn"
            onClick={() => {
              setAdding(true)
              lastSuggestedId.current = ''
              lastSuggestedLabel.current = ''
            }}
          >
            添加渠道
          </button>
        )}
        {current === '' && rows.length > 0 && (
          <p className="ad-hint">
            还没选当前渠道 —— 现在每条请求都会以 <code className="ad-mono">NO_CHANNEL_SELECTED</code> 失败。
            点任意一行左边的圆点即可选中。
          </p>
        )}
      </section>
      )}

      {tab === 'usage' && (
      <section className="ad-section" role="tabpanel" aria-label="用量">
        <div className="ad-sectionBar">
          <h3 className="ad-sectionTitle">用量</h3>
          {/* Grouping is the only choice this table asks; 刷新 lives beside the choice it refreshes. */}
          <div className="ad-segmented" role="group" aria-label="用量分组">
            <button
              type="button"
              className={`ad-seg${group === 'channel' ? ' ad-seg-on' : ''}`}
              onClick={() => {
                setGroup('channel')
                setShowAllRows(false)
              }}
            >
              按渠道
            </button>
            <button
              type="button"
              className={`ad-seg${group === 'day' ? ' ad-seg-on' : ''}`}
              onClick={() => {
                setGroup('day')
                // Collapse on switch: "expanded" was a choice about the previous table. Keeping it
                // would silently show a different amount of data than the reader last chose.
                setShowAllRows(false)
              }}
            >
              按天
            </button>
            <button type="button" className="ad-seg ad-seg-refresh" onClick={() => { void refresh() }}>
              刷新
            </button>
          </div>
        </div>

        {stats === null || stats.total.requests === 0 ? (
          <p className="ad-empty">
            还没有用量记录。跑一次对话，这里就会按渠道开始累计。
          </p>
        ) : (
          <div className="ad-tableWrap">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>{group === 'day' ? '日期' : '渠道'}</th>
                  <th className="ad-num">请求</th>
                  <th className="ad-num">失败</th>
                  <th className="ad-num">输入</th>
                  <th className="ad-num">缓存读</th>
                  <th className="ad-num">缓存写</th>
                  <th className="ad-num">输出</th>
                  <th className="ad-num">合计</th>
                  <th className="ad-num" title="每次请求平均携带的 token 数（含缓存命中）—— 与模型的 1M 窗口对照看，可判成本由对话长度还是窗口驱动">平均上下文</th>
                  <th className="ad-num" title="生成阶段速度（不含首字等待）">速度</th>
                  <th className="ad-num" title="首字平均等待时间">首字</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.key}>
                    {/*
                      The DISPLAY NAME, not the id. `key` is the row's identity (stable across
                      renames) and `label` is what a human recognises — printing the id made this
                      table disagree with the channel list above it about the same channel.
                    */}
                    <td>{row.label ?? row.key}</td>
                    <td className="ad-num">{row.aggregate.requests}</td>
                    <td className="ad-num">{row.aggregate.failures}</td>
                    <td className="ad-num">{formatTokens(row.aggregate.input)}</td>
                    <td className="ad-num">{formatTokens(row.aggregate.cacheRead)}</td>
                    <td className="ad-num">{formatTokens(row.aggregate.cacheWrite)}</td>
                    <td className="ad-num">{formatTokens(row.aggregate.output)}</td>
                    <td className="ad-num">{formatTokens(row.aggregate.total)}</td>
                    {/*
                      Mean context size — the cost-optimisation reference the owner asked for
                      (2026-10-24). An em dash for "no request reported usage", never `0`: zero
                      tokens per request is a different and false claim.
                    */}
                    <td className="ad-num">{formatMeanContext(row.meanContext)}</td>
                    {/*
                      Speed comes last, after the volume columns, because it is a different kind of
                      number: the rest are totals, this one is a rate. `—` means "not measured" and
                      is deliberately not `0`.
                    */}
                    <td className="ad-num">{formatSpeed(row.tokensPerSecond)}</td>
                    <td className="ad-num">{formatDuration(row.firstTokenMs)}</td>
                  </tr>
                ))}
                <tr className="ad-total">
                  <td>合计</td>
                  <td className="ad-num">{stats.total.requests}</td>
                  <td className="ad-num">{stats.total.failures}</td>
                  <td className="ad-num">{formatTokens(stats.total.input)}</td>
                  <td className="ad-num">{formatTokens(stats.total.cacheRead)}</td>
                  <td className="ad-num">{formatTokens(stats.total.cacheWrite)}</td>
                  <td className="ad-num">{formatTokens(stats.total.output)}</td>
                  <td className="ad-num">{formatTokens(stats.total.total)}</td>
                  <td className="ad-num">{formatMeanContext(stats.meanContext)}</td>
                  <td className="ad-num">{formatSpeed(stats.totalSpeed)}</td>
                  <td className="ad-num">{formatDuration(stats.totalFirstTokenMs)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/*
          🔴 「查看更多」 (owner request 2026-10-27: 「支持查看更多」).

          Three states, and the wording of all of them matters:

           · rows held back  → a button that says HOW MANY are hidden, so the click is informed;
           · everything shown → a 收起 button, but only when the table is longer than the limit
                               (otherwise it would be a control that does nothing);
           · nothing shown    → nothing at all (the empty-state paragraph above is the message).

          The count is stated because "查看更多" alone leaves the reader guessing whether there are
          two more rows or forty — and those are different decisions about whether to widen the
          range instead.

          Rendered OUTSIDE the table: a <button> inside <tbody> is invalid HTML and browsers
          relocate it, which would put the control in a place the code does not describe.
        */}
        {stats !== null && stats.total.requests > 0 && (
          <div className="ad-rowActions">
            {hiddenRowCount > 0 && (
              <button
                type="button"
                className="ad-btn ad-btn-quiet"
                onClick={() => setShowAllRows(true)}
              >
                查看更多（还有 {hiddenRowCount} 天）
              </button>
            )}
            {hiddenRowCount === 0 && showAllRows && allRows.length > USAGE_ROW_LIMIT && (
              <button
                type="button"
                className="ad-btn ad-btn-quiet"
                onClick={() => setShowAllRows(false)}
              >
                收起（只看最近 {USAGE_ROW_LIMIT} 天）
              </button>
            )}
          </div>
        )}

        {/*
          The counting convention is printed, not assumed. Harness token counts are disjoint, so
          a reader who sums the wrong columns concludes the input is being under-reported.

          🔴 The RANGE is printed too (owner request 2026-10-24: 「只保留近一周」). Saying "last 7
          days" is mandatory rather than cosmetic: the same table without a stated window invites
          the reader to assume it is all-time, and a header that says 合计 over a week looks
          identical to one over a month. The ledger files themselves are NOT pruned — only the
          default view is narrowed — so nothing is lost; the sentence says which it is.
        */}
        <p className="ad-note">
          口径：<strong>输入</strong>只算未命中缓存的输入；缓存读 / 缓存写单独成列，
          三者相加才是<strong>计费输入</strong>。
          <strong>平均上下文</strong>是每次请求平均携带的 token 数（含缓存命中）——
          与模型的 1M 窗口对照看：远低于窗口说明成本由对话长度驱动，不是窗口。
          速度只算生成阶段（总时长减去首字等待），<span className="ad-mono">—</span> 表示没测到，不是 0。
          {stats !== null && stats.total.unreported > 0 && (
            <> 另有 {stats.total.unreported} 次请求上游未回报用量，不计入合计。</>
          )}
        </p>
        <p className="ad-note">
          范围：<strong>近 7 天</strong>。更早的账本仍在磁盘上（按月的 JSONL，未删除），
          只是这个视图默认不展示——历史记录是花销的唯一凭据，删掉就回不来了。
        </p>
        {/*
          🔴 The display limit is DISCLOSED, because the alternative is a table that looks complete.

          Showing 10 rows while 合计 covers all N creates exactly the confusion this sentence
          removes: a reader who assumes the footer sums what they can see will conclude the visible
          rows under-count. Stating both halves — "these are the newest 10" and "合计 is over all"
          — is the only wording that survives being skimmed.
        */}
        {hiddenRowCount > 0 && (
          <p className="ad-note">
            下表只显示<strong>最新的 {visibleRows.length} 行</strong>；
            <strong>合计</strong>仍是整个范围内全部 {allRows.length} 行的总和，不是可见这部分的。
            点「查看更多」看其余 {hiddenRowCount} 行。
          </p>
        )}
      </section>
      )}

      {/*
        The footer states what this thing is and where it lives. A user deciding whether to fork
        it, add a relay or fix a rough edge should not have to search for the source, and a user
        wondering "is this a first-party thing?" should get the answer here rather than infer it.
      */}
      <footer className="ad-foot">
        <span className="ad-footNote">
          开源小工具，MIT 许可 —— 欢迎改、欢迎加渠道。
        </span>
        <a className="ad-footLink" href={REPO_URL} target="_blank" rel="noreferrer">
          {REPO_URL.replace('https://github.com/', 'github.com/')}
        </a>
      </footer>
    </div>
  )
}
