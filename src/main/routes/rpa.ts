import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { ProfileEntity, RpaScriptEntity } from '../entities'
import { ownerScope } from '../authScope'
import type { AuthedRequest } from '../authScope'
import { MARKET_SCRIPTS } from '../rpaMarket'
import { substituteSteps } from '../../shared/rpa'
import { normalizeScheduleInterval, normalizeVariables } from '../../shared/rpa'
import {
  getRunningWindowIds,
  replayRpaScript,
  startRpaRecording,
  stopRpaRecording,
  isRpaRecording,
  rpaRecordCount
} from '../browserManager'
import type { RpaStep } from '../../shared/types'

export interface RpaRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
}

/**
 * RPA 脚本路由：CRUD / 导入导出 / 内置市场 / 录制 / 回放。
 *
 * ## 路由顺序是硬约束，不是风格问题
 * Express 按注册顺序匹配，先注册者胜。以下三段必须排在 `/rpa/:id` 之前，
 * 否则 `/rpa/market` 会被当成 id="market" 直接查库 404：
 *   1. `/rpa/export/:id`（两段式）
 *   2. `/rpa/market`、`/rpa/market/install/:id`
 *   3. `/rpa/record/start|stop|status`
 * 拆分文件后顺序被打散过一次，所以这里整段保持原序，不再按方法分组重排。
 *
 * ## 定时配置的连带规则
 * `scheduleEnabled` 永远与 `scheduleProfileId` 联动：绑了环境才可能开定时。
 * 否则调度器每30s 扫到一个「已开启但没目标」的脚本，只能静默跳过——
 * 用户以为在跑，其实什么都没发生。
 *
 * ## 录制/回放的归属校验
 * 所有涉及 profileId 的入口都过 `ownerScope`：普通用户不能录制或往别人的环境里回放脚本。
 */

