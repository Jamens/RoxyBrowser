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

type EnvStatus = { status: 'running' | 'done' | 'failed'; result?: string }
type EnvStep = { step: number; action: AgentAction; screenshot?: string }

// 单个环境在矩阵运行里的进度卡片：各自独立显示状态 / 截图 / 执行轨迹 / 存模板入口
function EnvCard({
  envId,
  title,
  status,
  steps,
  rpaSteps,
  onSave
}: {
  envId: number
  title: string
  status?: EnvStatus
  steps: EnvStep[]
  rpaSteps: RpaStep[]
  onSave: (envId: number) => void
}) {
  const { t } = useI18n()
  const last = steps[steps.length - 1]
  const sColor = !status || status.status === 'running' ? 'green' : status.status === 'done' ? 'blue' : 'red'
  const sText = !status || status.status === 'running' ? t('aiAgent.agent.running') : status.status === 'done' ? t('aiAgent.agent.done') : t('aiAgent.agent.failed')
  return (
    <Card size="small" title={<Space size={6}>{<Tag color={sColor}>{sText}</Tag>}<span>{title}</span></Space>}>
      {last?.screenshot && (
        <img
          src={last.screenshot}
          alt=""
          style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(0,0,0,0.1)', marginBottom: 8, flexShrink: 0 }}
        />
      )}
      {status && status.status !== 'running' && status.result && (
        <Typography.Paragraph
          type={status.status === 'failed' ? 'danger' : 'secondary'}
          style={{ fontSize: 12, marginTop: 0, whiteSpace: 'pre-wrap' }}
        >
          {status.result}
        </Typography.Paragraph>
      )}
      {steps.length > 0 && (
        <div
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          {steps.map((s) => (
            <div key={s.step} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <Tag color="blue">#{s.step}</Tag>
              <Tag>{actionLabel(s.action, t as (k: string) => string)}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'pre-wrap', flex: 1, minWidth: 0 }}>
                {s.action.thought || actionLabel(s.action, t as (k: string) => string)}
              </Typography.Text>
            </div>
          ))}
        </div>
      )}
      {status?.status === 'done' && rpaSteps.length > 0 && (
        <Button type="dashed" icon={<SaveOutlined />} size="small" block style={{ marginTop: 8 }} onClick={() => onSave(envId)}>
          {t('aiAgent.agent.saveTemplate')}（{rpaSteps.length}）
        </Button>
      )}
    </Card>
  )
}

