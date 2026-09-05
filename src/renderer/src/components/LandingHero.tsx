import { useNavigate } from 'react-router-dom'

/**
 * 营销落地页 Hero 区块
 * 复刻截图中的绿色双栏结构：左侧文案 + CTA，右侧浏览器数据看板 mockup。
 * 完全用 React + inline SVG 实现，无外部图片依赖，缩放清晰。
 */
export default function LandingHero() {
  const navigate = useNavigate()

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        minHeight: 520,
        borderRadius: 24,
        overflow: 'hidden',
        background: 'linear-gradient(135deg, #5fd489 0%, #4ac07d 50%, #3bb073 100%)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
        padding: '48px',
        boxSizing: 'border-box'
      }}
    >
      {/* 装饰性背景波浪，让绿色不那么单调 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          opacity: 0.25
        }}
      >
        <svg width='100%' height='100%' viewBox='0 0 1200 520' preserveAspectRatio='none'>
          <path
            d='M0 520 C300 460 500 520 800 480 S1100 400 1200 420 L1200 520 Z'
            fill='rgba(255,255,255,0.35)'
          />
          <path
            d='M0 520 C400 500 700 440 900 470 S1100 500 1200 490 L1200 520 Z'
            fill='rgba(255,255,255,0.18)'
          />
        </svg>
      </div>

      {/* 左侧文案 */}
      <div style={{ position: 'relative', zIndex: 1, flex: '1 1 360px', maxWidth: 420, minWidth: 320, color: '#fff' }}>
        <h1
          style={{
            margin: 0,
            fontSize: 40,
            fontWeight: 700,
            lineHeight: 1.25,
            letterSpacing: '-0.02em'
          }}
        >
          用指纹浏览器，稳定提升付费广告投放效率
        </h1>
        <p
          style={{
            margin: '24px 0 0',
            fontSize: 16,
            lineHeight: 1.75,
            opacity: 0.92,
            maxWidth: 400
          }}
        >
          指纹浏览器为广告投放打造隔离、安全的测试环境，避免账户被封、数据异常，让广告更高效、更可控。
        </p>
        <button
          onClick={() => navigate('/login')}
          style={{
            marginTop: 36,
            padding: '12px 28px',
            fontSize: 16,
            fontWeight: 500,
            color: '#3bb073',
            background: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            transition: 'transform .15s, box-shadow .15s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)'
            e.currentTarget.style.boxShadow = '0 12px 32px rgba(0,0,0,0.16)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)'
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.12)'
          }}
        >
          免费使用
        </button>
      </div>

      {/* 右侧浏览器 mockup */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          flex: '1.4 1 480px',
          display: 'flex',
          justifyContent: 'center',
          minWidth: 460
        }}
      >
        <BrowserMockup />
      </div>
    </div>
  )
}

