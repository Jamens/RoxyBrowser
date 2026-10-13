import { Router, type Request, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { ProfileEntity, ProxyEntity, GroupEntity } from '../entities'
import { ownerScope } from '../authScope'
import type { AuthedRequest } from '../authScope'
import { getSystemStats } from '../systemStats'
import type { AppSettings } from '../../shared/types'

export interface SystemRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  getSettings: () => Promise<AppSettings>
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  /**
   * 窗口同步开关，由 main 进程在启动后注入。取函数而非值：按值捕获拿到的是 null，
   * 于是开关请求会静默无效——用户点了没反应，也没有任何报错。
   */
  syncToggle: (opts: { enabled: boolean; ids?: number[] }) => void
  /** 已打开窗口列表，同样由 main 注入（前端用它选同步对象） */
  windowsProvider: () => Array<{ id: number; title: string }>
}

/**
 * 系统与分组域：窗口同步开关 / 已打开窗口 / 系统资源占用 / 环境内新标签页信息 / 分组增删查。
 *
 * ## 唯一免鉴权的一条：/browser/profile-info/:id
 * 环境窗口里的新标签页要显示起始页、搜索引擎、代理状态，但它**没有登录态**
 * （用的是 profileId 直查，没有会话 cookie）。这是刻意的：这条接口只回
 * 起始页 / 搜索引擎 / 代理可用性这类「新标签页要显示的东西」，不泄露环境列表。
 * 它是本文件里唯一不挂 authMiddleware 的路由，也是全项目仅此一处例外。
 *
 * ## 代理状态要一并返回的原因
 * 环境窗口一旦绑了不可用的代理，**所有**站点（包括本可直连的国内站）都会
 * ERR_PROXY_CONNECTION_FAILED。不在用户点链接之前说清楚，他只会以为搜索功能坏了。
 *
 * ## 分组删除要解绑环境
 * 删分组时把挂在它下面的环境 groupId 置空，而不是连带删环境 ——
 * 分组只是组织手段，用户不会因为「取消分组」就期望数据消失。
 */
export function registerSystemRoutes(router: Router, deps: SystemRouteDeps): void {
  const { getDs, getSettings, authMiddleware, syncToggle, windowsProvider } = deps
  // ===== 窗口同步开关 =====
  // body: { enabled: boolean, ids?: number[] } —— ids 为空表示同步到全部已打开窗口
  router.post('/sync', authMiddleware, (req: Request, res: Response) => {
    const body = (req.body || {}) as { enabled?: boolean; ids?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : undefined
    syncToggle({ enabled: !!body.enabled, ids })
    res.json({ ok: true, enabled: !!body.enabled, ids: ids || [] })
  })

  // ===== 已打开的环境窗口（用于选择同步对象） =====
  router.get('/windows', authMiddleware, (_req: Request, res: Response) => {
    res.json(windowsProvider())
  })

  // ===== 系统资源占用（主窗口顶栏展示） =====
  router.get('/system/stats', authMiddleware, async (_req: Request, res: Response) => {
    res.json(await getSystemStats())
  })

  // ===== 浏览器环境（环境内新标签页信息，无需登录态） =====
  router.get('/browser/profile-info/:id', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const settings = await getSettings()
    // 代理信息一并返回（含检测状态）：起始页据此在「用户点链接之前」就预警。
    // 环境窗口一旦绑定了不可用的代理，所有站点（包括本可直连的国内站）都会
    // ERR_PROXY_CONNECTION_FAILED 全挂；不提前说清楚，用户只会以为是搜索功能坏了。
    let proxy: null | {
      id: number
      label: string
      status: string
      checked: boolean
      country: string
    } = null
    if (p.proxyId) {
      const proxyRepo = getDs().getRepository(ProxyEntity)
      const px = await proxyRepo.findOne({ where: { id: p.proxyId } })
      if (px) {
        proxy = {
          id: px.id,
          // 形如 socks5://1.2.3.4:1080，直接在页面上告诉用户是哪一条
          label: `${px.type}://${px.host}:${px.port}`,
          status: px.status || 'unknown',
          checked: !!px.lastCheckAt && px.status === 'active',
          country: px.country || ''
        }
      }
    }
    res.json({
      id: p.id,
      name: p.name,
      seq: p.seq,
      platform: p.platform,
      startUrl: p.startUrl,
      proxy,
      searchEngine: settings.searchEngine,
      fingerprint: {
        os: p.fingerprint.os,
        timezone: p.fingerprint.timezone,
        languages: p.fingerprint.languages,
        screenWidth: p.fingerprint.screenWidth,
        screenHeight: p.fingerprint.screenHeight,
        userAgent: p.fingerprint.userAgent
      }
    })
  })

  // ===== 分组 =====
  router.get('/groups', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(GroupEntity)
    const list = await repo.find({ where: ownerScope(req), order: { sort: 'ASC' } })
    res.json(list)
  })

  router.post('/groups', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(GroupEntity)
    const g = await repo.save(repo.create({ teamId: req.tid, ownerId: req.uid!, name: req.body.name, sort: req.body.sort || 0 }))
    res.json(g)
  })

  router.delete('/groups/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(GroupEntity)
    const g = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (g) await repo.remove(g)
    if (g) {
      const profileRepo = getDs().getRepository(ProfileEntity)
      await profileRepo.update({ ...ownerScope(req), groupId: g.id }, { groupId: null })
    }
    res.json({ ok: true })
  })
}
