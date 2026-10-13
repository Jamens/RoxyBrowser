import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { ProfileEntity, ProxyEntity, AccountEntity, GroupEntity, CookieEntity } from '../entities'
import { ownerScope, ownerAndWhere } from '../authScope'
import type { AuthedRequest } from '../authScope'
import type { BrowserBridge } from '../browserBridge'
import { randomFingerprint, deriveJitteredFingerprint } from '../../shared/fingerprint'
import { getEnvExpiresAt } from '../../shared/envExpiry'
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  validateSnapshot,
  normalizeSnapshot,
  type SnapshotFile
} from '../../shared/snapshot'
import {
  importProfileItems,
  importProxiesStructured,
  importRpaStructured,
  buildSnapshot
} from '../exporters'
import type { Fingerprint } from '../../shared/types'

export interface ProfileMigrateRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  /** 批量「打开」子动作要真开窗。取函数而非值：桥在启动后才注入 */
  getBridge: () => BrowserBridge | null
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
}

/**
 * 环境迁移与批量操作域：导入 / 全空间快照 / 复制克隆 / 批量重随机 / 批量移动·绑代理·删除·打开。
 *
 * ## 导入导出全部复用 exporters，不在这里另写一套
 * 单环境导入、批量导入、全空间快照导入、导入器的复用规则（同名分组/代理复用、
 * 扩展按名称引用、缺失即丢）全都在 `exporters.ts`。这里只做三件事：
 * 解析三种入参形态、调导入器、把 summary 如实回报。
 * 任何在路由层「顺手优化」落库逻辑的改动，都会让同一份数据经不同入口得到不同结果。
 *
 * ## 批量动作一律跳过运行中的环境
 * moveGroup / bindProxy / delete / randomize 都不动 `status === 'running'` 的环境：
 * 窗口正在用这套配置跑，改了下一次采集就对不上；删了则状态自相矛盾（进程里还开着，
 * 库里已软删）。批量打开时额外跳过**已过期**环境。
 *
 * ## 逐条失败不中断整批
 * 克隆、批量打开都是 try/catch 包住单条：一个环境失败不影响其余，
 * 最后只按成功数写日志。批量接口的价值就是「一次操作处理多个」，
 * 遇一个失败就整批回滚会让用户什么都做不成。
 */
