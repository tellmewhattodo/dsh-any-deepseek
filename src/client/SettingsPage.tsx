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

/**
 * The credential reference name a preset conventionally uses.
 *
 * This is a CONVENTION, not a lookup: the reference is just the environment-variable name the
 * user's key is stored under, and any name works. Pre-filling the conventional one saves typing;
 * `OPEN_DESIGN` → `OPEN_DESIGN_API_KEY`.
 * @param presetId - the chosen preset.
 * @returns the suggested reference name ('' when no preset is chosen).
 */
export function suggestKeyRef(presetId: string): string {
  if (presetId === '') return ''
  return `${presetId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
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
  const [newKeyRef, setNewKeyRef] = useState('')
  /**
   * The reference name the form last derived from a preset.
   *
   * Needed to tell "the user never touched this field" from "the user typed it": only a value that
   * still equals the last suggestion may be replaced when the preset changes. Without it,
   * switching presets after typing a custom reference would silently discard the user's input.
   */
  const lastSuggestedKeyRef = useRef('')
  /** Same idea for the derived channel id (see the select's onChange). */
  const lastSuggestedId = useRef('')

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
        if (!accepted) setError(`${context}：宿主拒绝了这个修改`)
        else setError(null)
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
   * Writes only the fields the user actually chose: a preset-backed channel needs nothing but
   * a key reference, and pre-filling endpoint fields would freeze today's preset values into the
   * user's document (later preset fixes would never reach them).
   */
  const addChannel = (): void => {
    const id = newId.trim()
    if (newPreset === '' || id === '' || newIdProblem !== null || newKeyRef.trim() === '') return
    // One write, one atomic result: the channel entry and the selection are separate documents,
    // so selecting is a second write — but both are awaited by `write`, and a refusal on either
    // is surfaced rather than swallowed.
    write(() => setField(['channels', id], {
      preset: newPreset,
      apiKeyEnv: newKeyRef.trim(),
    }), '添加渠道失败')
    // The first channel added to an empty document becomes current: leaving `current` empty
    // means every request fails with NO_CHANNEL_SELECTED, which reads as a broken plugin.
    if (current === '') write(() => setField(['current'], id), '设为当前渠道失败')
    setNewId('')
    setNewKeyRef('')
    setNewPreset('')
    lastSuggestedKeyRef.current = ''
    lastSuggestedId.current = ''
    setAdding(false)
  }

  const removeChannel = (id: string): void => {
    write(() => removeField(['channels', id]), '移除渠道失败')
    if (current === id) write(() => removeField(['current']), '清除当前选择失败')
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
              <li key={row.id} className={`ad-row${isCurrent ? ' ad-row-current' : ''}`}>
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
                    </span>
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
          Adding is a form, not a JSON editor — but it should not ask for facts the plugin can
          derive. Choosing a preset already determines the endpoint AND the credential reference
          name, so the form asks for the one thing only the user knows (which preset), then
          pre-fills the rest and lets them correct it.
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
                  // Derive the two fields the preset already answers — but only replace a value
                  // that is EMPTY or was itself derived by a previous preset choice. A value the
                  // user typed is theirs: switching presets must not silently discard it.
                  //
                  // 🔴 Read the previous suggestions into LOCALS before scheduling the updates.
                  // A React state updater runs LATER, so `previous === lastSuggestedId.current`
                  // inside one compared against the value this handler had already overwritten —
                  // the test could never succeed and a derived id was never refreshed. Measured
                  // in the real browser: Open Design then Ollama kept id "open-design" while the
                  // select showed Ollama. (An earlier version of this branch also read
                  // `previous === '' || previous === ''` — the same test twice.)
                  const previousId = lastSuggestedId.current
                  const previousKey = lastSuggestedKeyRef.current
                  const nextId = suggestId(next, rows)
                  const nextKey = suggestKeyRef(next)
                  setNewId((current) => (current === '' || current === previousId) ? nextId : current)
                  setNewKeyRef((current) => (current === '' || current === previousKey) ? nextKey : current)
                  lastSuggestedId.current = nextId
                  lastSuggestedKeyRef.current = nextKey
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
            <label className="ad-field">
              <span>凭据引用名</span>
              <input
                className="ad-input"
                value={newKeyRef}
                placeholder={newPreset === '' ? '例如 OPENCODE_GO_API_KEY' : suggestKeyRef(newPreset)}
                onChange={(event) => setNewKeyRef(event.target.value)}
              />
            </label>
            <p className="ad-hint">
              这里填的是<strong>引用名</strong>（环境变量名），不是密钥本身。密钥请通过凭据中心设置。
            </p>
            <div className="ad-rowActions">
              <button
                type="button"
                className="ad-btn"
                disabled={newPreset === '' || newId.trim() === '' || newIdProblem !== null || newKeyRef.trim() === ''}
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
          <button type="button" className="ad-btn" onClick={() => { setAdding(true); lastSuggestedId.current = ''; lastSuggestedKeyRef.current = '' }}>
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
