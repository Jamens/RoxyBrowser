import { Router, type Response, type NextFunction } from 'express'
import { app } from 'electron'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { ProfileEntity, ProxyEntity, AccountEntity, GroupEntity, CookieEntity, ExtensionEntity } from '../entities'
import { ownerScope, ownerAndWhere } from '../authScope'
import type { AuthedRequest } from '../authScope'
import type { BrowserBridge } from '../browserBridge'
import { randomFingerprint, deriveJitteredFingerprint } from '../../shared/fingerprint'
import { getEnvExpiresAt, withEnvExpiresAt } from '../../shared/envExpiry'
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  validateSnapshot,
  normalizeSnapshot,
  migrateSnapshot,
  type SnapshotFile
} from '../../shared/snapshot'
import { diffSnapshot } from '../../shared/snapshotDiff'
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
 * 查询目标团队现状并计算导入差异。
 *
 * 之所以抽成独立函数：**预览接口与导入接口必须共用它**。
 * 若两边各写一套判定，预览与实际行为一旦漂移，用户看到的「差异」就是假的——
 * 而用户正是靠这个预览来决定是否导入，假的预览会直接导致误操作。
 *
 * 查询范围需与 importers 的 scopeOf 保持一致：owner/admin 看全部，其余仅本人创建，
 * 否则预演会把「别人建的同名代理」当成不存在，误报冲突。
 */
