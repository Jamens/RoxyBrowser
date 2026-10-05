import { Router, type Response, type NextFunction, type Request } from 'express'
import type { DataSource } from 'typeorm'
import { OperationLogEntity } from '../entities'
import { exportStamp, logsToCsv, logsToJson } from '../logExport'
// 仅类型导入：编译期完全擦除，不会与 server.ts 形成运行时循环依赖
import type { AuthedRequest } from '../server'

export interface LogRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：AppDataSource 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
}

/** 注册操作日志相关路由（列表 + 导出）。静态路径 /logs/export 必须先于 /logs 注册。 */
export function registerLogRoutes(router: Router, deps: LogRouteDeps): void {
  const { getDs, authMiddleware, writeLog } = deps

  // 操作日志导出：CSV / JSON，便于审计留存。需鉴权，且只导出当前团队。
  // 复用与列表一致的关键词筛选，并额外支持 only-sensitive / action / 时间区间过滤。
  router.get('/logs/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const format = String(req.query.format || 'csv').toLowerCase()
    const repo = getDs().getRepository(OperationLogEntity)
    const qb = repo
      .createQueryBuilder('l')
      .where('l.teamId = :tid', { tid: req.tid })
      .orderBy('l.id', 'DESC')
    if (req.query.keyword) {
      qb.andWhere('(l.username LIKE :kw OR l.action LIKE :kw OR l.detail LIKE :kw)', { kw: `%${req.query.keyword}%` })
    }
    if (req.query.sensitive === '1') {
      qb.andWhere('l.sensitive = :s', { s: true })
    }
    if (req.query.action) {
      qb.andWhere('l.action = :act', { act: String(req.query.action) })
    }
    if (req.query.from) {
      const from = new Date(String(req.query.from))
      if (!isNaN(from.getTime())) qb.andWhere('l.createdAt >= :from', { from })
    }
    if (req.query.to) {
      const to = new Date(String(req.query.to))
      if (!isNaN(to.getTime())) qb.andWhere('l.createdAt <= :to', { to })
    }
    const list = await qb.getMany()
    const ts = exportStamp()
    // 先写审计日志（导出本身属敏感操作），再返回文件；二者互不阻塞。
    await writeLog(req, 'export_logs', `导出操作日志（格式=${format}，共 ${list.length} 条）`)
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="operation-logs-${ts}.json"`)
      res.send(logsToJson(list))
      return
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="operation-logs-${ts}.csv"`)
    res.send(logsToCsv(list))
  })

  router.get('/logs', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(OperationLogEntity)
    const qb = repo
      .createQueryBuilder('l')
      .where('l.teamId = :tid', { tid: req.tid })
      .orderBy('l.id', 'DESC')
      .take(500)
    if (req.query.keyword) qb.andWhere('(l.username LIKE :kw OR l.action LIKE :kw OR l.detail LIKE :kw)', { kw: `%${req.query.keyword}%` })
    const list = await qb.getMany()
    res.json(list)
  })
}
