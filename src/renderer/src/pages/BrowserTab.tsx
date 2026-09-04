import { useEffect, useState } from 'react'
import { Input, Tag, Typography, Space, Card } from 'antd'
import { GlobalOutlined, ArrowRightOutlined, SafetyOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { osLabel } from '@shared/types'

interface ProfileInfo {
  id: number
  name: string
  seq: number
  platform: string
  startUrl: string
  proxyCountry: string
  fingerprint: {
    os: string
    timezone: string
    languages: string[]
    screenWidth: number
    screenHeight: number
    userAgent: string
  }
}

const QUICK_LINKS = [
  { name: 'Amazon', url: 'https://www.amazon.com' },
  { name: 'Facebook', url: 'https://www.facebook.com' },
  { name: 'Instagram', url: 'https://www.instagram.com' },
  { name: 'TikTok', url: 'https://www.tiktok.com' },
  { name: 'eBay', url: 'https://www.ebay.com' },
  { name: 'Etsy', url: 'https://www.etsy.com' },
  { name: 'Google', url: 'https://www.google.com' },
  { name: '浏览器指纹检测', url: 'https://browserleaks.com/canvas' }
]

export default function BrowserTab() {
  const [params] = useSearchParams()
  const profileId = params.get('profileId')
  const [info, setInfo] = useState<ProfileInfo | null>(null)
  const [url, setUrl] = useState('')

  const apiBase = window.roxy?.apiBase || 'http://127.0.0.1:39100'

  useEffect(() => {
    if (!profileId) return
    fetch(`${apiBase}/api/browser/profile-info/${profileId}`)
      .then((r) => r.json())
      .then((d: ProfileInfo) => {
        setInfo(d)
        setUrl(d.startUrl || '')
      })
      .catch(() => {
        /* ignore */
      })
  }, [profileId, apiBase])

  const navigate = (target?: string) => {
    let u = (target ?? url).trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u)) {
      u = u.includes('.') && !u.includes(' ') ? `https://${u}` : `https://www.google.com/search?q=${encodeURIComponent(u)}`
    }
    window.location.href = u
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #101a3a 0%, #1d2b64 100%)',
        padding: '60px 40px 40px',
        boxSizing: 'border-box'
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <GlobalOutlined style={{ fontSize: 40, color: '#6a8dff' }} />
        </div>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <Typography.Title level={3} style={{ color: '#fff', margin: 0 }}>
            {info ? `#${info.seq} ${info.name}` : 'RoxyBrowser Clone'}
          </Typography.Title>
          <Space style={{ marginTop: 8 }}>
            <Tag icon={<SafetyOutlined />} color="success">
              指纹环境已启用
            </Tag>
            {info?.proxyCountry && <Tag color="blue">代理地区：{info.proxyCountry}</Tag>}
            {info?.platform && <Tag color="purple">{info.platform}</Tag>}
          </Space>
        </div>

        <Input.Search
          size="large"
          placeholder="输入网址或搜索关键词，回车访问"
          enterButton={<ArrowRightOutlined />}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onSearch={() => navigate()}
          style={{ marginBottom: 36 }}
        />

        <Space size={12} wrap style={{ justifyContent: 'center', width: '100%' }}>
          {QUICK_LINKS.map((l) => (
            <Card
              key={l.name}
              size="small"
              hoverable
              onClick={() => navigate(l.url)}
              style={{ minWidth: 130, textAlign: 'center', borderRadius: 8 }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{l.name}</div>
            </Card>
          ))}
        </Space>

        {info && (
          <Card size="small" style={{ marginTop: 40, background: 'rgba(255,255,255,0.92)', borderRadius: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前环境指纹摘要（右键页面可返回 / 刷新 / 打开开发者工具）
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Tag>{osLabel(info.fingerprint.os)}</Tag>
              <Tag color="geekblue">{info.fingerprint.timezone}</Tag>
              <Tag color="purple">{info.fingerprint.languages.join(', ')}</Tag>
              <Tag color="cyan">
                {info.fingerprint.screenWidth}×{info.fingerprint.screenHeight}
              </Tag>
            </div>
            <Typography.Paragraph style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }} type="secondary" ellipsis>
              {info.fingerprint.userAgent}
            </Typography.Paragraph>
          </Card>
        )}
      </div>
    </div>
  )
}
