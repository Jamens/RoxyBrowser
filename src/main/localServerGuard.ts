import type { Request, Response, NextFunction } from 'express'
import {
  evaluateLocalRequest,
  type LocalRequestRejection,
  type LocalRequestGuardOptions
} from '../shared/localRequestGuard'

/**
 * 本地 API 请求守卫中间件（Express 层）。
 *
 * 判定逻辑全在 `src/shared/localRequestGuard.ts`（纯函数，可离线单测），
 * 这里只负责取请求头、落响应头、拒绝时返回 403。
 *
 * ## 挂在哪
 *
 * 替换原来的 `app.use(cors())`，且必须在 `express.json()` **之前**——
 * 被拒绝的请求连 body 都不该解析。
 *
 * ## 为什么不是「包一层 cors()」
 *
 * `cors()` 只会决定"回不回落 CORS 头"，而本守卫要的是**服务端主动拒绝**：
 * 恶意网页用 `mode: 'no-cors'` 发出的写请求根本不会触发预检、CORS 拦不住它，
 * 只有服务端直接 403 才有效（详见 `src/shared/localRequestGuard.ts` 文件头）。
 */

export interface LocalServerGuardOptions extends LocalRequestGuardOptions {
  /** 被拒请求的回调（用于打日志，便于排查是谁在打） */
  onReject?: (info: {
    reason: LocalRequestRejection
    method: string
    path: string
    host: string | undefined
    origin: string | undefined
  }) => void
}

/** 请求头可能是 string[]（Node 类型如此），统一取第一个 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * 创建本地 API 请求守卫中间件。
 *
 * @param options nonce 与额外 Origin 白名单；不传 nonce 时 `null` 来源一律拒绝
 */
export function createLocalServerGuard(options: LocalServerGuardOptions = {}) {
  return function localServerGuard(req: Request, res: Response, next: NextFunction): void {
    const decision = evaluateLocalRequest(
      {
        method: req.method,
        host: firstHeader(req.headers.host),
        origin: firstHeader(req.headers.origin),
        nonce: firstHeader(req.headers['x-roxy-nonce'])
      },
      options
    )

    if (!decision.allowed) {
      options.onReject?.({
        reason: decision.reason,
        method: req.method,
        path: req.path,
        host: firstHeader(req.headers.host),
        origin: firstHeader(req.headers.origin)
      })
      // 不落任何 CORS 允许头——回了头浏览器就会把响应交给恶意脚本
      res.status(decision.status).json({ message: '请求来源不被信任，已拒绝' })
      return
    }

    for (const [key, value] of Object.entries(decision.corsHeaders)) {
      res.setHeader(key, value)
    }

    // 预检请求到此为止：渲染层所有请求都带 X-Roxy-Nonce（自定义头），
    // 必然触发一次 OPTIONS 预检，这里直接 204，不进业务路由。
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  }
}
