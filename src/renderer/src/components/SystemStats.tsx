// 顶栏系统资源占用（CPU / 内存），参照 168 SCRM 顶栏样式：
// 「CPU 14%   Memory 62%」，占用率越高颜色越警示。
// 数据来自本地 API /api/system/stats，主进程 2s 采样一次，这里同步 2s 轮询。
import { useEffect, useState } from 'react'
import { Tooltip } from 'antd'
import { DashboardOutlined, DatabaseOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useT } from '../i18n'

interface Stats {
  cpu: number
  memUsed: number
  memTotal: number
  memPct: number
}

function fmtBytes(n: number) {
  const gb = n / 1024 ** 3
  if (gb >= 1) return gb.toFixed(1) + ' GB'
  return Math.round(n / 1024 ** 2) + ' MB'
}

/** 占用率分档配色：绿色正常 → 橙色偏高 → 红色告急 */
function levelColor(pct: number, isDark: boolean) {
  if (pct >= 85) return '#ff4d4f'
  if (pct >= 60) return '#faad14'
  return isDark ? '#52c41a' : '#389e0d'
}

export default function SystemStats({ isDark }: { isDark: boolean }) {
  const t = useT()
  const [s, setS] = useState<Stats | null>(null)

  useEffect(() => {
    let stopped = false
    const tick = () => {
      api
        .get<Stats>('/api/system/stats')
        .then((d) => {
          if (!stopped) setS(d)
        })
        .catch(() => {
          /* 静默：顶栏指示器不值得为一次失败弹错误 */
        })
    }
    tick()
    const timer = setInterval(tick, 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  if (!s) return null

  const item = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 12,
    color: 'var(--ant-color-text-secondary, rgba(0,0,0,0.65))'
  } as const

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 16, marginRight: 16 }}>
      <Tooltip title={`CPU ${s.cpu}%`}>
        <span style={item}>
          <DashboardOutlined style={{ fontSize: 13 }} />
          <span>CPU</span>
          <span style={{ color: levelColor(s.cpu, isDark), fontWeight: 600, minWidth: 34, textAlign: 'right' }}>
            {s.cpu}%
          </span>
        </span>
      </Tooltip>
      <Tooltip title={`${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`}>
        <span style={item}>
          <DatabaseOutlined style={{ fontSize: 13 }} />
          <span>{t('layout.memory')}</span>
          <span style={{ color: levelColor(s.memPct, isDark), fontWeight: 600, minWidth: 34, textAlign: 'right' }}>
            {s.memPct}%
          </span>
        </span>
      </Tooltip>
    </div>
  )
}
