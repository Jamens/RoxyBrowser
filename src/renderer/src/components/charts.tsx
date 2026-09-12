import React, { useEffect, useRef, useState } from 'react'

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

/** 测量容器真实宽度，作为 viewBox 宽 → svg 按 1:1 像素渲染（字号真实、tooltip 定位准确） */
function useMeasuredWidth(fallback: number) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const cw = el.getBoundingClientRect().width
      if (cw > 0) setW(Math.round(cw))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { wrapRef, w }
}

/** 悬停数值气泡：绝对定位的 HTML 层，避免 SVG 内文字排版受限 */
function Tip({ left, top, anchor = 'top', children }: { left: number; top: number; anchor?: 'top' | 'middle'; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        transform: anchor === 'top' ? 'translate(-50%, -100%)' : 'translate(0, -50%)',
        marginTop: anchor === 'top' ? -10 : 0,
        marginLeft: anchor === 'top' ? 0 : 12,
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#fff',
        padding: '5px 9px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 5,
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
      }}
    >
      {children}
    </div>
  )
}

// ---------- 折线图（近 30 天趋势） ----------
export function TrendLine({
  data,
  color,
  grid,
  axis,
  height = 240,
  unit = ''
}: {
  data: { label: string; value: number }[]
  color: string
  grid: string
  axis: string
  height?: number
  unit?: string
}) {
  const { wrapRef, w } = useMeasuredWidth(760)
  const [hover, setHover] = useState<number | null>(null)

  const H = height
  const padL = 34
  const padR = 14
  const padT = 16
  const padB = 28
  const innerW = w - padL - padR
  const innerH = H - padT - padB
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = data.length
  const x = (i: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1))
  const y = (v: number) => padT + innerH * (1 - v / max)
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`)
  const line = pts.join(' ')
  const area = `${padL},${padT + innerH} ${line} ${padL + innerW},${padT + innerH}`
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))
  // 每个数据点一个等宽热区，宽度覆盖相邻点间距的一半，保证整条折线都能 hover 到
  const bandW = n > 1 ? innerW / (n - 1) : innerW

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" role="img">
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
              <text x={padL - 8} y={yy + 3} textAnchor="end" fontSize={11} fill={axis}>
                {tv}
              </text>
            </g>
          )
        })}
        <polygon points={area} fill="url(#trendFill)" />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* 悬停参考竖线 */}
        {hover !== null && (
          <line
            x1={x(hover)}
            y1={padT}
            x2={x(hover)}
            y2={padT + innerH}
            stroke={color}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.7}
          />
        )}
        {data.map((d, i) => {
          const on = hover === i
          return (
            <circle
              key={i}
              cx={x(i)}
              cy={y(d.value)}
              r={on ? 5.5 : 2.5}
              fill={color}
              stroke="#fff"
              strokeWidth={on ? 2 : 0}
              style={{ transition: 'r 0.12s ease, stroke-width 0.12s ease' }}
            />
          )
        })}
        {data.map((d, i) =>
          i % 5 === 0 || i === n - 1 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill={axis}>
              {d.label}
            </text>
          ) : null
        )}
        {/* 透明热区：负责接收鼠标事件 */}
        {data.map((d, i) => (
          <rect
            key={i}
            x={x(i) - bandW / 2}
            y={padT}
            width={bandW}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover !== null && data[hover] && (
        <Tip left={x(hover)} top={y(data[hover].value)}>
          {data[hover].label} · <b>{data[hover].value}</b>
          {unit}
        </Tip>
      )}
    </div>
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
  const [hover, setHover] = useState<number | null>(null)
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  const active = hover !== null ? segments[hover] : null
  const activePct = active && total > 0 ? Math.round((active.value / total) * 100) : 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ flex: '0 0 auto' }}>
        {total === 0 ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={muted} strokeWidth={thickness} />
        ) : (
          segments.map((seg, i) => {
            const len = (seg.value / total) * c
            const on = hover === i
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={on ? thickness + 7 : thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                opacity={hover === null || on ? 1 : 0.35}
                style={{ transition: 'stroke-width 0.15s ease, opacity 0.15s ease', cursor: 'pointer' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            )
            offset += len
            return el
          })
        )}
        {/* 悬停时中心切换为该分段数值，移开恢复总数 */}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize={24} fontWeight={700} fill={active ? active.color : text}>
          {active ? active.value : centerValue}
        </text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" fontSize={11} fill={muted}>
          {active ? `${active.label} · ${activePct}%` : centerLabel}
        </text>
      </svg>
      <div style={{ flex: 1, minWidth: 140 }}>
        {segments.map((seg, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              marginBottom: 8,
              cursor: 'pointer',
              opacity: hover === null || hover === i ? 1 : 0.45,
              transition: 'opacity 0.15s ease'
            }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
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
  height = 240,
  unit = ''
}: {
  items: { label: string; value: number; color: string }[]
  grid: string
  axis: string
  height?: number
  unit?: string
}) {
  const { wrapRef, w } = useMeasuredWidth(480)
  const [hover, setHover] = useState<number | null>(null)

  const labelW = Math.round(w * 0.34)
  const gutter = Math.round(w * 0.08)
  const gap = 14
  const minRow = 26
  const maxRow = 46
  // 行高自适应：条目少时撑满卡片高度（避免大框里只显示一小条），条目多时受 minRow 约束并让卡片纵向撑开
  const fit = (height - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length)
  const rowH = Math.min(maxRow, Math.max(minRow, fit))
  const contentH = items.length * rowH + (items.length - 1) * gap
  const H = Math.max(height, contentH)
  // 内容不足卡片高度时垂直居中，让大框里不再有大片空白
  const topPad = H > contentH ? 0 : (height - contentH) / 2
  const barArea = w - labelW - gutter
  const max = Math.max(1, ...items.map((d) => d.value))
  const total = items.reduce((s, x) => s + x.value, 0)

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" role="img">
        {items.map((d, i) => {
          const yy = topPad + i * (rowH + gap)
          const bw = Math.max(2, (d.value / max) * barArea)
          const on = hover === i
          return (
            <g key={i} opacity={hover === null || on ? 1 : 0.45} style={{ transition: 'opacity 0.15s ease' }}>
              <text x={labelW - 10} y={yy + rowH / 2 + 5} textAnchor="end" fontSize={14} fill={axis}>
                {d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label}
              </text>
              <rect x={labelW} y={yy} width={barArea} height={rowH} rx={8} fill={grid} />
              <rect x={labelW} y={yy} width={bw} height={rowH} rx={8} fill={d.color} />
              <text x={labelW + bw + 10} y={yy + rowH / 2 + 5} fontSize={14} fill={axis} fontWeight={600}>
                {d.value}
              </text>
              {/* 整行透明热区 */}
              <rect
                x={0}
                y={yy}
                width={w}
                height={rowH}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>
      {hover !== null && items[hover] && (
        <Tip left={labelW + Math.max(2, (items[hover].value / max) * barArea)} top={topPad + hover * (rowH + gap) + rowH / 2} anchor="middle">
          {items[hover].label} · <b>{items[hover].value}</b>
          {unit}
          {total > 0 ? `（${Math.round((items[hover].value / total) * 100)}%）` : ''}
        </Tip>
      )}
    </div>
  )
}
