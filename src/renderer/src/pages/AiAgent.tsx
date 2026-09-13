import { useEffect, useRef, useState } from 'react'
import { Button, Card, Empty, Input, Space, Spin, Tag, Typography } from 'antd'
import { RobotOutlined, SendOutlined, ClearOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { useI18n } from '../i18n'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export default function AiAgent() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  // 对话滚动容器：新消息到达时滚到底部
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .get<AppSettings>('/api/settings')
      .then(setSettings)
      .catch(() => setSettings(null))
      .finally(() => setLoadingSettings(false))
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, sending])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setSending(true)
    try {
      const res = await api.post<{ reply: string }>('/api/ai-agent/chat', {
        messages: next.map((m) => ({ role: m.role, content: m.content }))
      })
      setMessages([...next, { role: 'assistant', content: res.reply || '（模型返回了空回复）' }])
    } catch (e) {
      // 失败时保留用户消息，方便改后重发
      setMessages([...next, { role: 'assistant', content: `⚠️ ${(e as Error).message}` }])
    } finally {
      setSending(false)
    }
  }

  // 未启用：给明确引导而不是报错
  if (loadingSettings) {
    return (
      <Card>
        <Spin />
      </Card>
    )
  }

  if (!settings?.aiAgent?.enabled) {
    return (
      <Card>
        <Empty
          image={<RobotOutlined style={{ fontSize: 48, color: '#1677ff' }} />}
          description={t('aiAgent.chat.disabled')}
        >
          <Button type="primary" icon={<SettingOutlined />} onClick={() => navigate('/settings')}>
            {t('aiAgent.chat.goSettings')}
          </Button>
        </Empty>
      </Card>
    )
  }

  const a = settings.aiAgent

  return (
    <Card
      title={
        <Space>
          <RobotOutlined />
          {t('aiAgent.chat.title')}
        </Space>
      }
      extra={
        <Space size={8}>
          <Tag color={a.backend === 'local' ? 'green' : 'blue'}>
            {a.backend === 'local' ? t('aiAgent.backendLocal') : t('aiAgent.backendCloud')}
          </Tag>
          <Tag>{a.backend === 'local' ? a.localModel : a.cloudModel || '-'}</Tag>
          <Button size="small" icon={<ClearOutlined />} disabled={!messages.length || sending} onClick={() => setMessages([])}>
            {t('aiAgent.chat.clear')}
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('aiAgent.chat.subtitle')}
      </Typography.Paragraph>

      {/* 对话区：固定高度可滚动，气泡左右分列 */}
      <div
        ref={listRef}
        style={{
          height: 'calc(100vh - 320px)',
          minHeight: 320,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '4px 4px'
        }}
      >
        {!messages.length && !sending && (
          <div style={{ margin: 'auto', opacity: 0.65 }}>
            <Empty description={t('aiAgent.chat.emptyHistory')} />
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div
              style={{
                maxWidth: '78%',
                padding: '8px 12px',
                borderRadius: 10,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.6,
                // 用户气泡主色淡染，助手气泡中性底色，明暗主题均由 token 提供
                background:
                  m.role === 'user'
                    ? 'rgba(22,119,255,0.10)'
                    : 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.06))'
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '8px 12px' }}>
              <Spin size="small" /> <Typography.Text type="secondary">{t('aiAgent.chat.thinking')}</Typography.Text>
            </div>
          </div>
        )}
      </div>

      {/* 输入区：Enter 发送，Shift+Enter 换行 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={t('aiAgent.chat.placeholder')}
          autoSize={{ minRows: 1, maxRows: 5 }}
          disabled={sending}
        />
        <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={send} disabled={!input.trim()}>
          {t('aiAgent.chat.send')}
        </Button>
      </div>
    </Card>
  )
}
