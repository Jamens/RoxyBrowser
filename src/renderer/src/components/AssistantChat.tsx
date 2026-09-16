import { useState, useRef, useEffect, Fragment } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Drawer, Button, Input, Tag, Empty, Spin, Alert, App as AntdApp, Space } from 'antd'
import { api } from '../api'
import { useI18n } from '../i18n'
import dayjs from 'dayjs'

interface QueryRow {
  _id: unknown
  _deepLink: string
  _title: string
  _usedByEnvs?: Array<{ id: number; name: string; seq: number }>
  [k: string]: unknown
}
interface QueryResult {
  entity: string
  entityLabel: string
  columns: Array<{ key: string; label: string; type: string }>
  rows: QueryRow[]
  total: number
  truncated: boolean
}
interface ActionProposal {
  kind: string
  label: string
  danger: string
  target: { entity: string; id: number }
  params: Record<string, unknown>
}
interface AssistantReply {
  ok: boolean
  understanding: string
  reply: string
  intent: string
  sensitiveBlocked?: boolean
  queries: QueryResult[]
  actions: ActionProposal[]
}
interface MsgItem {
  id: string
  role: 'user' | 'bot'
  text: string
  result?: AssistantReply
}

const DANGER_COLOR: Record<string, string> = {
  safe: 'green',
  medium: 'orange',
  destructive: 'red'
}
const EXAMPLES = ['哪些环境快过期了', '哪个代理 3 天内到期', '最近删了哪些环境', '还剩多少可用代理']

