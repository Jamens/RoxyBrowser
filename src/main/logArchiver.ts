import { LessThan, MoreThan, type DataSource } from 'typeorm'
import { OperationLogEntity, OperationLogArchiveEntity } from './entities'
import {
  planArchive,
  shouldArchive,
  makeBatchId,
  emptyResult,
  validateArchive,
  monthKey,
  ARCHIVE_BATCH_SIZE,
  type ArchiveResult
} from '../shared/logArchive'

/**
 * 操作日志归档执行器：把过期的**整月**日志从热区搬到归档区。
 *
 * ## 搬运而非删除
 * 审计日志的价值在「事后可查」。这里只做「热区 → 归档区」的位移，记录本身
 * 一个字段都不丢，用户仍可在归档页按时间范围检索并导出。
 *
 * ## 为什么分批而不是一条 SQL
 * 一次 `DELETE ... WHERE createdAt < ?` 扫十万行会长时间锁表、撑大 undo log，
 * 且中途失败时难以判断搬走了多少。改为：分批读取 → 批量插入归档区 → 分批删除，
 * 每批都在**同一事务**内（插入与对应删除原子生效），失败只影响当批。
 */

export interface ArchiveOptions {
  /** 强制只归档指定月份；不传则按保留期自动计算 */
  months?: string[]
  /** dry-run：只统计不搬移 */
  dryRun?: boolean
  /** 每批行数上限（默认 1000） */
  batchSize?: number
}

export interface ArchiveOutcome extends ArchiveResult {
  dryRun: boolean
  /** 因超过保留期被跳过（仍需保留）的行数 */
  reason: string
}

export async function runLogArchive(ds: DataSource, opts: ArchiveOptions = {}): Promise<ArchiveOutcome> {
  const now = new Date()
  const retentionDays = await resolveRetentionDays(ds)
  // 先算出边界，再查「早于边界且实际有记录」的月份——只归档真正有数据的月份，
  // 否则批次号会显示成 `1976-07~2026-06`，让用户误以为要归档 50 年数据
  const probe = planArchive(now, retentionDays)
  const existingMonths = await listExistingMonthsBefore(ds, probe.before)
  const auto = planArchive(now, retentionDays, existingMonths)
  const months = opts.months?.length ? opts.months : auto.months
  const plan = { months, before: auto.before }
  const batchId = makeBatchId(now, months)
  const result: ArchiveOutcome = { ...emptyResult(batchId, months), dryRun: !!opts.dryRun, reason: '' }

  if (months.length === 0) {
    result.reason = `没有可归档的完整月份（保留期 ${retentionDays} 天，${now.toLocaleDateString()}）`
    return result
  }

  const hot = ds.getRepository(OperationLogEntity)
  const cold = ds.getRepository(OperationLogArchiveEntity)

  const stats = await hot
    .createQueryBuilder('l')
    .select('COUNT(*)', 'total')
    .addSelect('MIN(l.createdAt)', 'oldest')
    .getRawOne<{ total: string; oldest: Date | null }>()

  // 校验通过与否：把 reason 一次性摊平成独立变量，不依赖判别联合的收窄。
  // （收窄在此处不可靠：`pnpm typecheck` 用 tsconfig 的 composite 增量缓存会漏报，
  //   而独立 tsc 编译能报出来——两种编译结果不一致，说明依赖收窄的写法有风险。）
  const gate = validateArchive(plan, { totalRows: Number(stats?.total || 0), oldest: stats?.oldest || null })
  const rejectReason = gate.ok === false ? String((gate as { reason?: string }).reason ?? '校验未通过') : ''
  if (rejectReason) {
    result.reason = rejectReason
    return result
  }

  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : ARCHIVE_BATCH_SIZE
  const before = plan.before

  // 循环搬移：每批取一批 → 事务内「插归档 + 删热区」→ 直到取空
  // 游标 lastId：dry-run 时不删数据，若只按时间条件查会永远取到同一批导致死循环，
  // 故按主键递增推进。真跑模式下游标同样有效，且能避免 OFFSET 分页的性能衰减。
  let lastId = 0
  for (;;) {
    // 只取「早于 before 且属于归档月份」的记录。
    // 月份条件在应用层用 shouldArchive 判定：SQL 里做月份分桶要拼 CONCAT，
    // 既难读又无法索引；而 before + id > lastId 已把绝大多数行过滤掉，剩下的量很小。
    const candidates = await hot.find({
      where: { createdAt: LessThan(before), id: MoreThan(lastId) },
      order: { id: 'ASC' },
      take: batchSize * 4 // 多取一些，让应用层过滤后仍能凑满一批
    })
    if (candidates.length === 0) break
    lastId = candidates[candidates.length - 1].id

    const batch = candidates.filter((r) => shouldArchive(r, plan))
    if (batch.length > 0) {
      // 统计各月条数（即使 dry-run 也要给出，方便用户确认归档范围）
      for (const r of batch) {
        const k = monthKey(r.createdAt)
        result.byMonth[k] = (result.byMonth[k] || 0) + 1
      }
      if (!opts.dryRun) {
        await ds.transaction(async (mgr) => {
          const hotRepo = mgr.getRepository(OperationLogEntity)
          const coldRepo = mgr.getRepository(OperationLogArchiveEntity)
          await coldRepo.insert(
            batch.map((r) => ({
              teamId: r.teamId,
              userId: r.userId,
              username: r.username,
              action: r.action,
              detail: r.detail,
              sensitive: r.sensitive,
              createdAt: r.createdAt,
              batchId,
              month: monthKey(r.createdAt)
            }))
          )
          // 删除用主键 IN，命中主键索引，不触碰 createdAt 索引
          await hotRepo.delete(batch.map((r) => r.id))
        })
      }
      result.moved += batch.length
    }

    // 候选批次已取完（不足 take 说明到头了）
    if (candidates.length < batchSize * 4) break
  }

  if (result.moved > 0 && !opts.dryRun) {
    result.reason = `已归档 ${result.moved} 条（${months[0]} ~ ${months[months.length - 1]}）`
  } else if (result.moved > 0) {
    result.reason = `[试运行] 将归档 ${result.moved} 条（${months[0]} ~ ${months[months.length - 1]}）`
  } else {
    result.reason = '归档月份内没有记录'
  }
  return result
}

