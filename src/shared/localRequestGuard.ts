/**
 * 本地 API 请求守卫 —— 纯判定逻辑（无 Electron / Express 依赖，可离线单测）。
 *
 * ## 要解决什么
 *
 * 本地 API 只监听 `127.0.0.1`，但**同机任何网页都能对它发请求**：
 * `fetch('http://127.0.0.1:39100/api/...')`。这层风险此前只有 CORS 挡着，
 * 而 CORS 的语义被普遍误解——见 `src/main/rateLimiter.ts` 顶部的风险评估：
 *
 * > 无 CORS 阻止**请求发出**（只阻止读响应）。
 *
 * 也就是说，`cors()` 全开（`*`）时，恶意网页可以：
 * - `fetch(url, { mode: 'no-cors' })` 把写操作真的发出去（副作用成立）；
 * - 读回任何接口的响应（因为 `Access-Control-Allow-Origin: *`）。
 *
 * 所以**必须由服务端主动拒绝**，而不是指望浏览器不把它发出去。
 *
 * ## 三层判定
 *
 * 1. **Host 必须是回环地址** —— 挡 DNS rebinding。
 *    攻击者把 `evil.com` 解析到 `127.0.0.1`，浏览器访问 `http://evil.com:39100`，
 *    Host 头是 `evil.com`。只认 `127.0.0.1` / `localhost` / `::1` 三者（**精确相等**，
 *    不是后缀匹配，否则 `127.0.0.1.evil.com` 会蒙混过关）。
 *
 * 2. **Origin 必须在白名单** —— 挡网页侧的跨源请求。
 *    白名单 = 回环来源（`http://localhost:<port>` / `http://127.0.0.1:<port>`，
 *    对应 dev server 与应用自身的 `http://127.0.0.1:<port>/accept-invite` 页面）
 *    + 显式额外白名单 + 一次性 nonce 校验通过的 `null`。
 *
 * 3. **一次性 nonce** —— 补 `Origin: null` 这个洞。
 *    `file://` 页面在 Chromium 里发出的跨源请求 Origin 是字符串 `null`，
 *    而**不透明源**（sandboxed iframe）同样是 `null`。只靠 Origin 白名单区分不了二者。
 *    nonce 由主进程每次启动随机生成，只注入应用自己的页面
 *    （`window.roxy.apiNonce`，外部站点读不到），Origin 为 `null` 时必须带上。
 *
 * ## 为什么「无 Origin 一律放行」是安全的
 *
 * 浏览器发起的**跨源**请求一律带 Origin——包括 `mode: 'no-cors'` 的写操作
 * 与 `<form method=post>` 提交。唯一不带 Origin 的是 `<img>` / `<script>` / `<link>`
 * 这类**无源（no-cors）GET**，它们无法带自定义头、也无法构造 JSON body，
 * 且响应读不出来。因此：
 *
 * - 网页侧的**写操作**必然带 Origin → 被第 2 条挡住；
 * - 网页侧能"无 Origin"到达的只有 GET，响应读不出来，且需要鉴权的接口会 401；
 * - 无 Origin 的写操作只可能来自**本地进程**（curl / Python 脚本 / 第三方自动化工具），
 *   而本项目的本地 API 本来就是对它们开放的（见 FEATURES.md 的自动化 API 章节），
 *   挡掉反而是自断功能。
 *
 * ## 附带产出
 *
 * 放行时回显具体 Origin 并带上 `Access-Control-Allow-Private-Network: true`
 * —— 后者是 Chromium 142+ 强制 Local Network Access 的配套头，
 * 缺失时自家前端在 LNA 生效后会多出无谓的权限提示。
 */

/** 允许的 Host / Origin 主机名（精确匹配，不做后缀匹配） */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/** 守卫判定失败的原因（会写进日志，便于排查是谁在打） */
export type LocalRequestRejection = 'bad-host' | 'bad-origin' | 'bad-nonce'

export interface LocalRequestContext {
  /** HTTP 方法 */
  method: string
  /** Host 头 */
  host: string | undefined
  /** Origin 头（无 Origin = 非浏览器客户端） */
  origin: string | undefined
  /** `X-Roxy-Nonce` 头 */
  nonce: string | undefined
}

/**
 * 判定结果。
 *
 * 用**可辨识联合**而不是单一 interface：调用方在 `allowed === false` 的分支里
 * 应当能直接拿到 `reason: LocalRequestRejection`（不含 'ok'），
 * 否则每次都要自己再判一次 `reason !== 'ok'`，容易漏。
 */
export type LocalRequestDecision =
  | {
      /** 是否放行 */
      allowed: true
      /** HTTP 状态码 */
      status: 200
      /** 放行原因 */
      reason: 'ok'
      /** 需要写进响应的 CORS 头（**拒绝时恒为空**——回了头等于放行） */
      corsHeaders: Record<string, string>
    }
  | {
      /** 是否放行 */
      allowed: false
      /** HTTP 状态码 */
      status: 403
      /** 拒绝原因 */
      reason: LocalRequestRejection
      /** 恒为空对象——拒绝时不得回任何 CORS 允许头 */
      corsHeaders: Record<string, string>
    }

