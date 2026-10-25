import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { OperationLogEntity } from '../entities'
import { sendTestNotification } from '../notify'
import { classifyNotification, NOTIFY_EVENT_MAP, type NotifyCategory, type NotifySeverity } from '../../shared/notifications'
// 仅类型导入：编译期完全擦除，不会与 server.ts 形成运行时循环依赖
import type { AuthedRequest } from '../authScope'

/**
 * 通知中心路由（应用内铃铛的数据源 + 桌面弹窗测试）。
 *
 * 数据不新建表：通知是 operation_logs 的一张「值得主动告知」的视图，
 * 过滤白名单与 shared/notifications.ts 的 NOTIFY_EVENT_MAP 完全一致——
 * 铃铛里看到的集合与桌面弹窗的来源必须是同一批事件，
 * 否则会出现「弹过的没记录、记录的没弹过」，用户只会怀疑工具坏了。
 */

export interface NotificationItem {
  id: number
  action: string
  category: NotifyCategory
  severity: NotifySeverity
  /** 点击通知后前端跳转的页面 */
  route: string
  detail: string
  /** 操作人（定时任务为 system，API 调用为 api:<令牌名>） */
  username: string
  createdAt: string
}

export interface NotificationRouteDeps {
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
}

/** 白名单事件名集合（SQL 层过滤 + 导出供测试与文档对齐，避免两处各写一份） */
export const NOTIFY_ACTIONS = Object.keys(NOTIFY_EVENT_MAP)

export function registerNotificationRoutes(router: Router, deps: NotificationRouteDeps): void {
  const { getDs, authMiddleware } = deps

  // 最近的通知事件（当前团队）。已读状态在客户端按 id 游标维护，
  // 服务端不存——「看过没有」是纯 UI 状态，为它建表/加列不划算
  // （与 revokedDevices 一类决策同思路：有界、可重算的状态不进库）。
  router.get('/notifications', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100)
    const repo = getDs().getRepository(OperationLogEntity)
    // 白名单必须在 SQL 层过滤：若先取最近 N 条日志再在内存里过滤，
    // 活跃团队中用户自己的操作（建环境 / 开窗口……）会迅速把通知事件挤出窗口——
    // 铃铛静默漏事件，而「不漏」正是它相对于日志页的存在意义。
    const where = { teamId: req.tid!, action: In(NOTIFY_ACTIONS) }
    const list = await repo.find({
      where,
      order: { id: 'DESC' },
      take: limit
    })
    const total = await repo.count({ where })
    const items: NotificationItem[] = []
    for (const l of list) {
      const meta = classifyNotification(l.action)
      if (!meta) continue
      items.push({
        id: l.id,
        action: l.action,
        category: meta.category,
        severity: meta.severity,
        route: meta.route,
        detail: l.detail,
        username: l.username,
        createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : String(l.createdAt)
      })
    }
    res.json({ items, teamId: req.tid, total })
  })

  // 发送一条测试桌面通知：让用户在保存设置前就能验证系统弹窗是否工作
  // （macOS 需要通知权限、某些 Linux 桌面没装通知服务，这里如实返回原因）
  router.post('/notifications/test', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    const r = sendTestNotification()
    if (!r.ok) {
      res.status(400).json({ ok: false, error: r.error || '发送失败' })
      return
    }
    res.json({ ok: true })
  })
}
