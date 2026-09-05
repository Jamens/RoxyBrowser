import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, Row, Col, Spin, Button, Statistic, Typography, Space, theme } from 'antd'
import {
  ReloadOutlined,
  AppstoreOutlined,
  PlayCircleOutlined,
  GlobalOutlined,
  CheckCircleOutlined,
  KeyOutlined,
  VideoCameraOutlined,
  AppstoreAddOutlined
} from '@ant-design/icons'
import { api } from '../api'
import { useI18n } from '../i18n'
import type { ProfileDTO, AccountDTO, ExtensionDTO, RpaScriptDTO, LogDTO } from '@shared/types'

interface PoolStats {
  total: number
  active: number
  available: number
  inUse: number
  expired: number
  invalid: number
  unknown: number
  byCountry: { country: string; total: number; available: number }[]
}

interface DashData {
  profiles: ProfileDTO[]
  pool: PoolStats | null
  accounts: AccountDTO[]
  extensions: ExtensionDTO[]
  rpa: RpaScriptDTO[]
  logs: LogDTO[]
}

const EMPTY: DashData = { profiles: [], pool: null, accounts: [], extensions: [], rpa: [], logs: [] }

const PALETTE = ['#1677ff', '#52c41a', '#faad14', '#eb2f96', '#13c2c2', '#722ed1', '#fa8c16', '#2f54eb']
const STATUS_COLORS: Record<string, string> = {
  available: '#52c41a',
  inUse: '#1677ff',
  expired: '#faad14',
  invalid: '#ff4d4f',
  unknown: '#8c8c8c'
}

