// 智能助手（Planner）计划的结构化类型 + 多步编排的纯函数。
//
// 为什么放 shared：expandActions / getPath 是纯函数、无运行时依赖，既能被主进程 planner 复用，
// 也能用 tsc 转 CJS 离线单测（项目既有做法，见离线单测说明），无需拉起 Electron / 数据库。
//
// 多步编排的核心就在这个文件：LLM 出的动作可以挂一个 `forEach`，
// 表示「对第几个查询的每一行展开成一组动作」——这样「查出 N 个过期代理 → 逐个删除」
// 之类依赖前一步结果的流程就能被表达，而不必让 LLM 自己枚举 ID（本地小模型枚举极易出错）。

export interface PlanQuery {
  entity?: string
  fields?: string[]
  filters?: Array<{ field?: string; op?: string; value?: unknown }>
  limit?: number
  orderBy?: string
  orderDir?: 'ASC' | 'DESC'
}

export interface PlanForEach {
  /** 引用 queries 数组的下标（0 基） */
  fromQuery: number
  /** 动作参数键 → 从每行取值的字段路径（支持点号嵌套，如 "_usedByEnvs.0.id"） */
  map: Record<string, string>
}

export interface PlanAction {
  kind?: string
  label?: string
  target?: { entity?: string; id?: number }
  params?: Record<string, unknown>
  /** 多步编排：对指定查询的每行展开成一组动作 */
  forEach?: PlanForEach
}

export interface Plan {
  understanding?: string
  intent?: string
  queries?: PlanQuery[]
  actions?: PlanAction[]
  reply?: string
}

/** 展开后的单条动作（尚未经动作白名单解析 danger，由调用方补全） */
export interface ExpandedAction {
  kind: string
  label: string
  target: { entity?: string; id: number }
  params: Record<string, unknown>
  /** 来自 forEach 展开时记录出处，供前端展示「对查询①的 N 行 · 第 k 行」 */
  batch?: { queryIndex: number; total: number; rowIndex: number }
}

/** 一行查询结果的最小形态（只需 rows，纯函数不关心列定义） */
export interface RawQueryLike {
  rows: Array<Record<string, unknown>>
}

/** 按点号路径从对象取值，支持数组下标（"_usedByEnvs.0.id"） */
export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined
  const parts = String(path).split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(p)
      if (!Number.isInteger(idx)) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

function baseTargetId(a: PlanAction): number {
  return Number(
    a.target?.id ?? a.params?.profileId ?? a.params?.proxyId ?? a.params?.memberId ?? a.params?.scriptId ?? 0
  )
}

/**
 * 把计划里的动作列表展开成可执行的单条动作序列。
 * - 不带 forEach 的动作原样保留（保持旧行为，向后兼容）。
 * - 带 forEach 的动作：对 queries[fromQuery].rows 逐行生成一条动作，
 *   用 map 把行字段填进 params，并以 id/以 Id 结尾的键作为 target.id。
 *
 * 纯函数：给定相同输入必然得到相同输出，方便离线单测。
 */
export function expandActions(plan: Plan, queries: RawQueryLike[]): ExpandedAction[] {
  const out: ExpandedAction[] = []
  for (const a of plan.actions || []) {
    if (!a || !a.kind) continue
    const base: ExpandedAction = {
      kind: a.kind,
      label: a.label || a.kind,
      target: { entity: a.target?.entity || a.kind, id: baseTargetId(a) },
      params: { ...(a.params || {}) }
    }
    const fe = a.forEach
    const src = fe ? queries[fe.fromQuery] : undefined
    if (fe && src && Array.isArray(src.rows) && src.rows.length) {
      src.rows.forEach((row, idx) => {
        const params: Record<string, unknown> = { ...base.params }
        let targetId = base.target.id
        for (const [pk, field] of Object.entries(fe.map)) {
          const v = getPath(row, field)
          if (v === undefined || v === null) continue
          params[pk] = v
          if (pk === 'id' || pk.endsWith('Id')) targetId = Number(v) || targetId
        }
        out.push({
          ...base,
          params,
          target: { ...base.target, id: targetId },
          label: `${base.label} #${idx + 1}`,
          batch: { queryIndex: fe.fromQuery, total: src.rows.length, rowIndex: idx }
        })
      })
      // 注：forEach 引用的是「空结果 / 越界查询」时，此处不产生任何动作——
      // 避免带着空参数去执行一条无意义的基动作（如 deleteProxy 带空 proxyId）。
      // 不带 forEach 的动作（下方 else）才原样保留。
    } else if (!fe) {
      out.push(base)
    }
  }
  return out
}

// ===================== 相对时间标记（技能防时间冻结）=====================
// 过滤值里写 "@rel:now+7d"（或 {__rel:"now+7d"}）会在运行时解析成「相对当前时间」的偏移日期，
// 与系统提示词里的 CURRENT_TIME 同格式（YYYY-MM-DD HH:mm:ss），可直接用于 MySQL datetime 比较。
// 这样「7 天内到期」之类的技能模板在很久以后重跑时，仍然跟随当前时间，不会被保存时写死的绝对日期冻结。

/** 与系统提示词一致的 ISO 字符串（到秒），用于 datetime 列比较 */
function isoLike(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function applyRelOffset(now: Date, spec: string): string {
  const m = String(spec).match(/^now(?:([+-]\d+)([dhm]))?$/)
  if (!m) return spec
  const amt = m[1] ? parseInt(m[1], 10) : 0
  const unit = m[2] || 'd'
  const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000
  return isoLike(new Date(now.getTime() + amt * ms))
}

/** 解析过滤值中的相对时间标记；数组逐元素解析，其余值原样返回。导出以便离线单测。 */
export function resolveRelTime(value: unknown, now: Date): unknown {
  if (typeof value === 'string' && value.startsWith('@rel:')) {
    return applyRelOffset(now, value.slice(5))
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && '__rel' in (value as Record<string, unknown>)) {
    return applyRelOffset(now, String((value as Record<string, unknown>).__rel))
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRelTime(v, now))
  }
  return value
}
