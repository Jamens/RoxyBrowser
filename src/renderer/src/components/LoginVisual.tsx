import { GlobalOutlined, SafetyCertificateOutlined, LockOutlined, ApiOutlined } from '@ant-design/icons'
import { useT } from '../i18n'

/**
 * 登录页左侧科技感视觉：深空蓝渐变 + 网格 + 浮动粒子 +
 * 中心「安全盾牌」（指纹弧 + 对勾）+ 环绕加密节点 + 扫描光带。
 * 全部用内联 SVG + SMIL/CSS 动画，无新增依赖，跟随登录页自带暗色主题。
 */
export default function LoginVisual() {
  const t = useT()
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

        <div className="login-shield-wrap">
          <svg viewBox="0 0 420 380" className="login-shield-svg" role="img" aria-label="security shield">
            <defs>
              <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5ad1ff" />
                <stop offset="100%" stopColor="#2b6bff" />
              </linearGradient>
              <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#3aa0ff" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#3aa0ff" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="scanGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#5ad1ff" stopOpacity="0" />
                <stop offset="50%" stopColor="#aef0ff" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#5ad1ff" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* 外发光 */}
            <circle cx="210" cy="180" r="120" fill="url(#glowGrad)">
              <animate attributeName="r" values="110;128;110" dur="4s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;1;0.6" dur="4s" repeatCount="indefinite" />
            </circle>

            {/* 环绕加密节点 + 连线 */}
            <g>
              <animateTransform attributeName="transform" type="rotate" from="0 210 180" to="360 210 180" dur="20s" repeatCount="indefinite" />
              <line x1="210" y1="180" x2="210" y2="60" stroke="rgba(120,200,255,.35)" strokeWidth="1.5" />
              <line x1="210" y1="180" x2="330" y2="240" stroke="rgba(120,200,255,.35)" strokeWidth="1.5" />
              <line x1="210" y1="180" x2="90" y2="240" stroke="rgba(120,200,255,.35)" strokeWidth="1.5" />
              <circle cx="210" cy="60" r="7" fill="#5ad1ff" />
              <circle cx="330" cy="240" r="7" fill="#5ad1ff" />
              <circle cx="90" cy="240" r="7" fill="#5ad1ff" />
            </g>

            {/* 指纹弧 */}
            <g fill="none" stroke="rgba(150,210,255,.30)" strokeWidth="2" strokeLinecap="round">
              <path d="M170 150 a40 40 0 0 1 80 0" />
              <path d="M158 150 a52 52 0 0 1 104 0" />
              <path d="M146 150 a64 64 0 0 1 128 0" />
            </g>

            {/* 安全盾牌 */}
            <path
              d="M210 96 L276 122 V188 C276 246 246 280 210 300 C174 280 144 246 144 188 V122 Z"
              fill="url(#shieldGrad)"
              stroke="rgba(255,255,255,.55)"
              strokeWidth="1.5"
            />
            {/* 对勾 */}
            <path d="M186 188 L204 208 L238 162" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />

            {/* 扫描光带 */}
            <g>
              <rect x="150" y="120" width="120" height="3" rx="1.5" fill="url(#scanGrad)" />
              <animateTransform attributeName="transform" type="translate" from="0 -40" to="0 150" dur="3.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;1;1;0" dur="3.4s" repeatCount="indefinite" />
            </g>
          </svg>
        </div>

        <div className="login-feats">
          <div className="login-feat">
            <SafetyCertificateOutlined /> {t('login.feat1')}
          </div>
          <div className="login-feat">
            <LockOutlined /> {t('login.feat2')}
          </div>
          <div className="login-feat">
            <ApiOutlined /> {t('login.feat3')}
          </div>
        </div>
      </div>
    </div>
  )
}
