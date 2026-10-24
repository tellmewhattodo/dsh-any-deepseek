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
import type { BalanceResponse, BalanceRow, ChannelRow, ProbeResult, StatsResponse } from './panel-api.js'
import type { SettingsWire } from './index.js'
import { formatBalance, formatDuration, formatMeanContext, formatSpeed, formatTokens } from './panel-api.js'
import './SettingsPage.css'

/** What the plugin's `apply` hands this component. */
export interface SettingsPageInjected {
  hooks: { settings: ConfigForm<SettingsWire> }
  loadChannels: () => Promise<{
    channels: ChannelRow[]
    presets: Array<{ id: string; displayName: string }>
    model: { id: string; name: string }
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
   * Which of the panel's two questions is on screen.
   *
   * 渠道 is the default because it is the one a new user must answer first — an empty panel
   * showing a usage table with no rows answers nothing.
   */
  const [tab, setTab] = useState<PanelTab>('channels')
  const [probing, setProbing] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<Record<string, ProbeResult>>({})
  const [error, setError] = useState<string | null>(null)

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
  /** Which channel currently has its inline RENAME field open (null = none). */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** The channel id and the label the form last derived from a preset (see the select). */
  const lastSuggestedId = useRef('')
  const lastSuggestedLabel = useRef('')

  const refresh = useCallback(async (): Promise<void> => {
    const [loaded, statsNow] = await Promise.all([loadChannels(), loadStats(group)])
    setRows(loaded.channels)
    setPresets(loaded.presets)
    setModel(loaded.model)
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

  const select = (id: string): void => {
    write(() => setField(['current'], id))
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
   * Rename one channel.
   *
   * `label` is the display name and nothing else: the channel's identity is its id (the
   * configuration key), which renaming must never touch — a renamed key would be a different
   * channel, with a different key and a different `current` target.
   *
   * Clearing the name removes the field, which restores the preset's name rather than leaving an
   * empty label in the document.
   * @param row - the channel being renamed.
   */
  const renameChannel = (row: ChannelRow): void => {
    const next = renameDraft.trim()
    if (next === '') write(() => removeField(['channels', row.id, 'label']), '恢复默认名失败')
    else write(() => setField(['channels', row.id, 'label'], next), '重命名失败')
    setRenaming(null)
    setRenameDraft('')
  }

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
        <ul className="ad-rows" role="radiogroup" aria-label="选择当前渠道">
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
                        Renaming lives next to the name it changes.

                        Two accounts on the same relay differ only by their label, so the label has
                        to be editable — and editable where it is read, not behind a separate
                        screen. The row is a radio label, so this button stops the click from
                        propagating; otherwise renaming would also select the channel.
                      */}
                      <button
                        type="button"
                        className="ad-link ad-renameBtn"
                        title="改显示名（渠道 id 不变）"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setRenaming(renaming === row.id ? null : row.id)
                          setRenameDraft(renaming === row.id ? '' : row.label)
                        }}
                      >
                        {renaming === row.id ? '取消' : '改名'}
                      </button>
                    </span>
                    {renaming === row.id && (
                      <span className="ad-keyForm">
                        <input
                          className="ad-input"
                          value={renameDraft}
                          placeholder="显示名（留空则用预设默认名）"
                          onClick={(event) => event.preventDefault()}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              renameChannel(row)
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="ad-btn"
                          onClick={(event) => {
                            event.preventDefault()
                            renameChannel(row)
                          }}
                        >
                          保存名字
                        </button>
                      </span>
                    )}
                    {/*
                      🔴 ONE detail line, not four (owner request 2026-10-24:
                      「每个渠道高度希望小一些，紧凑些」).

                      The row previously stacked 模型·协议·地址 / 密钥态 / 余额 / 探测结果 as
                      separate lines — four lines of secondary fact under one line of name. With
                      five channels that spent most of the panel on whitespace.

                      Nothing was removed to fix it: every one of those facts is still rendered,
                      but they now share one wrapping line. Order is by importance to a reader
                      scanning for "why isn't this working": the endpoint identity first, then the
                      key state, then the live verdict, then the balance.
                    */}
                    <span className="ad-rowDetail">
                      <span className="ad-mono" title="上游模型 id">{row.model}</span>
                      <span className="ad-sep">·</span>
                      <span title="接口协议">{row.api}</span>
                      <span className="ad-sep">·</span>
                      <span className="ad-mono" title="端点地址">{row.baseURL}</span>
                      {probeResult !== undefined && (
                        <span className={`ad-probe ad-probe-${probeResult.ok ? 'ok' : 'bad'}`}>
                          {probeResult.ok
                            ? `通（${probeResult.ms}ms）`
                            : `不通：${probeResult.code ?? 'ERROR'}${probeResult.message === undefined ? '' : ` — ${probeResult.message}`}`}
                        </span>
                      )}
                      {/*
                        Key state is shown as a fact, with the fix one step away: an unconfigured
                        channel offers the input inline rather than sending the user off to another
                        screen. `keyConfigured` is the host's own answer (it never returns the value).

                        🔴 `keyRefValid === false` is a DIFFERENT state from "no key yet": the entry
                        has something that is not a credential name in the name field (in practice
                        a key pasted into it). Calling that "未配置" would be true but useless — the
                        user's next action is not "add a key", it is "fix the slot", which the panel
                        now does for them when they save one.
                      */}
                      {row.keyConfigured ? (
                        <span className="ad-keyLine">
                          <span className="ad-keyOn">密钥已配置</span>
                          {row.keyKind === 'reference' && (
                            <code className="ad-mono ad-keyName">{row.keyRef}</code>
                          )}
                          <button
                            type="button"
                            className="ad-link"
                            onClick={(event) => {
                              event.preventDefault()
                              setKeying(keying === row.id ? null : row.id)
                            }}
                          >
                            {keying === row.id ? '取消' : '更换'}
                          </button>
                        </span>
                      ) : (
                        <span className="ad-keyLine">
                          <span className="ad-keyOff">未配置密钥</span>
                          <button
                            type="button"
                            className="ad-link"
                            onClick={(event) => {
                              event.preventDefault()
                              setKeying(keying === row.id ? null : row.id)
                            }}
                          >
                            {keying === row.id ? '取消' : '填写密钥'}
                          </button>
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
                <div className="ad-rowActions">
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
                只影响这里显示的名字。同一家开两个号时，靠它区分；留空就用规格默认名。
                <strong>改名不动 id</strong>。
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
              onClick={() => setGroup('channel')}
            >
              按渠道
            </button>
            <button
              type="button"
              className={`ad-seg${group === 'day' ? ' ad-seg-on' : ''}`}
              onClick={() => setGroup('day')}
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
                {stats.rows.map((row) => (
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
