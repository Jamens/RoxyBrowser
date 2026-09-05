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
import { TrendLine, Donut, HBar, cap, PALETTE, STATUS_COLORS } from '../components/charts'

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

export default function Dashboard() {
  const { t } = useI18n()
  const { token } = theme.useToken()
  const [data, setData] = useState<DashData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [now, setNow] = useState<Date>(() => new Date())

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

  // 实时时钟：每秒刷新一次，让顶部「当前时间」真正走起来（数据刷新时间戳仍由 updatedAt 单独记录）
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

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
    for (const p of data.profiles || []) m.set(p.platform || '?', (m.get(p.platform || '?') || 0) + 1)
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label: cap(label), value, color: PALETTE[i % PALETTE.length] }))
  }, [data.profiles])

  // 环境分组分布
  const groupBars = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of data.profiles || []) {
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
          <Typography.Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {t('dashboard.currentTime')}: {now.toLocaleTimeString()}
          </Typography.Text>
          {updatedAt && (
            <Typography.Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {t('dashboard.lastUpdated')}: {updatedAt.toLocaleTimeString()}
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
