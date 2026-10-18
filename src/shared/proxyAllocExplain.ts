/**
 * 智能代理分配的「决策解释」—— 纯函数，零依赖，可离线单测。
 *
 * ## 为什么需要
 * 分配器（proxyAllocator.allocateProxies）是一个**黑盒**：用户点一次「智能分配」，
 * 看到的是「分配了 12 个，跳过 3 个」。但他真正想知道的是：
 *   - **为什么这个环境分到了这个代理？**（是它本来就独占，还是从别人手里挪来的）
 *   - **为什么有的环境被跳过？**（是没代理了，还是池里那些都被人占着）
 *   - **池里到底有什么？** 200 个代理，凭什么只够分 12 个
 *   - **我设的国家/类型筛选生效了吗？**
 *
 * 这些问题此前**只能靠猜**。分配失败时用户既不知道该补代理还是该改筛选条件，
 * 也不知道自己的环境有没有和别人共用出口 IP——而后者正是这个功能要防的事。
 *
 * ## 与分配器严格同源
 * 排除原因按 allocateProxies 里 `isUsable` / `matchFilter` / `outsiderUsage`
 * **逐条复刻**。若这里自己另写一套判定，解释就会与实际行为不符——
 * 而用户正是靠这份解释来决定「要不要补代理」或「要不要改筛选」。
 * 那比没有解释更糟：它会让人往错误的方向补货。
 */

import type { AllocEnv, AllocProxy, AllocResult } from './proxyAllocator'

/** 单个代理为何（不）进入可用池 */
export type PoolRejectReason =
  | 'invalid'          // 已失效
  | 'expired'          // 已过期
  | 'countryFilter'    // 不符合国家筛选
  | 'typeFilter'       // 不符合类型筛选
  | 'occupied'         // 被「未选中」环境占用（外人持有，不可重分配）

export interface PoolItemExplain {
  id: number
  name: string
  /** 是否进入可用池 */
  usable: boolean
  /** 不可用时的原因（可同时多个，如「已过期 + 国家不符」） */
  reasons: PoolRejectReason[]
  /** 人类可读的排除说明 */
  detail: string
  /** 被谁占用（occupied 时）：未选中环境的数量 */
  heldByCount?: number
  /** 是否被本批选中环境占用（本批内部共享，可重新平衡） */
  heldBySelected?: number
}

/** 单个环境的分配决策 */
export interface AllocDecisionExplain {
  id: number
  name: string
  action: 'assigned' | 'kept' | 'skipped'
  /** 原代理名（无则空） */
  fromProxy: string
  /** 新代理名（kept 时等于 fromProxy） */
  toProxy: string
  /** 人类可读的决策说明 */
  why: string
  /**
   * 原代理是否与本批其他环境共用（即本次会把它拆开）。
   * 注意语义：**不是**「这个环境脱离了共享」——那要等整批分配完才算得出。
   */
  brokeShared?: boolean
}

export interface AllocExplain {
  pool: {
    total: number
    usable: number
    /** 按原因计数的排除分布（如 { expired: 3, occupied: 5 }） */
    rejected: Record<string, number>
    items: PoolItemExplain[]
  }
  decisions: AllocDecisionExplain[]
  /** 整体结论（池是否够用、筛选是否过严等） */
  notes: string[]
}

/** 与 allocateProxies.isUsable 同源 */
function checkUsable(p: AllocProxy, now: number): PoolRejectReason | null {
  if (p.status === 'invalid') return 'invalid'
  if (p.expiresAt && new Date(p.expiresAt).getTime() <= now) return 'expired'
  return null
}

/** 与 allocateProxies.matchFilter 同源 */
function checkFilter(p: AllocProxy, country: string, type: string): PoolRejectReason | null {
  if (country && !(p.country || '').toLowerCase().includes(country.toLowerCase())) return 'countryFilter'
  if (type && p.type !== type) return 'typeFilter'
  return null
}

const REASON_TEXT: Record<PoolRejectReason, string> = {
  invalid: '已失效',
  expired: '已过期',
  countryFilter: '国家不符筛选',
  typeFilter: '类型不符筛选',
  occupied: '被其他环境占用'
}

/**
 * 解释一次分配决策。
 *
 * @param envs    参与分配的环境（须与传给 allocateProxies 的完全一致）
 * @param proxies 全部代理（须与传给 allocateProxies 的完全一致）
 * @param usage   每个代理被多少环境占用（全局）
 * @param results **allocateProxies 的实际返回结果**
 * @param opts    筛选条件
 *
 * ## 为什么 results 是入参而不是在这里重跑分配
 * 若本函数自己再跑一遍 allocateProxies，两处逻辑将来一改一不改，
 * 解释就会与实际行为悄悄分叉——而用户正是靠这份解释判断「该不该补代理」。
 * 那比没有解释危险得多。所以必须由调用方把**真实结果**传进来。
 */
