import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { CookieEntity, ProfileEntity } from '../entities'
import { mapCookie, parseCookieText } from '../cookieText'
import { ownerScope, type AuthedRequest } from '../authScope'

export interface CookieRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：AppDataSource 在 server.ts 中是 `export let`，
   * 由 initDb 运行时赋值，按值捕获会在注册路由那一刻拿到 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /** browserManager 提供的「立即注入已打开窗口」，经 deps 注入以避免 routes → browserManager 的运行时依赖 */
  applyCookies: (profileId: number) => Promise<number>
}

/**
 * 注册 Cookie 管理路由（按环境隔离，团队维度鉴权）。
 * 注入发生在环境打开时（browserManager.openWindow 读取并写入 session.cookies）；
 * 这里负责 Cookie 的持久化、增删改查、批量导入导出，以及「立即应用到已打开窗口」。
 *
 * 路由顺序：静态段 /cookies/export、/cookies/import、/cookies/apply 必须先于
 * /cookies/:id 注册，否则会被「:id」当成参数吞掉。
 */
export function registerCookieRoutes(router: Router, deps: CookieRouteDeps): void {
  const { getDs, authMiddleware, writeLog, applyCookies } = deps

  // 列出某环境的 Cookie（必须传 profileId，且属于当前团队）
  router.get('/cookies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const repo = getDs().getRepository(CookieEntity)
    const list = await repo.find({ where: { profileId, ...ownerScope(req) }, order: { domain: 'ASC', name: 'ASC' } })
    res.json(list.map(mapCookie))
  })

  // 新增 Cookie
  router.post('/cookies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number(req.body.profileId), ...ownerScope(req) } })
    if (!profile) return res.status(400).json({ message: '环境不存在' })
    const repo = getDs().getRepository(CookieEntity)
    const c = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        profileId: profile.id,
        domain: (req.body.domain || '').trim(),
        name: (req.body.name || '').trim(),
        value: req.body.value == null ? '' : String(req.body.value),
        path: req.body.path || '/',
        secure: !!req.body.secure,
        httpOnly: !!req.body.httpOnly,
        sameSite: req.body.sameSite || 'unspecified',
        expirationDate: req.body.expirationDate ? new Date(req.body.expirationDate) : null,
        hostOnly: req.body.hostOnly == null ? true : !!req.body.hostOnly
      })
    )
    await writeLog(req, 'create_cookie', `环境「${profile.name}」新增 Cookie ${c.domain} / ${c.name}`)
    res.json(mapCookie(c))
  })

  // 清空某环境的全部 Cookie
  router.delete('/cookies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const repo = getDs().getRepository(CookieEntity)
    const r = await repo.delete({ profileId, ...ownerScope(req) })
    await writeLog(req, 'clear_cookies', `清空环境「${profile.name}」的 Cookie（${r.affected || 0} 条）`)
    res.json({ ok: true, deleted: r.affected || 0 })
  })

  // 批量导入 Cookie 文本（Netscape / Set-Cookie / JSON）
  router.post('/cookies/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.body.profileId)
    const text: string = req.body?.text || ''
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    if (!text.trim()) return res.status(400).json({ message: '请粘贴 Cookie 文本' })
    const { cookies, failed } = parseCookieText(text)
    if (!cookies.length) return res.status(400).json({ message: '未解析到任何 Cookie', failed })
    const repo = getDs().getRepository(CookieEntity)
    const saved = await repo.save(
      cookies.map((c) =>
        repo.create({
          teamId: req.tid!,
          ownerId: req.uid!,
          profileId,
          domain: (c.domain || '').trim(),
          name: (c.name || '').trim(),
          value: c.value == null ? '' : String(c.value),
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'unspecified',
          expirationDate: c.expirationDate ? new Date(c.expirationDate) : null,
          hostOnly: c.hostOnly == null ? true : !!c.hostOnly
        })
      )
    )
    await writeLog(req, 'import_cookies', `环境「${profile.name}」导入 ${saved.length} 条 Cookie`)
    res.json({ imported: saved.length, failed })
  })

  // 导出为 Netscape cookie 文本
  router.get('/cookies/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const repo = getDs().getRepository(CookieEntity)
    const list = await repo.find({ where: { profileId, ...ownerScope(req) }, order: { domain: 'ASC', name: 'ASC' } })
    const text = list
      .map((c) => {
        const flag = c.hostOnly ? 'FALSE' : 'TRUE'
        const exp = c.expirationDate ? Math.floor(new Date(c.expirationDate).getTime() / 1000) : 0
        return [c.domain, flag, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t')
      })
      .join('\n')
    res.json({ text, count: list.length })
  })

  // 立即把 Cookie 写入已打开的环境窗口（未打开则提示下次打开时自动注入）
  router.post('/cookies/apply', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId || req.body.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    try {
      const n = await applyCookies(profileId)
      await writeLog(req, 'apply_cookies', `环境「${profile.name}」立即注入 ${n} 条 Cookie`)
      res.json({ ok: true, applied: n })
    } catch (e) {
      res.status(400).json({ message: (e as Error).message })
    }
  })

  router.put('/cookies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!c) return res.status(404).json({ message: 'Cookie 不存在' })
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: c.profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    for (const f of ['domain', 'name', 'value', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate', 'hostOnly'] as const) {
      if (f in req.body) {
        if (f === 'expirationDate') (c as any)[f] = req.body[f] ? new Date(req.body[f]) : null
        else if (f === 'value') (c as any)[f] = req.body[f] == null ? '' : String(req.body[f])
        else (c as any)[f] = req.body[f]
      }
    }
    await repo.save(c)
    res.json(mapCookie(c))
  })

  router.delete('/cookies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!c) return res.status(404).json({ message: 'Cookie 不存在' })
    await repo.remove(c)
    res.json({ ok: true })
  })
}
