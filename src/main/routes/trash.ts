import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { ProfileEntity, AccountEntity, CookieEntity } from '../entities'
import { ownerScope, ownerAndWhere } from '../authScope'
import type { AuthedRequest } from '../authScope'
import { planBatch, canPurge, canRestore } from '../../shared/trashBatch'
import { clearProfilePartition } from '../browserManager'

export interface TrashRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
}

/**
 * 回收站域：软删除环境的列表 / 恢复 / 彻底删除（含批量）。
 *
 * ## 为什么单独成文件
 * 这段代码的每一个决定都服务于「别让用户丢东西」：
 * 级联清理、分区清理、逐条独立判定、拒绝原因如实回报。
 * 和普通 CRUD 混在一起，日后一次「顺手简化」就能把这些护栏删掉，
 * 而它们在 typecheck 和测试里都不会报错——只会安静地少删或多删。
 *
 * ## 注册顺序是硬约束
 * `GET /profiles/trash` 必须排在 `GET /profiles/:id` **之前**。
 * 两者都是 2 段路径，`/profiles/trash` 会被 `/profiles/:id` 抢先匹配
 * （`:id` 匹配任意一段），结果是回收站页面报「环境不存在」。
 * 同理还有 `GET /profiles/export`。server.ts 里 trash 域的注册点
 * 刻意留在 profiles CRUD 之前，不要为了「按字母排」把它挪到后面。
 *
 * ## 彻底删除必须清浏览器数据分区
 * 数据库里的 Cookie 记录删了，但 Chromium 自己写的 localStorage /
 * IndexedDB / Service Worker 缓存还在 `userData/Partitions/env-<id>/`。
 * id 被复用时新环境会继承旧环境的登录态——指纹浏览器最不能容忍的串号。
 * 清理失败**不阻断**删除（记录已经没了，此时把用户卡在报错里毫无意义），
 * 但必须把失败如实写进日志与响应，绝不静默吞掉。
 */
