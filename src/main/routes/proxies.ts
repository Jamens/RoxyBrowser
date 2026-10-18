import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { ProfileEntity, ProxyEntity } from '../entities'
import {
  ApiError,
  allocateProxy,
  applyProxyCheckResult,
  checkProxy,
  computeProxyUsage,
  parseProxyLine,
  proxyPoolStatus
} from '../proxyService'
import { allocateProxies } from '../../shared/proxyAllocator'
import { explainAllocation } from '../../shared/proxyAllocExplain'
import type { AppSettings } from '../../shared/types'
import { ownerScope } from '../authScope'
import type { AuthedRequest } from '../authScope'

export interface ProxyRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /** 读应用设置（代理检测超时等） */
  getSettings: () => Promise<AppSettings>
}

/**
 * 代理域路由：CRUD / 检测 / IP 池分配 / 智能批量分配 / 池统计 / 批量导入导出。
 *
 * 从 server.ts 抽离。遵循既有 routes/* 模式：**依赖经 deps 注入**，不反向
 * import server——否则 routes → server → routes 形成运行时循环依赖。
 * 业务逻辑（检测 / 分配）全部在 proxyService 中，同样不依赖 AppDataSource。
 */
export function registerProxyRoutes(router: Router, deps: ProxyRouteDeps): void {
  const { getDs, authMiddleware, writeLog, getSettings } = deps

  router.get('/proxies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const list = await repo.find({ where: ownerScope(req), order: { id: 'DESC' } })
    const usage = await computeProxyUsage(getDs(), req.tid!)
    const now = Date.now()
    res.json(
      list.map((p) => {
        const cnt = usage.get(p.id) || 0
        return { ...p, usageCount: cnt, poolStatus: proxyPoolStatus(p, cnt, now) }
      })
    )
  })

  router.post('/proxies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const b = req.body || {}
    if (!b.host || !b.port) return res.status(400).json({ message: '主机和端口不能为空' })
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: b.name || `${b.host}:${b.port}`,
        type: b.type || 'http',
        host: b.host,
        port: Number(b.port),
        username: b.username || '',
        password: b.password || '',
        remark: b.remark || ''
      })
    )
    await writeLog(req, 'create_proxy', `添加代理「${p.name}」(#${p.id})`)
    res.json(p)
  })

  router.put('/proxies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    const b = req.body || {}
    for (const f of ['name', 'type', 'host', 'username', 'password', 'remark', 'expiresAt'] as const) {
      if (f in b) (p as any)[f] = b[f]
    }
    if (b.port) p.port = Number(b.port)
    await repo.save(p)
    await writeLog(req, 'update_proxy', `修改代理「${p.name}」(#${p.id})`)
    res.json(p)
  })

  router.delete('/proxies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ds = getDs()
    const repo = ds.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    await repo.remove(p)
    // 删代理必须解绑环境：否则环境上留着一个已不存在的 proxyId，
    // 用户点「打开环境」才在浏览器启动那一刻才报错，且报错信息完全指不到真因。
    const profileRepo = ds.getRepository(ProfileEntity)
    await profileRepo.update({ ...ownerScope(req), proxyId: p.id }, { proxyId: null })
    await writeLog(req, 'delete_proxy', `删除代理「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  router.post('/proxies/:id/check', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    const settings = await getSettings()
    const result = await checkProxy(p, (settings.proxyCheckTimeout as number) * 1000)
    applyProxyCheckResult(p, result)
    await repo.save(p)
    res.json(p)
  })

  // 从 IP 池一键分配：优先空闲代理，可按地区筛选，可选绑定到指定环境
  router.post('/proxies/allocate', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const b = req.body || {}
    try {
      const { proxy, profileId, reused, poolStatus } = await allocateProxy(getDs(), req.tid!, {
        profileId: b.profileId,
        country: b.country,
        region: b.region
      })
      const usage = await computeProxyUsage(getDs(), req.tid!)
      if (profileId) {
        const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, ...ownerScope(req) } })
        await writeLog(req, 'allocate_proxy', `为环境「${profile?.name}」从 IP 池分配代理「${proxy.name}」(#${proxy.id})`)
      } else {
        await writeLog(
          req,
          'allocate_proxy',
          `从 IP 池分配代理「${proxy.name}」(#${proxy.id})` + (reused ? '（池中无空闲代理，复用已占用代理）' : '')
        )
      }
      res.json({
        proxy: { ...proxy, usageCount: (usage.get(proxy.id) || 0) + (profileId ? 1 : 0), poolStatus },
        profileId,
        reused
      })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  })

  // 智能代理分配（负载均衡 + 避免同代理复用）：
  // 对选中的 N 个环境，从「空闲可用代理池」逐一分配**互不相同**的代理，杜绝两个环境共用同一出口 IP（防关联）。
  // 核心分配逻辑抽到纯函数 allocateProxies（src/shared/proxyAllocator.ts），便于离线单测；此处只负责取数、落库、写日志。
  router.post('/profiles/batch-allocate-proxy', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n))
      : []
    if (!ids.length) return res.status(400).json({ message: '请选择至少一个环境' })
    const country = typeof req.body?.country === 'string' ? req.body.country.trim() : ''
    const type = typeof req.body?.type === 'string' ? req.body.type.trim() : ''

    const ds = getDs()
    const profileRepo = ds.getRepository(ProfileEntity)
    const proxyRepo = ds.getRepository(ProxyEntity)
    const profiles = await profileRepo.find({ where: { id: In(ids), ...ownerScope(req) } })
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is ProfileEntity => !!p)

    const usage = await computeProxyUsage(ds, req.tid!)
    const allProxies = await proxyRepo.find({ where: { teamId: req.tid! } })

    const allocEnvs = ordered.map((p) => ({ id: p.id, name: p.name, status: p.status, proxyId: p.proxyId }))
    const allocProxies = allProxies.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      country: p.country,
      type: p.type,
      expiresAt: p.expiresAt
    }))
    const result = allocateProxies(allocEnvs, allocProxies, usage, { country, type })
    // 解释与分配同源：传的是**本次真实分配结果**，不在这里另算一遍
    const explain = explainAllocation(allocEnvs, allocProxies, usage, result, { country, type })

    // 预演（默认 false 以兼容既有调用；前端新流程会显式传 preview: true）：
    // 只算不落库，把「池里有什么、谁分到了什么、为什么跳过」摊开给用户看。
    // 分配前看不清后果，是这个功能此前最大的短板——代理绑错不会报错，
    // 只会在用户真正用到同出口 IP 时才发现关联风险。
    if (req.body?.preview === true) {
      return res.json({ ...result, explain, applied: false })
    }

    if (result.updates.length) {
      const saveMap = new Map(result.updates.map((u) => [u.id, u.proxyId]))
      const toSave = ordered.filter((p) => saveMap.has(p.id))
      for (const p of toSave) p.proxyId = saveMap.get(p.id) ?? null
      await profileRepo.save(toSave)
      await writeLog(
        req,
        'batch_allocate_proxy',
        `智能分配代理：分配 ${result.assigned} 个、保留 ${result.kept} 个、跳过 ${result.skippedRunning + result.skippedNoProxy} 个` +
          (explain.pool.rejected.occupied ? `；${explain.pool.rejected.occupied} 个代理被未选中环境占用、无法抢占` : '')
      )
    }

    res.json({ ...result, explain, applied: true })
  })

  // IP 池统计：总数 / 可用 / 占用 / 过期 / 按地区分布
  router.get('/proxies/pool-stats', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const list = await repo.find({ where: ownerScope(req) })
    const usage = await computeProxyUsage(getDs(), req.tid!)
    const now = Date.now()
    let available = 0
    let inUse = 0
    let expired = 0
    let invalid = 0
    let unknown = 0
    let active = 0
    const byCountry = new Map<string, { country: string; total: number; available: number }>()
    for (const p of list) {
      const ps = proxyPoolStatus(p, usage.get(p.id) || 0, now)
      if (ps === 'available') available++
      else if (ps === 'in-use') inUse++
      else if (ps === 'expired') expired++
      else if (ps === 'invalid') invalid++
      else unknown++
      if (p.status === 'active') active++
      if (p.country) {
        const c = byCountry.get(p.country) || { country: p.country, total: 0, available: 0 }
        c.total++
        if (ps === 'available') c.available++
        byCountry.set(p.country, c)
      }
    }
    res.json({
      total: list.length,
      active,
      available,
      inUse,
      expired,
      invalid,
      unknown,
      byCountry: [...byCountry.values()].sort((a, b) => b.total - a.total)
    })
  })

  // 批量导入代理（每行一条，支持多种格式，见 parseProxyLine）
  router.post('/proxies/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const text: string = req.body?.text || ''
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return res.status(400).json({ message: '没有可导入的数据' })

    const repo = getDs().getRepository(ProxyEntity)
    let ok = 0
    const failed: string[] = []
    for (const line of lines) {
      const parsed = parseProxyLine(line)
      if (!parsed) {
        failed.push(line)
        continue
      }
      await repo.save(repo.create({ teamId: req.tid!, ownerId: req.uid!, name: `${parsed.host}:${parsed.port}`, ...parsed }))
      ok += 1
    }
    await writeLog(req, 'import_proxies', `批量导入代理 ${ok} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`)
    res.json({ imported: ok, failed })
  })

  // 代理导出（文本，便于备份与迁移）
  router.get('/proxies/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const list = await repo.find({ where: ownerScope(req), order: { id: 'ASC' } })
    const text = list
      .map((p) => [p.type, p.host, p.port, p.username, p.password].join(':'))
      .join('\n')
    res.json({ text, count: list.length })
  })
}