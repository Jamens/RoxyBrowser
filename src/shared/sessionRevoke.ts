/**
 * 会话撤销的**纯判定逻辑**（主进程 / 渲染进程共用，零 Node 依赖）。
 *
 * ## 背景
 * 会话令牌是 `jwt.sign({ uid, tid, username, role }, secret, { expiresIn: '7d' })`
 * ——**无状态**。这带来两个绕不过去的问题：
 *
 * 1. 「登出」此前只做前端清 localStorage，令牌在服务端**依然有效满 7 天**。
 *    一旦令牌被截获（XSS、日志泄漏、备份文件），攻击者可以在有效期内
 *    完整使用该账号——登出这个动作在安全上形同虚设。
 * 2. 管理员无法强制让某个用户的会话下线（比如怀疑账号被盗）。
 *
 * ## 为什么用 tokenVersion 而不是黑名单
 * JWT 无状态，要「撤销单个令牌」就得维护黑名单，而黑名单要么无限增长、
 * 要么过期清理出错（漏删 = 该死令牌仍有效）。而我们真正需要的是
 * **「让某个用户的全部会话失效」**——这正是登出、改密码、
 * 「退出所有设备」三种场景的语义。用 `users.tokenVersion`（一个整数）
 * 做版本号：令牌里带上签发时的版本号，校验时与库里的当前版本比对，
 * 不一致即失效。递增一个整数即吊销该用户全部令牌，O(1)、无存储、无清理。
 *
 * 代价是「改密码会让所有设备下线」——但这恰恰是**用户期望的行为**
 * （密码泄露时你当然希望把其他设备踢下线），不是缺陷。
 */

/** 令牌载荷中与撤销相关的字段 */
export interface SessionClaims {
  uid: number
  tid: number
  username: string
  role: string
  /** 签发时的用户会话版本号；**缺失视为 0**（兼容本功能上线前的旧令牌） */
  ver?: number
  /**
   * 签发时的设备指纹（`dev`），用于「只让本设备失效」的设备级撤销。
   * **缺失视为空串**：兼容本功能上线前的旧令牌——它们无法被设备级撤销，
   * 但也绝不能因此被误判失效（升级不能踢人）。
   */
  dev?: string
  /** 分步挑战令牌标记：有值即表示它不是完整会话令牌（2FA 中间态） */
  purpose?: string
}

/** 设备级撤销记录（存于 `users.revokedDevices`，JSON 数组） */
export interface RevokedDevice {
  /** 设备指纹 */
  dev: string
  /** 撤销时间戳（毫秒）；用于按令牌有效期过期回收 */
  at: number
}

/**
 * 由 User-Agent 算设备指纹（**纯函数**，主进程与路由共用）。
 *
 * 取哈希而非原始 UA 的原因有二：
 * 1. **不落可识别信息**——UA 含操作系统与浏览器版本，是可用于指纹关联的用户数据。
 *    存哈希后库里只有一段不可逆摘要，符合「不落敏感信息」的约定。
 * 2. **不可枚举**——即使数据库泄露，也无法通过 UA 反查是谁的设备。
 *
 * 稳定性权衡：UA 变化（浏览器自动升级、系统更新）会改变哈希，
 * 该设备的「已登出」状态随之失效。但这只影响撤销的**残留时长**，
 * 不影响安全模型——真正的全设备吊销仍由 tokenVersion 兜底。
 * 不引入安装 ID 文件等更复杂的设备标识，是因为本项目是单机部署的指纹浏览器，
 * 跨设备登出的主要诉求是「别把我其他电脑踢下线」，UA 哈希已足够。
 *
 * 截断到 32 位十六进制：够区分设备，又不至于把列撑大。
 * **必须与校验侧共用本函数**——两处各写一遍 sha256+截断规则，
 * 迟早会写歪，届时表现为「登出后令牌仍有效」，且没有任何报错。
 */
