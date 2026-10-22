/**
 * client/SettingsPage.tsx — the panel.
 *
 * Three screens in one page, because they answer one question each at increasing depth:
 *
 *  1. **which channel is live** — the only decision v1 asks of the user;
 *  2. **what each channel costs** — tokens per relay, with the counting convention printed next
 *     to the numbers rather than buried in a doc;
 *  3. **whether a channel works** — an explicit, token-spending probe.
 *
 * The page never displays a key. It displays whether a key is configured, which is the fact the
 * harness credential surface is willing to expose.
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChannelRow, ProbeResult, StatsResponse } from './panel-api.js'
import type { SettingsWire } from './index.js'
import { formatTokens } from './panel-api.js'
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
  const { useSettings, loadChannels, loadStats, probe, setField, removeField } = props
  const settings = useSettings((snapshot) => snapshot)

  const [rows, setRows] = useState<ChannelRow[]>([])
  const [presets, setPresets] = useState<Array<{ id: string; displayName: string }>>([])
  const [model, setModel] = useState<{ id: string; name: string }>({ id: '', name: '' })
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [group, setGroup] = useState<'channel' | 'day'>('channel')
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
          这里定义的是 <strong>any-deepseek 这一个 provider</strong> 的内部渠道，
          与 DSH 别处的设置无关。本插件对外只暴露一个模型
          （<span className="ad-mono">{model.name || 'DeepSeek V4.1 Flash'}</span>）；
          下面勾选哪一个渠道，请求就只发到那一个，不会自动切换。
        </p>
      </header>

      {error !== null && (
        <div className="ad-error" role="alert">加载失败：{error}</div>
      )}

      <section className="ad-section">
        <h3 className="ad-sectionTitle">渠道</h3>
        {rows.length === 0 && (
          <p className="ad-empty">还没有渠道。用下面的表单加一个。</p>
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
                    <span className="ad-rowMeta">
                      <span className="ad-mono">{row.model}</span>
                      <span className="ad-sep">·</span>
                      <span>{row.api}</span>
                      <span className="ad-sep">·</span>
                      <span className="ad-mono">{row.baseURL}</span>
                    </span>
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
                          onClick={() => setKeying(keying === row.id ? null : row.id)}
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
                          onClick={() => setKeying(keying === row.id ? null : row.id)}
                        >
                          {keying === row.id ? '取消' : '填写密钥'}
                        </button>
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
              <span>规格</span>
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
            </label>
            <label className="ad-field">
              <span>渠道 id</span>
              <input
                className="ad-input"
                value={newId}
                placeholder={newPreset === '' ? '先选上面的规格' : suggestId(newPreset, rows)}
                onChange={(event) => setNewId(event.target.value)}
              />
            </label>
            {newIdProblem !== null && <p className="ad-fieldError">{newIdProblem}</p>}
            {/*
              The display name — editable, and derived from the preset by default.

              This is what makes "the same relay, two accounts" readable: the entries differ only
              by which key they carry, so the name is the only thing that can tell them apart. The
              runtime has honoured `label` since the beginning; the panel simply never asked.
            */}
            <label className="ad-field">
              <span>显示名</span>
              <input
                className="ad-input"
                value={newLabel}
                placeholder={newPreset === '' ? '先选上面的规格' : '例如「Open Design（主号）」'}
                onChange={(event) => setNewLabel(event.target.value)}
              />
            </label>
            {/*
              🔴 The key, and nothing but the key.

              This field used to ask for a "credential reference name" and tell the user to set
              the secret "in the credential centre" — a place that does not exist in this UI, so
              the value the user actually held had nowhere to go. It now takes the key itself and
              stores it on the channel; there is no name to invent and no second store to visit.
            */}
            <label className="ad-field">
              <span>密钥</span>
              <input
                className="ad-input"
                type="password"
                autoComplete="off"
                value={newSecret}
                placeholder={newPreset === '' ? '先选上面的规格' : 'sk-…'}
                onChange={(event) => setNewSecret(event.target.value)}
              />
            </label>
            <p className="ad-hint">
              密钥写在本机 profile 配置里（<code className="ad-mono">channels.&lt;id&gt;.apiKey</code>）。
              它<strong>不</strong>外传，但会因为配置文件而被看到——别把这个 profile 分享出去。
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
          <p className="ad-hint">尚未选择当前渠道，请求会以 NO_CHANNEL_SELECTED 失败。</p>
        )}
      </section>

      <section className="ad-section">
        <h3 className="ad-sectionTitle">用量</h3>
        <div className="ad-tabs">
          <button
            type="button"
            className={`ad-tab${group === 'channel' ? ' ad-tab-on' : ''}`}
            onClick={() => setGroup('channel')}
          >
            按渠道
          </button>
          <button
            type="button"
            className={`ad-tab${group === 'day' ? ' ad-tab-on' : ''}`}
            onClick={() => setGroup('day')}
          >
            按天
          </button>
          <button type="button" className="ad-tab ad-tab-refresh" onClick={() => { void refresh() }}>
            刷新
          </button>
        </div>

        {stats === null || stats.total.requests === 0 ? (
          <p className="ad-empty">还没有用量记录。</p>
        ) : (
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
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.key}</td>
                  <td className="ad-num">{row.aggregate.requests}</td>
                  <td className="ad-num">{row.aggregate.failures}</td>
                  <td className="ad-num">{formatTokens(row.aggregate.input)}</td>
                  <td className="ad-num">{formatTokens(row.aggregate.cacheRead)}</td>
                  <td className="ad-num">{formatTokens(row.aggregate.cacheWrite)}</td>
                  <td className="ad-num">{formatTokens(row.aggregate.output)}</td>
                  <td className="ad-num">{formatTokens(row.aggregate.total)}</td>
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
              </tr>
            </tbody>
          </table>
        )}

        {/*
          The counting convention is printed, not assumed. Harness token counts are disjoint, so
          a reader who sums the wrong columns concludes the input is being under-reported.
        */}
        <p className="ad-note">
          口径：输入 = 未命中缓存的输入；缓存读 / 写分列，三者相加才是计费输入。
          {stats !== null && stats.total.unreported > 0 && (
            <> 另有 {stats.total.unreported} 次请求上游未回报用量（不计入合计）。</>
          )}
        </p>
      </section>
    </div>
  )
}