export function registerRpaRoutes(router: Router, deps: RpaRouteDeps): void {
  const { getDs, authMiddleware, writeLog } = deps

  const rpaRepo = () => getDs().getRepository(RpaScriptEntity)

  // 导出单个脚本为 JSON 文件（按 :id 路由在下方，但 export 是两段式，必须放在 /rpa/:id 之前）
  router.get('/rpa/export/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const s = await rpaRepo().findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    const data = {
      id: s.id,
      name: s.name,
      remark: s.remark,
      steps: s.steps,
      variables: s.variables || {}
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="rpa-${s.id}-${encodeURIComponent(s.name)}.json"`)
    res.send(JSON.stringify(data, null, 2))
  })

  // 导入脚本（接受单个对象、{items:[...]} 或数组）。新建到当前团队，定时配置重置。
  router.post('/rpa/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const payload = req.body || {}
    const arr = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { items?: unknown }).items)
        ? (payload as { items: unknown[] }).items
        : [payload]
    if (!Array.isArray(arr) || !arr.length) return res.status(400).json({ message: '没有可导入的数据' })
    const created: number[] = []
    for (const item of arr as Array<Record<string, unknown>>) {
      if (!item || !item.name || !Array.isArray(item.steps)) continue
      const saved = await rpaRepo().save(
        rpaRepo().create({
          teamId: req.tid!,
          ownerId: req.uid!,
          name: String(item.name).slice(0, 128),
          remark: String(item.remark || '').slice(0, 512),
          steps: item.steps,
          variables: normalizeVariables(item.variables),
          scheduleEnabled: false,
          scheduleIntervalMin: 30,
          scheduleProfileId: null
        })
      )
      created.push(saved.id)
    }
    if (!created.length) return res.status(400).json({ message: '没有有效的脚本可导入（需含 name 与 steps）' })
    await writeLog(req, 'import_rpa_script', `导入 RPA 脚本 ${created.length} 个`)
    res.json({ ok: true, created })
  })

  // ===== RPA 市场（内置预设脚本目录）=====
  // 注意：/rpa/market 与 /rpa/market/install/:id 是静态前缀，必须排在 /rpa/:id 之前（既有约定）。
  router.get('/rpa/market', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    res.json(
      MARKET_SCRIPTS.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category,
        tags: m.tags,
        stepCount: m.steps.length,
        variables: m.variables,
        note: m.note || '',
        steps: m.steps
      }))
    )
  })

  // 从市场安装一个预设脚本到当前团队（克隆为一个新脚本，定时配置重置；用户可随后编辑/回放）
  router.post('/rpa/market/install/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const m = MARKET_SCRIPTS.find((x) => x.id === req.params.id)
    if (!m) return res.status(404).json({ message: '市场脚本不存在' })
    const saved = await rpaRepo().save(
      rpaRepo().create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: m.name,
        remark: `[市场] ${m.description}`.slice(0, 512),
        steps: m.steps,
        variables: normalizeVariables(m.variables),
        scheduleEnabled: false,
        scheduleIntervalMin: 30,
        scheduleProfileId: null
      })
    )
    await writeLog(req, 'install_rpa_market', `从市场安装脚本「${m.name}」(#${saved.id})`)
    res.json({ ok: true, id: saved.id })
  })

  router.get('/rpa', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const list = await rpaRepo().find({ where: ownerScope(req), order: { id: 'DESC' } })
    res.json(
      list.map((s) => ({
        id: s.id,
        name: s.name,
        remark: s.remark,
        steps: s.steps as unknown as RpaStep[],
        variables: s.variables || {},
        scheduleEnabled: s.scheduleEnabled,
        scheduleIntervalMin: s.scheduleIntervalMin,
        scheduleProfileId: s.scheduleProfileId,
        lastScheduledRunAt: s.lastScheduledRunAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }))
    )
  })

  router.post('/rpa', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const b = req.body || {}
    if (!b.name || !Array.isArray(b.steps)) return res.status(400).json({ message: '名称和步骤不能为空' })
    const saved = await rpaRepo().save(
      rpaRepo().create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: String(b.name).slice(0, 128),
        remark: String(b.remark || '').slice(0, 512),
        steps: b.steps,
        variables: normalizeVariables(b.variables),
        scheduleEnabled: !!b.scheduleEnabled && !!b.scheduleProfileId,
        scheduleIntervalMin: normalizeScheduleInterval(b.scheduleIntervalMin),
        scheduleProfileId: b.scheduleProfileId || null
      })
    )
    await writeLog(req, 'create_rpa_script', `创建 RPA 脚本「${saved.name}」(#${saved.id})，${b.steps.length} 步`)
    res.json({ id: saved.id })
  })

  router.put('/rpa/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = rpaRepo()
    const s = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    const b = req.body || {}
    if (b.name !== undefined) s.name = String(b.name).slice(0, 128)
    if (b.remark !== undefined) s.remark = String(b.remark).slice(0, 512)
    if (Array.isArray(b.steps)) s.steps = b.steps
    if (b.variables !== undefined) s.variables = normalizeVariables(b.variables)
    if (b.scheduleIntervalMin !== undefined) s.scheduleIntervalMin = normalizeScheduleInterval(b.scheduleIntervalMin)
    if (b.scheduleProfileId !== undefined) s.scheduleProfileId = b.scheduleProfileId || null
    if (b.scheduleEnabled !== undefined) s.scheduleEnabled = !!b.scheduleEnabled && !!s.scheduleProfileId
    // 开启定时必须已绑定目标环境（save 前校验，避免落库一个永远不会执行的配置）
    if (s.scheduleEnabled && !s.scheduleProfileId) {
      return res.status(400).json({ message: '开启定时执行前请先选择目标环境' })
    }
    await repo.save(s)
    await writeLog(req, 'update_rpa_script', `更新 RPA 脚本「${s.name}」(#${s.id})`)
    res.json({ ok: true })
  })

  router.delete('/rpa/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = rpaRepo()
    const s = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    // remove 后实体主键会被清空，先取出来写日志
    const { id, name } = s
    await repo.remove(s)
    await writeLog(req, 'delete_rpa_script', `删除 RPA 脚本「${name}」(#${id})`)
    res.json({ ok: true })
  })

  // 开始录制（环境需处于运行态）
  router.post('/rpa/record/start', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    // 归属校验（普通用户只能录制自己的环境）
    const profile = await getDs().getRepository(ProfileEntity).findOne({
      where: { id: profileId, ...ownerScope(req) }
    })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    try {
      ;startRpaRecording(profileId)
    } catch (e) {
      return res.status(400).json({ message: (e as Error).message })
    }
    await writeLog(req, 'rpa_record_start', `开始录制 RPA 脚本（环境「${profile.name}」#${profileId}）`)
    res.json({ ok: true })
  })

  // 停止录制：返回采集到的步骤，由前端命名后调POST /rpa 保存
  router.post('/rpa/record/stop', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const steps = stopRpaRecording(profileId)
    res.json({ steps })
  })

  // 录制状态（轮询用）
  router.get('/rpa/record/status', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.query || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const recording = isRpaRecording(profileId)
    const count = rpaRecordCount(profileId)
    res.json({ recording, count })
  })

  // 回放：在指定环境窗口执行脚本（后台异步执行，结果写操作日志）
  router.post('/rpa/:id/run', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const s = await rpaRepo().findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    const profile = await getDs().getRepository(ProfileEntity).findOne({
      where: { id: profileId, ...ownerScope(req) }
    })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    // 变量替换：回放时可传入覆盖变量；否则用脚本自带变量
    const reqVars = (req.body || {}).variables
    const vars = reqVars && typeof reqVars === 'object' && Object.keys(reqVars).length
      ? normalizeVariables(reqVars) || {}
      : s.variables || {}
    const steps = substituteSteps(s.steps as unknown as RpaStep[], vars)
    // 前置校验环境必须处于运行态（否则后台任务会静默失败，用户无从得知）
    const runningIds = getRunningWindowIds()
    if (!runningIds.includes(profileId)) {
      return res.status(400).json({ message: '环境未运行，请先打开环境再回放' })
    }
    // 回放可能持续数分钟，不阻塞请求；完成 / 中止写操作日志
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await replayRpaScript(profileId, steps)
      } catch (e) {
        err = (e as Error).message
      }
      await writeLog(
        req,
        'rpa_run',
        err
          ? `回放脚本「${s.name}」失败：${err}`
          : `回放脚本「${s.name}」完成（环境「${profile.name}」#${profileId}，执行 ${executed}/${steps.length} 步）`
      )
    })()
    res.json({ started: true, steps: steps.length })
  })
}