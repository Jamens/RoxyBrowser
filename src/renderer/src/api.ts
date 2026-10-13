const API_BASE = window.roxy?.apiBase || 'http://127.0.0.1:39100'

export function getToken(): string {
  return localStorage.getItem('roxy_token') || ''
}
export function setToken(token: string) {
  localStorage.setItem('roxy_token', token)
}
export function clearToken() {
  localStorage.removeItem('roxy_token')
}

/**
 * 会话失效的回调（由 App 注入，用于跳转登录页）。
 *
 * 带上原因：以前回调无参，跳登录页时用户只看到「莫名其妙回到登录页」，
 * 没有任何线索区分是「令牌被撤销」「令牌过期」还是「服务端没认出这个令牌」。
 * 排查这类问题全靠服务端日志猜——本机开发时能看得到，线上用户报障就彻底盲了。
 */
let onSessionExpired: ((reason: string) => void) | null = null

/** 注册会话失效回调。避免 api.ts 直接依赖 react-router（会引入循环依赖与耦合）。 */
export function setSessionExpiredHandler(fn: ((reason: string) => void) | null) {
  onSessionExpired = fn
}

/**
 * 这些接口返回 401 属于**业务预期**，不能触发「会话失效」跳转。
 *
 * - 登录：密码错误返回 400/429，但账号不存在等分支会返回 401
 * - 注册 / 切换团队 / 2FA 中间态：401 表示「这一步没过」，不是「会话作废」
 *
 * 漏掉任何一个，用户在这些页面上都会被莫名踢回登录页——那才是真的「点着点着就退出」。
 */
const NO_SESSION_EXPIRED_PATHS = ['/api/auth/login', '/api/auth/register', '/api/auth/switch-team', '/api/auth/2fa/']

/**
 * 带 HTTP 状态码的接口错误。
 *
 * 为什么要自定义而不是直接 throw new Error：调用方需要**区分错误类型**才能
 * 决定行为。真实教训——Layout 的 `/api/auth/me` 之前写成
 * `.catch(() => { clearToken(); navigate('/login') })`，结果限流（429）时
 * 也被当成「认证失败」踢出登录。用户表现是「频繁点菜单 → 突然退出登录」，
 * 而 429 完全是前端自己请求太密导致的，与会话无关。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  /** Retry-After 头给出的建议等待秒数（限流时才有） */
  readonly retryAfterSec?: number

  constructor(message: string, status: number, code?: string, retryAfterSec?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }

  /** 会话已失效（服务端明确拒绝当前令牌）——只有这种才该清令牌跳登录页 */
  get isSessionExpired(): boolean {
    return this.status === 401
  }

  /** 被限流：临时故障，等一会儿重试即可，不该影响登录态 */
  get isRateLimited(): boolean {
    return this.status === 429
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 401 且本地确实存着令牌 → 说明这个会话已被服务端拒绝（吊销 / 过期 / 令牌异常）。
    // 必须自动清掉并跳登录页：否则页面会拿着一个永久失效的令牌反复报错，
    // 用户既看不懂错误也走不出去，只能手动清 localStorage。
    // 排除「本来就没登录」的情况（见下方 NO_SESSION_EXPIRED_PATHS 说明）。
    if (res.status === 401 && getToken()) {
      // 排除「本来就没登录 / 这一步本就不该有会话」的接口：
      // 登录失败返回 401 时若触发跳转，用户会陷入「登录→被踢回登录页」的死循环。
      const isExpected401 = NO_SESSION_EXPIRED_PATHS.some((p) => path.startsWith(p))
      if (!isExpected401) {
        const reason = (data as { message?: string })?.message || '登录已失效，请重新登录'
        // 打一条日志：用户报「莫名退出登录」时，主进程日志里能看到是哪个接口
        // 触发的。没有这条就只能靠猜——401 可能来自任意一个接口。
        console.warn('[api] 会话失效，跳转登录页:', reason, '←', method, path)
        clearToken()
        onSessionExpired?.(reason)
      }
    }
    throw new ApiError(
      (data as { message?: string }).message || `请求失败 (${res.status})`,
      res.status,
      (data as { code?: string })?.code,
      // Retry-After 头告诉客户端该等多久，限流时用它决定退避时长
      Number(res.headers.get('Retry-After')) || undefined
    )
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path)
}

export { API_BASE }