function BrowserMockup() {
  return (
    <div
      style={{
        width: 540,
        background: '#fff',
        borderRadius: 16,
        boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        overflow: 'hidden',
        border: '1px solid rgba(0,0,0,0.06)'
      }}
    >
      {/* 浏览器标题栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 18px',
          borderBottom: '1px solid #f0f0f0',
          background: '#fafafa'
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840' }} />
        <div
          style={{
            marginLeft: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
            fontWeight: 600,
            color: '#444'
          }}
        >
          {/* Google Ads 风格图标 */}
          <svg width='22' height='22' viewBox='0 0 24 24'>
            <circle cx='12' cy='12' r='10' fill='#4285f4' />
            <path d='M7 12l5-5 5 5' stroke='#fff' strokeWidth='2.2' fill='none' strokeLinecap='round' strokeLinejoin='round' />
            <path d='M12 7v10' stroke='#fff' strokeWidth='2.2' fill='none' strokeLinecap='round' />
          </svg>
          Google Ads
        </div>
      </div>

      {/* 看板内容区 */}
      <div style={{ padding: '24px 28px 32px', position: 'relative' }}>
        {/* 顶部控制栏：指标 + 时间粒度 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <LegendItem color='#4285f4' label='View' active />
            <LegendItem color='#ff8f00' label='Click' />
            <LegendItem color='#34a853' label='Dwell Time' />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['Day', 'Week', 'Month'].map((t, i) => (
              <button
                key={t}
                style={{
                  padding: '5px 14px',
                  fontSize: 13,
                  borderRadius: 6,
                  border: '1px solid #e8e8e8',
                  background: i === 0 ? '#f6f6f6' : '#fff',
                  color: i === 0 ? '#333' : '#888',
                  fontWeight: i === 0 ? 500 : 400,
                  cursor: 'default'
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* 折线图 */}
        <div style={{ position: 'relative', height: 220 }}>
          <svg width='100%' height='100%' viewBox='0 0 560 220' preserveAspectRatio='none'>
            {/* 网格横线 */}
            {[0, 1, 2, 3, 4].map((i) => (
              <line
                key={i}
                x1={50}
                y1={20 + i * 44}
                x2={540}
                y2={20 + i * 44}
                stroke='#f0f0f0'
                strokeWidth={1}
              />
            ))}

            {/* 三条折线 */}
            <ChartLine
              color='#4285f4'
              path='M50 155 C90 148, 130 120, 170 128 C210 136, 250 78, 310 82 C370 86, 460 36, 540 30'
            />
            <ChartLine
              color='#ff8f00'
              path='M50 168 C100 160, 150 140, 200 146 C250 152, 300 100, 350 106 C400 112, 490 70, 540 68'
            />
            <ChartLine
              color='#34a853'
              path='M50 185 C110 178, 180 168, 250 172 C320 176, 420 140, 540 132'
            />

            {/* 高亮点（右侧 tooltip 附近） */}
            <circle cx={520} cy={30} r={5} fill='#fff' stroke='#4285f4' strokeWidth={2.5} />
            <circle cx={520} cy={68} r={5} fill='#fff' stroke='#ff8f00' strokeWidth={2.5} />
            <circle cx={520} cy={132} r={5} fill='#fff' stroke='#34a853' strokeWidth={2.5} />

            {/* X 轴刻度 */}
            {['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'].map((t, i) => (
              <text
                key={t}
                x={50 + i * (490 / 6)}
                y={210}
                textAnchor='middle'
                fill='#9e9e9e'
                fontSize={11}
              >
                {t}
              </text>
            ))}
          </svg>

          {/* 数据 tooltip */}
          <div
            style={{
              position: 'absolute',
              right: 24,
              top: 18,
              padding: '12px 16px',
              background: '#1e293b',
              borderRadius: 10,
              color: '#fff',
              fontSize: 13,
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)'
            }}
          >
            <TooltipRow color='#60a5fa' value='68.2k' />
            <TooltipRow color='#fbbf24' value='10k' style={{ marginTop: 6 }} />
            <TooltipRow color='#4ade80' value='14.2s' style={{ marginTop: 6 }} />
          </div>

          {/* Manager 浮动卡片 */}
          <FloatingCard
            left={-18}
            top={48}
            bg='#3b82f6'
            iconBg='#2563eb'
            label='Manager'
          />

          {/* Agent 浮动卡片 */}
          <FloatingCard
            right={-18}
            bottom={28}
            bg='#34a853'
            iconBg='#2e8b4a'
            label='Agent'
          />
        </div>
      </div>
    </div>
  )
}

function LegendItem({ color, label, active }: { color: string; label: string; active?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: active ? 1 : 0.65 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 13, color: '#444', fontWeight: active ? 500 : 400 }}>{label}</span>
    </div>
  )
}

function ChartLine({ color, path }: { color: string; path: string }) {
  return (
    <path
      d={path}
      fill='none'
      stroke={color}
      strokeWidth={2.8}
      strokeLinecap='round'
      strokeLinejoin='round'
    />
  )
}

function TooltipRow({
  color,
  value,
  style
}: {
  color: string
  value: string
  style?: React.CSSProperties
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontWeight: 600, fontSize: 14 }}>{value}</span>
    </div>
  )
}

function FloatingCard({
  label,
  bg,
  iconBg,
  left,
  right,
  top,
  bottom
}: {
  label: string
  bg: string
  iconBg: string
  left?: number
  right?: number
  top?: number
  bottom?: number
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: left !== undefined ? left : undefined,
        right: right !== undefined ? right : undefined,
        top: top !== undefined ? top : undefined,
        bottom: bottom !== undefined ? bottom : undefined,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        borderRadius: 20,
        background: bg,
        color: '#fff',
        fontSize: 13,
        fontWeight: 500,
        boxShadow: '0 8px 20px rgba(0,0,0,0.14)',
        zIndex: 2
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <svg width='14' height='14' viewBox='0 0 24 24' fill='none'>
          <circle cx='12' cy='9' r='4' stroke='#fff' strokeWidth='2' />
          <path d='M6 21c0-3.3 2.7-6 6-6s6 2.7 6 6' stroke='#fff' strokeWidth='2' strokeLinecap='round' />
        </svg>
      </div>
      {label}
    </div>
  )
}