/** 热区与归档区的规模概览，供前端展示 */
export async function getArchiveStats(ds: DataSource): Promise<{
  hotCount: number
  archiveCount: number
  oldestHot: string | null
  oldestArchive: string | null
  retentionDays: number
}> {
  const hot = ds.getRepository(OperationLogEntity)
  const cold = ds.getRepository(OperationLogArchiveEntity)
  const hotRow = await hot
    .createQueryBuilder('l')
    .select('COUNT(*)', 'c')
    .addSelect('MIN(l.createdAt)', 'o')
    .getRawOne<{ c: string; o: Date | null }>()
  const coldRow = await cold
    .createQueryBuilder('a')
    .select('COUNT(*)', 'c')
    .addSelect('MIN(a.createdAt)', 'o')
    .getRawOne<{ c: string; o: Date | null }>()
  return {
    hotCount: Number(hotRow?.c || 0),
    archiveCount: Number(coldRow?.c || 0),
    oldestHot: hotRow?.o ? new Date(hotRow.o).toISOString() : null,
    oldestArchive: coldRow?.o ? new Date(coldRow.o).toISOString() : null,
    retentionDays: await resolveRetentionDays(ds)
  }
}

/**
 * 按批次把归档记录退回热区（撤销误归档）。
 *
 * 为什么需要：归档是**不可逆**操作，用户可能把保留期设成 1 天后立刻后悔。
 * 没有撤销就等于「一个设置项能毁掉全部审计证据」——这是不可接受的风险。
 */
export async function revertLogArchive(ds: DataSource, batchId: string, teamId: number): Promise<number> {
  const cold = ds.getRepository(OperationLogArchiveEntity)
  const rows = await cold.find({ where: { batchId, teamId } })
  if (rows.length === 0) return 0
  await ds.transaction(async (mgr) => {
    await mgr.getRepository(OperationLogEntity).insert(
      rows.map((r) => ({
        teamId: r.teamId,
        userId: r.userId,
        username: r.username,
        action: r.action,
        detail: r.detail,
        sensitive: r.sensitive,
        createdAt: r.createdAt
      }))
    )
    await mgr.getRepository(OperationLogArchiveEntity).delete({ batchId, teamId })
  })
  return rows.length
}

/**
 * 查出热区中「早于 before 且实际有记录」的自然月列表。
 *
 * 用 SQL 的 DATE_FORMAT 在数据库侧分桶：一次查询拿到全部月份，
 * 避免把整张表拉到 Node 再逐条归月（百万行时不可接受）。
 * 走 createdAt 索引的等值/范围前缀，无需全表扫描。
 */
async function listExistingMonthsBefore(ds: DataSource, before: Date): Promise<string[]> {
  const rows = await ds
    .getRepository(OperationLogEntity)
    .createQueryBuilder('l')
    .select('DATE_FORMAT(l.createdAt, \'%Y-%m\')', 'm')
    .where('l.createdAt < :before', { before })
    .groupBy('m')
    .orderBy('m', 'ASC')
    .getRawMany<{ m: string }>()
  return rows.map((r) => r.m).filter((m): m is string => typeof m === 'string')
}

/** 读取保留期；读不到时回落 90 天（与 DEFAULT_SETTINGS 一致） */async function resolveRetentionDays(ds: DataSource): Promise<number> {
  try {
    const { DEFAULT_SETTINGS } = await import('../shared/types')
    const { AppSettingsEntity } = await import('./entities')
    const row = await ds.getRepository(AppSettingsEntity).findOne({ where: { key: 'global' } })
    const raw = (row?.settings as Record<string, unknown> | undefined)?.logRetentionDays
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_SETTINGS.logRetentionDays
  } catch {
    return 90
  }
}

