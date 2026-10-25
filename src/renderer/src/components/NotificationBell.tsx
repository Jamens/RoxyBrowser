import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Empty, Popover, Typography } from 'antd'
import {
  BellOutlined,
  GlobalOutlined,
  SwapOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  VideoCameraOutlined
} from '@ant-design/icons'
import { api } from '../api'
import { useI18n } from '../i18n'
import { useNavigate } from 'react-router-dom'
import type { NotifyCategory, NotifySeverity } from '@shared/notifications'

/**
 * 通知中心（顶栏铃铛）。
 *
 * 与应用主界面同层：无论停在哪一页，系统事件（代理漂移 / 换绑 / 到期 / 安全 / 定时任务失败）
 * 都能从右上角直达处理页面。数据是 GET /api/notifications（操作日志的过滤视图）。
 *
 * 已读状态按「当前团队 + 最大已读 id」存在 localStorage：
 * 「看过没有」是纯 UI 状态，不进数据库（与 revokedDevices 一类决策同思路）。
 * 切团队时 teamId 变了，游标自动作废——不会把 A 团队的已读态带给 B 团队。
 */

interface NotificationItem {
  id: number
  action: string
  category: NotifyCategory
  severity: NotifySeverity
  route: string
  detail: string
  username: string
  createdAt: string
}

const SEEN_KEY = 'roxy_notif_seen'
const POLL_MS = 30_000

const CATEGORY_ICONS: Record<NotifyCategory, typeof GlobalOutlined> = {
  proxy_drift: GlobalOutlined,
  proxy_heal: SwapOutlined,
  expiry: ClockCircleOutlined,
  security: WarningOutlined,
  rpa: VideoCameraOutlined
}

// 严重度 → 图标颜色。跟随语义而非主题色：error 必须一眼红
const SEVERITY_COLORS: Record<NotifySeverity, string> = {
  error: '#ff4d4f',
  warning: '#fa8c16',
  info: '#1677ff'
}

function loadSeen(teamId: number): number {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (!raw) return 0
    const s = JSON.parse(raw) as { teamId?: number; maxId?: number }
    return s.teamId === teamId && Number.isFinite(s.maxId) ? Number(s.maxId) : 0
  } catch {
    return 0
  }
}

function saveSeen(teamId: number, maxId: number): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ teamId, maxId }))
  } catch {
    /* 隐私模式下 localStorage 不可写：降级为「每次刷新都重算未读」，可接受 */
  }
}

/** 粗粒度相对时间：通知列表只需要「多久以前」，不需要精确到秒 */
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(iso).toLocaleDateString()
}

export default function NotificationBell() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [teamId, setTeamId] = useState(0)
  const [seen, setSeen] = useState(0)
  const [open, setOpen] = useState(false)
  // 组件卸载后不再 setState：轮询是长生命周期副作用，必须显式取消
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: NotificationItem[]; teamId: number }>('/api/notifications?limit=30')
      if (!alive.current) return
      setItems(res.items || [])
      const tid = res.teamId || 0
      setTeamId(tid)
      // 已读游标每次轮询都从 localStorage 重读：刷新页面 / 换团队后不会全量变未读
      setSeen(loadSeen(tid))
    } catch {
      /* 通知拉取失败静默：铃铛不是关键路径，不值得打断用户 */
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const unread = items.filter((i) => i.id > seen)
  const maxId = items.reduce((m, i) => Math.max(m, i.id), 0)

  // 关闭铃铛时标记已读：浏览期间未读项保持高亮（用户能看到哪些是新的），
  // 关闭即清红点。列表本身完整保留——标记已读只是消红点，不是删除。
  // 安全类事件同样留在列表里可回溯，不会因为「已读」而消失。
  const markSeen = useCallback(() => {
    if (!teamId || maxId <= 0) return
    setSeen(maxId)
    saveSeen(teamId, maxId)
  }, [teamId, maxId])

  const content = (
    <div style={{ width: 380, maxHeight: 460, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0 10px' }}>
        <Typography.Text strong>{t('notif.title')}</Typography.Text>
        <Button type="link" size="small" onClick={() => { setOpen(false); navigate('/logs') }}>
          {t('notif.viewAll')}
        </Button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notif.empty')} style={{ margin: '24px 0' }} />
        ) : (
          items.map((i) => {
            const Icon = CATEGORY_ICONS[i.category] || BellOutlined
            const isUnread = i.id > seen
            return (
              <div
                key={i.id}
                onClick={() => {
                  setOpen(false)
                  navigate(i.route)
                }}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '9px 8px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: isUnread ? 'rgba(22,119,255,0.06)' : 'transparent'
                }}
              >
                <Icon style={{ color: SEVERITY_COLORS[i.severity], fontSize: 16, marginTop: 3, flex: '0 0 auto' }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {t(`notif.cat.${i.category}`)}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11, flex: '0 0 auto' }}>
                      {relTime(i.createdAt)}
                    </Typography.Text>
                  </div>
                  <Typography.Paragraph
                    type="secondary"
                    ellipsis={{ rows: 2, tooltip: i.detail }}
                    style={{ fontSize: 12, margin: '2px 0 0', lineHeight: 1.5 }}
                  >
                    {i.detail}
                  </Typography.Paragraph>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // 关闭时也标记已读：用户瞟一眼列表即算看过（与打开时同口径）
        if (!next) markSeen()
      }}
    >
      <Badge count={unread.length} size="small" offset={[-2, 2]} style={{ cursor: 'pointer' }}>
        <BellOutlined style={{ fontSize: 16, padding: '8px 4px' }} />
      </Badge>
    </Popover>
  )
}
