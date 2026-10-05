import { Router, type Request, type Response } from 'express'
import type { DataSource } from 'typeorm'
import { CookieEntity, ProfileEntity } from '../entities'
import { mapCookie, parseCookieText } from '../cookieText'
import type { AuthedRequest } from '../authScope'

export interface V1CookieRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：AppDataSource 在 server.ts 中是 `export let`，
   * 由 initDb 运行时赋值，按值捕获会在注册路由那一刻拿到 undefined。
   */
  getDs: () => DataSource
  /** browserManager 提供的「立即注入已打开窗口」，经 deps 注入以避开 routes → browserManager 的运行时依赖 */
  applyCookies: (profileId: number) => Promise<number>
}

/**
 * 注册 v1 自动化 API 的 Cookie 读写路由（按环境隔离）。
 *
 * 与 `/api/cookies`（登录态 + ownerScope 隔离）不同，这里是**令牌鉴权**：
 * 路由挂在 v1 router 上，由 tokenAuthMiddleware 统一注入 `tid`，故本组接口
 * 只需按 teamId + profileId 过滤，不再套 ownerScope。
 *
 * 约定：成功返回 { code: 0, data }；失败返回 { code, message }。
 * 解析 / 映射复用 cookieText.ts 的纯函数，与内部接口同一套语义。
 */
export function registerV1CookieRoutes(v1: Router, deps: V1CookieRouteDeps): void {
  const { getDs, applyCookies } = deps

  v1.get('/cookies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const repo = getDs().getRepository(CookieEntity)
    const list = await repo.find({ where: { teamId: tid, profileId }, order: { domain: 'ASC', name: 'ASC' } })
    res.json({ code: 0, data: list.map(mapCookie) })
  })

  v1.post('/cookies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const b = req.body || {}
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: Number(b.profileId), teamId: tid } })
    if (!profile) return res.status(400).json({ code: 400, message: 'profile not found' })
    const repo = getDs().getRepository(CookieEntity)
    const c = await repo.save(
      repo.create({
        teamId: tid,
        ownerId: 0,
        profileId: profile.id,
        domain: (b.domain || '').trim(),
        name: (b.name || '').trim(),
        value: b.value == null ? '' : String(b.value),
        path: b.path || '/',
        secure: !!b.secure,
        httpOnly: !!b.httpOnly,
        sameSite: b.sameSite || 'unspecified',
        expirationDate: b.expirationDate ? new Date(b.expirationDate) : null,
        hostOnly: b.hostOnly == null ? true : !!b.hostOnly
      })
    )
    res.json({ code: 0, data: mapCookie(c) })
  })

  v1.put('/cookies/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!c) return res.status(404).json({ code: 404, message: 'cookie not found' })
    const b = req.body || {}
    for (const f of ['domain', 'name', 'value', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate', 'hostOnly'] as const) {
      if (f in b) {
        if (f === 'expirationDate') (c as any)[f] = b[f] ? new Date(b[f]) : null
        else if (f === 'value') (c as any)[f] = b[f] == null ? '' : String(b[f])
        else (c as any)[f] = b[f]
      }
    }
    await repo.save(c)
    res.json({ code: 0, data: mapCookie(c) })
  })

  v1.delete('/cookies/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!c) return res.status(404).json({ code: 404, message: 'cookie not found' })
    await repo.remove(c)
    res.json({ code: 0, data: { id: c.id } })
  })

  v1.delete('/cookies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const repo = getDs().getRepository(CookieEntity)
    const r = await repo.delete({ teamId: tid, profileId })
    res.json({ code: 0, data: { deleted: r.affected || 0 } })
  })

  v1.post('/cookies/import', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const b = req.body || {}
    const profileId = Number(b.profileId)
    const text: string = b.text || ''
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    if (!text.trim()) return res.status(400).json({ code: 400, message: 'empty cookie text' })
    const { cookies, failed } = parseCookieText(text)
    if (!cookies.length) return res.status(400).json({ code: 400, message: 'no cookie parsed', data: { failed } })
    const repo = getDs().getRepository(CookieEntity)
    const saved = await repo.save(
      cookies.map((c) =>
        repo.create({
          teamId: tid,
          ownerId: 0,
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
    res.json({ code: 0, data: { imported: saved.length, failed } })
  })

  v1.get('/cookies/export', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const repo = getDs().getRepository(CookieEntity)
    const list = await repo.find({ where: { teamId: tid, profileId }, order: { domain: 'ASC', name: 'ASC' } })
    const text = list
      .map((c) => {
        const flag = c.hostOnly ? 'FALSE' : 'TRUE'
        const exp = c.expirationDate ? Math.floor(new Date(c.expirationDate).getTime() / 1000) : 0
        return [c.domain, flag, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t')
      })
      .join('\n')
    res.json({ code: 0, data: { text, count: list.length } })
  })

  v1.post('/cookies/apply', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId || (req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    try {
      const n = await applyCookies(profileId)
      res.json({ code: 0, data: { applied: n } })
    } catch (e) {
      res.status(400).json({ code: 400, message: (e as Error).message })
    }
  })
}
