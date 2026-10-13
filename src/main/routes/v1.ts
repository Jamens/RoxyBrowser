import express, { type Request, type Response, type NextFunction } from 'express'
import { IsNull } from 'typeorm'
import type { DataSource } from 'typeorm'
import { ProfileEntity, ProxyEntity, AccountEntity, CookieEntity, RpaScriptEntity } from '../entities'
import type { AuthedRequest } from '../authScope'
import type { BrowserBridge } from '../browserBridge'
import { getCdpInfo } from '../cdpManager'
import { applyCookies, getRunningWindowIds, replayRpaScript } from '../browserManager'
import { allocateProxy, applyProxyCheckResult, checkProxy, computeProxyUsage, ApiError } from '../proxyService'
import { randomFingerprint, normalizeFingerprint, listFingerprintPresets } from '../../shared/fingerprint'
import { substituteSteps, normalizeVariables } from '../../shared/rpa'
import { DEFAULT_START_URL, type RpaStep, type OSKind, type AppSettings } from '../../shared/types'
import { registerV1CookieRoutes } from './v1Cookie'
import { apiShouldAudit, apiActionName, apiAuditDetail } from '../apiAudit'

export interface V1RouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  /** 浏览器窗口桥。取函数而非值：bridge 由 main 进程在启动后才注入（setBrowserBridge） */
  getBridge: () => BrowserBridge | null
  /** 令牌鉴权：v1 用 API 令牌而非登录会话，权限与作用域都不同，不能复用 authMiddleware */
  tokenAuthMiddleware: (req: Request, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: unknown) => Promise<void>
  /** 代理检测超时等参数来自全局设置，v1 与登录态 API 共用同一份，不能各读各的 */
  getSettings: () => Promise<AppSettings>
  /** 环境的 v1 输出形态（含指纹展开）。与登录态 GET /profiles/:id 保持同一序列化 */
  mapProfile: (p: ProfileEntity) => Record<string, unknown>
}

/**
 * 自动化 API v1：令牌鉴权，供外部脚本 / 调度器驱动。
 *
 * ## 与登录态API 的三处根本差异
 * 1. **鉴权**：`tokenAuthMiddleware` 而非 `authMiddleware`。令牌按 teamId 鉴权，
 *    拿不到别的团队的数据；但令牌可被复制，**不能**像会话那样随时撤销到单设备。
 * 2. **返回约定**：成功 `{ code: 0, data }`，失败 `{ code, message }`。
 *    这是给脚本用的——脚本判断 `code === 0` 即可，不必区分 HTTP 状态。
 * 3. **错误文案**：全英文（`profile not found`）。这套 API 的调用方是脚本与
 *    第三方集成，中文报错在对方的日志里是噪音。
 *
 * ## 审计为什么要用中间件兜底
 * 令牌能创建 / 删除环境、导出 Cookie、跑 RPA。不落日志就完全无法追溯
 * 「谁在何时用哪个令牌做了什么」——这是实打实的审计盲区。
 * 中间件统一兜底而非逐路由手写：既省事，也杜绝以后新增 v1 接口漏记。
 * 推导逻辑在 `apiAudit.ts` 纯函数模块（与 webhook.ts / logExport.ts 同构），可离线单测。
 */