export function registerProfileMigrateRoutes(router: Router, deps: ProfileMigrateRouteDeps): void {
  const { getDs, getBridge, authMiddleware, writeLog } = deps
  // ===== 批量能力：导入 / 导出 / 复制 / 批量随机指纹 =====

  // 导入环境（JSON）：兼容纯环境数组，也支持带分组 / 代理 / 账号的完整迁移文件
  router.post('/profiles/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const payload = req.body || {}
    // 支持三种入参：{ items: [...] }（批量）、整环境导出单对象（含 name 字段）、裸数组 [...]
    const items = (Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : payload && payload.name
          ? [payload]
          : []) as Array<Record<string, unknown>>
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: '没有可导入的数据' })
    // 复用导出器里的导入实现，保证与全空间快照导入同源
    const summary = await importProfileItems(items, { tid: req.tid!, uid: req.uid, role: req.role })
    if (summary.created === 0) return res.status(400).json({ message: '没有有效的环境可导入' })
    await writeLog(
      req,
      'import_profiles',
      `导入 ${summary.created} 个环境（新建分组 ${summary.groupsCreated} 个、代理 ${summary.proxiesCreated} 条、账号 ${summary.accountsCreated} 条、Cookie ${summary.cookiesCreated} 条）`
    )
    res.json({
      created: summary.created,
      items: summary.items,
      groupsCreated: summary.groupsCreated,
      proxiesCreated: summary.proxiesCreated,
      accountsCreated: summary.accountsCreated,
      cookiesCreated: summary.cookiesCreated
    })
  })

  // ===== 全空间快照：把整个团队空间打包为单一 JSON（环境 + 代理 + RPA + 扩展引用）=====
  // 复用各模块导出器拼装；导入端同样复用各模块导入器，保证「整环境迁移」与「整团队迁移」同源。
  router.get('/snapshot/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const snap = await buildSnapshot({ tid: req.tid!, uid: req.uid, role: req.role }, req.username)
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="roxy-snapshot-${req.tid}-${stamp}.json"`)
    res.send(JSON.stringify(snap, null, 2))
  })

  // 一键灌入：先恢复代理池（按名称复用），再导入环境（引用同名代理），最后导入 RPA。
  // 扩展为名称引用，目标缺同名扩展则自动丢弃引用（与单环境导入行为一致）。
  router.post('/snapshot/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const v = validateSnapshot(req.body)
    if (!v.ok) return res.status(400).json({ message: '快照文件不合法：' + v.errors.join('；'), detail: v })
    const data = normalizeSnapshot(req.body as SnapshotFile)
    const proxyRes = await importProxiesStructured(data.proxies, { tid: req.tid!, uid: req.uid, role: req.role })
    const profRes = await importProfileItems(data.profiles as unknown as Array<Record<string, unknown>>, {
      tid: req.tid!,
      uid: req.uid,
      role: req.role
    })
    const rpaRes = await importRpaStructured(data.rpa, { tid: req.tid!, uid: req.uid, role: req.role })
    if (profRes.created === 0 && proxyRes.imported === 0 && rpaRes.created === 0) {
      return res.status(400).json({ message: '快照中没有可导入的内容' })
    }
    await writeLog(
      req,
      'import_snapshot',
      `导入快照（团队「${data.team.name || req.tid}」）：环境 ${profRes.created} 个、代理 ${proxyRes.imported} 条、RPA ${rpaRes.created} 个`
    )
    res.json({
      ok: true,
      profiles: profRes.created,
      groupsCreated: profRes.groupsCreated,
      proxiesCreated: proxyRes.imported,
      proxiesSkipped: proxyRes.skipped,
      rpaCreated: rpaRes.created,
      extensionsReferenced: data.extensions.length
    })
  })


  // 复制环境（连同账号一起复制，用于资料迁移）
  router.post('/profiles/:id/duplicate', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const src = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!src) return res.status(404).json({ message: '环境不存在' })
    const qbDup = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbDup, req)
    const max = await qbDup.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const copy = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        groupId: src.groupId,
        name: `${src.name} 副本`,
        seq,
        remark: src.remark,
        platform: src.platform,
        startUrl: src.startUrl,
        proxyId: null,
        fingerprint: src.fingerprint,
        isTemplate: src.isTemplate,
        createdBy: req.uid!
      })
    )
    // 连同账号资料一起迁移
    const accRepo = getDs().getRepository(AccountEntity)
    const accounts = await accRepo.find({ where: { profileId: src.id } })
    for (const a of accounts) {
      await accRepo.save(
        accRepo.create({
          profileId: copy.id,
          ownerId: req.uid!,
          platform: a.platform,
          username: a.username,
          password: a.password,
          remark: a.remark
        })
      )
    }
    await writeLog(req, 'duplicate_profile', `复制环境「${src.name}」→「${copy.name}」，迁移 ${accounts.length} 个账号`)
    res.json({ id: copy.id, name: copy.name, migratedAccounts: accounts.length })
  })

  // 环境克隆工厂：以某环境为母本批量派生 N 个副本。
  // 与 /duplicate（单个、指纹原样复制）的关键区别——每个副本都做「指纹微抖动」：
  // 行为一致（系统 / UA / 语言 / 时区 / 噪声开关），指纹各异（分辨率 / CPU / 内存 / 显卡 / 字体），
  // 避免批量号共用同一套设备特征被一锅端。
  // 明确不复制 Cookie：登录态复制过去等于主动制造关联。
  router.post('/profiles/:id/duplicate-batch', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const src = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!src) return res.status(404).json({ message: '环境不存在' })
    if (src.isTemplate) return res.status(400).json({ message: '模板环境不支持批量克隆' })
    const body = req.body || {}
    const count = Math.max(1, Math.min(50, Number(body.count) || 1))
    const namePrefix = String(body.namePrefix || src.name).trim() || src.name
    const copyAccounts = !!body.copyAccounts
    const srcFp = (src.fingerprint || {}) as unknown as Fingerprint

    const accRepo = getDs().getRepository(AccountEntity)
    const accounts = copyAccounts ? await accRepo.find({ where: { profileId: src.id } }) : []

    const qbBatch = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbBatch, req)
    let seq = ((await qbBatch.getRawOne<{ m: number | null }>())?.m || 1000) + 1

    const created: { id: number; name: string }[] = []
    for (let i = 1; i <= count; i++) {
      const copy = await repo.save(
        repo.create({
          teamId: req.tid!,
          ownerId: req.uid!,
          groupId: src.groupId,
          name: `${namePrefix} ${i}`,
          seq: seq++,
          remark: src.remark,
          platform: src.platform,
          startUrl: src.startUrl,
          proxyId: null,
          fingerprint: deriveJitteredFingerprint(srcFp) as unknown as Record<string, unknown>,
          isTemplate: false,
          createdBy: req.uid!
        })
      )
      for (const a of accounts) {
        await accRepo.save(
          accRepo.create({
            profileId: copy.id,
            ownerId: req.uid!,
            platform: a.platform,
            username: a.username,
            password: a.password,
            remark: a.remark
          })
        )
      }
      created.push({ id: copy.id, name: copy.name })
    }
    await writeLog(
      req,
      'duplicate_batch',
      `从「${src.name}」批量克隆 ${created.length} 个环境（指纹微抖动${copyAccounts ? `，账号资料一并复制` : ''}）`
    )
    res.json({ created: created.length, items: created })
  })

  // 批量重新生成指纹
  router.post('/profiles/batch-randomize', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids: number[] = req.body?.ids || []
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: '请先选择环境' })
    const repo = getDs().getRepository(ProfileEntity)
    let count = 0
    for (const id of ids) {
      const p = await repo.findOne({ where: { id: Number(id), ...ownerScope(req) } })
      if (!p) continue
      if (p.status === 'running') continue // 运行中的环境不改动
      p.fingerprint = randomFingerprint() as unknown as Record<string, unknown>
      await repo.save(p)
      count += 1
    }
    await writeLog(req, 'batch_randomize', `批量重随机 ${count} 个环境的指纹`)
    res.json({ updated: count })
  })

  // 批量操作：moveGroup / bindProxy / delete（软删除进回收站）/ open
  // 路由顺序：/profiles/batch 是静态段，与 /profiles/:id/* 不冲突
  router.post('/profiles/batch', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids: unknown[] = req.body?.ids || []
    const action: string = req.body?.action
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: '请先选择环境' })
    const repo = getDs().getRepository(ProfileEntity)
    const profiles = await repo.find({ where: { id: In(ids.map(Number)), ...ownerScope(req) } })
    if (profiles.length === 0) return res.status(404).json({ message: '未找到所选环境' })
    const now = new Date()

    if (action === 'moveGroup') {
      const raw = req.body?.groupId
      const groupId = raw === null || raw === undefined ? null : Number(raw)
      if (groupId != null) {
        const g = await getDs().getRepository(GroupEntity).findOne({ where: { id: groupId, teamId: req.tid } })
        if (!g) return res.status(400).json({ message: '目标分组不存在' })
      }
      for (const p of profiles) {
        p.groupId = groupId
        await repo.save(p)
      }
      await writeLog(req, 'batch_move_group', `批量移动 ${profiles.length} 个环境到分组 #${groupId ?? '无'}`)
      return res.json({ updated: profiles.length })
    }

    if (action === 'bindProxy') {
      const raw = req.body?.proxyId
      const proxyId = raw === null || raw === undefined ? null : Number(raw)
      if (proxyId != null) {
        const pr = await getDs().getRepository(ProxyEntity).findOne({ where: { id: proxyId, ...ownerScope(req) } })
        if (!pr) return res.status(400).json({ message: '目标代理不存在' })
      }
      let updated = 0
      for (const p of profiles) {
        if (p.status === 'running') continue // 运行中的环境不改动绑定
        p.proxyId = proxyId
        await repo.save(p)
        updated += 1
      }
      await writeLog(req, 'batch_bind_proxy', `批量绑定 ${updated} 个环境到代理 #${proxyId ?? '无'}`)
      return res.json({ updated })
    }

    if (action === 'delete') {
      let updated = 0
      for (const p of profiles) {
        if (p.status === 'running') continue
        if (p.deletedAt) continue
        p.deletedAt = now
        await repo.save(p)
        updated += 1
      }
      await writeLog(req, 'batch_delete_profile', `批量删除 ${updated} 个环境（进回收站）`)
      return res.json({ updated })
    }

    if (action === 'open') {
      const bridge = getBridge()
      if (!bridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
      let opened = 0
      for (const p of profiles) {
        if (p.status === 'running' || p.deletedAt) continue
        // 生命周期管理（候选③）：到期环境在批量打开时同样跳过
        const exp = getEnvExpiresAt(p.fingerprint as Record<string, unknown>)
        if (exp && new Date(exp).getTime() < Date.now()) continue
        try {
          await bridge.openWindow(p.id)
          p.status = 'running'
          p.lastOpenedAt = now
          await repo.save(p)
          opened += 1
        } catch {
          /* 单个窗口打开失败不影响其他 */
        }
      }
      await writeLog(req, 'batch_open_profile', `批量打开 ${opened} 个环境`)
      return res.json({ updated: opened })
    }

    return res.status(400).json({ message: '未知批量操作' })
  })
}