export function registerTrashRoutes(router: Router, deps: TrashRouteDeps): void {
  const { getDs, authMiddleware, writeLog } = deps

  const isoOf = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

  // ===== 回收站批量操作 =====
  // 为什么需要批量接口而不是前端循环调单条：
  // ① 循环 50 次单条接口 = 50 次鉴权 + 50 次日志写入，慢且容易撞限流；
  // ② 单条接口中途失败时前端无法区分「已删」与「未删」，重试会造成重复操作；
  // ③ 批量审计日志需要聚合成一条，否则 50 个环境删除会刷出 50 行日志。
  //
  // **逐条独立判定**（见 shared/trashBatch.ts）：一条失败不影响其他，
  // 但拒绝原因必须如实回报——否则用户以为全删了，实际有几个还在。
  const readTrashBatch = async (req: AuthedRequest): Promise<ProfileEntity[]> => {
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      : []
    // 上限保护：一次删太多会长时间持锁，且用户多半是误操作
    if (!ids.length) throw new Error('请选择至少一个环境')
    if (ids.length > 200) throw new Error('一次最多操作 200 个环境')
    const repo = getDs().getRepository(ProfileEntity)
    // ownerScope 必带：批量是批量越权的高发路径，绝不能只信前端传来的 id
    return repo.find({ where: { id: In(ids), ...ownerScope(req) } })
  }

  router.get('/profiles/trash', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const qb = repo
      .createQueryBuilder('p')
      .where('p.teamId = :tid', { tid: req.tid })
      .andWhere('p.isTemplate = 0')
      .andWhere('p.deletedAt IS NOT NULL')
      .orderBy('p.deletedAt', 'DESC')
    ownerAndWhere(qb, req)
    const list = await qb.getMany()
    res.json(
      list.map((p) => ({
        id: p.id,
        name: p.name,
        seq: p.seq,
        platform: p.platform,
        proxyId: p.proxyId,
        deletedAt: p.deletedAt,
        // 必须带上 status：批量彻底删除要拦「窗口正在运行」的环境。
        // 回收站里的环境理论上都是 idle，但软删除后仍可能被 RPA / 自动化
        // 重新拉起，此时不带上就会漏判，把运行中的环境删掉。
        status: p.status
      }))
    )
  })

  router.post('/profiles/:id/restore', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (!p.deletedAt) return res.status(400).json({ message: '该环境不在回收站中' })
    p.deletedAt = null
    await repo.save(p)
    await writeLog(req, 'restore_profile', `从回收站恢复环境「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  router.delete('/profiles/:id/purge', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (!p.deletedAt) return res.status(400).json({ message: '仅回收站中的环境可彻底删除' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口' })
    // 彻底删除：级联清理关联账号与 Cookie，并把绑定该代理的其他环境解绑（沿用旧删除语义）
    await repo.remove(p)
    const accRepo = getDs().getRepository(AccountEntity)
    await accRepo.delete({ profileId: p.id })
    const cookieRepo = getDs().getRepository(CookieEntity)
    await cookieRepo.delete({ profileId: p.id })
    // 清理该环境的持久化分区（Cookie/localStorage/缓存）。
    // 必须做：数据库里的 Cookie 记录删了，但 Chromium 自己写的 localStorage、
    // IndexedDB、Service Worker 缓存还在分区目录里。id 被复用时新环境会继承旧环境的
    // 登录态 —— 指纹浏览器最不能容忍的串号。清理失败不阻断删除（记录已没了，
    // 此时把用户卡在报错里毫无意义），只把结果如实回报。
    const partitionCleared = await clearProfilePartition(p.id, 'purge', true)
    await writeLog(
      req,
      'purge_profile',
      `彻底删除环境「${p.name}」(#${p.id})（含账号与 Cookie）` +
        (partitionCleared ? '，已清理浏览器数据分区' : '，浏览器数据分区清理失败')
    )
    res.json({ ok: true, partitionCleared })
  })

  /**
   * 手动清理某环境的浏览器数据分区（Cookie / localStorage / 缓存）。
   *
   * ## 为什么需要「不删环境也能清」
   * 自动清理只在彻底删除时发生，但真实场景里磁盘压力往往来自**还在用**的环境：
   * 跑了一周的账号环境缓存能到几百 MB，用户不会为了清缓存去删环境。
   * 给一个显式入口，让用户在不丢环境的前提下回收空间。
   *
   * 注意这是**破坏性**操作：清完该环境的站点登录态会没（数据库里持久化的
   * Cookie 会保留？——不会，Chromium 层清掉后 seedCookies 下次开窗会重新注入，
   * 所以导入型 Cookie 仍在；仅本地存储/缓存/未持久化的会话丢失）。
   */
  router.post('/profiles/:id/clear-partition', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id)
    const repo = getDs().getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口，再清理浏览器数据' })
    const ok = await clearProfilePartition(id, 'manual', !!p.deletedAt)
    await writeLog(
      req,
      'clear_partition',
      `手动清理环境「${p.name}」(#${p.id}) 的浏览器数据分区${ok ? '' : '（清理失败）'}`
    )
    res.json({ ok, message: ok ? '浏览器数据已清理' : '浏览器数据清理失败，请查看日志' })
  })

  router.post('/profiles/batch-restore', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profiles = await readTrashBatch(req)
    const plan = planBatch(
      profiles.map((p) => ({ id: p.id, name: p.name, deletedAt: isoOf(p.deletedAt), status: p.status })),
      canRestore
    )
    const repo = getDs().getRepository(ProfileEntity)
    let done = 0
    for (const id of plan.okIds) {
      try {
        await repo.update({ id }, { deletedAt: null })
        done++
      } catch (e) {
        console.error(`[roxy] 批量恢复失败 #${id}:`, (e as Error).message)
      }
    }
    if (done > 0) {
      await writeLog(req, 'restore_profile', `批量恢复 ${done} 个环境（回收站）${plan.rejected.length ? `，${plan.rejected.length} 个未成功` : ''}`)
    }
    res.json({ ok: true, restored: done, rejected: plan.rejected })
  })

  router.post('/profiles/batch-purge', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profiles = await readTrashBatch(req)
    const plan = planBatch(
      profiles.map((p) => ({ id: p.id, name: p.name, deletedAt: isoOf(p.deletedAt), status: p.status })),
      canPurge
    )
    const repo = getDs().getRepository(ProfileEntity)
    const accRepo = getDs().getRepository(AccountEntity)
    const cookieRepo = getDs().getRepository(CookieEntity)
    let done = 0
    let partitionCleared = 0
    for (const id of plan.okIds) {
      const p = profiles.find((x) => x.id === id)
      if (!p) continue
      try {
        // 与单条 purge 保持完全一致的级联语义：账号、Cookie 一并清理
        await repo.remove(p)
        await accRepo.delete({ profileId: id })
        await cookieRepo.delete({ profileId: id })
        // 分区清理与单条同路径；失败只计数，不影响 done（数据库已删，卡住用户没意义）
        if (await clearProfilePartition(id, 'purge', true)) partitionCleared++
        done++
      } catch (e) {
        console.error(`[roxy] 批量彻底删除失败 #${id}:`, (e as Error).message)
      }
    }
    if (done > 0) {
      await writeLog(
        req,
        'purge_profile',
        `批量彻底删除 ${done} 个环境（含账号与 Cookie，已清理 ${partitionCleared} 个浏览器数据分区）` +
          `${plan.rejected.length ? `，${plan.rejected.length} 个未成功` : ''}`
      )
    }
    res.json({ ok: true, purged: done, partitionCleared, rejected: plan.rejected })
  })
}