export function createV1Router(deps: V1RouteDeps): express.Router {
  const { getDs, getBridge, tokenAuthMiddleware, writeLog, getSettings, mapProfile } = deps
  const v1 = express.Router()
  v1.use(tokenAuthMiddleware)

  // ===== v1 审计：令牌调用统一留痕 =====
  // 兜底理由见文件头注释；推导逻辑在 apiAudit.ts 纯函数模块，可离线单测。
  v1.use((req, res, next) => {
    res.on('finish', () => {
      if (!apiShouldAudit(req.method, req.path)) return
      const action = apiActionName(req.method, req.path)
      if (!action) return
      void writeLog(req as AuthedRequest, action, apiAuditDetail(req.method, req.path, req.body))
    })
    next()
  })

  // ===== CDP 调试端点（供 Playwright / Puppeteer 连接）=====
  // 返回连接地址与「当前打开的环境 → targetId」映射。只读接口，不改任何数据，
  // 故不进 apiShouldAudit 的写审计；但返回的 profileId 列表属于环境元信息，
  // 令牌本身是按 teamId 鉴权的，跨团队拿不到别人的环境 id。
  v1.get('/cdp', async (_req: Request, res: Response) => {
    res.json({ code: 0, data: await getCdpInfo() })
  })

  v1.get('/profiles', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    // 排除回收站中的环境（软删除）：TypeORM 需显式用 IsNull() 表达 IS NULL
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid, isTemplate: false, deletedAt: IsNull() } })
    res.json({ code: 0, data: list.map((p) => ({ id: p.id, name: p.name, seq: p.seq, status: p.status })) })
  })

  v1.post('/profiles', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const tid = (req as AuthedRequest).tid!
    const b = req.body || {}
    let fingerprint = (b.fingerprint || randomFingerprint()) as Record<string, unknown>
    let platform = b.platform || ''
    let startUrl = b.startUrl || DEFAULT_START_URL
    let remark = b.remark || ''
    if (b.templateId) {
      const tpl = await repo.findOne({ where: { id: Number(b.templateId), teamId: tid, isTemplate: true } })
      if (!tpl) return res.status(404).json({ code: 404, message: 'template not found' })
      fingerprint = tpl.fingerprint as Record<string, unknown>
      platform = b.platform || tpl.platform || ''
      startUrl = b.startUrl || tpl.startUrl || DEFAULT_START_URL
      remark = b.remark || tpl.remark || ''
    }
    const max = await repo.createQueryBuilder('p').select('MAX(p.seq)', 'm').where('p.teamId = :tid', { tid }).getRawOne()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: tid,
        name: b.name || `API环境 ${seq}`,
        seq,
        platform,
        startUrl,
        remark,
        fingerprint,
        createdBy: 0
      })
    )
    res.json({ code: 0, data: { id: p.id, name: p.name } })
  })

  v1.post('/profiles/:id/open', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    const bridge = getBridge()
    if (!bridge) return res.status(500).json({ code: 500, message: 'browser engine not ready' })
    await bridge.openWindow(p.id)
    p.status = 'running'
    p.lastOpenedAt = new Date()
    await repo.save(p)
    res.json({ code: 0, data: { id: p.id, status: 'running' } })
  })

  v1.post('/profiles/:id/close', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    const bridge = getBridge()
    if (bridge) await bridge.closeWindow(p.id)
    p.status = 'idle'
    await repo.save(p)
    res.json({ code: 0, data: { id: p.id, status: 'idle' } })
  })

  v1.get('/proxies', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid } })
    res.json({ code: 0, data: list })
  })

  // ===== 自动化 API v1 写入类（供脚本调度） =====
  // 约定：成功返回 { code: 0, data }；失败返回 { code, message }，并记录 HTTP 状态码

  // --- 环境：查询单条 / 更新 / 删除 ---
  v1.get('/profiles/:id', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    res.json({ code: 0, data: mapProfile(p) })
  })

  v1.put('/profiles/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    const b = req.body || {}
    const fields = ['name', 'remark', 'platform', 'startUrl', 'groupId', 'proxyId', 'extensions'] as const
    for (const f of fields) {
      if (f in b) (p as any)[f] = b[f] === '' && (f === 'groupId' || f === 'proxyId') ? null : b[f]
    }
    if (b.fingerprint) p.fingerprint = b.fingerprint
    await repo.save(p)
    res.json({ code: 0, data: { id: p.id, name: p.name } })
  })

  v1.delete('/profiles/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    await repo.remove(p)
    // 清理关联数据，避免孤儿记录
    await getDs().getRepository(AccountEntity).delete({ profileId: p.id })
    await getDs().getRepository(CookieEntity).delete({ profileId: p.id })
    await getDs().getRepository(ProfileEntity).update({ teamId: tid, proxyId: p.id }, { proxyId: null })
    res.json({ code: 0, data: { id: p.id } })
  })

  // --- 代理：创建 / 查询单条 / 更新 / 删除 / 分配 / 检测 ---
  v1.post('/proxies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(ProxyEntity)
    const b = req.body || {}
    if (!b.host || !b.port) return res.status(400).json({ code: 400, message: 'host and port required' })
    const p = await repo.save(
      repo.create({
        teamId: tid,
        name: b.name || `${b.host}:${b.port}`,
        type: b.type || 'http',
        host: b.host,
        port: Number(b.port),
        username: b.username || '',
        password: b.password || '',
        remark: b.remark || ''
      })
    )
    res.json({ code: 0, data: p })
  })

  v1.get('/proxies/:id', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    res.json({ code: 0, data: p })
  })

  v1.put('/proxies/:id', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    const b = req.body || {}
    for (const f of ['name', 'type', 'host', 'username', 'password', 'remark', 'expiresAt'] as const) {
      if (f in b) (p as any)[f] = b[f]
    }
    if (b.port) p.port = Number(b.port)
    await repo.save(p)
    res.json({ code: 0, data: p })
  })

  v1.delete('/proxies/:id', async (req: Request, res: Response) => {
    const repo = getDs().getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    await repo.remove(p)
    await getDs().getRepository(ProfileEntity).update(
      { teamId: (req as AuthedRequest).tid, proxyId: p.id },
      { proxyId: null }
    )
    res.json({ code: 0, data: { id: p.id } })
  })

  v1.post('/proxies/allocate', async (req: Request, res: Response) => {
    const b = req.body || {}
    try {
      const { proxy, profileId, reused, poolStatus } = await allocateProxy(getDs(), (req as AuthedRequest).tid!, {
        profileId: b.profileId,
        country: b.country,
        region: b.region
      })
      const usage = await computeProxyUsage(getDs(), (req as AuthedRequest).tid!)
      res.json({
        code: 0,
        data: { proxy: { ...proxy, usageCount: (usage.get(proxy.id) || 0) + (profileId ? 1 : 0), poolStatus }, profileId, reused }
      })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ code: e.status, message: e.message })
      throw e
    }
  })

  v1.post('/proxies/check', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(ProxyEntity)
    const id = Number((req.body || {}).id)
    const p = await repo.findOne({ where: { id, teamId: tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    const settings = await getSettings()
    const result = await checkProxy(p, (settings.proxyCheckTimeout as number) * 1000)
    applyProxyCheckResult(p, result)
    await repo.save(p)
    res.json({ code: 0, data: p })
  })

  // --- 指纹：随机生成 ---
  v1.post('/fingerprint/random', async (req: Request, res: Response) => {
    const body = req.body || {}
    const os = body.os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    const cv = typeof body.coreVersion === 'number' ? body.coreVersion : undefined
    res.json({ code: 0, data: randomFingerprint(valid as OSKind | undefined, cv) })
  })

  // --- 账号：列表 / 创建 / 更新 / 删除 ---
  v1.get('/accounts', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: { teamId: tid, isTemplate: false } })
    const profileIds = new Set(profiles.map((p) => p.id))
    const nameMap = new Map(profiles.map((p) => [p.id, p.name]))
    const all = await repo.find({ order: { id: 'DESC' } })
    res.json({ code: 0, data: all.filter((a) => profileIds.has(a.profileId)).map((a) => ({ ...a, profileName: nameMap.get(a.profileId) || '' })) })
  })

  v1.post('/accounts', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number((req.body || {}).profileId), teamId: tid } })
    if (!profile) return res.status(400).json({ code: 400, message: 'profile not found' })
    const a = await repo.save(
      repo.create({
        profileId: profile.id,
        platform: (req.body || {}).platform || '',
        username: (req.body || {}).username || '',
        password: (req.body || {}).password || '',
        remark: (req.body || {}).remark || ''
      })
    )
    res.json({ code: 0, data: a })
  })

  v1.put('/accounts/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
    const ids = new Set((await profileRepo.find({ where: { teamId: tid } })).map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ code: 404, message: 'account not found' })
    for (const f of ['platform', 'username', 'password', 'remark'] as const) {
      if (f in (req.body || {})) (a as any)[f] = (req.body as any)[f]
    }
    await repo.save(a)
    res.json({ code: 0, data: a })
  })

  v1.delete('/accounts/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
    const ids = new Set((await profileRepo.find({ where: { teamId: tid } })).map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ code: 404, message: 'account not found' })
    await repo.remove(a)
    res.json({ code: 0, data: { id: a.id } })
  })

  // ===== Cookie（v1 自动化读写，按环境隔离）=====
  // 已抽到 src/main/routes/v1Cookie.ts；解析/映射复用 cookieText.ts，与内部接口同一套语义。
  registerV1CookieRoutes(v1, { getDs: () => getDs(), applyCookies })

  // ===== RPA 脚本（v1 自动化触发）=====
  // 列出当前团队的脚本（用于外部自动化查找 id / 步数 / 是否含变量）
  v1.get('/rpa', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(RpaScriptEntity)
    const list = await repo.find({ where: { teamId: tid }, order: { id: 'DESC' } })
    res.json({
      code: 0,
      data: list.map((s) => ({
        id: s.id,
        name: s.name,
        steps: (s.steps as unknown as RpaStep[]).length,
        hasVariables: !!(s.variables && Object.keys(s.variables).length)
      }))
    })
  })

  // 脚本详情（含完整步骤与变量，供外部自动化取用）
  v1.get('/rpa/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = getDs().getRepository(RpaScriptEntity)
    const s = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!s) return res.status(404).json({ code: 404, message: 'script not found' })
    res.json({
      code: 0,
      data: {
        id: s.id,
        name: s.name,
        remark: s.remark,
        steps: s.steps,
        variables: s.variables || {},
        scheduleEnabled: s.scheduleEnabled
      }
    })
  })

  // 触发回放（Bearer 鉴权，供外部自动化调用）。body: { profileId, variables? }
  v1.post('/rpa/:id/run', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const repo = getDs().getRepository(RpaScriptEntity)
    const s = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!s) return res.status(404).json({ code: 404, message: 'script not found' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const reqVars = (req.body || {}).variables
    const vars = reqVars && typeof reqVars === 'object' && Object.keys(reqVars).length
      ? normalizeVariables(reqVars) || {}
      : s.variables || {}
    const steps = substituteSteps(s.steps as unknown as RpaStep[], vars)
    const runningIds = getRunningWindowIds()
    if (!runningIds.includes(profileId)) {
      return res.status(400).json({ code: 400, message: 'profile not running' })
    }
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await replayRpaScript(profileId, steps)
      } catch (e) {
        err = (e as Error).message
      }
      await writeLog(
        req as AuthedRequest,
        'rpa_run',
        err
          ? `v1 回放脚本「${s.name}」失败：${err}`
          : `v1 回放脚本「${s.name}」完成（环境「${profile.name}」#${profileId}，执行 ${executed}/${steps.length} 步）`
      )
    })()
    res.json({ code: 0, data: { started: true, steps: steps.length } })
  })

  return v1
}