async function buildSnapshotDiff(
  mig: { data: SnapshotFile; from: number; applied: string[] },
  ctx: { tid: number; uid?: number; role?: string },
  getDs: () => DataSource
) {
  const data = normalizeSnapshot(mig.data)
  // 与 exporters.scopeOf 同规则：owner/admin 不过滤，其余按 ownerId 隔离
  const scope =
    ctx.role === 'owner' || ctx.role === 'admin' ? {} : { ownerId: ctx.uid }
  const [proxyList, groupList, extList] = await Promise.all([
    getDs().getRepository(ProxyEntity).find({ where: { teamId: ctx.tid, ...scope } }),
    getDs().getRepository(GroupEntity).find({ where: { teamId: ctx.tid, ...scope } }),
    getDs().getRepository(ExtensionEntity).find({ where: { teamId: ctx.tid, ...scope } })
  ])
  return diffSnapshot(
    data,
    {
      proxies: proxyList.map((p) => ({ name: p.name, host: p.host, port: Number(p.port) })),
      groups: groupList.map((g) => g.name),
      extensions: extList.map((e) => e.name)
    },
    { from: mig.from, applied: mig.applied }
  )
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
    // 带上 appVersion：将来排查「同一份快照在不同机器上行为不同」时，
    // 第一手证据就是它由哪个应用版本导出（此前该字段声明了却从未赋值，等于没有）。
    const snap = await buildSnapshot({ tid: req.tid!, uid: req.uid, role: req.role }, req.username, app.getVersion())
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="roxy-snapshot-${req.tid}-${stamp}.json"`)
    res.send(JSON.stringify(snap, null, 2))
  })

  // 导入预演：**只读、不写库**。返回这次导入会发生什么（哪些新建/复用/连接冲突/
  // 哪些扩展引用会丢），供设置页在确认前展示。
  // 与 /snapshot/import 共用同一套校验 + 迁移 + 差异计算（buildSnapshotDiff），
  // 保证「预览说的」与「导入做的」不会不一致——不一致的预览比没有预览更危险。
  router.post('/snapshot/preview', authMiddleware, async (req: AuthedRequest, res: Response) => {
    try {
      const v = validateSnapshot(req.body)
      if (!v.ok) return res.status(400).json({ message: '快照文件不合法：' + v.errors.join('；'), detail: v })
      const mig = migrateSnapshot(req.body)
      if (mig.to !== SNAPSHOT_VERSION) {
        return res.status(400).json({
          message: `快照版本 ${mig.from} 无法迁移到当前版本 ${SNAPSHOT_VERSION}：缺少 v${mig.to} → v${mig.to + 1} 的迁移步骤`
        })
      }
      const diff = await buildSnapshotDiff(mig, { tid: req.tid!, uid: req.uid, role: req.role }, getDs)
      res.json({ ok: true, diff, warnings: v.warnings })
    } catch (e) {
      res.status(400).json({ message: `预览失败：${(e as Error).message}` })
    }
  })

  // 一键灌入：先恢复代理池（按名称复用），再导入环境（引用同名代理），最后导入 RPA。
  // 扩展为名称引用，目标缺同名扩展则自动丢弃引用（与单环境导入行为一致）。
  router.post('/snapshot/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const v = validateSnapshot(req.body)
    if (!v.ok) return res.status(400).json({ message: '快照文件不合法：' + v.errors.join('；'), detail: v })
    // 迁移升级：老版本快照先升到当前结构再消费。v1 是首个发布版本，阶梯当前为空，
    // 但入口与「升不上去就拒绝」的保护必须常驻——否则将来升版时无从补救。
    const mig = migrateSnapshot(req.body)
    if (mig.to !== SNAPSHOT_VERSION) {
      return res.status(400).json({
        message: `快照版本 ${mig.from} 无法迁移到当前版本 ${SNAPSHOT_VERSION}：缺少 v${mig.to} → v${mig.to + 1} 的迁移步骤`
      })
    }
    const data = normalizeSnapshot(mig.data)
    // 差异必须在写库**之前**算：一旦代理池先落地，本轮「将新建」的代理就会
    // 变成「已存在」，算出来的结果全是「复用」，等于什么都没告诉用户。
    const diff = await buildSnapshotDiff(mig, { tid: req.tid!, uid: req.uid, role: req.role }, getDs)
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
    // 迁移告警 + 版本信息 + 预演差异一并回传：用户必须能看见
    // 「哪些条目没完全还原」「哪些代理因连接信息不同被保留未覆盖」
    const warnings = [...v.warnings, ...proxyRes.warnings]
    await writeLog(
      req,
      'import_snapshot',
      `导入快照（团队「${data.team.name || req.tid}」，格式 v${SNAPSHOT_VERSION}）：环境 ${profRes.created} 个、代理 ${proxyRes.imported} 条、RPA ${rpaRes.created} 个`
    )
    res.json({
      ok: true,
      profiles: profRes.created,
      groupsCreated: profRes.groupsCreated,
      proxiesCreated: proxyRes.imported,
      proxiesSkipped: proxyRes.skipped,
      rpaCreated: rpaRes.created,
      extensionsReferenced: data.extensions.length,
      formatVersion: SNAPSHOT_VERSION,
      sourceVersion: mig.from,
      migrations: mig.applied,
      warnings,
      diff
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

    // 批量延长 / 设置 / 清除到期时间。
    // 此前只有单条编辑弹窗能改到期时间——到期环境一多就得一个个点开改，
    // 而「这些号都是同一天买的，一起延期」恰恰是最常见的真实场景。
    if (action === 'extendExpiry') {
      const raw = req.body?.days
      const days = Number(raw)
      // mode: 'add' 是在各自现有到期时间上加 N 天（默认）；'set' 是统一设为某一天；
      //        null / 'clear' 是清除到期时间（转为长期有效）。
      const mode = (req.body?.mode as string) || (raw === null || raw === '' ? 'clear' : 'add')
      if (mode === 'clear') {
        let cleared = 0
        for (const p of profiles) {
          const fp = (p.fingerprint || {}) as Record<string, unknown>
          if (!getEnvExpiresAt(fp)) continue
          p.fingerprint = withEnvExpiresAt(fp, null) as never
          await repo.save(p)
          cleared++
        }
        await writeLog(req, 'batch_clear_expiry', `批量清除 ${cleared} 个环境的到期时间（转为长期有效）`)
        return res.json({ updated: cleared, cleared })
      }
      // 天数只在 mode:'add' 下才需要校验 —— 'set' 走的是 expiresAt，不看 days。
      // 早先把校验放在分支外，导致 set 模式因 days 缺失（NaN）被提前 400 掉、整个模式静默失效。
      if (mode === 'add') {
        if (!Number.isFinite(days)) return res.status(400).json({ message: '天数必须是数字' })
        // 上限 3650 天（10 年）：再长就该用 mode:'set' 直接指定日期，
        // 而且超长天数本身就多半是用户手滑多打了个 0。
        const absDays = Math.abs(Math.round(days))
        if (absDays === 0 || absDays > 3650) {
          return res.status(400).json({ message: '天数需在 1 ~ 3650 之间（或用「设为指定日期」）' })
        }
      }
      let updated = 0
      let skippedNoExpiry = 0
      // 延期后仍在过去的环境数量：已经过期很久的号 +30 天大概率还是过期，
      // 用户以为「续上了」但环境照样打不开 —— 这个数要如实返回给前端提示。
      let stillExpired = 0
      const target = mode === 'set' ? req.body?.expiresAt : null
      // 直接校验 ISO 字符串本身，**不要**套 getEnvExpiresAt——
      // 后者签名是「读指纹对象里的 expiresAt 键」，传字符串进去必然取不到值，
      // 于是每次 set 都返回 400，表现为「这个模式完全不起作用」。
      if (mode === 'set') {
        const t = typeof target === 'string' ? new Date(target).getTime() : NaN
        if (!Number.isFinite(t)) {
          return res.status(400).json({ message: 'expiresAt 不是合法日期' })
        }
      }
      for (const p of profiles) {
        const fp = (p.fingerprint || {}) as Record<string, unknown>
        if (mode === 'set') {
          p.fingerprint = withEnvExpiresAt(fp, target as string) as never
          await repo.save(p)
          updated++
          continue
        }
        const cur = getEnvExpiresAt(fp)
        // 原本就没有到期时间（长期有效）的环境不加天数——
        // 用户勾选时看到的一批「临期」，不该被顺带改成有期限，反过来也是。
        if (!cur) {
          skippedNoExpiry++
          continue
        }
        const base = new Date(cur).getTime()
        const next = base + days * 86400000
        if (next < Date.now()) stillExpired++
        p.fingerprint = withEnvExpiresAt(fp, new Date(next).toISOString()) as never
        await repo.save(p)
        updated++
      }
      await writeLog(
        req,
        'batch_extend_expiry',
        mode === 'set'
          ? `批量设置 ${updated} 个环境的到期时间为 ${String(target).slice(0, 10)}`
          : `批量延长 ${updated} 个环境的到期时间 ${days > 0 ? '+' : ''}${days} 天${skippedNoExpiry ? `，跳过 ${skippedNoExpiry} 个长期有效的` : ''}`
      )
      return res.json({ updated, skippedNoExpiry, stillExpired })
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
