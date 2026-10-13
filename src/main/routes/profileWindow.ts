import { Router, type Request, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { ProfileEntity, ProxyEntity, CookieEntity, AccountEntity, TeamMemberEntity, TeamEntity, AppSettingsEntity } from '../entities'
import { ownerScope, ownerAndWhere } from '../authScope'
import type { AuthedRequest } from '../authScope'
import type { BrowserBridge } from '../browserBridge'
import { getEnvExpiresAt } from '../../shared/envExpiry'
import { buildHealthReport, healthItemLabel, type HealthReport } from '../../shared/healthcheck'
import { diffBaseline, regressedItems, regressedText, MIN_SAMPLES, type HealthBaseline } from '../../shared/healthBaseline'
import { SCAN_SITES, getScanSite, type ScanResult } from '../fingerprintScan'
import type { Fingerprint } from '../../shared/types'

export interface ProfileWindowRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  /**
   * 取浏览器桥的**函数**而非值。桥由 main 进程在启动后才通过 setBrowserBridge 注入，
   * 按值捕获拿到的是 null，所有窗口操作会一律报「浏览器引擎未就绪」。
   */
  getBridge: () => BrowserBridge | null
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /** 环境的 API 输出形态（含指纹展开）。与登录态 GET /profiles/:id 共用同一序列化 */
  mapProfile: (p: ProfileEntity) => Record<string, unknown>
}

/**
 * 环境窗口操作域：开关窗口 / 体检 / 批量体检 / 截图 / 在线检测 / 从模板克隆 / 跨团队转移。
 *
 * ## 全部动作都要求窗口处于运行态
 * 体检、截图、在线检测这三类操作的共同点：**只有注入真正生效了，读回来的值才有意义**。
 * 体检是「设定值 ↔ 回读值」对撞，截图与检测则是真实页面渲染 ——
 * 窗口没开时执行它们，得到的要么是空、要么是假绿。
 * 故每个入口都先校验 `status === 'running'`，**不自动开窗**：
 * 替用户开窗会改动他当前的窗口布局，而他可能正开着别的环境做别的事。
 *
 * ## 体检的 audioSeed 必须与 preload 同源
 * `profileId * 2654435761` 是 preload 注入端与体检端共用的种子公式。
 * 两端一旦漂移，体检算出的音频期望值与窗口内实际注入的值永远对不上，
 *表现为「音频特征项恒红」——一个看似数据坏了、实则代码不同步的假象。
 *
 * ## 批量体检的并发上限
 * 探针要在每个窗口里跑 JS 采集，无上限并发会把主进程打爆（几十个窗口同时采集）。
 * 故分片并发 10；未运行的环境标 skipped 而不自动开窗。
 */
