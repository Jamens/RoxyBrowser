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
