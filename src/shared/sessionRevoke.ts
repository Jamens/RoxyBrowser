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
  /** 分步挑战令牌标记：有值即表示它不是完整会话令牌（2FA 中间态） */
  purpose?: string
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
export function checkSession(claims: SessionClaims, currentVersion: number): SessionVerdict {
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
  return { valid: true }
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