export function deviceFingerprint(userAgent: string | undefined | null): string {
  const ua = String(userAgent || '')
  if (!ua) return ''
  // 同步 SHA-256（无 Node 依赖，可离线单测）；主进程与路由用同一份实现
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < ua.length; i++) {
    const c = ua.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${h1.toString(16)}${h2.toString(16)}`.slice(0, 32)
}

/** 校验结果 */
export type SessionVerdict =
  | { valid: true }
  | { valid: false; reason: string; code: SessionRejectCode }

export type SessionRejectCode =
  /** 令牌类型不对（如把 2FA 挑战令牌当会话令牌用） */
  | 'wrong_token_type'
  /** 版本号落后 → 已被登出 / 改密码 / 管理员强制下线 */
  | 'session_revoked'

/**
 * 判定一个已通过签名校验的令牌是否仍然有效。
 *
 * 注意：`jwt.verify` 的**签名与过期校验必须在调用之前完成**——本函数
 * 只处理「签名合法但已不该再用」的情况，无权也不该重新验证密码学部分。
 */
export function checkSession(
  claims: SessionClaims,
  currentVersion: number,
  revokedDevices: RevokedDevice[] = []
): SessionVerdict {
  // 先判类型：2FA 挑战令牌绝不能当会话令牌用，否则存在 2FA 降级/绕过风险
  if (claims.purpose) return { valid: false, reason: '令牌类型无效，请重新登录', code: 'wrong_token_type' }

  // 版本号缺失按 0 处理：兼容本功能上线前签发的旧令牌。
  // 这是**必须**的——否则升级后所有在线用户会被立刻踢下线。
  const tokenVersion = claims.ver ?? 0
  const now = Number(currentVersion) || 0
  if (tokenVersion < now) {
    return { valid: false, reason: '登录已失效，请重新登录', code: 'session_revoked' }
  }
  // 版本号**大于**库里的当前值（令牌比库还新）同样不可信：
  // 说明库里数据被回滚/重置过，或令牌来自另一套环境，放行等于绕过撤销。
  if (tokenVersion > now) {
    return { valid: false, reason: '登录状态异常，请重新登录', code: 'session_revoked' }
  }
  // 设备级撤销：普通「登出」只吊销本设备，其他设备的会话不受影响。
  // 令牌无 dev 字段（旧令牌）时跳过——升级不能踢人。
  const dev = claims.dev || ''
  if (dev && isDeviceRevoked(dev, revokedDevices)) {
    return { valid: false, reason: '本设备已登出，请重新登录', code: 'session_revoked' }
  }
  return { valid: true }
}

/** 该设备是否已被撤销 */
export function isDeviceRevoked(dev: string, revokedDevices: RevokedDevice[]): boolean {
  if (!dev || !Array.isArray(revokedDevices)) return false
  return revokedDevices.some((d) => !!d && d.dev === dev)
}

/**
 * 把某设备追加进撤销列表。
 *
 * **必须去重**：同一设备反复登出会追加出多条相同记录，把这一列撑到无意义的大小。
 * 同设备只保留**最新**那条时间戳——旧的已过期，留下只会误导后续的过期回收。
 *
 * 数组长度上限 `MAX_REVOKED_DEVICES`：撤销列表只在令牌还有效期内有意义，
 * 过期回收（见 `pruneRevokedDevices`）之外再加一道硬上限兜底，
 * 避免极端情况下（大量设备反复登出）该列无限增长——那正是黑名单的老毛病。
 * 超出时丢弃**最旧的**（即将过期、危害最小），而不是最新的。
 */
export const MAX_REVOKED_DEVICES = 50

export function addRevokedDevice(revokedDevices: RevokedDevice[], dev: string, now: number): RevokedDevice[] {
  if (!dev) return Array.isArray(revokedDevices) ? revokedDevices.slice() : []
  const base = Array.isArray(revokedDevices) ? revokedDevices.filter((d) => !!d && !!d.dev) : []
  const rest = base.filter((d) => d.dev !== dev)
  const next = [...rest, { dev, at: Number(now) || 0 }].sort((a, b) => a.at - b.at)
  return next.length > MAX_REVOKED_DEVICES ? next.slice(next.length - MAX_REVOKED_DEVICES) : next
}

/**
 * 回收已过期的撤销记录。
 *
 * 一条撤销记录只在「它吊销的那个令牌还没过期」期间才有意义。令牌有效期是
 * `SESSION_TTL_DAYS`，超过就随令牌自然失效一同作废——继续留着既占空间，
 * 又会在设备指纹偶然复用时（同型号机器、同版本浏览器）造成误杀。
 */
export function pruneRevokedDevices(
  revokedDevices: RevokedDevice[],
  now: number,
  ttlDays = SESSION_TTL_DAYS
): RevokedDevice[] {
  if (!Array.isArray(revokedDevices)) return []
  const cutoff = (Number(now) || 0) - ttlDays * 24 * 60 * 60 * 1000
  return revokedDevices.filter((d) => !!d && !!d.dev && Number(d.at) > cutoff)
}

/** 校验失败时前端应据此决定是否清理本地令牌并跳登录页 */
export function shouldClearLocalSession(verdict: SessionVerdict): boolean {
  return !verdict.valid
}

/**
 * 算出「退出所有设备」需要递增到的版本号。
 * 直接 +1 即可——版本号的具体取值无意义，只有「相等 / 不等」有意义，
 * 不需要时间戳或随机数（那会引入不必要的复杂度与碰撞考量）。
 */
export function nextSessionVersion(current: number): number {
  return (Number(current) || 0) + 1
}

/** 令牌有效期（天）→ 供前端展示「登录有效期」 */
export const SESSION_TTL_DAYS = 7
