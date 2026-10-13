// 到期预警判定（代理 + 环境）—— 纯函数，零依赖，主进程 / 渲染进程共用，可离线单测
//
// 为什么单独成模块：预警逻辑看着简单，但有三个容易做错的地方，
// 抽出来单独测比混在调度器里可靠得多：
//   1. **重复预警**：用户改了到期时间、或扫描间隔很短时，同一条到期项不该反复刷屏。
//      故判定要考虑「上次是否已预警过」。
//   2. **不误报**：`expiresAt` 为空 / 非法值 / 已在过去（早已过期、上一轮已报过）都不该进本期预警。
//   3. **边界**：刚好等于阈值算不算「即将到期」必须固定下来，否则用户会看到「7 天内到期」里混进第 8 天的。

/** 一条到期项的最小结构（代理与环境共用） */
export interface ExpiringItem {
  id: number
  /** 所属团队，用于按团队推 webhook 与写日志 */
  teamId: number
  /** 展示名，出现在预警文案里 */
  name: string
  /** 到期时间（ISO 字符串或 Date）；无效值视为「无到期时间」 */
  expiresAt: Date | string | null | undefined
}

/** 预警级别 */
export type ExpiryLevel = 'expiring' | 'expired'

export interface ExpiryAlert {
  id: number
  teamId: number
  name: string
  expiresAt: string
  /** 距离到期的天数：负数表示已过期几天 */
  daysLeft: number
  level: ExpiryLevel
}

/** 一次判定的输入 */
export interface ExpiryScanInput {
  items: ExpiringItem[]
  /** 阈值（天）：到期天数 ≤ 该值即进本期预警 */
  thresholdDays: number
  /** 本轮判定时刻 */
  now: Date
  /**
   * 已预警过的 key（`${kind}:${id}:${expiresAt}`）→ 上次预警的 ISO 日期。
   * 用 expiresAt 参与 key 是关键：用户改了到期时间后 key 自然变化，会被重新预警一次；
   * 而没改的话 key 不变，第二次扫描就不再刷屏。
   */
  warned?: Map<string, string>
}

const MS_PER_DAY = 86_400_000

/**
 * 把 expiresAt 规整成毫秒时间戳；空 / 非法 / NaN 一律返回 null（视为「无到期时间」）。
 *
 * 不用 `new Date(x).getTime()` 直接判 NaN 就完事，是因为 `new Date('')` 会得到
 * Invalid Date、`new Date(null)` 却得到 epoch 0（1970 年）—— 后者若不显式挡住，
 * 会把所有「无到期时间」的代理算成「过期 20000 天」，进而天天误报。
 */
export function parseExpiry(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * 剩余天数（可为负）。
 *
 * 用 `Math.ceil` 而不是 `Math.round` / `Math.floor`：今天 23:59 到期、明天 00:01 判定时，
 * 真实剩余 2 分钟——`floor` 会算出 0 天（该报），`ceil` 也算出 1 天（该报）；
 * 但反向场景（还剩 23 小时 59 分）`floor` 得 0、`ceil` 得 1，前者会提前一天报警。
 * 阈值语义是「还剩 N 天以内要预警」，`ceil` 更贴近人的直觉。
 */
export function daysUntil(v: Date | string | null | undefined, now: Date): number | null {
  const t = parseExpiry(v)
  if (t === null) return null
  return Math.ceil((t - now.getTime()) / MS_PER_DAY)
}

/**
 * 扫描一组条目，产出本期应预警的列表。
 *
 * 规则：
 * - `expiresAt` 无效 → 跳过（无到期时间 = 长期有效，不该报警）；
 * - 剩余天数 > 阈值 → 跳过（还早着）；
 * - 剩余天数 ≤ 阈值 → 进本期预警，级别按是否已过期分 `expired` / `expiring`；
 * - 已在 `warned` 里且 expiresAt 未变 → 跳过（避免每轮重复刷屏）。
 *
 * 纯函数：同样的输入必然得到同样的输出（`warned` Map 只读不写）。
 */
export function scanExpiring(input: ExpiryScanInput): ExpiryAlert[] {
  const { items, thresholdDays, now, warned } = input
  if (!Array.isArray(items) || items.length === 0) return []
  const out: ExpiryAlert[] = []
  for (const it of items) {
    const t = parseExpiry(it.expiresAt)
    if (t === null) continue
    const daysLeft = Math.ceil((t - now.getTime()) / MS_PER_DAY)
    if (daysLeft > thresholdDays) continue
    const iso = new Date(t).toISOString()
    // 同一到期项在「同一个到期时间」上只报一次；改了到期时间则 key 变化，会重新预警
    const key = `${it.id}:${iso}`
    if (warned && warned.has(key)) continue
    out.push({
      id: it.id,
      teamId: it.teamId,
      name: it.name,
      expiresAt: iso,
      daysLeft,
      level: daysLeft < 0 ? 'expired' : 'expiring'
    })
  }
  // 先过期、再即将到期；同级按剩余天数升序（最紧急的排最前）。
  //
  // **daysLeft 相同时必须用 id兜底**：同日到期的代理/环境**非常常见**
  // （批量买的往往同一天到期），此时 daysLeft 完全并列，原先 `a.daysLeft - b.daysLeft`
  // 返回 0，顺序取决于输入顺序 + sort 稳定性。而这个顺序会直接进用户看到的
  // 告警文案里——顺序随机跳动会让人怀疑「是不是误报了」。
  out.sort((a, b) => {
    if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft
    return a.id - b.id
  })
  return out
}

/** 生成去重键，与 scanExpiring 内部保持一致 */
export function expiryWarnKey(id: number, expiresAtIso: string): string {
  return `${id}:${expiresAtIso}`
}

/**
 * 构造预警文案。区分「已过期」与「即将到期」——
 * 这两者对用户的行动要求完全不同（一个是「现在就不能用了」，一个是「该准备了」），
 * 混成一句话会让用户分不清轻重。
 */
export function expiryAlertText(kind: '代理' | '环境', alerts: ExpiryAlert[]): string {
  if (!alerts.length) return ''
  const expired = alerts.filter((a) => a.level === 'expired')
  const expiring = alerts.filter((a) => a.level === 'expiring')
  const parts: string[] = []
  if (expired.length) {
    parts.push(`已过期 ${expired.length} 个（${expired.map((a) => a.name).join('、')}）`)
  }
  if (expiring.length) {
    // 天数取「本批里最短的剩余天数」而不是条数——条数该用「个」，
    // 写成 `${expiring.length} 天内` 会让「1 个代理」显示成「1 天内将到期 1 个」，
    // 读起来像只剩 1 天，与它实际还剩 3 天 / 5 天完全不符。
    const soonest = Math.min(...expiring.map((a) => a.daysLeft))
    const dayText = soonest <= 0 ? '今天' : `${soonest} 天`
    // 前缀已经写了「N 天内」，每项再重复天数就成了「临期3天（3 天）」这种废话；
    // 但**最短的那条**值得单独标注——用户需要知道具体是谁最紧急。
    const names = expiring.slice(0, 5).map((a) => (a.daysLeft === soonest ? `${a.name}（最紧急）` : a.name))
    const more = expiring.length > 5 ? ` 等 ${expiring.length} 个` : ''
    parts.push(`${dayText}内将到期 ${expiring.length} 个（${names.join('、')}${more}）`)
  }
  return `${kind}到期预警：${parts.join('；')}`
}
