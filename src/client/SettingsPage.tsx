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
import { useCallback, useEffect, useState } from 'react'
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
  setField: (field: string, value: unknown) => void
}

type SettingsPageProps = PropsRuntime<'settings.section'> & InjectFace<SettingsPageInjected>

/** One labelled switch. */
function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  return (
    <label className="ad-switch">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="ad-switchTrack" />
    </label>
  )
}

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
  const { useSettings, loadChannels, loadStats, probe, setField } = props
  const settings = useSettings((snapshot) => snapshot)

  const [rows, setRows] = useState<ChannelRow[]>([])
  const [presets, setPresets] = useState<Array<{ id: string; displayName: string }>>([])
  const [model, setModel] = useState<{ id: string; name: string }>({ id: '', name: '' })
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [group, setGroup] = useState<'channel' | 'day'>('channel')
  const [probing, setProbing] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<Record<string, ProbeResult>>({})
  const [error, setError] = useState<string | null>(null)

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
  const channels = settings.value?.channels ?? {}

  const select = (id: string): void => {
    setField('current', id)
  }

  const toggleChannel = (id: string, on: boolean): void => {
    // Path-scoped write: only this channel's `enabled` field, so a concurrent edit to another
    // channel cannot be clobbered by a whole-section rewrite.
    setField(`channels.${id}.enabled`, on)
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

  return (
    <div className="ad-page">
      <header className="ad-head">
        <h2 className="ad-title">Any DeepSeek</h2>
        <p className="ad-intro">
          一个模型（{model.name || 'DeepSeek V4.1 Flash'}），多个中转渠道。
          在下面选定当前渠道；请求只会发到你选中的那一个，不会自动切换。
        </p>
      </header>

      {error !== null && (
        <div className="ad-error" role="alert">加载失败：{error}</div>
      )}

      <section className="ad-section">
        <h3 className="ad-sectionTitle">渠道</h3>
        {rows.length === 0 && (
          <p className="ad-empty">
            还没有渠道。在配置文件里给 <code>any-deepseek.channels</code> 添加一项，或等待本面板的编辑功能。
          </p>
        )}
        <ul className="ad-rows">
          {rows.map((row) => {
            const enabled = channels[row.id]?.enabled !== false
            const isCurrent = current === row.id
            const probeResult = verdict[row.id]
            return (
              <li key={row.id} className={`ad-row${isCurrent ? ' ad-row-current' : ''}`}>
                <div className="ad-rowMain">
                  <div className="ad-rowTitleLine">
                    <KeyDot configured={row.keyConfigured} known={row.keySource !== undefined || row.keyConfigured} />
                    <span className="ad-rowTitle">{row.label}</span>
                    {isCurrent && <span className="ad-badge">当前</span>}
                    {row.warnings.length > 0 && (
                      <span className="ad-warn" title={row.warnings.join('\n')}>⚠</span>
                    )}
                  </div>
                  <div className="ad-rowMeta">
                    <span className="ad-mono">{row.model}</span>
                    <span className="ad-sep">·</span>
                    <span>{row.api}</span>
                    <span className="ad-sep">·</span>
                    <span className="ad-mono">{row.baseURL}</span>
                  </div>
                  {probeResult !== undefined && (
                    <div className={`ad-probe ad-probe-${probeResult.ok ? 'ok' : 'bad'}`}>
                      {probeResult.ok
                        ? `通（${probeResult.ms}ms）`
                        : `不通：${probeResult.code ?? 'ERROR'}${probeResult.message === undefined ? '' : ` — ${probeResult.message}`}`}
                    </div>
                  )}
                </div>
                <div className="ad-rowActions">
                  <button
                    type="button"
                    className="ad-btn"
                    disabled={isCurrent || !enabled}
                    onClick={() => select(row.id)}
                  >
                    {isCurrent ? '使用中' : '设为当前'}
                  </button>
                  <button
                    type="button"
                    className="ad-btn ad-btn-quiet"
                    disabled={probing === row.id || !enabled}
                    onClick={() => { void runProbe(row.id) }}
                  >
                    {probing === row.id ? '测试中…' : '测试'}
                  </button>
                  <Toggle checked={enabled} onChange={(on) => toggleChannel(row.id, on)} />
                </div>
              </li>
            )
          })}
        </ul>
        {current === '' && rows.length > 0 && (
          <p className="ad-hint">尚未选择当前渠道，请求会以 NO_CHANNEL_SELECTED 失败。</p>
        )}
        {presets.length > 0 && (
          <p className="ad-hint">
            内置规格：{presets.map((preset) => preset.id).join('、')}（配置文件里用 <code>preset:</code> 引用，只需再给一个 key 引用）
          </p>
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
