import { useEffect, useRef, useState, useCallback } from 'react'
import { Button, Card, Empty, Input, Segmented, Space, Spin, Tag, Typography, Select, Switch, Alert, Modal, Form, message } from 'antd'
import { RobotOutlined, SendOutlined, ClearOutlined, SettingOutlined, PlayCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { DEFAULT_SETTINGS, type AppSettings, type AgentAction, type RpaStep } from '@shared/types'
import { useI18n } from '../i18n'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** 该条回复实际走的模式（auto 模式下由 Dispatcher 判定） */
  mode?: 'chat' | 'support'
}

type UiMode = 'auto' | 'chat' | 'support' | 'agent'

function actionLabel(a: AgentAction, t: (k: string) => string): string {
  switch (a.action) {
    case 'click':
      return `${t('aiAgent.agent.act.click')} (${a.x}, ${a.y})`
    case 'type':
      return `${t('aiAgent.agent.act.type')}: ${a.text}`
    case 'scroll':
      return `${t('aiAgent.agent.act.scroll')} ${a.delta > 0 ? '↓' : '↑'}${Math.abs(a.delta)}`
    case 'wait':
      return `${t('aiAgent.agent.act.wait')} ${a.ms}ms`
    case 'finish':
      return t('aiAgent.agent.act.finish')
    case 'ask':
      return t('aiAgent.agent.act.ask')
    default:
      return (a as { action: string }).action
  }
}

