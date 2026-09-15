/**
 * 自动化 API（v1）审计：把「一次 HTTP 调用」推导成操作日志的 action / detail。
 *
 * 独立成纯函数模块（不依赖 express / DB / TypeORM），与 `webhook.ts`、`logExport.ts`
 * 同构，便于离线单测——action 名决定日志语义与「是否敏感」的判定，推导错了
 * 会把删除 / 导出这类高危动作记成普通动作，所以必须可测。
 */

/** 资源名单数形式：/profiles → profile */
const API_RES_SINGULAR: Record<string, string> = {
  profiles: 'profile',
  proxies: 'proxy',
  accounts: 'account',
  cookies: 'cookie',
  rpa: 'rpa',
  fingerprint: 'fingerprint'
}

/** 末段即动作的（/profiles/1/open → open）；其余按 HTTP 方法推导 */
const API_SUB_VERB: Record<string, string> = {
  open: 'open',
  close: 'close',
  allocate: 'allocate',
  check: 'check',
  run: 'run',
  import: 'import',
  export: 'export',
  apply: 'apply',
  random: 'random'
}

/**
 * 推导操作日志 action，形如 `api_open_profile`。
 * 无法识别（空路径）时返回空串，调用方据此跳过记录。
 *
 * 优先级：末段命中「动作词」> HTTP 方法推导。
 * 因为 `/profiles/1/open` 的语义是「开窗」而不是「创建」。
 */
export function apiActionName(method: string, path: string): string {
  const seg = path.split('/').filter(Boolean)
  if (!seg.length) return ''
  const resource = API_RES_SINGULAR[seg[0]] || seg[0]
  const last = seg[seg.length - 1]
  const verb =
    API_SUB_VERB[last] ||
    (method === 'POST' ? 'create' : method === 'PUT' ? 'update' : method === 'DELETE' ? 'delete' : 'read')
  return `api_${verb}_${resource}`
}

/**
 * 是否需要审计留痕。
 * 只读请求不记（与界面操作一致，避免日志被列表查询刷屏）；
 * 但 `/export` 虽是 GET，属数据外泄，必须记录。
 */
export function apiShouldAudit(method: string, path: string): boolean {
  if (method === 'GET') return /\/export$/.test(path)
  return true
}

/**
 * 生成日志 detail：只保留「方法 + 路径 + 资源 id + 名称」。
 * **绝不记录 token / password / cookie value 等敏感字段**——审计日志本身
 * 会展示给团队成员看，把凭据写进去等于二次泄露。
 */
export function apiAuditDetail(method: string, path: string, body?: unknown): string {
  const id = path.split('/').filter(Boolean).find((s) => /^\d+$/.test(s))
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const name = typeof b.name === 'string' && b.name ? `「${b.name}」` : ''
  // 各段之间显式留空格：否则会连成 `/profiles「XXX」`，日志读起来很别扭
  return `${method} /api/v1${path}${id ? ` #${id}` : ''}${name ? ` ${name}` : ''}`
}