// Agent 执行闭环面板（矩阵并行）：选 N 个目标环境 → 自然语言指令 → 各环境独立并发执行 → 实时步骤流 → 停止 / 按环境人工确认 / 各环境存为 RPA 模板
function AgentPanel({ settings }: { settings: AppSettings }) {
  const { t } = useI18n()
  const [envs, setEnvs] = useState<{ id: number; title: string }[]>([])
  const [envIds, setEnvIds] = useState<number[]>([])
  const [instruction, setInstruction] = useState('')
  const [running, setRunning] = useState(false)
  const [needApproval, setNeedApproval] = useState(settings.aiAgent.needApprovalByDefault)
  // 按环境分组的状态（每个 envId 独立一份）
  const [envStatus, setEnvStatus] = useState<Record<number, EnvStatus>>({})
  const [envSteps, setEnvSteps] = useState<Record<number, EnvStep[]>>({})
  const [envRpa, setEnvRpa] = useState<Record<number, RpaStep[]>>({})
  const [ask, setAsk] = useState<{ envId: number; question: string } | null>(null)
  const [matrix, setMatrix] = useState<{ results: { envId: number; status: 'done' | 'failed'; result: string; rpaSteps?: RpaStep[] }[] } | null>(null)
  const [status, setStatus] = useState('')
  // 资产化：每个环境运行结束后把归一化的 RPA 步骤存为可离线回放的模板
  const [saveForEnv, setSaveForEnv] = useState<number | null>(null)
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

  const envTitle = (id: number) => {
    const e = envs.find((x) => x.id === id)
    return e ? `#${id} ${e.title}` : `#${id}`
  }

  // 订阅主进程推送的单步 / 完成 / 出错 / 待审批 / 全部完成 事件（按父 runId 过滤，多 run 互不串扰；按 envId 分组）
  useEffect(() => {
    const roxy = window.roxy
    if (!roxy) return
    const offs: Array<() => void> = []
    offs.push(
      roxy.agentOnStep((d) => {
        if (d.runId !== runIdRef.current) return
        const e = d.envId
        setEnvSteps((prev) => ({ ...prev, [e]: [...(prev[e] || []), { step: d.step, action: d.action, screenshot: d.screenshot }] }))
        if (d.rpaStep) setEnvRpa((prev) => ({ ...prev, [e]: [...(prev[e] || []), d.rpaStep as RpaStep] }))
      })
    )
    offs.push(
      roxy.agentOnDone((d) => {
        if (d.runId !== runIdRef.current) return
        setEnvStatus((prev) => ({ ...prev, [d.envId]: { status: 'done', result: d.result } }))
        if (d.rpaSteps?.length) setEnvRpa((prev) => ({ ...prev, [d.envId]: d.rpaSteps! }))
      })
    )
    offs.push(
      roxy.agentOnError((d) => {
        if (d.runId !== runIdRef.current) return
        setEnvStatus((prev) => ({ ...prev, [d.envId]: { status: 'failed', result: d.error } }))
      })
    )
    offs.push(
      roxy.agentOnNeedApproval((d) => {
        if (d.runId !== runIdRef.current) return
        setAsk({ envId: d.envId, question: d.question })
      })
    )
    offs.push(
      roxy.agentOnAllDone((d) => {
        if (d.runId !== runIdRef.current) return
        runIdRef.current = null
        setRunning(false)
        setMatrix({ results: d.results })
        setAsk(null)
      })
    )
    return () => offs.forEach((f) => f())
  }, [t])

  const start = async () => {
    if (!envIds.length || !instruction.trim() || running) return
    setStatus('')
    const init: Record<number, EnvStatus> = {}
    envIds.forEach((id) => {
      init[id] = { status: 'running' }
    })
    setEnvStatus(init)
    setEnvSteps({})
    setEnvRpa({})
    setMatrix(null)
    setSaveOpen(false)
    setSaveForEnv(null)
    setAsk(null)
    const res = await window.roxy?.agentStart?.({ envIds, instruction: instruction.trim(), options: { needApproval } })
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
    if (runIdRef.current && ask) window.roxy?.agentApprove?.(runIdRef.current, ask.envId, ok)
    setAsk(null)
  }

  const openSave = (envId: number) => {
    setSaveForEnv(envId)
    setTplName('')
    setTplRemark('')
    setSaveOpen(true)
  }

  const saveTemplate = async () => {
    if (saveForEnv == null || !tplName.trim() || !envRpa[saveForEnv]?.length) return
    setSaving(true)
    try {
      const res = await api.post<{ id: number }>('/api/rpa', {
        name: tplName.trim(),
        remark: tplRemark.trim(),
        steps: envRpa[saveForEnv]
      })
      if (res.id) {
        message.success(t('aiAgent.agent.saveTemplateOk'))
        setSaveOpen(false)
        setSaveForEnv(null)
      } else {
        message.error(t('aiAgent.agent.saveTemplateFail'))
      }
    } catch (e) {
      message.error(`${t('aiAgent.agent.saveTemplateFail')}：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const doneCount = matrix ? matrix.results.filter((r) => r.status === 'done').length : 0
  const failCount = matrix ? matrix.results.filter((r) => r.status === 'failed').length : 0

  return (
    <div>
      {envs.length === 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('aiAgent.agent.noEnv')} />
      )}
      <Space wrap size={12} style={{ display: 'flex', marginBottom: 12 }}>
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          style={{ minWidth: 320, maxWidth: 560 }}
          placeholder={t('aiAgent.agent.targetEnvs')}
          value={envIds}
          onChange={(v: number[]) => setEnvIds(v)}
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
          <Button type="primary" icon={<PlayCircleOutlined />} disabled={!envIds.length || !instruction.trim()} onClick={start}>
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
          message={`${t('aiAgent.agent.ask')} · ${envTitle(ask.envId)}`}
          description={ask.question}
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

      {running && envIds.length > 0 && Object.values(envSteps).every((arr) => !arr.length) && (
        <div style={{ marginTop: 12 }}>
          <Spin tip={t('aiAgent.agent.thinking')} />
        </div>
      )}

      {matrix && (
        <Alert
          type={failCount > 0 ? 'warning' : 'success'}
          showIcon
          style={{ marginTop: 12 }}
          message={t('aiAgent.agent.matrixDone', { done: doneCount, failed: failCount })}
        />
      )}

      {envIds.length > 0 && (
        <div
          style={{
            marginTop: 12,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
            alignItems: 'start'
          }}
        >
          {envIds.map((id) => (
            <EnvCard
              key={id}
              envId={id}
              title={envTitle(id)}
              status={envStatus[id]}
              steps={envSteps[id] || []}
              rpaSteps={envRpa[id] || []}
              onSave={openSave}
            />
          ))}
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
          <Form.Item label={`${t('aiAgent.agent.templateName')}${saveForEnv != null ? `（${envTitle(saveForEnv)}）` : ''}`} required>
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