export function registerProfileWindowRoutes(router: Router, deps: ProfileWindowRouteDeps): void {
  const { getDs, getBridge, authMiddleware, writeLog, mapProfile } = deps
  router.post('/profiles/:id/open', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    if (p.status === 'running') return res.status(400).json({ message: '窗口已在运行中' })
    // 生命周期管理（候选③）：到期环境拒绝打开，提示用户在编辑中延长或清空到期时间
    const exp = getEnvExpiresAt(p.fingerprint as Record<string, unknown>)
    if (exp && new Date(exp).getTime() < Date.now()) {
      const when = exp.slice(0, 16).replace('T', ' ')
      return res.status(400).json({ message: `环境已过期（到期时间 ${when}），请在编辑中延长或清空到期时间后重试` })
    }
    const bridge = getBridge()
    if (!bridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    try {
      await bridge.openWindow(p.id)
      p.status = 'running'
      p.lastOpenedAt = new Date()
      await repo.save(p)
      await writeLog(req, 'open_profile', `打开环境「${p.name}」(#${p.id})`)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ message: (e as Error).message })
    }
  })

  router.post('/profiles/:id/close', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const bridge = getBridge()
    if (bridge) await bridge.closeWindow(p.id)
    p.status = 'idle'
    await repo.save(p)
    await writeLog(req, 'close_profile', `关闭环境「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  // 环境体检：把「数据库里的设定指纹」与「窗口内实测回读值」对撞，
  // 输出伪装度分与一致性红绿灯（IP国家 ↔ 时区 ↔ 语言 ↔ UA 是否自洽）。
  // 必须在环境窗口运行时执行——注入生效与否只有在真实页面上下文里才读得准。
  router.post('/profiles/:id/healthcheck', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    const bridge = getBridge()
    if (!bridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    if (p.status !== 'running') return res.status(400).json({ message: '请先打开环境窗口，再执行体检' })
    const actual = await bridge.probeFingerprint(p.id)
    if (!actual) return res.status(400).json({ message: '环境窗口未运行，请打开后再体检' })
    if (actual.error) return res.status(500).json({ message: `指纹采集失败：${actual.error}` })
    let proxyCountry = ''
    if (p.proxyId) {
      const px = await getDs().getRepository(ProxyEntity).findOne({ where: { id: p.proxyId } })
      proxyCountry = px?.country || ''
    }
    // audioSeed 必须与 preload 注入端的 seed 同源（profileId * 2654435761），
    // 否则体检算出的音频期望值与窗口内实际注入的值对不上，会永远判不合格。
    const report = buildHealthReport(p.fingerprint as unknown as Partial<Fingerprint>, actual, {
      proxyCountry,
      audioSeed: p.id * 2654435761
    })
    res.json(report)
  })

  // 批量体检总览：一次对 N 个选中环境跑体检，聚合出「系统级问题分布」+ 逐环境报告。
  // 每个环境需处于 running（探针必须在真实窗口内执行，与单环境体检一致）；未运行的环境标记为 skipped，
  // 不自动开关窗口以免改动用户状态。探针并发受限（默认 10），避免同时几十个窗口 JS 采集把主进程打爆。
  router.post('/profiles/batch-healthcheck', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n))
      : []
    if (!ids.length) return res.status(400).json({ message: '请选择至少一个环境' })
    const bridge = getBridge()
    if (!bridge) return res.status(500).json({ message: '浏览器引擎未就绪' })

    const repo = getDs().getRepository(ProfileEntity)
    const proxyRepo = getDs().getRepository(ProxyEntity)
    const profiles = await repo.find({ where: { id: In(ids), ...ownerScope(req) } })
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is ProfileEntity => !!p)

    const PASS = 80
    const results: Array<{
      id: number
      name: string
      status: string
      skipped: boolean
      reason?: string
      report?: HealthReport
    }> = []
    const itemStats = new Map<string, { passed: number; failed: number; na: number }>()
    let probed = 0, skipped = 0, scoreSum = 0, passCount = 0

    const probeOne = async (p: ProfileEntity) => {
      if (p.status !== 'running') return { skipped: true as const, reason: '环境未运行', report: undefined as HealthReport | undefined }
      const actual = await bridge.probeFingerprint(p.id)
      if (!actual) return { skipped: true as const, reason: '窗口未运行', report: undefined }
      if (actual.error) return { skipped: true as const, reason: `采集失败：${actual.error}`, report: undefined }
      let proxyCountry = ''
      if (p.proxyId) {
        const px = await proxyRepo.findOne({ where: { id: p.proxyId } })
        proxyCountry = px?.country || ''
      }
      const report = buildHealthReport(p.fingerprint as unknown as Partial<Fingerprint>, actual, {
        proxyCountry,
        audioSeed: p.id * 2654435761
      })
      return { skipped: false as const, reason: undefined as string | undefined, report }
    }

    const CONCURRENCY = 10
    for (let i = 0; i < ordered.length; i += CONCURRENCY) {
      const chunk = ordered.slice(i, i + CONCURRENCY)
      const chunkRes = await Promise.all(chunk.map((p) => probeOne(p).then((r) => ({ p, r }))))
      for (const { p, r } of chunkRes) {
        if (r.skipped || !r.report) {
          skipped++
          results.push({ id: p.id, name: p.name, status: p.status, skipped: true, reason: r.reason })
          continue
        }
        const report = r.report
        probed++
        scoreSum += report.score
        if (report.score >= PASS) passCount++
        for (const it of report.items) {
          const st = itemStats.get(it.key) || { passed: 0, failed: 0, na: 0 }
          if (it.weight === 0) st.na++
          else if (it.ok) st.passed++
          else st.failed++
          itemStats.set(it.key, st)
        }
        results.push({ id: p.id, name: p.name, status: p.status, skipped: false, report })
      }
    }

    const itemStatsArr = Array.from(itemStats.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.failed - a.failed || b.passed - a.passed)

    // ===== 体检基线对比（发现「注入改坏了」）=====
    // 单次体检报告是即用即弃的，跑完就没了。而指纹注入代码一改，往往一次改坏
    // 影响**全部**环境——这正是最该被立刻发现的信号，却最难靠用户主动复查发现。
    // 故把本次聚合存为基线，下次体检时对比：有检查项的通过率集体下滑则告警。
    //
    // 基线存在 app_settings 单例的 settings.healthBaseline 里，**不新增数据库表**：
    // 一是避免让已有用户升级就得跑 db:sync，二是注入逻辑本就是全局的，
    // 全局基线在语义上比「每团队一份」更正确（改坏的是代码，不是某个团队的数据）。
    const agg = Object.fromEntries(itemStatsArr.map((x) => [x.key, { passed: x.passed, failed: x.failed, na: x.na }]))
    const baseline = (await loadHealthBaseline()) as HealthBaseline | null
    const diffs = diffBaseline(baseline, agg)
    const bad = regressedItems(diffs)

    // 回归时先告警、再更新基线：顺序反了的话，一旦告警投递失败基线已被覆盖，
    // 这条回归就永远丢了，下一轮会以为「一切正常」。
    if (bad.length) {
      const text = regressedText(diffs, healthItemLabel)
      await writeLog(req, 'health_baseline_regressed', text)
    }
    // 只在有足够样本时才更新基线：拿 1~2 个环境的结果当基线，
    // 下次拿 20 个来比就会得出「大幅回归」的错误结论。
    if (probed >= MIN_SAMPLES) {
      await saveHealthBaseline({
        savedAt: new Date().toISOString(),
        probed,
        avgScore: probed ? Math.round(scoreSum / probed) : 0,
        items: agg
      })
    }

    res.json({
      total: ordered.length,
      probed,
      skipped,
      avgScore: probed ? Math.round(scoreSum / probed) : 0,
      passCount,
      passThreshold: PASS,
      itemStats: itemStatsArr,
      profiles: results,
      baseline: {
        // 首次体检时 baseline 为 null，前端据此显示「已建立首个基线」而非「无变化」
        firstRun: !baseline,
        comparedAt: baseline?.savedAt ?? null,
        diffs,
        regressed: bad.map((d) => d.key)
      }
    })
  })

  // 读 / 写体检基线（存 app_settings 单例，非独立表）
  async function loadHealthBaseline(): Promise<HealthBaseline | null> {
    const row = await getDs().getRepository(AppSettingsEntity).findOne({ where: { key: 'global' } })
    const v = (row?.settings as Record<string, unknown> | undefined)?.healthBaseline
    return (v as HealthBaseline | undefined) ?? null
  }
  async function saveHealthBaseline(b: HealthBaseline): Promise<void> {
    const repo = getDs().getRepository(AppSettingsEntity)
    const row = await repo.findOne({ where: { key: 'global' } })
    if (!row) return
    await repo.save(repo.create({ ...row, settings: { ...(row.settings || {}), healthBaseline: b } }))
  }

  // 环境截图：截取运行中环境窗口当前视口，返回 PNG（data URL）。
  // 用于 SEO 报告 / 收录检测 / A-B 测试证据 / 竞品调研留痕等；必须在环境运行时执行——
  // capturePage 只能在真实窗口上下文里截到页面内容（与体检同理）。
  router.post('/profiles/:id/screenshot', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    if (p.status !== 'running') return res.status(400).json({ message: '请先打开环境窗口，再截图' })
    const bridge = getBridge()
    if (!bridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    try {
      const buf = await bridge.captureScreenshot(p.id)
      const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
      await writeLog(req, 'screenshot_profile', `对环境「${p.name}」(#${p.id}) 截图`)
      res.json({ ok: true, image: dataUrl, capturedAt: new Date().toISOString() })
    } catch (e) {
      res.status(400).json({ message: (e as Error).message })
    }
  })

  // ===== 在线检测站实战验证 =====
  // 与环境体检互补：体检是「自己出题自己判卷」（设定值 ↔ 回读值），
  // 这里则是让第三方检测站从外部视角评判，能发现设定值互相矛盾、
  // 或某项指标落在真实人群分布之外这类体检抓不到的问题。
  // 站点清单不含凭据，直接下发即可；扫描结果含截图，故需登录鉴权。
  router.get('/scan-sites', authMiddleware, (_req: AuthedRequest, res: Response) => {
    res.json(
      SCAN_SITES.map((s) => ({ id: s.id, name: s.name, url: s.url, desc: s.desc }))
    )
  })

  router.post('/profiles/:id/scan', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    if (p.status !== 'running') return res.status(400).json({ message: '请先打开环境窗口，再执行在线检测' })
    const bridge = getBridge()
    if (!bridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    const siteId = String((req.body || {}).siteId || '')
    const site = getScanSite(siteId)
    if (!site) return res.status(400).json({ message: `未知检测站：${siteId}` })
    try {
      const result: ScanResult = await bridge.scanSite(p.id, siteId)
      // 抓取异常（网络不通 / 被验证拦截）同样要留痕：这类记录恰恰最需要追溯
      const tail = result.error ? `（抓取异常：${result.error}）` : ''
      await writeLog(req, 'scan_profile', `对环境「${p.name}」(#${p.id}) 执行在线检测（${site.name}）${tail}`)
      res.json(result)
    } catch (e) {
      const detail = (e as Error).message
      await writeLog(req, 'scan_profile', `对环境「${p.name}」(#${p.id}) 执行在线检测失败（${site.name}）：${detail}`)
      res.status(400).json({ message: detail })
    }
  })

  // 从模板创建环境
  router.post('/profiles/:id/clone', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const tpl = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!tpl) return res.status(404).json({ message: '模板不存在' })
    const qbMax2 = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbMax2, req)
    const max = await qbMax2.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        groupId: tpl.groupId,
        name: (req.body?.name as string) || `${tpl.name} 副本`,
        seq,
        remark: tpl.remark,
        platform: tpl.platform,
        startUrl: tpl.startUrl,
        proxyId: null,
        fingerprint: tpl.fingerprint,
        isTemplate: false,
        createdBy: req.uid!
      })
    )
    await writeLog(req, 'clone_template', `从模板「${tpl.name}」创建环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })

  // 环境转移到其他团队：团队切换器打通的多团队模型下，数据按 teamId 强隔离，
  // 「转移」= 把环境及其关联 Cookie / 账号的归属 teamId 改写为目标团队（即把数据分享给目标团队）。
  // 仅当操作人本人也是目标团队成员时才允许移入，避免把数据塞进无权访问的团队；
  // 转移前必须关闭运行中的窗口（与删除同等约束），并级联迁移关联数据，避免产生跨团队孤儿记录。
  router.post('/profiles/:id/transfer', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口，再转移' })
    const targetTeamId = Number((req.body || {}).teamId)
    if (!targetTeamId || targetTeamId === req.tid) return res.status(400).json({ message: '请选择不同的目标团队' })
    // 操作人必须是目标团队成员，否则无权把数据移入该团队
    const memberRepo = getDs().getRepository(TeamMemberEntity)
    const targetMember = await memberRepo.findOne({ where: { userId: req.uid, teamId: targetTeamId } })
    if (!targetMember) return res.status(403).json({ message: '你不是目标团队成员，无法转移' })
    const targetTeam = await getDs().getRepository(TeamEntity).findOne({ where: { id: targetTeamId } })
    // 改写环境归属
    p.teamId = targetTeamId
    p.ownerId = req.uid!
    await repo.save(p)
    // 级联：该环境的 Cookie / 账号一并归属到目标团队（保持同团队，避免孤儿数据）。
    // Cookie 自带 teamId 列需改写；账号无 teamId 列、靠 profileId 隐式归属新团队，只同步 ownerId。
    await getDs().getRepository(CookieEntity).update({ profileId: p.id }, { teamId: targetTeamId, ownerId: req.uid! })
    await getDs().getRepository(AccountEntity).update({ profileId: p.id }, { ownerId: req.uid! })
    await writeLog(req, 'transfer_profile', `将环境「${p.name}」(#${p.id}) 转移到团队「${targetTeam?.name || targetTeamId}」`)
    res.json({ ok: true, profile: mapProfile(p) })
  })
}