function fmt(v: unknown, type: string): string {
  if (v === null || v === undefined || v === '') return '—'
  if (type === 'date') {
    const d = dayjs(v as string)
    return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : String(v)
  }
  if (type === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

export default function AssistantChat() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const { message: msgApi, modal } = AntdApp.useApp()

  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [msgs, setMsgs] = useState<MsgItem[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // 登录 / 全屏浏览器页不显示助手
  const hidden = location.pathname === '/login' || location.pathname === '/browser'

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [msgs, loading, open])

  function go(deepLink: string) {
    // deepLink 形如 '#/envs?focus=12'，HashRouter 下 navigate 到去 # 后的路径即可
    const path = deepLink.startsWith('#') ? deepLink.slice(1) : deepLink
    navigate(path)
    setOpen(false)
  }

  async function send(text: string) {
    const q = text.trim()
    if (!q || loading) return
    setInput('')
    // UI 用 'bot' 标记助手回复，但模型（Ollama / 云端）只认 'assistant'，这里转成标准角色
    const history = msgs.slice(-8).map((m) => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.text }))
    const userMsg: MsgItem = { id: `u${Date.now()}`, role: 'user', text: q }
    setMsgs((m) => [...m, userMsg])
    setLoading(true)
    try {
      const res = await api.post<AssistantReply>('/api/assistant/chat', { message: q, history })
      setMsgs((m) => [...m, { id: `b${Date.now()}`, role: 'bot', text: res.reply, result: res }])
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: `b${Date.now()}`, role: 'bot', text: e instanceof Error ? e.message : String(e) }
      ])
    } finally {
      setLoading(false)
    }
  }

  async function runAction(a: ActionProposal) {
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/api/assistant/action', {
        kind: a.kind,
        params: a.params
      })
      if (res.ok) {
        msgApi.success(t('assistant.actionDone', { msg: res.message }))
        setMsgs((m) => [...m, { id: `a${Date.now()}`, role: 'bot', text: `✅ ${res.message}` }])
      } else {
        msgApi.error(t('assistant.actionFailed', { msg: res.message }))
      }
    } catch (e) {
      msgApi.error(t('assistant.actionFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  function onActionClick(a: ActionProposal) {
    if (a.danger === 'safe') {
      void runAction(a)
      return
    }
    if (a.danger === 'medium') {
      modal.confirm({
        title: t('assistant.confirmAction'),
        content: a.label,
        okText: t('assistant.confirmAction'),
        cancelText: t('common.cancel'),
        onOk: () => runAction(a)
      })
      return
    }
    // destructive：列出确切影响对象，强确认
    modal.confirm({
      title: t('assistant.dangerDestructive'),
      content: t('assistant.confirmDestructive', { list: `#${a.target.id}` }),
      okText: t('assistant.confirmAction'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => runAction(a)
    })
  }

  function renderRow(r: QueryRow) {
    return (
      <div className="assistant-row" key={String(r._id)}>
        <div className="assistant-row-title" onClick={() => go(r._deepLink)}>
          {r._title}
        </div>
        <div className="assistant-row-meta">
          {r._deepLink && (
            <a
              onClick={(e) => {
                e.preventDefault()
                go(r._deepLink)
              }}
              href={r._deepLink}
              style={{ marginRight: 8 }}
            >
              {t('assistant.jump')} →
            </a>
          )}
        </div>
        {r._usedByEnvs && r._usedByEnvs.length > 0 && (
          <div className="assistant-row-meta">
            {t('assistant.usedBy')}：
            {r._usedByEnvs.map((e) => (
              <Tag
                key={e.id}
                style={{ cursor: 'pointer', marginInlineEnd: 4 }}
                onClick={() => go(`#/envs?focus=${e.id}`)}
              >
                {e.name || `环境#${e.seq}`}
              </Tag>
            ))}
          </div>
        )}
      </div>
    )
  }

  function renderQuery(q: QueryResult) {
    if (!q.rows.length) return null
    return (
      <div key={q.entity} style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          {q.entityLabel} · {q.total}
          {q.truncated ? ` (≥${q.total})` : ''}
        </div>
        {q.rows.map(renderRow)}
      </div>
    )
  }

  function renderActions(actions: ActionProposal[]) {
    if (!actions.length) return null
    return (
      <div style={{ marginTop: 6 }}>
        {actions.map((a, i) => (
          <div className="assistant-row" key={`${a.kind}-${i}`}>
            <Space size={8}>
              <Tag color={DANGER_COLOR[a.danger] || 'default'}>{a.label}</Tag>
              <Button size="small" type="primary" danger={a.danger === 'destructive'} onClick={() => onActionClick(a)}>
                {a.danger === 'safe' ? t('assistant.confirmAction') : a.danger === 'medium' ? t('assistant.dangerMedium') : t('assistant.dangerDestructive')}
              </Button>
            </Space>
          </div>
        ))}
      </div>
    )
  }

  function renderBot(item: MsgItem) {
    const res = item.result
    return (
      <div className="assistant-msg bot">
        <div className="assistant-bubble">
          {res?.sensitiveBlocked ? (
            <Alert
              type="warning"
              showIcon
              message={t('assistant.sensitiveTitle')}
              description={t('assistant.sensitiveHint')}
            />
          ) : (
            <Fragment>
              {res?.understanding ? <div className="assistant-understand">↳ {res.understanding}</div> : null}
              <div style={{ whiteSpace: 'pre-wrap' }}>{item.text}</div>
              {res?.queries?.map(renderQuery)}
              {renderActions(res?.actions || [])}
            </Fragment>
          )}
        </div>
      </div>
    )
  }

  if (hidden) return null

  return (
    <Fragment>
      {!open && (
        <button className="assistant-fab" title={t('assistant.open')} onClick={() => setOpen(true)}>
          💬
        </button>
      )}
      <Drawer
        title={t('assistant.open')}
        placement="right"
        width={440}
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button size="small" onClick={() => setMsgs([])}>
            {t('assistant.clear')}
          </Button>
        }
        styles={{ body: { padding: 12, display: 'flex', flexDirection: 'column' } }}
      >
        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
          {msgs.length === 0 && !loading && (
            <div>
              <div className="assistant-bubble assistant-msg bot" style={{ background: 'transparent', color: 'inherit', padding: 0 }}>
                <div style={{ whiteSpace: 'pre-wrap', color: '#5b6675' }}>{t('assistant.empty')}</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <span style={{ fontSize: 12, color: '#8c9bb0' }}>{t('assistant.examples')}</span>
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {EXAMPLES.map((ex) => (
                    <Tag key={ex} style={{ cursor: 'pointer' }} onClick={() => send(ex)}>
                      {ex}
                    </Tag>
                  ))}
                </div>
              </div>
            </div>
          )}
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div className="assistant-msg user" key={m.id}>
                <div className="assistant-bubble">{m.text}</div>
              </div>
            ) : (
              <Fragment key={m.id}>{renderBot(m)}</Fragment>
            )
          )}
          {loading && (
            <div className="assistant-msg bot">
              <div className="assistant-bubble">
                <Spin size="small" /> {t('assistant.thinking')}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('assistant.placeholder')}
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
          />
          <Button type="primary" onClick={() => void send(input)} disabled={loading || !input.trim()}>
            {t('assistant.send')}
          </Button>
        </div>
      </Drawer>
    </Fragment>
  )
}
