import { Router, type Request, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { ProfileEntity, ProxyEntity, GroupEntity, AccountEntity } from '../entities'
import { ownerScope, ownerAndWhere } from '../authScope'
import type { AuthedRequest } from '../authScope'
import {
  randomFingerprint,
  defaultFingerprint,
  normalizeFingerprint,
  listFingerprintPresets
} from '../../shared/fingerprint'
import { getEnvExpiresAt } from '../../shared/envExpiry'
import { exportProfileFull } from '../exporters'
import { allocateProxy, ApiError } from '../proxyService'
import { DEFAULT_START_URL, type OSKind, type Fingerprint } from '../../shared/types'

export interface ProfileCrudRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`getDs()` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /**
   * 环境的 API 输出形态（含指纹展开）。列表 / 单条 / 新建 / 导出都靠它统一序列化。
   * 第二个参数是分组名、第三个是已加载的代理实体 —— 列表接口一次查出全部分组与代理
   * 再逐行传入，避免 N+1 查询。
   */
  mapProfile: (p: ProfileEntity, groupName?: string | null, proxy?: ProxyEntity | null) => Record<string, unknown>
}

/**
 * 环境 CRUD 域：列表 / 导出 / 快速创建 / 单条增删改查 / 换代理线路 / 指纹随机与预设。
 *
 * ## 注册顺序不可重排（本域内部的两个真冲突）
 * `GET /profiles/export` 必须排在 `GET /profiles/:id` **之前**：
 * 两者都是 2 段路径，`:id` 匹配任意一段，排错了 `/profiles/export` 会被当作
 * id="export" 查库，然后回收「环境不存在」——而用户点的是「导出全部」。
 * `GET /profiles/trash` 同理，那条在 routes/trash.ts，故本域须在它之后注册。
 * （`DELETE /profiles/:id/purge` 是 3 段，与 2 段的 `:id` 不冲突，顺序无所谓。）
 *
 * 换句话说：**server.ts 里 profiles 各域的注册顺序本身是契约的一部分**，
 * 按字母重排或「把相关的放一起」都会改坏路由。
 *
 * ## 删除是软删除
 * `DELETE /profiles/:id` 只写 `deletedAt`；真正的清理（含账号 / Cookie 级联
 * 与浏览器数据分区）由 routes/trash.ts 的 purge 负责。
 * 防误删是首要理由——指纹浏览器里一个环境常绑着跑久的账号与 Cookie。
 */
