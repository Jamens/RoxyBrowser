/**
 * 接口限流与登录锁定的**纯判定逻辑**（主进程 / 渲染进程共用，零 Node 依赖）。
 *
 * ## 背景与风险评估
 * 本地 API 只监听 `127.0.0.1`，**不暴露局域网**——这已经消掉了大部分攻击面。
 * 但两个风险仍在：
 *
 * 1. **登录爆破**：本机任意进程/任意网页（浏览器里的恶意脚本能发到 127.0.0.1）
 *    都能无限次尝试 `/auth/login`。默认账号是 `admin / 123456`，无锁定机制时
 *    爆破成本几乎为零。
 * 2. **API 滥用**：令牌接口一旦泄漏，调用方可无限建/删环境。令牌能删数据、
 *    导出 Cookie，没有任何速率约束。
 *
 * ## 两个刻意的设计选择
 *
 * **① 用滑动窗口而不是固定窗口计数**
 * 固定窗口（每分钟计数清零）有个经典绕过：窗口末尾打满 N 次，下个窗口开头
 * 再打 N 次，实际 2 倍速率。滑动窗口按时间戳保留每次请求，边界无法卡。
 *
 * **② 登录失败按「用户名」计数而不是按 IP**
 * 本地场景下所有请求都来自 127.0.0.1，按 IP 计数等于**所有人共用一个额度**——
 * 攻击者只需猛打任意账号就会把正常用户锁在门外（自我 DoS）。按用户名计数才能
 * 精准打击爆破目标，同时不影响其他人正常登录。
 * 注意这也意味着攻击者可轮换用户名来规避，因此阈值仍需配合「注册接口限流」。
 */

/** 滑动窗口内的单次记录 */
interface Hit {
  at: number
}

/** 单个桶的状态 */
export interface Bucket {
  hits: Hit[]
  /** 连续失败次数（登录专用）；成功登录后清零 */
  failures: number
  /** 锁定截止时间戳；0 表示未锁定 */
  lockedUntil: number
}

export function createBucket(): Bucket {
  return { hits: [], failures: 0, lockedUntil: 0 }
}

export interface RateDecision {
  /** 是否放行 */
  allowed: boolean
  /** 被拒时的 HTTP 状态码：限流 429 / 锁定 423（Locked） */
  status: number
  /** 剩余可用次数 */
  remaining: number
  /** 建议的 Retry-After 秒数 */
  retryAfterSec: number
  reason: string
}

function allow(remaining: number): RateDecision {
  return { allowed: true, status: 200, remaining, retryAfterSec: 0, reason: '' }
}

/**
 * 滑动窗口限流：窗口内请求数超过 limit 即拒绝。
 *
 * @param now 当前时间戳（注入以便单测，不依赖真实时钟）
 * @param limit 窗口内最大请求数
 * @param windowMs 窗口长度（毫秒）
 */
export function consumeRateLimit(
  bucket: Bucket,
  now: number,
  limit: number,
  windowMs: number
): RateDecision {
  if (limit <= 0) return allow(Number.MAX_SAFE_INTEGER) // 0 = 不限流
  pruneHits(bucket, now, windowMs)
  if (bucket.hits.length >= limit) {
    // Retry-After 取「最早那次命中滑出窗口」的剩余时间——这是最早能再试的时刻
    const oldest = bucket.hits[0]?.at ?? now
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    return {
      allowed: false,
      status: 429,
      remaining: 0,
      retryAfterSec,
      reason: `请求过于频繁，请 ${retryAfterSec} 秒后重试`
    }
  }
  bucket.hits.push({ at: now })
  return allow(limit - bucket.hits.length)
}

/** 丢弃滑出窗口的记录（顺带丢弃过期的锁定状态） */
function pruneHits(bucket: Bucket, now: number, windowMs: number): void {
  const cutoff = now - windowMs
  while (bucket.hits.length && bucket.hits[0].at <= cutoff) bucket.hits.shift()
  if (bucket.lockedUntil && bucket.lockedUntil <= now) {
    // 锁定已到期：清零失败计数，否则用户解封后第一次输错就又被锁
    bucket.lockedUntil = 0
    bucket.failures = 0
  }
}

