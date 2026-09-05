import React from 'react'

export const PALETTE = ['#1677ff', '#52c41a', '#faad14', '#eb2f96', '#13c2c2', '#722ed1', '#fa8c16', '#2f54eb']
export const STATUS_COLORS: Record<string, string> = {
  available: '#52c41a',
  inUse: '#1677ff',
  expired: '#faad14',
  invalid: '#ff4d4f',
  unknown: '#8c8c8c'
}

export function cap(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------- 折线图（近 30 天趋势） ----------
export function TrendLine({
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
export function Donut({
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
export function HBar({
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