export function registerProfileCrudRoutes(router: Router, deps: ProfileCrudRouteDeps): void {
  const { getDs, authMiddleware, writeLog, mapProfile } = deps
  // ===== 浏览器环境 =====
  router.get('/profiles', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const isTemplate = req.query.templates === '1'
    const qb = repo
      .createQueryBuilder('p')
      .where('p.teamId = :tid', { tid: req.tid })
      .andWhere('p.isTemplate = :tpl', { tpl: isTemplate ? 1 : 0 })
      // 回收站（软删除）的环境不出现在常规列表；templates 查询同样排除
      .andWhere('p.deletedAt IS NULL')
      .orderBy('p.seq', 'ASC')
    if (req.query.groupId) qb.andWhere('p.groupId = :gid', { gid: Number(req.query.groupId) })
    if (req.query.keyword) qb.andWhere('(p.name LIKE :kw OR p.remark LIKE :kw OR p.platform LIKE :kw)', { kw: `%${req.query.keyword}%` })
    ownerAndWhere(qb, req)
    const list = await qb.getMany()

    const groupRepo = getDs().getRepository(GroupEntity)
    const proxyRepo = getDs().getRepository(ProxyEntity)
    const groups = await groupRepo.find({ where: ownerScope(req) })
    const proxies = await proxyRepo.find({ where: ownerScope(req) })
    const groupMap = new Map(groups.map((g) => [g.id, g.name]))
    const proxyMap = new Map(proxies.map((p) => [p.id, p]))
    res.json(list.map((p) => mapProfile(p, p.groupId ? groupMap.get(p.groupId) : null, p.proxyId ? proxyMap.get(p.proxyId) ?? null : null)))
  })

  // 导出环境（JSON，含完整指纹 + 分组 + 代理 + 账号，可直接迁移到另一台设备）
  router.get('/profiles/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const groupRepo = getDs().getRepository(GroupEntity)
    const proxyRepo = getDs().getRepository(ProxyEntity)
    const accountRepo = getDs().getRepository(AccountEntity)
    const tid = req.tid!

    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    const qb = repo
      .createQueryBuilder('p')
      .where('p.teamId = :tid', { tid })
      .andWhere('p.isTemplate = 0')
      .andWhere('p.deletedAt IS NULL')
    if (ids.length) qb.andWhere('p.id IN (:...ids)', { ids })
    ownerAndWhere(qb, req)
    const list = await qb.orderBy('p.seq', 'ASC').getMany()

    const groups = await groupRepo.find({ where: ownerScope(req) })
    const proxies = await proxyRepo.find({ where: ownerScope(req) })
    const accounts = await accountRepo.find()
    const groupMap = new Map(groups.map((g) => [g.id, g.name]))
    const proxyMap = new Map(proxies.map((x) => [x.id, x]))

    res.json(
      list.map((p) => {
        const proxy = p.proxyId ? proxyMap.get(p.proxyId) : null
        return {
          name: p.name,
          platform: p.platform,
          startUrl: p.startUrl,
          remark: p.remark,
          group: p.groupId ? groupMap.get(p.groupId) || null : null,
          proxy: proxy?.name || null,
          proxyDetail: proxy
            ? {
                type: proxy.type,
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password
              }
            : null,
          fingerprint: p.fingerprint,
          accounts: accounts
            .filter((a) => a.profileId === p.id)
            .map((a) => ({ platform: a.platform, username: a.username, password: a.password, remark: a.remark }))
        }
      })
    )
  })

  router.post('/profiles/quick-create', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const qbMax = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbMax, req)
    const max = await qbMax.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: `环境 ${seq}`,
        seq,
        remark: '',
        platform: '',
        startUrl: DEFAULT_START_URL,
        proxyId: null,
        fingerprint: randomFingerprint() as unknown as Record<string, unknown>,
        isTemplate: false,
        createdBy: req.uid!
      })
    )
    await writeLog(req, 'quick_create_profile', `快速创建环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })
  router.get('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    res.json(mapProfile(p))
  })

  router.post('/profiles', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const body = req.body || {}
    const qbMax = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbMax, req)
    const max = await qbMax.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const fingerprint = (body.fingerprint || defaultFingerprint()) as Fingerprint
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        groupId: body.groupId || null,
        name: body.name || `环境 ${seq}`,
        seq,
        remark: body.remark || '',
        platform: body.platform || '',
        startUrl: body.startUrl || DEFAULT_START_URL,
        proxyId: body.proxyId || null,
        fingerprint: fingerprint as unknown as Record<string, unknown>,
        isTemplate: !!body.isTemplate,
        createdBy: req.uid!
      })
    )
    await writeLog(req, 'create_profile', `创建环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })

  // 整环境迁移：导出（含指纹 / 分组 / 代理 / 账号 / Cookie / 扩展名；扩展以名称带出，导入按名重映射）
  router.get('/profiles/export/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    // 复用导出器，保证「单环境导出」与「全空间快照」走同一套结构，往返一致
    const data = await exportProfileFull(p, { tid: req.tid!, uid: req.uid, role: req.role })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="profile-${p.id}-${encodeURIComponent(p.name)}.json"`)
    res.send(JSON.stringify(data, null, 2))
  })

  router.put('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const body = req.body || {}
    const fields = ['name', 'remark', 'platform', 'startUrl', 'groupId', 'proxyId', 'extensions'] as const
    for (const f of fields) {
      if (f in body) (p as any)[f] = body[f] === '' && (f === 'groupId' || f === 'proxyId') ? null : body[f]
    }
    if (body.fingerprint) p.fingerprint = body.fingerprint
    await repo.save(p)
    await writeLog(req, 'update_profile', `修改环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })

  // 手动切换线路（对标官方）：从 IP 池分配一条「不同的」可用代理替换当前绑定。
  // 旧代理随 proxyId 覆盖自动释放回池（占用数 -1）。运行中的环境只改绑定，
  // 窗口代理在打开时注入，需重启环境才生效（响应里带 running 标记由前端提示）。
  router.post('/profiles/:id/switch-line', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    try {
      const { proxy, reused } = await allocateProxy(getDs(), req.tid!, {
        excludeProxyId: p.proxyId,
        country: (req.body || {}).country,
        region: (req.body || {}).region
      })
      const oldProxy = p.proxyId ? await getDs().getRepository(ProxyEntity).findOne({ where: { id: p.proxyId } }) : null
      p.proxyId = proxy.id
      await repo.save(p)
      const running = p.status === 'running'
      await writeLog(
        req,
        'switch_line',
        `环境「${p.name}」(#${p.id})切换线路：${oldProxy ? `「${oldProxy.name}」` : '（无代理）'} → 「${proxy.name}」(#${proxy.id})${reused ? '（池中无空闲代理，复用已占用代理）' : ''}${running ? '；环境运行中，重启后生效' : ''}`
      )
      res.json({ proxy, running, oldProxyId: oldProxy?.id ?? null })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  })

  router.delete('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口' })
    // 软删除：进回收站，关联账号 / Cookie 原样保留，恢复即完整还原
    p.deletedAt = new Date()
    await repo.save(p)
    await writeLog(req, 'delete_profile', `删除环境「${p.name}」(#${p.id})（已进回收站）`)
    res.json({ ok: true, trashed: true })
  })
  // 生成随机指纹
  router.post('/fingerprint/random', authMiddleware, (req: Request, res: Response) => {
    const body = req.body || {}
    const os = body.os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    const cv = typeof body.coreVersion === 'number' ? body.coreVersion : undefined
    res.json(randomFingerprint(valid as OSKind | undefined, cv))
  })

  // 指纹预设库（内置验证过的指纹组合）
  router.get('/fingerprint/presets', authMiddleware, (_req: Request, res: Response) => {
    res.json(listFingerprintPresets())
  })
  // 手动切换线路（对标官方）：从 IP 池分配一条「不同的」可用代理替换当前绑定。
  // 旧代理随 proxyId 覆盖自动释放回池（占用数 -1）。运行中的环境只改绑定，
  // 窗口代理在打开时注入，需重启环境才生效（响应里带 running 标记由前端提示）。
  router.post('/profiles/:id/switch-line', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    try {
      const { proxy, reused } = await allocateProxy(getDs(), req.tid!, {
        excludeProxyId: p.proxyId,
        country: (req.body || {}).country,
        region: (req.body || {}).region
      })
      const oldProxy = p.proxyId ? await getDs().getRepository(ProxyEntity).findOne({ where: { id: p.proxyId } }) : null
      p.proxyId = proxy.id
      await repo.save(p)
      const running = p.status === 'running'
      await writeLog(
        req,
        'switch_line',
        `环境「${p.name}」(#${p.id})切换线路：${oldProxy ? `「${oldProxy.name}」` : '（无代理）'} → 「${proxy.name}」(#${proxy.id})${reused ? '（池中无空闲代理，复用已占用代理）' : ''}${running ? '；环境运行中，重启后生效' : ''}`
      )
      res.json({ proxy, running, oldProxyId: oldProxy?.id ?? null })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  })

  router.delete('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口' })
    // 软删除：进回收站，关联账号 / Cookie 原样保留，恢复即完整还原
    p.deletedAt = new Date()
    await repo.save(p)
    await writeLog(req, 'delete_profile', `删除环境「${p.name}」(#${p.id})（已进回收站）`)
    res.json({ ok: true, trashed: true })
  })

  // 生成随机指纹
  router.post('/fingerprint/random', authMiddleware, (req: Request, res: Response) => {
    const body = req.body || {}
    const os = body.os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    const cv = typeof body.coreVersion === 'number' ? body.coreVersion : undefined
    res.json(randomFingerprint(valid as OSKind | undefined, cv))
  })

  // 指纹预设库（内置验证过的指纹组合）
  router.get('/fingerprint/presets', authMiddleware, (_req: Request, res: Response) => {
    res.json(listFingerprintPresets())
  })
}
