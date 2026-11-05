import { randomBytes } from 'crypto'

/**
 * 本地 API 请求守卫的一次性 nonce。
 *
 * ## 为什么需要它
 *
 * 应用自己的界面是 `file://` 加载的，Chromium 给这种页面发出的跨源请求
 * Origin 是字符串 `null`；而**不透明源**（sandboxed iframe）同样是 `null`。
 * 只靠 Origin 白名单区分不了「我们自己的页面」和「恶意页面里的 sandboxed iframe」。
 *
 * nonce 就是这个区分依据：主进程每次启动随机生成，只注入应用自己的页面
 * （`window.roxy.apiNonce`），外部站点与第三方 iframe 读不到。
 *
 * ## 为什么放在独立模块
 *
 * 时序要求：**必须在 API 服务创建中间件之前就存在**。
 * 若在 `index.ts` 的 `app.whenReady()` 里生成，而 `bootstrap()`（会启动 HTTP 服务）
 * 排在它前面，服务端拿到的就是空 nonce —— `null` 来源的请求会被全部拒绝，
 * 表现为「应用打开就是白屏 / 所有接口 403」。
 *
 * 模块顶层在 import 时求值，天然早于任何函数调用，因此不存在时序问题。
 * 环境变量那份（`ROXY_API_NONCE`）只是给 preload 传递用，与这里的值同源。
 */
export const API_NONCE = randomBytes(32).toString('hex')