export interface LocalRequestGuardOptions {
  /**
   * 进程内一次性 nonce。Origin 为 `null` 时必须匹配。
   * 未配置（空串）时 `null` 来源一律拒绝——宁可拒绝也不能放行。
   */
  nonce?: string
  /** 额外允许的 Origin（精确匹配，大小写敏感——scheme+host+port 全等） */
  extraOrigins?: string[]
}

/** 去掉 IPv6 的方括号并转小写，便于统一比较 */
function normalizeHostname(hostname: string): string {
  let s = hostname.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s
}

/**
 * 从 Host 头取出主机名。
 *
 * 处理三种写法：
 * - `127.0.0.1:39100` → `127.0.0.1`
 * - `localhost` → `localhost`
 * - `[::1]:39100` → `::1`
 *
 * 解析不出来（缺 Host、格式非法）返回 null——一律按拒绝处理。
 */
export function parseHostHostname(host: string | undefined): string | null {
  if (!host) return null
  const trimmed = host.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return null
    return normalizeHostname(trimmed.slice(1, end))
  }
  const colon = trimmed.indexOf(':')
  const hostname = colon >= 0 ? trimmed.slice(0, colon) : trimmed
  return hostname ? normalizeHostname(hostname) : null
}

/** Host 是否为回环地址（精确匹配） */
export function isLoopbackHost(host: string | undefined): boolean {
  const hostname = parseHostHostname(host)
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname)
}

/**
 * Origin 是否来自本机。
 *
 * 放行 `http://localhost:<port>` / `http://127.0.0.1:<port>` / `https://` 同理，
 * 对应两种合法场景：dev server（vite）、应用自身的接受邀请页
 * （`http://127.0.0.1:<port>/accept-invite`，在系统浏览器里打开）。
 *
 * 端口不限：本机页面发起请求本来就不构成越权，而真正的边界是
 * "外部站点不能冒充本机来源"——那些站点的 Origin 是 `https://evil.com`，进不来。
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(url.hostname))
}

/**
 * 构造放行时要回写的 CORS 头。
 *
 * 注意回显**具体 Origin** 而不是 `*`：
 * - `*` 等于对所有来源开放读响应，与本守卫的目的直接冲突；
 * - 回显还能顺带把 `Vary: Origin` 带上，避免代理/缓存串味。
 */
export function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Roxy-Nonce',
    // Chromium 142+ 强制 Local Network Access 的配套头，缺了自家前端会多出权限提示
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  }
}

/**
 * 比较 nonce。
 *
 * **故意不用 timing-safe 比较**：nonce 是每次启动重新生成的 256 位随机值，
 * 攻击者无法靠时序侧信道在有意义的次数内猜出；而 `crypto.timingSafeEqual`
 * 会让本模块依赖 `node:crypto`，进而不能在渲染层被 import。
 */
function nonceMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false
  if (expected.length !== actual.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i)
  return diff === 0
}

/**
 * 核心判定：这条本地 API 请求该不该放行。
 *
 * 纯函数，无副作用，可离线单测（见 `tests/localRequestGuard.test.cjs`）。
 */
export function evaluateLocalRequest(
  ctx: LocalRequestContext,
  options: LocalRequestGuardOptions = {}
): LocalRequestDecision {
  const reject = (reason: LocalRequestRejection): LocalRequestDecision => ({
    allowed: false,
    status: 403,
    reason,
    // 拒绝时**绝不能**回 CORS 允许头——回了等于放行
    corsHeaders: {}
  })

  // 1) Host 必须是回环：挡 DNS rebinding
  if (!isLoopbackHost(ctx.host)) return reject('bad-host')

  const origin = ctx.origin?.trim()

  // 2) 无 Origin = 非浏览器客户端（curl / Node / 第三方自动化脚本）→ 放行。
  //    浏览器发起的跨源请求一律带 Origin，详见文件头「为什么无 Origin 一律放行是安全的」。
  if (!origin) return { allowed: true, status: 200, reason: 'ok', corsHeaders: {} }

  // 3) Origin 为 'null'（file:// 页面 / 不透明源）→ 必须带正确 nonce
  if (origin === 'null') {
    if (!nonceMatches(options.nonce, ctx.nonce)) return reject('bad-nonce')
    return { allowed: true, status: 200, reason: 'ok', corsHeaders: buildCorsHeaders(origin) }
  }

  // 4) 回环来源 + 显式白名单
  const extra = options.extraOrigins ?? []
  if (!isLoopbackOrigin(origin) && !extra.includes(origin)) return reject('bad-origin')

  return { allowed: true, status: 200, reason: 'ok', corsHeaders: buildCorsHeaders(origin) }
}
