import { useEffect, useState } from 'react'
import { GlobalOutlined } from '@ant-design/icons'
import { useT } from '../i18n'

/**
 * 登录页左侧视觉：深空蓝渐变 + 网格 + 浮动粒子 + 品牌标题 + **功能轮播**。
 *
 * 轮播规则（按需求）：
 * - 3 张插画 + 下方文案，每 2 秒自动切换；
 * - 鼠标移入轮播区域暂停，移出继续；
 * - **禁止手动切换**：不提供左右箭头，底部指示点也不可点击，仅作进度展示。
 *
 * 插画全部内联 SVG（渐变 + 动效），无外部图片依赖、无新增包。
 */

// ---------- 三张插画 ----------

/** 1) AI 智能体：机器人 + 神经网络 + 指令气泡 */
function ArtAi() {
  return (
    <svg viewBox="0 0 340 240" className="login-art" role="img" aria-label="AI agent">
      <defs>
        <linearGradient id="aiBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8ab6ff" />
          <stop offset="100%" stopColor="#4b6cff" />
        </linearGradient>
        <radialGradient id="aiGlow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#6f8cff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#6f8cff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="170" cy="110" r="95" fill="url(#aiGlow)" />

      {/* 神经网络连线 */}
      <g stroke="rgba(160,195,255,.45)" strokeWidth="1.4" fill="none">
        <path d="M60 70 L150 105" />
        <path d="M60 130 L150 115" />
        <path d="M60 190 L150 130" />
        <path d="M280 70 L190 105" />
        <path d="M280 130 L190 115" />
        <path d="M280 190 L190 130" />
      </g>
      <g fill="#9fc0ff">
        <circle cx="60" cy="70" r="5" />
        <circle cx="60" cy="130" r="5" />
        <circle cx="60" cy="190" r="5" />
        <circle cx="280" cy="70" r="5" />
        <circle cx="280" cy="130" r="5" />
        <circle cx="280" cy="190" r="5" />
      </g>

      {/* 机器人主体 */}
      <rect x="128" y="72" width="84" height="72" rx="20" fill="url(#aiBody)" stroke="rgba(255,255,255,.6)" strokeWidth="1.5" />
      <line x1="170" y1="72" x2="170" y2="52" stroke="rgba(255,255,255,.7)" strokeWidth="2" />
      <circle cx="170" cy="48" r="5" fill="#aef0ff">
        <animate attributeName="opacity" values="1;.35;1" dur="1.8s" repeatCount="indefinite" />
      </circle>
      <circle cx="152" cy="104" r="7" fill="#0b1a3a" />
      <circle cx="188" cy="104" r="7" fill="#0b1a3a" />
      <circle cx="154" cy="102" r="2.2" fill="#fff" />
      <circle cx="190" cy="102" r="2.2" fill="#fff" />
      <rect x="150" y="122" width="40" height="6" rx="3" fill="rgba(255,255,255,.75)" />

      {/* 指令气泡：正在接收自然语言指令 */}
      <rect x="196" y="158" width="104" height="34" rx="12" fill="rgba(140,180,255,.28)" stroke="rgba(190,220,255,.55)" />
      <circle cx="216" cy="175" r="4" fill="#cfe4ff">
        <animate attributeName="opacity" values=".3;1;.3" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle cx="230" cy="175" r="4" fill="#cfe4ff">
        <animate attributeName="opacity" values=".3;1;.3" dur="1.4s" begin=".2s" repeatCount="indefinite" />
      </circle>
      <circle cx="244" cy="175" r="4" fill="#cfe4ff">
        <animate attributeName="opacity" values=".3;1;.3" dur="1.4s" begin=".4s" repeatCount="indefinite" />
      </circle>
    </svg>
  )
}

/** 2) 隐私安全：盾牌 + 锁 + 环绕加密环 */
function ArtPrivacy() {
  return (
    <svg viewBox="0 0 340 240" className="login-art" role="img" aria-label="privacy and security">
      <defs>
        <linearGradient id="pvShield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6ff0d0" />
          <stop offset="100%" stopColor="#12a5a0" />
        </linearGradient>
        <radialGradient id="pvGlow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#3fe0c0" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#3fe0c0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="170" cy="110" r="95" fill="url(#pvGlow)" />

      {/* 环绕加密环 */}
      <circle cx="170" cy="118" r="82" fill="none" stroke="rgba(120,240,215,.35)" strokeWidth="1.5" strokeDasharray="7 9">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 170 118"
          to="360 170 118"
          dur="16s"
          repeatCount="indefinite"
        />
      </circle>

      {/* 盾牌 */}
      <path
        d="M170 46 L228 68 V126 C228 172 202 198 170 214 C138 198 112 172 112 126 V68 Z"
        fill="url(#pvShield)"
        stroke="rgba(255,255,255,.6)"
        strokeWidth="1.5"
      />
      {/* 锁 */}
      <rect x="152" y="120" width="36" height="28" rx="6" fill="rgba(6,40,45,.85)" />
      <path
        d="M158 120 v-8 a12 12 0 0 1 24 0 v8"
        fill="none"
        stroke="rgba(255,255,255,.9)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="170" cy="134" r="4" fill="#9ff5e2" />
    </svg>
  )
}

/** 3) 多账号防关联：三张独立窗口 + 隔断线 */
function ArtIsolate() {
  const cards = [
    { x: 44, color: '#7ad1ff' },
    { x: 132, color: '#ffd166' },
    { x: 220, color: '#ff8fb1' }
  ]
  return (
    <svg viewBox="0 0 340 240" className="login-art" role="img" aria-label="isolated multi-account profiles">
      <defs>
        <radialGradient id="isoGlow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#c07bff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#c07bff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="170" cy="110" r="95" fill="url(#isoGlow)" />

      {/* 卡片之间的隔断线：明确表示「互不关联」 */}
      <g stroke="rgba(255,255,255,.35)" strokeWidth="1.4" strokeDasharray="4 6">
        <line x1="124" y1="48" x2="124" y2="172" />
        <line x1="212" y1="48" x2="212" y2="172" />
      </g>

      {cards.map((c, i) => (
        <g key={c.x}>
          <rect x={c.x} y="62" width="72" height="92" rx="10" fill="rgba(255,255,255,.10)" stroke="rgba(230,215,255,.55)" strokeWidth="1.4" />
          {/* 窗口标题栏 */}
          <rect x={c.x} y="62" width="72" height="16" rx="10" fill="rgba(255,255,255,.16)" />
          <circle cx={c.x + 12} cy="70" r="3" fill={c.color} />
          <circle cx={c.x + 22} cy="70" r="3" fill="rgba(255,255,255,.5)" />
          {/* 指纹纹路：三张各不相同，表示每个环境指纹独立 */}
          <g stroke={c.color} strokeWidth="2.4" fill="none" strokeLinecap="round" opacity=".9">
            <path d={`M${c.x + 14} ${96 + i * 3} h${16 + i * 6}`} />
            <path d={`M${c.x + 14} ${108 + i * 2} h${26 - i * 4}`} />
            <path d={`M${c.x + 14} ${120} h${20 + i * 5}`} />
          </g>
        </g>
      ))}

      {/* 三个账号各自独立的标识点 */}
      <g fill="rgba(255,255,255,.75)">
        <circle cx="80" cy="192" r="4" />
        <circle cx="170" cy="192" r="4" />
        <circle cx="260" cy="192" r="4" />
      </g>
    </svg>
  )
}

// as const 必不可少：否则 titleKey / descKey 会被推断成 string，
// 而 t() 的参数是「词典 key 的字面量联合类型」，string 传不进去（TS2345）。
const SLIDES = [
  { key: 'ai', Art: ArtAi, titleKey: 'login.slideAiTitle', descKey: 'login.slideAiDesc' },
  { key: 'privacy', Art: ArtPrivacy, titleKey: 'login.slidePrivacyTitle', descKey: 'login.slidePrivacyDesc' },
  { key: 'isolate', Art: ArtIsolate, titleKey: 'login.slideIsolateTitle', descKey: 'login.slideIsolateDesc' }
] as const

const SLIDE_INTERVAL = 2000

export default function LoginVisual() {
  const t = useT()
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)

  // 每 2 秒自动切换；鼠标移入（paused）时清掉定时器实现暂停，移出后从当前张继续。
  // 刻意不提供左右箭头、指示点也不可点击——需求要求禁止手动切换。
  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => {
      setIdx((i) => (i + 1) % SLIDES.length)
    }, SLIDE_INTERVAL)
    return () => clearInterval(timer)
  }, [paused])

  const active = SLIDES[idx]

  return (
    <div className="login-aside">
      <div className="login-grid" />
      <span className="login-particle" style={{ left: '12%', top: '22%', animationDelay: '0s' }} />
      <span className="login-particle" style={{ left: '80%', top: '30%', animationDelay: '.8s' }} />
      <span className="login-particle" style={{ left: '30%', top: '72%', animationDelay: '1.6s' }} />
      <span className="login-particle" style={{ left: '64%', top: '80%', animationDelay: '2.3s' }} />
      <span className="login-particle" style={{ left: '46%', top: '14%', animationDelay: '1.1s' }} />

      <div className="login-aside-inner">
        <div className="login-brand">
          <GlobalOutlined /> RoxyBrowser
        </div>
        <h1 className="login-hero-title">{t('login.heroTitle')}</h1>
        <p className="login-hero-sub">{t('login.heroSub')}</p>

        {/* 轮播区：鼠标移入暂停、移出继续 */}
        <div
          className="login-carousel"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div className="login-slides">
            {SLIDES.map((s, i) => {
              const Art = s.Art
              return (
                <div
                  key={s.key}
                  className={`login-slide${i === idx ? ' is-active' : ''}`}
                  aria-hidden={i !== idx}
                >
                  <Art />
                </div>
              )
            })}
          </div>

          <div className="login-slide-text">
            <div className="login-slide-title">{t(active.titleKey)}</div>
            <p className="login-slide-desc">{t(active.descKey)}</p>
          </div>

          {/* 进度指示点：纯展示，不可点击（禁止手动切换） */}
          <div className="login-dots">
            {SLIDES.map((s, i) => (
              <span key={s.key} className={`login-dot${i === idx ? ' is-active' : ''}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
