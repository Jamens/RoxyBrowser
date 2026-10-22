import { countryTimezone, findCountryLoose } from './countries'

/**
 * 代理出口 IP 漂移检测（纯函数，可离线单测）。
 *
 * ## 为什么需要这个模块
 *
 * 代理 IP 池会**轮换出口 IP**。此前 `applyProxyCheckResult` 直接把新出口 IP 与
 * 新国家覆盖写回代理记录，**不与旧值比对**。于是当某个代理的出口从美国换成德国时：
 *
 *   1. 库里 `country` 被悄悄改成 Germany；
 *   2. 但已绑定环境的**时区 / 语言 / GEO 仍是按旧国家（美国）生成的**；
 *   3. 环境变成「时区纽约 + 出口德国」——平台侧一眼看出关联异常；
 *   4. 而界面上**没有任何提示**，`proxyId` 也没变，用户完全不知情。
 *
 * 这对一款以「多账号防关联」为卖点的产品是最不能出的错，却完全静默。
 * 本模块负责把这件事**变成可检测、可告警、可处理的**。
 *
 * ## 两条信号，含义不同，不要混用
 *
 * - **漂移事件**（`detectExitIpChange`）：*瞬时*——「本次检测发现出口 IP 与上次不同」。
 *   只在变化发生的那一刻有意义，用于**写日志 / 发 webhook**，让用户立刻知道。
 *   判不出来（比如检测失败、首次检测）就返回 null，不硬造。
 *
 * - **错位环境**（`findMisalignedProfiles`）：*持续*——「绑定了这个代理、但时区与
 *   代理当前国家对不上的环境」。这是**可随时重新计算的派生状态**，不需要存库，
 *   也不需要"记住"曾经发生过漂移：只要代理国家变了、环境的时区没跟着变，
 *   它就一直是错位的。这也意味着修复完（时区对齐新国家）它自动消失。
 *
 * ## 为什么错位判定要与体检完全同口径
 *
 * 判定用 `countryTimezone(country) === timezone`（精确相等），与
 * `shared/healthFix.ts` 的 `tzVsProxy` **完全一致**。
 * 若这里用更宽松的"同国家即可"，代理列表会说"一致"而体检说"不一致"，
 * 用户只会怀疑工具坏了——两个视图打架比不显示更糟。
 */

export interface ProxyExitSnapshot {
  exitIp?: string | null
  country?: string | null
}

/** 一次出口 IP 漂移的完整描述 */
export interface ExitIpChange {
  /** 变化前的出口 IP */
  oldExitIp: string
  /** 变化后的出口 IP */
  newExitIp: string
  /** 变化前记录的国家（空表示此前没检测过或未识别） */
  oldCountry: string
  /** 变化后的国家 */
  newCountry: string
  /**
   * 国家是否也变了。
   *
   * 注意：**同国不同 IP 同样算漂移**——出口节点换了，即便国家没变，
   * 平台的"同 IP 多账号"关联规则照样可能命中，所以这个标记要保留。
   */
  countryChanged: boolean
}

/**
 * 判断一次检测是否意味着出口 IP 漂移。
 *
 * 判定为「漂移」需同时满足：
 *   - 旧出口 IP 存在（首次检测没有旧值，不算漂移）
 *   - 新出口 IP 存在（检测失败时 ip-api 返回空，不算漂移）
 *   - 两者不相同
 *
 * @param prev 上一次记录下来的出口信息
 * @param next 本次检测得到的出口信息
 */
export function detectExitIpChange(
  prev: ProxyExitSnapshot | null | undefined,
  next: ProxyExitSnapshot | null | undefined
): ExitIpChange | null {
  const oldIp = String(prev?.exitIp || '').trim()
  const newIp = String(next?.exitIp || '').trim()
  // 旧值缺失 = 首次检测，没有"变化"可言；新值缺失 = 检测失败，不该覆盖旧事实
  if (!oldIp || !newIp) return null
  if (oldIp === newIp) return null
  const oldCountry = String(prev?.country || '').trim()
  const newCountry = String(next?.country || '').trim()
  return { oldExitIp: oldIp, newExitIp: newIp, oldCountry, newCountry, countryChanged: oldCountry !== newCountry }
}

/** 判定错位所需的最小环境信息 */
export interface DriftProfileLike {
  id: number
  name: string
  proxyId: number | null
  timezone: string
}

/** 一个与代理出口国家对不上的环境 */
export interface MisalignedProfile {
  id: number
  name: string
  /** 环境当前时区 */
  timezone: string
  /** 按代理国家应有时区 */
  expectedTimezone: string
}

/**
 * 找出绑定了该代理、但时区与代理当前国家不一致的环境。
 *
 * 判定口径与体检 `tzVsProxy` 一致：`countryTimezone(country) === timezone`。
 * 代理国家为空或不在内置国家表里时返回空数组——**不制造噪音**
 * （代理刚建还没检测过、或国家名无法识别时，不该弹一堆"错位"）。
 */
export function findMisalignedProfiles(
  proxy: { id: number; country?: string | null },
  profiles: DriftProfileLike[]
): MisalignedProfile[] {
  // 必须用宽松匹配：代理 country 存的是英文名（"United States"），不是代码。
  // 与 healthFix.resolveProxyCountry 共用 findCountryLoose，判定口径只有一处。
  const country = findCountryLoose(proxy?.country)
  if (!country) return []
  const expected = countryTimezone(country.code)
  if (!expected) return []
  return profiles
    .filter((p) => p.proxyId === proxy.id && !!p.timezone && p.timezone !== expected)
    .map((p) => ({ id: p.id, name: p.name, timezone: p.timezone, expectedTimezone: expected }))
}

/**
 * 生成写入操作日志 / webhook 的人类可读描述。
 *
 * 单独抽出来是为了让**措辞可被单测锁住**——这段文字是用户唯一的通知渠道，
 * 写坏了（例如把"出口已变更"说成"代理失效"）会让用户做出错误判断。
 *
 * @param change    漂移详情
 * @param proxyName 代理名称
 * @param affected  受影响（错位）的环境
 */
export function describeExitIpChange(
  change: ExitIpChange,
  proxyName: string,
  affected: MisalignedProfile[]
): string {
  const parts: string[] = []
  parts.push(`代理「${proxyName}」出口 IP 已变更：${change.oldExitIp} → ${change.newExitIp}`)
  if (change.countryChanged) {
    parts.push(`出口国家：${change.oldCountry || '未知'} → ${change.newCountry || '未知'}`)
  } else {
    // 同国不同 IP 也要说明，否则用户会以为"国家没变所以没事"
    parts.push(`出口国家未变（${change.newCountry || '未知'}），但出口节点已更换`)
  }
  if (affected.length > 0) {
    const names = affected.map((p) => `「${p.name}」(#${p.id})`).join('、')
    parts.push(
      `受影响 ${affected.length} 个环境：${names}。` +
        `这些环境的时区仍是 ${affected[0].timezone}，与出口国家对应的 ${affected[0].expectedTimezone} 不一致，` +
        `请在「一致性修复」中按需校正`
    )
  } else {
    parts.push('当前没有绑定该代理的环境，或环境时区与出口国家一致，无需处理')
  }
  return parts.join('；')
}
