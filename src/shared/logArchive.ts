/**
 * 操作日志归档的**纯判定逻辑**（主进程 / 渲染进程共用，零 Node 依赖）。
 *
 * ## 为什么归档而不是直接删
 * 审计日志的全部价值在于「事后可查」。`operation_logs` 只增不删，半年后就是个
 * 垃圾堆：单表百万行、列表接口变慢、备份体积膨胀。但直接删又会毁掉证据——
 * 出了安全事故回头查「三个月前谁导出了 Cookie」，发现已被清理，是不可接受的。
 *
 * 所以采用**两段式保留**：
 * - **热区**（`operation_logs`）：保留最近 N 天，承载日常查询与导出；
 * - **归档区**（`operation_log_archives`）：更早的数据按**自然月**打包留存，
 *   体积小（可用 zip / gzip 压缩字段）、不进列表接口、只在「审计归档」页按需查询。
 *
 * 按自然月而非按固定天数切分，是为了让归档单元语义清晰——「2026 年 7 月的
 * 全部日志」是一个可交付的审计时间段，而「第 87 天到第 102 天」不是。
 */

/** 归档记录：与热区字段一致，外加归档元信息 */
export interface ArchivedLog {
  teamId: number
  userId: number
  username: string
  action: string
  detail: string
  sensitive: boolean
  createdAt: Date
  /** 归档批次号：同一次归档的所有记录共享，便于回溯与撤销 */
  batchId: string
}

export interface ArchivePlan {
  /** 应当归档的月份键，如 '2026-07' */
  months: string[]
  /** 起始时间（含）：早于此时间且所属月份未被排除的记录都应归档 */
  before: Date
}

/** 把 Date 归到自然月键：'2026-07'。注意必须用本地时区—— */
export function monthKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** 月键转该月的起始时间（本地时区，月初 00:00:00.000） */
export function monthStart(key: string): Date {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1, 0, 0, 0, 0)
}

/** 该月结束时刻的下一个月月初（闭区间上界，用作 lt 查询） */
export function nextMonthStart(key: string): Date {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m, 1, 0, 0, 0, 0)
}

/**
 * 计算「哪些整月应当归档」。
 *
 * ## 关键约束一：只归档**完整**月份
 * 假如今天是 7 月 15 日，保留期 30 天，那么 6 月 15 日之前的日志已过期——
 * 但 6 月 1 日到 6 月 14 日**还没过期**。若按时间点切割，归档出去的就包含了
 * 仍在保留期内的记录，等于提前销毁证据。
 *
 * 所以这里改为：找出**已经完整过去**的月份中，最早的边界月。也就是说，
 * 只有「整月都在保留期外」的月份才归档。
 *
 * ## 关键约束二：只列**实际有记录**的月份
 * 朴素的实现是从边界月一路回推到 1970 年，得到 600 个「可归档月份」。
 * 但绝大多数月份在表里**一条记录都没有**——若把它们写进批次号，
 * 会显示成 `1976-07~2026-06`，让用户以为要归档 50 年数据，纯属误导。
 *
 * 因此 `existingMonths` 由调用方从数据库查出（有记录且早于边界的月份）传入，
 * 本函数只做交集与过滤。查不到时退化为「只返回边界月」——保守做法，
 * 宁可少归档也不虚报范围。
 *
 * @param now 当前时间
 * @param retentionDays 热区保留天数；<= 0 表示不归档
 * @param existingMonths 数据库中实际存在的月份列表（可选，用于收敛报告范围）
 */
export function planArchive(now: Date, retentionDays: number, existingMonths?: string[]): ArchivePlan {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { months: [], before: now }
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000)
  // 保留期起始点所在的月份（含）不归档——该月可能还有未过期记录
  const boundary = monthKey(cutoff)
  const boundaryStart = monthStart(boundary)

  if (existingMonths && existingMonths.length > 0) {
    // 只保留「有记录」且「早于边界月」的月份，升序
    const set = new Set(existingMonths)
    const months = [...set].filter((k) => k < boundary).sort()
    return { months, before: boundaryStart }
  }

  // 未提供现有月份时只返回边界月之前的那个月（保守：宁少勿多，且不虚报范围）
  const cursor = new Date(boundaryStart.getFullYear(), boundaryStart.getMonth() - 1, 1)
  const months: string[] = []
  if (cursor.getTime() <= now.getTime()) months.push(monthKey(cursor))
  return { months, before: boundaryStart }
}

/**
 * 判断某条记录是否应被归档。
 *
 * 与 planArchive 配套使用：`before` 之前**且**其所属月份在归档列表中才归档。
 * 这里再判一次月份是为了防御——若调用方误传了过小的 `before`，也不会把保留期内
 * 的记录卷进归档。
 */
export function shouldArchive(row: { createdAt: Date }, plan: ArchivePlan): boolean {
  if (plan.months.length === 0) return false
  if (row.createdAt.getTime() >= plan.before.getTime()) return false
  return plan.months.includes(monthKey(row.createdAt))
}

/**
 * 生成批次号：归档是不可逆操作，出问题时需要能定位「是哪一批」。
 * 不含随机数依赖，便于单测断言格式。
 *
 * 月份范围显示为「最早~最晚」而非依赖入参顺序——调用方传入的月份顺序不保证，
 * 若直接取首尾会随机显示成 `2026-05~2026-03`，让排查时误判。
 */
export function makeBatchId(now: Date, months: string[]): string {
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  const scope = months.length
    ? (() => {
        const sorted = [...months].sort()
        return `${sorted[0]}~${sorted[sorted.length - 1]}`
      })()
    : 'none'
  return `arch-${y}${mo}${d}-${h}${mi}${s}-${scope}`
}

/** 归档结果统计（用于写日志与展示） */
export interface ArchiveResult {
  batchId: string
  months: string[]
  moved: number
  /** 各月条数，便于验证归档是否符合预期 */
  byMonth: Record<string, number>
  skipped: number
}

export function emptyResult(batchId: string, months: string[]): ArchiveResult {
  return { batchId, months, moved: 0, byMonth: {}, skipped: 0 }
}

/**
 * 归档前置校验：把「不该归档的情况」挡在删数据之前。
 *
 * 这是不可逆操作的最后一道理闸——宁可一次都不归档，也不能误删审计证据。
 */
export type ArchiveGate = { ok: true } | { ok: false; reason: string }

export function validateArchive(plan: ArchivePlan, stats: { totalRows: number; oldest: Date | null }): ArchiveGate {
  const reject = (reason: string): ArchiveGate => ({ ok: false, reason })
  if (plan.months.length === 0) return reject('没有可归档的完整月份')
  if (stats.totalRows <= 0) return reject('日志表为空')
  // 最老的一条若都在保留期内，说明计算有误 —— 拒绝执行
  if (stats.oldest && stats.oldest.getTime() >= plan.before.getTime()) {
    return reject('最老的日志仍在保留期内，计算可能有误，已拒绝归档')
  }
  // 单批归档量上限：一次搬走过多行会长时间锁表，且失败时难以恢复
  if (stats.totalRows > 500_000) return reject('待归档行数超过 50 万上限，请分批处理')
  return { ok: true }
}

/**
 * 安全删除的批量大小。
 *
 * 一次 DELETE 十万行会锁表数秒并撑大 undo log；分批 + 短暂让出事件循环，
 * 让 MySQL 有机会处理其它查询。
 */
export const ARCHIVE_BATCH_SIZE = 1000