// Agent 执行闭环面板：选目标环境 → 自然语言指令 → 实时步骤流（含截图缩略）→ 停止 / 人工确认
function AgentPanel({ settings }: { settings: AppSettings }) {
  const { t } = useI18n()
  const [envs, setEnvs] = useState<{ id: number; title: string }[]>([])
  const [envId, setEnvId] = useState<number | null>(null)
  const [instruction, setInstruction] = useState('')
  const [running, setRunning] = useState(false)
  const [needApproval, setNeedApproval] = useState(settings.aiAgent.needApprovalByDefault)
  const [steps, setSteps] = useState<{ step: number; action: AgentAction; screenshot?: string }[]>([])
  const [status, setStatus] = useState('')
  const [ask, setAsk] = useState<string | null>(null)
  // 资产化：运行结束后把归一化的 RPA 步骤存为可离线回放的模板
  const [rpaSteps, setRpaSteps] = useState<RpaStep[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tplName, setTplName] = useState('')
  const [tplRemark, setTplRemark] = useState('')
  const runIdRef = useRef<string | null>(null)

  const loadEnvs = useCallback(() => {
    api
      .get<{ id: number; title: string }[]>('/api/windows')
      .then(setEnvs)
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadEnvs()
  }, [loadEnvs])

  // 订阅主进程推送的单步 / 完成 / 出错 / 待审批事件（按 runId 过滤，多 run 互不串扰）
  useEffect(() => {
    const roxy = window.roxy
    if (!roxy) return
    const offs: Array<() => void> = []
    offs.push(
      roxy.agentOnStep((d) => {
        if (d.runId !== runIdRef.current) return
        setSteps((prev) => [...prev, { step: d.step, action: d.action, screenshot: d.screenshot }])
        if (d.rpaStep) setRpaSteps((prev) => [...prev, d.rpaStep as RpaStep])
      })
    )
    offs.push(
      roxy.agentOnDone((d) => {
        if (d.runId !== runIdRef.current) return
        runIdRef.current = null
        setRunning(false)
        setStatus(d.result)
        if (d.rpaSteps?.length) setRpaSteps(d.rpaSteps)
      })
    )
    offs.push(
      roxy.agentOnError((d) => {
        if (d.runId !== runIdRef.current) return
        runIdRef.current = null
        setRunning(false)
        setStatus(`${t('aiAgent.agent.failed')}：${d.error}`)
      })
    )
    offs.push(
      roxy.agentOnNeedApproval((d) => {
        if (d.runId !== runIdRef.current) return
        setAsk(d.question)
      })
    )
    return () => offs.forEach((f) => f())
  }, [t])

  const start = async () => {
    if (!envId || !instruction.trim() || running) return
    setStatus('')
    setSteps([])
    setRpaSteps([])
    setSaveOpen(false)
    setAsk(null)
    const res = await window.roxy?.agentStart?.({ envId, instruction: instruction.trim(), options: { needApproval } })
    if (!res) {
      setStatus(t('aiAgent.agent.noEnv'))
      return
    }
    if (res.error) {
      setStatus(res.error)
      return
    }
    if (res.runId) {
      runIdRef.current = res.runId
      setRunning(true)
    }
  }
  const stop = () => {
    if (runIdRef.current) window.roxy?.agentStop?.(runIdRef.current)
    setRunning(false)
    setStatus(t('aiAgent.agent.idle'))
  }
  const approve = (ok: boolean) => {
    if (runIdRef.current) window.roxy?.agentApprove?.(runIdRef.current, ok)
    setAsk(null)
  }

  const saveTemplate = async () => {
    if (!tplName.trim() || !rpaSteps.length) return
    setSaving(true)
    try {
      const res = await api.post<{ id: number }>('/api/rpa', { name: tplName.trim(), remark: tplRemark.trim(), steps: rpaSteps })
      if (res.id) {
        message.success(t('aiAgent.agent.saveTemplateOk'))
        setSaveOpen(false)
        setTplName('')
        setTplRemark('')
      } else {
        message.error(t('aiAgent.agent.saveTemplateFail'))
      }
    } catch (e) {
      message.error(`${t('aiAgent.agent.saveTemplateFail')}：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {envs.length === 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('aiAgent.agent.noEnv')} />
      )}
      <Space wrap size={12} style={{ display: 'flex', marginBottom: 12 }}>
        <Select
          style={{ width: 280 }}
          placeholder={envs.length ? t('aiAgent.agent.env') : t('aiAgent.agent.noEnv')}
          value={envId ?? undefined}
          onChange={(v: number) => setEnvId(v)}
          options={envs.map((e) => ({ value: e.id, label: `#${e.id} ${e.title}` }))}
          notFoundContent={t('aiAgent.agent.noEnv')}
        />
        <Button icon={<ReloadOutlined />} onClick={loadEnvs}>
          {t('aiAgent.agent.refresh')}
        </Button>
        <Space size={6}>
          <Switch checked={needApproval} onChange={(v) => setNeedApproval(v)} />
          <Typography.Text type="secondary">{t('aiAgent.agent.needApproval')}</Typography.Text>
        </Space>
      </Space>

      <Input.TextArea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={t('aiAgent.agent.instructionPlaceholder')}
        autoSize={{ minRows: 2, maxRows: 5 }}
        disabled={running}
      />

      <Space style={{ marginTop: 12 }}>
        {running ? (
          <Button danger icon={<ClearOutlined />} onClick={stop}>
            {t('aiAgent.agent.stop')}
          </Button>
        ) : (
          <Button type="primary" icon={<PlayCircleOutlined />} disabled={!envId || !instruction.trim()} onClick={start}>
            {t('aiAgent.agent.start')}
          </Button>
        )}
        <Tag color={running ? 'green' : 'default'}>{running ? t('aiAgent.agent.running') : t('aiAgent.agent.idle')}</Tag>
      </Space>

      {ask && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={t('aiAgent.agent.ask')}
          description={ask}
          action={
            <Space>
              <Button size="small" type="primary" onClick={() => approve(true)}>
                {t('aiAgent.agent.continue')}
              </Button>
              <Button size="small" danger onClick={() => approve(false)}>
                {t('aiAgent.agent.abort')}
              </Button>
            </Space>
          }
        />
      )}

      {status && (
        <Typography.Paragraph
          style={{ marginTop: 12 }}
          type={status.startsWith(t('aiAgent.agent.failed')) ? 'danger' : 'secondary'}
        >
          {status}
        </Typography.Paragraph>
      )}

      {steps.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong>{t('aiAgent.agent.steps')}</Typography.Text>
          <div
            style={{
              maxHeight: 'calc(100vh - 470px)',
              minHeight: 120,
              overflowY: 'auto',
              marginTop: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            {steps.map((s) => (
              <div
                key={s.step}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: 8,
                  borderRadius: 8,
                  background: 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.04))'
                }}
              >
                {s.screenshot && (
                  <img
                    src={s.screenshot}
                    alt=""
                    style={{ width: 160, borderRadius: 6, border: '1px solid rgba(0,0,0,0.1)', flexShrink: 0 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 4 }}>
                    <Tag color="blue">#{s.step}</Tag>
                    <Tag>{actionLabel(s.action, t as (k: string) => string)}</Tag>
                  </div>
                  <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                    {s.action.thought || actionLabel(s.action, t as (k: string) => string)}
                  </Typography.Text>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {!running && rpaSteps.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Button type="dashed" icon={<SaveOutlined />} onClick={() => setSaveOpen(true)}>
            {t('aiAgent.agent.saveTemplate')}（{rpaSteps.length}）
          </Button>
        </div>
      )}
      <Modal
        title={t('aiAgent.agent.saveTemplate')}
        open={saveOpen}
        onOk={saveTemplate}
        confirmLoading={saving}
        okText={t('aiAgent.agent.saveTemplate')}
        cancelText={t('aiAgent.agent.cancel')}
        onCancel={() => setSaveOpen(false)}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label={t('aiAgent.agent.templateName')} required>
            <Input
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              placeholder={t('aiAgent.agent.templateNamePlaceholder')}
              maxLength={128}
            />
          </Form.Item>
          <Form.Item label={t('aiAgent.agent.templateRemark')}>
            <Input.TextArea
              value={tplRemark}
              onChange={(e) => setTplRemark(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={512}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default function AiAgent() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [uiMode, setUiMode] = useState<UiMode>('auto')
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
      const res = await api.post<{ reply: string; mode: 'chat' | 'support' }>('/api/ai-agent/chat', {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        mode: uiMode === 'agent' ? 'auto' : uiMode
      })
      setMessages([
        ...next,
        { role: 'assistant', content: res.reply || '（模型返回了空回复）', mode: res.mode }
      ])
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
  const title = uiMode === 'agent' ? t('aiAgent.agent.title') : t('aiAgent.chat.title')

  return (
    <Card
      title={
        <Space>
          <RobotOutlined />
          {title}
        </Space>
      }
      extra={
        <Space size={8}>
          <Segmented
            value={uiMode}
            onChange={(v) => setUiMode(v as UiMode)}
            options={[
              { value: 'auto', label: t('aiAgent.modeAuto') },
              { value: 'chat', label: t('aiAgent.modeChat') },
              { value: 'support', label: t('aiAgent.modeSupport') },
              { value: 'agent', label: t('aiAgent.modeAgent') }
            ]}
          />
          {uiMode !== 'agent' && (
            <>
              <Tag color={a.backend === 'local' ? 'green' : 'blue'}>
                {a.backend === 'local' ? t('aiAgent.backendLocal') : t('aiAgent.backendCloud')}
              </Tag>
              <Tag>{a.backend === 'local' ? a.localModel : a.cloudModel || '-'}</Tag>
              <Button
                size="small"
                icon={<ClearOutlined />}
                disabled={!messages.length || sending}
                onClick={() => setMessages([])}
              >
                {t('aiAgent.chat.clear')}
              </Button>
            </>
          )}
        </Space>
      }
    >
      {uiMode === 'agent' ? (
        <AgentPanel settings={settings} />
      ) : (
        <>
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
                    background:
                      m.role === 'user'
                        ? 'rgba(22,119,255,0.10)'
                        : 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.06))'
                  }}
                >
                  {m.role === 'assistant' && m.mode === 'support' && (
                    <div style={{ marginBottom: 4 }}>
                      <Tag color="geekblue" style={{ marginRight: 0 }}>
                        {t('aiAgent.modeSupport')}
                      </Tag>
                    </div>
                  )}
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
        </>
      )}
    </Card>
  )
}
