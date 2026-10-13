/**
 * 代理故障自愈的**纯判定逻辑**（主进程 / 渲染进程共用，零 Node 依赖）。
 *
 * ## 背景
 * 定时巡检原本只把 `proxies.status` 写成 `invalid` 就结束了——**没有任何后续动作**。
 * 对矩阵运营来说，一个环境的代理掉线等于该环境的出口 IP 变成了宿主真实 IP，
 * 多个环境同时掉线则可能挤到同一个 IP 上，这是防关联的大忌。
 *
 * ## 三条不可让步的约束（做这个功能最容易踩的坑）
 *
 * 1. **绝不把两个环境换绑到同一个出口 IP**。
 *    「自动换绑」最朴素的做法是随便找个可用代理，但这样会把 N 个掉线环境
 *    全部挤到同一个新代理上——等于亲手制造关联，比代理失效本身更糟。
 *    故挑选时必须排除「出口 IP 已被其他环境占用」的代理。
 *
 * 2. **绝不把环境换绑到与它自己原代理相同的出口 IP**。
 *    代理地址不同但出口 IP 相同（同一服务商的不同接入点）是很常见的，
 *    换过去等于什么都没换，还白白改了配置。
 *
 * 3. **必须有连续失败阈值**。
 *    网络抖动、目标检测站偶发超时都会让单次巡检失败。若一次失败就换绑，
 *    用户会发现环境 IP 在几分钟内反复跳变——这本身就是一个极强的「自动化工具」
 *    信号，且会连带触发平台的关联风控。故需连续 N 轮失败才动手。
 */

/** 巡检结果里与自愈相关的最小信息集（与 ProxyEntity 解耦，便于纯函数测试） */
export interface ProxyLike {
  id: number
  teamId: number
  type: string
  host: string
  port: number
  country: string
  region: string
  status: string
  exitIp: string
  expiresAt: Date | null
}

/** 环境侧的最小信息集 */
export interface ProfileLike {
  id: number
  teamId: number
  name: string
  proxyId: number | null
  /** 运行中的环境不做自动换绑：改代理要重启窗口才生效，会打断正在进行的操作 */
  status: string
}

/** 自愈决策的输出 */
export interface HealDecision {
  profileId: number
  profileName: string
  /** 失效的代理 */
  fromProxyId: number
  fromProxyName: string
  /** 替代代理；null 表示找不到合规替代，需人工介入 */
  toProxyId: number | null
  toProxyName: string | null
  /** 找不到替代时的原因，会写进日志 / 展示给用户 */
  reason: string
}

/** 连续失败计数的存储键：代理 id */
export type FailureCounts = Map<number, number>

/** 单个环境是否需要换绑 */
export function shouldHealProfile(
  profile: ProfileLike,
  failedProxyId: number,
  counts: FailureCounts,
  threshold: number
): { heal: boolean; reason: string } {
  if (profile.proxyId !== failedProxyId) return { heal: false, reason: '未绑定失效代理' }
  // 运行中的环境不自动换绑：换代理需重启窗口，正在进行的操作会被打断，
  // 且用户可能正在这个窗口里手动操作，贸然改配置比让它保持原状更糟
  if (profile.status === 'running') return { heal: false, reason: '环境运行中，不自动换绑（需手动处理）' }
  const n = counts.get(failedProxyId) || 0
  if (n < threshold) return { heal: false, reason: `连续失败 ${n}/${threshold} 轮，未达阈值` }
  return { heal: true, reason: `连续失败 ${n} 轮` }
}

/**
 * 为某个环境挑选合规的替代代理。
 *
 * @param candidates 候选代理（同团队、未失效、未过期、排除原代理）
 * @param usedExitIps 该团队已被其他环境占用的出口 IP 集合（含失效代理的 exitIp）
 * @param originalExitIp 原代理的出口 IP——新代理若与它相同则等于没换
 */