function cap(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------- 折线图（近 30 天趋势） ----------
function TrendLine({
  data,
  color,
  grid,
  axis,
  height = 240
}: {
  data: { label: string; value: number }[]
  color: string
  grid: string
  axis: string
  height?: number
}) {
  const W = 760
  const H = height
  const padL = 34
  const padR = 14
  const padT = 16
  const padB = 28
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = data.length
  const x = (i: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1))
  const y = (v: number) => padT + innerH * (1 - v / max)
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`)
  const line = pts.join(' ')
  const area = `${padL},${padT + innerH} ${line} ${padL + innerW},${padT + innerH}`
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" role="img">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {ticks.map((tv, i) => {
        const yy = padT + innerH * (1 - i / 4)
        return (
          <g key={i}>
            <line x1={padL} y1={yy} x2={padL + innerW} y2={yy} stroke={grid} strokeWidth={1} />
            <text x={padL - 8} y={yy + 3} textAnchor="end" fontSize={10} fill={axis}>
              {tv}
            </text>
          </g>
        )
      })}
      <polygon points={area} fill="url(#trendFill)" />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.value)} r={2.5} fill={color} />
      ))}
      {data.map((d, i) =>
        i % 5 === 0 || i === n - 1 ? (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill={axis}>
            {d.label}
          </text>
        ) : null
      )}
    </svg>
  )
}

// ---------- 环形图（代理状态分布） ----------
function Donut({
  segments,
  size = 188,
  thickness = 26,
  centerLabel,
  centerValue,
  text,
  muted
}: {
  segments: { label: string; value: number; color: string }[]
  size?: number
  thickness?: number
  centerLabel: string
  centerValue: number | string
  text: string
  muted: string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ flex: '0 0 auto' }}>
        {total === 0 ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={muted} strokeWidth={thickness} />
        ) : (
          segments.map((seg, i) => {
            const len = (seg.value / total) * c
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            )
            offset += len
            return el
          })
        )}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize={24} fontWeight={700} fill={text}>
          {centerValue}
        </text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" fontSize={11} fill={muted}>
          {centerLabel}
        </text>
      </svg>
      <div style={{ flex: 1, minWidth: 140 }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: seg.color, display: 'inline-block' }} />
            <span style={{ flex: 1 }}>{seg.label}</span>
            <span style={{ fontWeight: 600 }}>{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- 横向条形图（分布） ----------
function HBar({
  items,
  grid,
  axis,
  height = 240
}: {
  items: { label: string; value: number; color: string }[]
  grid: string
  axis: string
  height?: number
}) {
  const labelW = 92
  const W = 760
  const rowH = 26
  const gap = 12
  const H = Math.max(height, items.length * (rowH + gap))
  const barArea = W - labelW - 52
  const max = Math.max(1, ...items.map((d) => d.value))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" role="img">
      {items.map((d, i) => {
        const yy = i * (rowH + gap)
        const bw = Math.max(2, (d.value / max) * barArea)
        return (
          <g key={i}>
            <text x={labelW - 8} y={yy + rowH / 2 + 4} textAnchor="end" fontSize={11} fill={axis}>
              {d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label}
            </text>
            <rect x={labelW} y={yy} width={barArea} height={rowH} rx={6} fill={grid} />
            <rect x={labelW} y={yy} width={bw} height={rowH} rx={6} fill={d.color} />
            <text x={labelW + bw + 8} y={yy + rowH / 2 + 4} fontSize={11} fill={axis} fontWeight={600}>
              {d.value}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function Dashboard() {
  const { t } = useI18n()
  const { token } = theme.useToken()
  const [data, setData] = useState<DashData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const fill = token.colorFillSecondary || token.colorBorderSecondary
  const grid = token.colorBorderSecondary

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [profiles, pool, accounts, extensions, rpa, logs] = await Promise.all([
        api.get<ProfileDTO[]>('/api/profiles'),
        api.get<PoolStats>('/api/proxies/pool-stats').catch(() => null),
        api.get<AccountDTO[]>('/api/accounts'),
        api.get<ExtensionDTO[]>('/api/extensions'),
        api.get<RpaScriptDTO[]>('/api/rpa'),
        api.get<LogDTO[]>('/api/logs')
      ])
      setData({
        profiles: profiles ?? [],
        pool,
        accounts: accounts ?? [],
        extensions: extensions ?? [],
        rpa: rpa ?? [],
        logs: logs ?? []
      })
      setUpdatedAt(new Date())
    } catch {
      /* 保留上一次数据 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const ti = setInterval(load, 30000)
    return () => clearInterval(ti)
  }, [load])

  // 近 30 天操作趋势
  const trend = useMemo(() => {
    const days: { label: string; value: number; key: string }[] = []
    const now = new Date()
    const buckets = new Map<string, number>()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      buckets.set(key, 0)
      days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, value: 0, key })
    }
    for (const log of data.logs) {
      const key = (log.createdAt || '').slice(0, 10)
      if (key && buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + 1)
    }
    return days.map((d) => ({ label: d.label, value: buckets.get(d.key) || 0 }))
  }, [data.logs])

  // 代理状态分布
  const proxySegs = useMemo(() => {
    const p = data.pool
    if (!p) return []
    return [
      { label: t('dashboard.statusAvailable'), value: p.available, color: STATUS_COLORS.available },
      { label: t('dashboard.statusInUse'), value: p.inUse, color: STATUS_COLORS.inUse },
      { label: t('dashboard.statusExpired'), value: p.expired, color: STATUS_COLORS.expired },
      { label: t('dashboard.statusInvalid'), value: p.invalid, color: STATUS_COLORS.invalid },
      { label: t('dashboard.statusUnknown'), value: p.unknown, color: STATUS_COLORS.unknown }
    ].filter((s) => s.value > 0)
  }, [data.pool, t])

  // 环境平台分布
  const platformBars = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of data.profiles) m.set(p.platform || '?', (m.get(p.platform || '?') || 0) + 1)
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label: cap(label), value, color: PALETTE[i % PALETTE.length] }))
  }, [data.profiles])

  // 环境分组分布
  const groupBars = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of data.profiles) {
      const g = p.groupName || t('dashboard.ungrouped')
      m.set(g, (m.get(g) || 0) + 1)
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: PALETTE[i % PALETTE.length] }))
  }, [data.profiles, t])

  // 代理国家分布（Top 8）
  const countryBars = useMemo(() => {
    const list = (data.pool?.byCountry || []).slice(0, 8)
    return list.map((c, i) => ({ label: c.country || '?', value: c.total, color: PALETTE[i % PALETTE.length] }))
  }, [data.pool])

  const envRunning = (data.profiles || []).filter((p) => p.status === 'running').length
  const noData = (arr: unknown[]) => arr.length === 0

  const metrics = [
    { title: t('dashboard.envTotal'), value: (data.profiles || []).length, icon: <AppstoreOutlined />, color: '#1677ff', bg: 'rgba(22,119,255,0.12)' },
    { title: t('dashboard.envRunning'), value: envRunning, icon: <PlayCircleOutlined />, color: '#52c41a', bg: 'rgba(82,196,26,0.12)' },
    { title: t('dashboard.proxyTotal'), value: data.pool?.total ?? 0, icon: <GlobalOutlined />, color: '#13c2c2', bg: 'rgba(19,194,194,0.12)' },
    { title: t('dashboard.proxyAvailable'), value: data.pool?.available ?? 0, icon: <CheckCircleOutlined />, color: '#52c41a', bg: 'rgba(82,196,26,0.12)' },
    { title: t('dashboard.accountTotal'), value: (data.accounts || []).length, icon: <KeyOutlined />, color: '#fa8c16', bg: 'rgba(250,140,22,0.12)' },
    { title: t('dashboard.rpaTotal'), value: (data.rpa || []).length, icon: <VideoCameraOutlined />, color: '#722ed1', bg: 'rgba(114,46,209,0.12)' },
    { title: t('dashboard.extTotal'), value: (data.extensions || []).length, icon: <AppstoreAddOutlined />, color: '#eb2f96', bg: 'rgba(235,47,150,0.12)' }
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('dashboard.title')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('dashboard.subtitle')}</Typography.Text>
        </div>
        <Space size={12}>
          {updatedAt && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {updatedAt.toLocaleTimeString()}
            </Typography.Text>
          )}
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            {t('dashboard.refresh')}
          </Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <Row gutter={[16, 16]}>
          {metrics.map((m) => (
            <Col xs={12} sm={8} md={6} lg={4} xl={3} key={m.title}>
              <Card size="small" styles={{ body: { padding: 16 } }} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 10,
                      background: m.bg,
                      color: m.color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 20,
                      flex: '0 0 auto'
                    }}
                  >
                    {m.icon}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: token.colorTextSecondary, fontSize: 12, lineHeight: 1.2 }}>{m.title}</div>
                    <div style={{ color: m.color, fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>{m.value}</div>
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} lg={15}>
            <Card title={t('dashboard.trendTitle')} size="small" styles={{ body: { padding: 12 } }} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {noData(trend.filter((d) => d.value > 0)) ? (
                <EmptyHint text={t('dashboard.noData')} />
              ) : (
                <TrendLine data={trend} color={token.colorPrimary} grid={grid} axis={token.colorTextSecondary} />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={9}>
            <Card title={t('dashboard.proxyStatusTitle')} size="small" styles={{ body: { padding: 12 } }} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {proxySegs.length === 0 ? (
                <EmptyHint text={t('dashboard.noData')} />
              ) : (
                <Donut segments={proxySegs} centerLabel={t('dashboard.proxyTotal')} centerValue={data.pool?.total ?? 0} text={token.colorText} muted={token.colorTextSecondary} />
              )}
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} lg={8}>
            <Card title={t('dashboard.platformTitle')} size="small" styles={{ body: { padding: 12 } }} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {noData(platformBars) ? <EmptyHint text={t('dashboard.noData')} /> : <HBar items={platformBars} grid={fill} axis={token.colorTextSecondary} />}
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card title={t('dashboard.groupTitle')} size="small" styles={{ body: { padding: 12 } }} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {noData(groupBars) ? <EmptyHint text={t('dashboard.noData')} /> : <HBar items={groupBars} grid={fill} axis={token.colorTextSecondary} />}
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card title={t('dashboard.countryTitle')} size="small" styles={{ body: { padding: 12 } }} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              {noData(countryBars) ? <EmptyHint text={t('dashboard.noData')} /> : <HBar items={countryBars} grid={fill} axis={token.colorTextSecondary} />}
            </Card>
          </Col>
        </Row>
      </Spin>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(0,0,0,0.35)' }}>
      {text}
    </div>
  )
}
