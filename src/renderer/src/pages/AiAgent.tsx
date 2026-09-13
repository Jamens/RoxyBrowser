import { useEffect, useRef, useState, useCallback } from 'react'
import { Button, Card, Empty, Input, Segmented, Space, Spin, Tag, Typography, Select, Switch, Alert, Modal, Form, message, theme } from 'antd'
import { RobotOutlined, SendOutlined, ClearOutlined, SettingOutlined, PlayCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { DEFAULT_SETTINGS, type AppSettings, type AgentAction, type RpaStep } from '@shared/types'
import { useI18n } from '../i18n'
import { useAgentStore, ensureAgentSubscriptions, agentStore, type EnvStatus, type EnvStep } from '../agentStore'
import { useAgentChatStore, agentChatStore, type ChatMessage, type UiMode } from '../agentChatStore'

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

// EnvStatus / EnvStep 类型见 ./agentStore（与 AgentPanel 共用同一份执行态定义）

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
  // 用主题 token 而非硬编码 rgba(0,0,0,0.1)：暗色模式下黑边框几乎不可见
  const { token } = theme.useToken()
  const last = steps[steps.length - 1]
  const sColor = !status || status.status === 'running' ? 'green' : status.status === 'done' ? 'blue' : 'red'
  const sText = !status || status.status === 'running' ? t('aiAgent.agent.running') : status.status === 'done' ? t('aiAgent.agent.done') : t('aiAgent.agent.failed')
  return (
    <Card size="small" title={<Space size={6}>{<Tag color={sColor}>{sText}</Tag>}<span>{title}</span></Space>}>
      {last?.screenshot && (
        <img
          src={last.screenshot}
          alt=""
          style={{ width: '100%', borderRadius: 6, border: `1px solid ${token.colorBorderSecondary}`, marginBottom: 8, flexShrink: 0 }}
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
// 注意：执行态全部走模块级 agentStore（见 agentStore.ts），切到其它标签（路由卸载重建）后数据不丢，
// 切回时通过 useSyncExternalStore 立即拿到最新进度；IPC 订阅在 ensureAgentSubscriptions 里只注册一次。
function AgentPanel({ settings }: { settings: AppSettings }) {
  const { t } = useI18n()
  const s = useAgentStore()
  const [envs, setEnvs] = useState<{ id: number; title: string }[]>([])
  // 当前登录用户：随执行一起传给主进程，用于把 AI 执行写进操作日志（归属到操作人）
  const [actor, setActor] = useState<{ userId: number; username: string } | null>(null)
  // 资产化：每个环境运行结束后把归一化的 RPA 步骤存为可离线回放的模板（弹窗态，非执行数据，可随卸载重置）
  const [saveForEnv, setSaveForEnv] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tplName, setTplName] = useState('')
  const [tplRemark, setTplRemark] = useState('')

  const loadEnvs = useCallback(() => {
    api
      .get<{ id: number; title: string }[]>('/api/windows')
      .then(setEnvs)
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadEnvs()
  }, [loadEnvs])

  // 拉取当前登录用户（操作日志的操作人），失败则留空、日志回落为 ai-agent
  useEffect(() => {
    api
      .get<{ id: number; username: string }>('/api/auth/me')
      .then((u) => setActor({ userId: u.id, username: u.username }))
      .catch(() => {})
  }, [])

  // 注册 IPC 订阅（只一次，进程级常驻）+ 空闲时把审批默认开关同步进 store
  useEffect(() => {
    ensureAgentSubscriptions()
    if (!s.runId) agentStore.setNeedApproval(settings.aiAgent.needApprovalByDefault)
    // 仅挂载时执行一次：t 稳定，避免重复写入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const envTitle = (id: number) => {
    const e = envs.find((x) => x.id === id)
    return e ? `#${id} ${e.title}` : `#${id}`
  }

  const start = async () => {
    if (!s.envIds.length || !s.instruction.trim() || s.running) return
    agentStore.setStatus('')
    agentStore.start(s.envIds, s.instruction.trim(), s.needApproval)
    setSaveOpen(false)
    setSaveForEnv(null)
    const res = await window.roxy?.agentStart?.({
      envIds: s.envIds,
      instruction: s.instruction.trim(),
      options: { needApproval: s.needApproval },
      actor: actor || undefined
    })
    if (!res) {
      agentStore.setStatus(t('aiAgent.agent.noEnv'))
      agentStore.setRunning(false)
      return
    }
    if (res.error) {
      agentStore.setStatus(res.error)
      agentStore.setRunning(false)
      return
    }
    if (res.runId) agentStore.setRunId(res.runId)
  }
  const stop = () => {
    if (s.runId) window.roxy?.agentStop?.(s.runId)
    agentStore.stop()
  }
  const approve = (ok: boolean) => {
    if (s.runId && s.ask) window.roxy?.agentApprove?.(s.runId, s.ask.envId, ok)
    agentStore.setAsk(null)
  }

  const openSave = (envId: number) => {
    setSaveForEnv(envId)
    setTplName('')
    setTplRemark('')
    setSaveOpen(true)
  }

  const saveTemplate = async () => {
    if (saveForEnv == null || !tplName.trim() || !s.envRpa[saveForEnv]?.length) return
    setSaving(true)
    try {
      const res = await api.post<{ id: number }>('/api/rpa', {
        name: tplName.trim(),
        remark: tplRemark.trim(),
        steps: s.envRpa[saveForEnv]
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

  const doneCount = s.matrix ? s.matrix.results.filter((r) => r.status === 'done').length : 0
  const failCount = s.matrix ? s.matrix.results.filter((r) => r.status === 'failed').length : 0

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
          value={s.envIds}
          onChange={(v: number[]) => agentStore.setEnvIds(v)}
          options={envs.map((e) => ({ value: e.id, label: `#${e.id} ${e.title}` }))}
          notFoundContent={t('aiAgent.agent.noEnv')}
        />
        <Button icon={<ReloadOutlined />} onClick={loadEnvs}>
          {t('aiAgent.agent.refresh')}
        </Button>
        <Space size={6}>
          <Switch checked={s.needApproval} onChange={(v) => agentStore.setNeedApproval(v)} />
          <Typography.Text type="secondary">{t('aiAgent.agent.needApproval')}</Typography.Text>
        </Space>
      </Space>

      <Input.TextArea
        value={s.instruction}
        onChange={(e) => agentStore.setInstruction(e.target.value)}
        placeholder={t('aiAgent.agent.instructionPlaceholder')}
        autoSize={{ minRows: 2, maxRows: 5 }}
        disabled={s.running}
      />

      <Space style={{ marginTop: 12 }}>
        {s.running ? (
          <Button danger icon={<ClearOutlined />} onClick={stop}>
            {t('aiAgent.agent.stop')}
          </Button>
        ) : (
          <Button type="primary" icon={<PlayCircleOutlined />} disabled={!s.envIds.length || !s.instruction.trim()} onClick={start}>
            {t('aiAgent.agent.start')}
          </Button>
        )}
        <Tag color={s.running ? 'green' : 'default'}>{s.running ? t('aiAgent.agent.running') : t('aiAgent.agent.idle')}</Tag>
      </Space>

      {s.ask && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={`${t('aiAgent.agent.ask')} · ${envTitle(s.ask.envId)}`}
          description={s.ask.question}
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

      {s.status && (
        <Typography.Paragraph
          style={{ marginTop: 12 }}
          type={s.status.startsWith(t('aiAgent.agent.failed')) ? 'danger' : 'secondary'}
        >
          {s.status}
        </Typography.Paragraph>
      )}

      {s.running && s.envIds.length > 0 && Object.values(s.envSteps).every((arr) => !arr.length) && (
        <div style={{ marginTop: 12 }}>
          <Spin tip={t('aiAgent.agent.thinking')} />
        </div>
      )}

      {s.matrix && (
        <Alert
          type={failCount > 0 ? 'warning' : 'success'}
          showIcon
          style={{ marginTop: 12 }}
          message={t('aiAgent.agent.matrixDone', { done: doneCount, failed: failCount })}
        />
      )}

      {s.envIds.length > 0 && (
        <div
          style={{
            marginTop: 12,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
            alignItems: 'start'
          }}
        >
          {s.envIds.map((id) => (
            <EnvCard
              key={id}
              envId={id}
              title={envTitle(id)}
              status={s.envStatus[id]}
              steps={s.envSteps[id] || []}
              rpaSteps={s.envRpa[id] || []}
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
  // 对话 UI 态走模块级 store：切到其它页面再切回时，对话内容 / 输入框残值 / 当前标签页都不丢
  const { uiMode, messages, input, sending } = useAgentChatStore()
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
    agentChatStore.setMessages(next)
    agentChatStore.setInput('')
    agentChatStore.setSending(true)
    try {
      const res = await api.post<{ reply: string; mode: 'chat' | 'support' }>('/api/ai-agent/chat', {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        mode: uiMode === 'agent' ? 'auto' : uiMode
      })
      agentChatStore.setMessages([
        ...next,
        { role: 'assistant', content: res.reply || '（模型返回了空回复）', mode: res.mode }
      ])
    } catch (e) {
      // 失败时保留用户消息，方便改后重发
      agentChatStore.setMessages([...next, { role: 'assistant', content: `⚠️ ${(e as Error).message}` }])
    } finally {
      agentChatStore.setSending(false)
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
            onChange={(v) => agentChatStore.setUiMode(v as UiMode)}
            options={[
              { value: 'auto', label: t('aiAgent.modeAuto') },
              { value: 'chat', label: t('aiAgent.modeChat') },
              { value: 'support', label: t('aiAgent.modeSupport') },
              { value: 'agent', label: t('aiAgent.modeAgent') }
            ]}
          />
          {/* 所有 tab 都展示后端与模型名：对话/客服/自动用文本模型，
              执行(agent) tab 用其实际看屏决策的「视觉模型」，避免显示成文本模型造成误导 */}
          <Tag color={a.backend === 'local' ? 'green' : 'blue'}>
            {a.backend === 'local' ? t('aiAgent.backendLocal') : t('aiAgent.backendCloud')}
          </Tag>
          <Tag>
            {uiMode === 'agent'
              ? (a.backend === 'local' ? a.localVisionModel : a.cloudVisionModel) || '-'
              : (a.backend === 'local' ? a.localModel : a.cloudModel) || '-'}
          </Tag>
          {uiMode !== 'agent' && (
            <Button
              size="small"
              icon={<ClearOutlined />}
              disabled={!messages.length || sending}
              onClick={() => agentChatStore.clear()}
            >
              {t('aiAgent.chat.clear')}
            </Button>
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
              onChange={(e) => agentChatStore.setInput(e.target.value)}
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