export function explainAllocation(
  envs: AllocEnv[],
  proxies: AllocProxy[],
  usage: Map<number, number>,
  results: AllocResult,
  opts: { country?: string; type?: string } = {}
): AllocExplain {
  const country = opts.country?.trim() || ''
  const type = opts.type?.trim() || ''
  const now = Date.now()
  const nameOf = new Map(proxies.map((p) => [p.id, p.name || `#${p.id}`]))
  const envById = new Map(envs.map((e) => [e.id, e]))

  // 与 allocateProxies 同口径：被「未选中」环境占用 = 全局占用 - 本批选中占用
  const selCount = new Map<number, number>()
  for (const e of envs) {
    if (e.proxyId != null) selCount.set(e.proxyId, (selCount.get(e.proxyId) || 0) + 1)
  }
  const outsiderOf = (pid: number) => (usage.get(pid) || 0) - (selCount.get(pid) || 0)

  // ===== 池构成 =====
  const items: PoolItemExplain[] = proxies.map((p) => {
    const reasons: PoolRejectReason[] = []
    const u = checkUsable(p, now)
    if (u) reasons.push(u)
    const f = checkFilter(p, country, type)
    if (f) reasons.push(f)
    const outsiders = outsiderOf(p.id)
    if (outsiders > 0) reasons.push('occupied')
    return {
      id: p.id,
      name: p.name || `#${p.id}`,
      usable: reasons.length === 0,
      reasons,
      detail: reasons.map((r) => REASON_TEXT[r]).join('、') || '可用',
      heldByCount: outsiders > 0 ? outsiders : undefined,
      heldBySelected: selCount.get(p.id) || undefined
    }
  })

  const rejected: Record<string, number> = {}
  for (const it of items) {
    for (const r of it.reasons) rejected[r] = (rejected[r] || 0) + 1
  }
  const usable = items.filter((i) => i.usable).length

  // ===== 逐环境决策 =====
  // 只翻译，不重算：results 来自调用方实际调用的 allocateProxies
  const decisions: AllocDecisionExplain[] = results.results.map((r) => {
    const env = envById.get(r.id)
    const fromId = env?.proxyId ?? null
    const fromProxy = fromId != null ? nameOf.get(fromId) || '' : ''
    const toProxy = r.proxyId != null ? nameOf.get(r.proxyId) || '' : ''

    if (r.action === 'skipped') {
      return {
        id: r.id,
        name: r.name,
        action: 'skipped' as const,
        fromProxy,
        toProxy: fromProxy,
        why: r.reason || '未分配'
      }
    }
    if (r.action === 'kept') {
      return {
        id: r.id,
        name: r.name,
        action: 'kept' as const,
        fromProxy,
        toProxy,
        why: `已独占代理「${toProxy}」，保持不变`
      }
    }
    // assigned：分到了新代理（或仍拿原代理，但原代理的共享状态可能改变）。
    // 注意 brokeShared 的语义是「**原代理本来与本批其他环境共用**」，
    // 而不是「这个环境脱离了共享」——后者要等整批分配完才算得出，单条无从判断。
    const shared = fromId != null && (selCount.get(fromId) || 0) > 1
    const sameProxy = fromId != null && fromId === r.proxyId
    let why: string
    if (!fromProxy) {
      why = `新分配代理「${toProxy}」`
    } else if (sameProxy) {
      // 仍拿原代理：不能说「由 X 改为 X」——那是自相矛盾的文案
      why = `仍使用代理「${toProxy}」${shared ? '（原代理与本批其他环境共用，本次会把它们拆开）' : ''}`
    } else {
      why = `由「${fromProxy}」改为独占「${toProxy}」${shared ? '（原代理与本批其他环境共用，已拆开）' : ''}`
    }
    return {
      id: r.id,
      name: r.name,
      action: 'assigned' as const,
      fromProxy,
      toProxy,
      why,
      brokeShared: shared
    }
  })

  const notes = buildNotes(items, rejected, country, type)
  // 池不够是最需要解释的情形：说明「差几个」以及缺口出在哪
  const need = envs.filter((e) => e.status !== 'running').length
  if (usable < need) {
    notes.push(`可用代理 ${usable} 个，待分配环境 ${need} 个，缺 ${need - usable} 个`)
  }

  return {
    pool: {
      total: proxies.length,
      usable,
      rejected,
      items
    },
    decisions,
    notes
  }
}

/** 池构成的整体结论：告诉用户「为什么不够」以及「该往哪补」 */
function buildNotes(
  items: PoolItemExplain[],
  rejected: Record<string, number>,
  country: string,
  type: string
): string[] {
  const notes: string[] = []
  if (!items.length) return ['当前团队没有任何代理']

  // 按「可补救性」排序给出建议：先说改筛选就能解决的，再说必须补货的
  const filterHits = (rejected.countryFilter || 0) + (rejected.typeFilter || 0)
  if (filterHits) {
    const parts: string[] = []
    if (rejected.countryFilter) parts.push(`${rejected.countryFilter} 个国家不符${country ? `（当前筛选：${country}）` : ''}`)
    if (rejected.typeFilter) parts.push(`${rejected.typeFilter} 个类型不符${type ? `（当前筛选：${type}）` : ''}`)
    notes.push(`${parts.join('，')}；放宽筛选条件即可让它们进入可用池`)
  }
  if (rejected.expired) notes.push(`${rejected.expired} 个已过期，需续期或删除`)
  if (rejected.invalid) notes.push(`${rejected.invalid} 个已失效，需重新检测`)
  if (rejected.occupied) {
    notes.push(`${rejected.occupied} 个正被未选中的环境占用，无法抢占——如需重新平衡，请把这些环境也一起选进来`)
  }
  return notes
}

/** 取出「原代理是共享的」那些决策——防关联是这个功能的卖点，UI 要显眼 */
export function sharedBrokeList(explain: AllocExplain): AllocDecisionExplain[] {
  return explain.decisions.filter((d) => d.brokeShared)
}
