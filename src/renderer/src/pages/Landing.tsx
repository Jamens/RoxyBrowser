import LandingHero from '../components/LandingHero'

/**
 * 营销落地页（当前仅作 Hero 区块预览）。
 * 可以扩展为完整官网首页：上方 Hero、功能亮点、价格、FAQ 等。
 */
export default function Landing() {
  return (
    <div
      style={{
        width: '100%',
        minHeight: '100vh',
        background: '#f5f7fa',
        padding: '64px 5vw',
        boxSizing: 'border-box'
      }}
    >
      <LandingHero />

      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <p
          style={{
            marginTop: 48,
            textAlign: 'center',
            color: '#888',
            fontSize: 14
          }}
        >
          此页面为营销落地页预览，可继续扩展功能模块、客户案例、价格方案等。
        </p>
      </div>
    </div>
  )
}