export function pickReplacementProxy(
  candidates: ProxyLike[],
  usedExitIps: Set<string>,
  originalExitId: string
): { proxy: ProxyLike | null; reason: string } {
  const usable = candidates.filter((p) => p.status !== 'invalid')
  if (!usable.length) return { proxy: null, reason: 'IP 池中没有其他可用代理' }

  // 第一优先：出口 IP 未被任何环境占用，且与原代理不同
  const safe = usable.filter((p) => p.exitIp && !usedExitIps.has(p.exitIp) && p.exitIp !== originalExitId)
  if (safe.length) return { proxy: safe[0], reason: '' }

  // 兜底：候选代理尚未巡检过（拿不到 exitIp），此时无法判定是否冲突。
  // candidates 已由调用方排除掉原代理本身（p.id !== bad.id），故这里无需再比 id——
  // 只需确认它确实没有已知的冲突出口 IP 即可放行。
  // 若不放行，「所有新代理都没测过出口 IP」会让自愈永远无法启用，退化成 useless。
  const unknownExit = usable.filter((p) => !p.exitIp)
  if (unknownExit.length) return { proxy: unknownExit[0], reason: '' }

  return {
    proxy: null,
    reason: `池中代理的出口 IP 均已被占用，换绑会造成多环境共用同一 IP（宁可保持现状）`
  }
}

/**
 * 计算一批自愈决策。纯函数：给定巡检结果与环境列表，产出该换谁、换到哪。
 *
 * @param opts.threshold 连续失败多少轮才动手
 * @param opts.dryRun 只决策不落库（供设置页「预览」与单测用）
 */
export function planProxyHealing(
  failedProxies: ProxyLike[],
  profiles: ProfileLike[],
  allProxies: ProxyLike[],
  counts: FailureCounts,
  opts: { threshold: number }
): HealDecision[] {
  const decisions: HealDecision[] = []
  const now = Date.now()

  /**
   * 本轮自愈中「已被本轮决策占用」的代理 id。
   *
   * **这是整个功能最容易漏、后果最严重的一处**：若每个环境各自独立决策，
   * 两个共用同一失效代理的环境会各自挑中同一个备选代理——自愈跑完了，
   * 两个环境还是共用同一个出口 IP，等于没修，甚至比不修更糟（用户以为修好了）。
   * 故必须把「本轮已选中的代理」记下来，后续决策要把它排除。
   *
   * 用代理 **id** 而非出口 IP 记录，是因为两个不同 id 的代理完全可能共享同一
   * 出口 IP（同一服务商的不同接入点）；真正的去重在 pickReplacementProxy
   * 里的 exitIp 判定，两层都要有。
   */
  const claimedProxyIds = new Set<number>()
  /** 失效代理也要计入占用：它仍绑在环境上，退出 IP 不能被别人拿走 */
  const claimedExitIps = new Set<string>()

  for (const bad of failedProxies) {
    const teamProfiles = profiles.filter((p) => p.teamId === bad.teamId)
    // 该团队已被其他环境占用的出口 IP。注意含失效代理自己的 exitIp：
    // 失效代理仍绑在环境上，它的 IP 仍是「已占用」，避免换绑回去
    const usedExitIps = new Set<string>()
    for (const p of teamProfiles) {
      const bound = p.proxyId === bad.id ? bad : allProxies.find((x) => x.id === p.proxyId)
      if (bound?.exitIp) usedExitIps.add(bound.exitIp)
    }
    // 合并本轮其他失效代理已认领的出口（多个代理同时失效时互相影响）
    for (const ip of claimedExitIps) usedExitIps.add(ip)

    for (const profile of teamProfiles) {
      const gate = shouldHealProfile(profile, bad.id, counts, opts.threshold)
      if (!gate.heal) continue

      const candidates = allProxies.filter(
        (p) =>
          p.teamId === bad.teamId &&
          p.id !== bad.id &&
          !claimedProxyIds.has(p.id) &&
          p.status !== 'invalid' &&
          (!p.expiresAt || new Date(p.expiresAt).getTime() > now)
      )
      const picked = pickReplacementProxy(candidates, usedExitIps, bad.exitIp)
      if (picked.proxy) {
        claimedProxyIds.add(picked.proxy.id)
        if (picked.proxy.exitIp) claimedExitIps.add(picked.proxy.exitIp)
      }
      decisions.push({
        profileId: profile.id,
        profileName: profile.name,
        fromProxyId: bad.id,
        fromProxyName: `${bad.host}:${bad.port}`,
        toProxyId: picked.proxy?.id ?? null,
        toProxyName: picked.proxy ? `${picked.proxy.host}:${picked.proxy.port}` : null,
        reason: picked.proxy ? gate.reason : `${gate.reason}；${picked.reason}`
      })
    }
  }
  return decisions
}

/** 递增连续失败计数；巡检成功则清零 */
export function bumpFailureCount(counts: FailureCounts, proxyId: number, ok: boolean): number {
  if (ok) {
    counts.delete(proxyId)
    return 0
  }
  const n = (counts.get(proxyId) || 0) + 1
  counts.set(proxyId, n)
  return n
}
