// 智能代理分配核心（纯函数，无 DB / Electron 依赖，便于离线单测）。
// 设计目标：对一批环境，逐一分配**互不相同**的代理，杜绝两个环境共用同一出口 IP（防关联）。
// 关键规则：
// - 可用池 = 未失效、未过期、符合 country/type 过滤，且**未被「未选中」环境占用**的代理（outsiderUsage===0）。
//   其中既包含全局空闲代理（usageCount===0），也包含「仅被本批选中环境共享」的代理——后者是本批可重新平衡的，
//   必须释放并打散到各选中环境，让原本挤在同一代理上的多个环境各自独占一个出口（防关联核心收益）。
// - 某环境若已独占一个合规代理（仅自己用、无外人占用），则保留不动（Phase1 先锁定，避免被后面的空环境抢走）；
// - 其余环境（无代理，或代理被共享）从可用池按 id 顺序取一个未被本轮占用的代理；池不够则标记 skipped（不强行复用）；
// - 运行中的环境不改动绑定，标记 skipped。
// 调用方负责把 updates 落库（设置对应环境的 proxyId）。

export interface AllocEnv {
  id: number
  name: string
  status: string
  proxyId: number | null
}

export interface AllocProxy {
  id: number
  status: string
  country?: string | null
  type?: string
  expiresAt?: Date | string | null
}

export interface AllocItem {
  id: number
  name: string
  action: 'assigned' | 'kept' | 'skipped'
  proxyId?: number
  reason?: string
}

export interface AllocResult {
  total: number
  assigned: number
  kept: number
  skippedRunning: number
  skippedNoProxy: number
  insufficient: boolean
  assignedProxyIds: number[]
  results: AllocItem[]
  /** 需要落库的环境（proxyId 已改）；调用方据此 save */
  updates: Array<{ id: number; proxyId: number | null }>
}

const isUsable = (p: AllocProxy, now: number): boolean =>
  p.status !== 'invalid' && (!p.expiresAt || new Date(p.expiresAt).getTime() > now)

const matchFilter = (p: AllocProxy, country: string, type: string): boolean => {
  if (country && !(p.country || '').toLowerCase().includes(country.toLowerCase())) return false
  if (type && p.type !== type) return false
  return true
}

export function allocateProxies(
  envs: AllocEnv[],
  proxies: AllocProxy[],
  usage: Map<number, number>,
  opts: { country?: string; type?: string } = {}
): AllocResult {
  const country = opts.country?.trim() || ''
  const type = opts.type?.trim() || ''
  const now = Date.now()
  const proxyMap = new Map(proxies.map((p) => [p.id, p]))

  // 本批选中环境对每个代理的绑定计数
  const selCount = new Map<number, number>()
  for (const e of envs) {
    if (e.proxyId != null) selCount.set(e.proxyId, (selCount.get(e.proxyId) || 0) + 1)
  }
  // 某代理是否被「未选中」环境占用：globalUsage - 选中计数 > 0
  // 外人持有则该代理不可被本批重新平衡（本批只能从其他真正空闲的代理挪走，或放弃）
  const outsiderUsage = (pid: number): number => (usage.get(pid) || 0) - (selCount.get(pid) || 0)

  // 可用池：合规且**无外人占用**（可被本批自由重分配，含全局空闲与仅本批内部共享两类）
  const pool = proxies
    .filter((p) => isUsable(p, now) && matchFilter(p, country, type) && outsiderUsage(p.id) === 0)
    .sort((a, b) => a.id - b.id)

  const claimed = new Set<number>()
  const results: AllocItem[] = []
  let assigned = 0,
    kept = 0,
    skippedRunning = 0,
    skippedNoProxy = 0
  const updates: Array<{ id: number; proxyId: number | null }> = []

  // Phase 1：先锁定「已独占合规代理」的环境（仅自己用、无外人），避免被后面的空环境从池中抢走
  const handled = new Set<number>()
  for (const env of envs) {
    if (env.status === 'running') continue
    const cur = env.proxyId
    if (cur != null) {
      const cp = proxyMap.get(cur)
      const exclusive = !!cp && isUsable(cp, now) && matchFilter(cp, country, type) && outsiderUsage(cur) === 0 && (selCount.get(cur) || 0) === 1
      if (exclusive && !claimed.has(cur)) {
        claimed.add(cur)
        kept++
        handled.add(env.id)
        results.push({ id: env.id, name: env.name, action: 'kept', proxyId: cur })
      }
    }
  }

  // Phase 2：处理剩余环境（无代理，或代理被共享/被外人占用），从可用池取互不相同的代理
  for (const env of envs) {
    if (handled.has(env.id)) continue
    if (env.status === 'running') {
      skippedRunning++
      results.push({ id: env.id, name: env.name, action: 'skipped', reason: '环境运行中，未改动绑定' })
      continue
    }
    const pick = pool.find((p) => !claimed.has(p.id))
    if (!pick) {
      skippedNoProxy++
      results.push({ id: env.id, name: env.name, action: 'skipped', reason: '无可分配的空闲代理（池不足，避免同代理复用）' })
      continue
    }
    claimed.add(pick.id)
    assigned++
    results.push({ id: env.id, name: env.name, action: 'assigned', proxyId: pick.id })
    updates.push({ id: env.id, proxyId: pick.id })
  }

  return {
    total: envs.length,
    assigned,
    kept,
    skippedRunning,
    skippedNoProxy,
    insufficient: skippedNoProxy > 0,
    assignedProxyIds: Array.from(claimed),
    results,
    updates
  }
}