/** 只看判定不消费额度（用于「是否仍处于锁定期」的查询） */
export function isLocked(bucket: Bucket, now: number): boolean {
  return bucket.lockedUntil > now
}

/**
 * 登录失败处理：累加失败次数，达阈值则锁定。
 *
 * @param threshold 连续失败多少次后锁定；0 表示不锁定（仅记录）
 * @param lockMs 锁定时长（毫秒）
 */
export function registerLoginFailure(
  bucket: Bucket,
  now: number,
  threshold: number,
  lockMs: number
): RateDecision {
  pruneHits(bucket, now, DEFAULT_LOGIN_WINDOW_MS)
  bucket.failures += 1
  if (threshold > 0 && bucket.failures >= threshold) {
    bucket.lockedUntil = now + lockMs
    const retryAfterSec = Math.max(1, Math.ceil(lockMs / 1000))
    return {
      allowed: false,
      status: 423,
      remaining: 0,
      retryAfterSec,
      reason: `密码错误次数过多，账号已锁定，请 ${formatDuration(retryAfterSec)}后重试`
    }
  }
  const left = threshold > 0 ? threshold - bucket.failures : 0
  return {
    allowed: true,
    status: 200,
    remaining: left,
    retryAfterSec: 0,
    // 剩余次数提示仅在阈值较大时给——否则「还剩 1 次」这种提示反而帮爆破者精确定位阈值
    reason: left > 0 && left <= 3 ? `密码错误，还可尝试 ${left} 次` : ''
  }
}

/** 登录成功：清空该账号的失败计数与锁定 */
export function registerLoginSuccess(bucket: Bucket): void {
  bucket.failures = 0
  bucket.lockedUntil = 0
}

/** 登录锁定检查（登录接口入口调用）。锁定中直接拒绝，不再查密码 */
export function checkLoginLock(bucket: Bucket, now: number): RateDecision {
  pruneHits(bucket, now, DEFAULT_LOGIN_WINDOW_MS)
  if (!isLocked(bucket, now)) return allow(1)
  const retryAfterSec = Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000))
  return {
    allowed: false,
    status: 423,
    remaining: 0,
    retryAfterSec,
    reason: `账号已锁定，请 ${formatDuration(retryAfterSec)}后重试`
  }
}

export const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000

/**
 * 从请求解析客户端标识。
 *
 * 放在 shared 而非 main：登录路由（routes/auth.ts）也要用它做注册限流的桶键，
 * 而 routes 反向依赖 main 会形成循环依赖。纯函数、无框架类型依赖。
 *
 * 优先取 X-Forwarded-For：本服务只监听回环，但保留以便将来放到反代后面时
 * 仍能取到真实来源 IP。
 */
export function clientKeyOf(headers: Record<string, unknown>, fallback: string): string {
  const xff = headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim().length > 0) return xff.split(',')[0].trim()
  return fallback || 'unknown'
}

/** 秒数 → 人类可读（用于错误提示，避免用户看到裸秒数） */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const min = Math.ceil(seconds / 60)
  if (min < 60) return `${min} 分钟`
  return `${Math.ceil(min / 60)} 小时`
}

/**
 * 内存桶存储：键 → 桶。附带定期清理，避免长期运行内存无限增长。
 * 键由调用方构造（如 `login:admin`、`api:127.0.0.1`）。
 */
export class BucketStore {
  private buckets = new Map<string, Bucket>()

  get(key: string): Bucket {
    let b = this.buckets.get(key)
    if (!b) {
      b = createBucket()
      this.buckets.set(key, b)
    }
    return b
  }

  /** 清掉已无命中记录且无锁定的空桶 */
  sweep(now: number, windowMs: number, maxAgeMs = 60 * 60 * 1000): number {
    let removed = 0
    for (const [key, b] of this.buckets) {
      const lastHit = b.hits.length ? b.hits[b.hits.length - 1].at : 0
      const hasLock = b.lockedUntil > now
      const hasFailures = b.failures > 0
      if (!hasLock && !hasFailures && (!lastHit || now - lastHit > Math.max(windowMs, maxAgeMs))) {
        this.buckets.delete(key)
        removed++
      }
    }
    return removed
  }

  get size(): number {
    return this.buckets.size
  }

  /** 仅供单测：清空全部状态 */
  clear(): void {
    this.buckets.clear()
  }
}
