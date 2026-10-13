import type { Request, Response, NextFunction } from 'express'
import { BucketStore, consumeRateLimit, type RateDecision } from '../shared/rateLimit'

/**
 * 接口限流中间件（滑动窗口，按客户端 IP）。
 *
 * ## 为什么需要（风险评估要说清，避免过度设计）
 * 本地 API 只监听 `127.0.0.1`，**不暴露局域网**——真正的外部攻击面已经很小。
 * 但两个风险仍在：
 * 1. **浏览器里的恶意脚本**：`fetch('http://127.0.0.1:39100/api/...')` 对同机
 *    任何网页都成立（CSRF 之外的本地攻击面），无 CORS 阻止**请求发出**（只阻止读响应）。
 * 2. **本机任意进程**可无限调用；令牌泄漏后无速率约束。
 *
 * 所以限流的价值是「抬高暴力尝试的成本 + 限制异常调用速率」，而非防网络攻击。
 *
 * ## 桶键的选择
 * 按 **IP + 路径前缀**分桶。若全用一个桶，一个失控的前端轮询就会耗尽全部额度
 * 把正常操作一起限掉；按前缀分可让「登录」与「环境列表」互不影响。
 *
 * 注意：本地场景下 IP 永远是 127.0.0.1，**登录爆破不能靠这个桶防**——
 * 那需要按用户名计数，见 `routes/auth.ts` 里的登录锁定。
 */

/** 全局限流状态（进程内；应用重启即清空，符合「防突发」而非「防长期攻击」的定位） */
const apiBuckets = new BucketStore()

/** 已告警过的桶（接近限额时提示一次，避免每请求刷屏） */
const warnedBuckets = new Set<string>()

/** 登录桶在 auth 域共享，用 set 避免重复实例 */
export const loginBuckets = new BucketStore()

const DEFAULT_WINDOW_MS = 60 * 1000

/** 从请求解析客户端标识：优先 XFF（虽然只听回环，但保留以便反代场景） */
export function clientKey(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim()
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function respondDenied(res: Response, d: RateDecision): void {
  if (d.retryAfterSec > 0) res.setHeader('Retry-After', String(d.retryAfterSec))
  res.setHeader('X-RateLimit-Remaining', String(d.remaining))
  res.status(d.status).json({ message: d.reason, code: d.status === 423 ? 'account_locked' : 'rate_limited' })
}

/**
 * 生成限流中间件。
 *
 * @param bucketPrefix 桶键前缀（按前缀分桶，见上方说明）
 * @param limitProvider 每次请求实时读取限额：限流值可被用户改，不能在启动时固化
 * @param windowMs 窗口长度
 */
export function rateLimit(
  bucketPrefix: string,
  limitProvider: () => number,
  windowMs: number = DEFAULT_WINDOW_MS
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const limit = limitProvider()
    if (limit > 0) {
      const bucket = apiBuckets.get(`${bucketPrefix}:${clientKey(req)}`)
      const decision = consumeRateLimit(bucket, Date.now(), limit, windowMs)
      res.setHeader('X-RateLimit-Limit', String(limit))
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining))
      // 接近限额时提示一次（按桶去重，避免每请求都刷屏）：
      // 限额快用尽通常意味着轮询过密或某个页面在疯狂请求，
      // 提前看到比撞墙后排查省事得多。
      if (decision.remaining <= Math.max(1, Math.floor(limit * 0.1))) {
        const key = `${bucketPrefix}:warned`
        if (!warnedBuckets.has(key)) {
          warnedBuckets.add(key)
          console.warn(
            `[rateLimit] ${bucketPrefix} 即将打满（剩余 ${decision.remaining}/${limit}），` +
              '若随后触发限流请检查轮询频率'
          )
          // 下一个窗口自然过期后再允许告警
          setTimeout(() => warnedBuckets.delete(key), windowMs).unref?.()
        }
      }
      if (!decision.allowed) {
        // 诊断日志：限流是「结果」，真正要查的是「谁在打」。
        // 没有这条只能看到前端一句「请求过于频繁」，无从定位是轮询太密
        // 还是用户操作太频繁，也无从判断该调限额还是该降轮询频率。
        console.warn(
          `[rateLimit] 触发限流 ${bucketPrefix}: ${req.method} ${req.originalUrl} ` +
            `(${decision.reason}, 用满 ${limit}/${Math.floor((Date.now() % windowMs) / 1000)}s)`
        )
        respondDenied(res, decision)
        return
      }
    }
    next()
  }
}

/** 定期清理空桶，避免长期运行时 Map 无限增长 */
export function startRateLimitSweeper(): void {
  const timer = setInterval(() => {
    apiBuckets.sweep(Date.now(), DEFAULT_WINDOW_MS)
    loginBuckets.sweep(Date.now(), DEFAULT_WINDOW_MS)
  }, 5 * 60 * 1000)
  // unref：不让这个定时器阻止应用退出（托盘常驻场景下由用户显式退出）
  if (typeof timer.unref === 'function') timer.unref()
}

/** 仅供单测 / 诊断：查看当前桶数量 */
export function rateLimitBucketCount(): number {
  return apiBuckets.size + loginBuckets.size
}
