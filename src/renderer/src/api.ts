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

/** 会话失效的回调（由 App 注入，用于跳转登录页） */
let onSessionExpired: (() => void) | null = null

/** 注册会话失效回调。避免 api.ts 直接依赖 react-router（会引入循环依赖与耦合）。 */
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn
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
    // 401 且本地确实存着令牌 → 说明这个会话已被服务端吊销
    // （用户点了「退出所有设备」，或令牌过期）。
    // 必须自动清掉并跳登录页：否则页面会拿着一个永久失效的令牌反复报错，
    // 用户既看不懂错误也走不出去，只能手动清 localStorage。
    // 排除「本来就没登录」的情况（登录接口失败也会返回 401）。
    if (res.status === 401 && getToken()) {
      clearToken()
      onSessionExpired?.()
    }
    throw new Error((data as { message?: string }).message || `请求失败 (${res.status})`)
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
