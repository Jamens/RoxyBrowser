import http from 'http'
import type { DataSource } from 'typeorm'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ProfileEntity, ProxyEntity } from './entities'
import { detectExitIpChange, type ExitIpChange } from '../shared/proxyDrift'

/**
 * 代理检测 / 分配的**服务层**，从 server.ts 抽离。
 *
 * ## 为什么抽出来
 * server.ts 已 4000+ 行，而这段逻辑（检测、匿名度、占用统计、池分配）被
 * 三处路由同时用到：`/proxies/*`（管理端）、`/profiles/:id/switch-line`、
 * v1 自动化 `/v1/proxies/*`。留在 server.ts 里只能靠「导出一个内部函数」
 * 让 routes 反向 import，形成 routes → server → routes 的运行时循环依赖
 * （`AppDataSource` 是 `export let`，模块求值期拿到 undefined）。
 * 抽成独立服务后，routes 直接 import，server 只做装配。
 *
 * **不依赖 AppDataSource**：DataSource 由调用方以参数传入。
 * 这样本模块可以被任意装配顺序引用，也便于测试时注入 mock。
 */

/** 带 HTTP 状态码的业务错误，便于在 handler 中统一转为响应 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function httpGetViaProxy(
  url: string,
  proxy: { type: string; host: string; port: number; username?: string; password?: string },
  timeoutMs = 12000
): Promise<{ body: string; ms: number }> {
  const auth =
    proxy.username && proxy.password ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}` : ''
  const at = auth ? `${auth}@` : ''
  let agent: http.Agent
  if (proxy.type === 'socks5') agent = new SocksProxyAgent(`socks5://${at}${proxy.host}:${proxy.port}`)
  else if (proxy.type === 'https') agent = new HttpsProxyAgent(`http://${at}${proxy.host}:${proxy.port}`)
  else agent = new HttpProxyAgent(`http://${at}${proxy.host}:${proxy.port}`)

  return new Promise((resolve, reject) => {
    const start = Date.now()
    const req = http.request(
      url,
      { agent, timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } } as http.RequestOptions,
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ body, ms: Date.now() - start }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 匿名度判定：请求一个会回显请求头的服务，看代理有没有把客户端真实 IP / 代理标识透传出去。
 * - 出现 X-Forwarded-For / X-Real-IP 等 → transparent（泄露真实 IP）
 * - 仅出现 Via / Proxy-Connection 等 → anonymous（看得出用了代理，但未泄露 IP）
 * - 都没有 → elite（高匿）
 * 该服务不可达时返回 unknown，不影响主检测结果（尽力而为）。
 */
async function detectAnonymity(proxy: ProxyEntity, timeoutMs?: number): Promise<string> {
  try {
    const { body } = await httpGetViaProxy(
      'http://httpbin.org/headers',
      {
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
      },
      timeoutMs
    )
    const data = JSON.parse(body)
    const keys = Object.keys(data.headers || {}).map((k) => k.toLowerCase())
    if (keys.some((k) => ['x-forwarded-for', 'x-real-ip', 'x-client-ip', 'client-ip', 'forwarded'].includes(k))) {
      return 'transparent'
    }
    if (keys.some((k) => ['via', 'proxy-connection', 'proxy-agent'].includes(k))) {
      return 'anonymous'
    }
    return 'elite'
  } catch {
    return 'unknown'
  }
}

export async function checkProxy(
  proxy: ProxyEntity,
  timeoutMs?: number
): Promise<{ ok: boolean; country: string; region: string; city: string; isp: string; exitIp: string; latency: number; anonymity: string }> {
  try {
    const { body, ms } = await httpGetViaProxy(
      'http://ip-api.com/json/?fields=status,country,regionName,city,isp,query',
      {
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
      },
      timeoutMs
    )
    const data = JSON.parse(body)
    if (data.status !== 'success')
      return { ok: false, country: '', region: '', city: '', isp: '', exitIp: '', latency: ms, anonymity: 'unknown' }
    const anonymity = await detectAnonymity(proxy, timeoutMs)
    return {
      ok: true,
      country: data.country || '',
      region: data.regionName || '',
      city: data.city || '',
      isp: data.isp || '',
      exitIp: data.query || '',
      latency: ms,
      anonymity
    }
  } catch {
    return { ok: false, country: '', region: '', city: '', isp: '', exitIp: '', latency: 0, anonymity: 'unknown' }
  }
}

/** 把检测结果写回代理实体（检测端点与巡检共用，保证落库字段完全一致） */
/**
 *
 * @returns 若本次检测发现**出口 IP 漂移**（出口节点换了），返回漂移详情；否则返回 null。
 *   调用方据此写日志 / 发 webhook —— 此前这里直接覆盖 `exitIp` 与 `country`，
 *   漂移被完全吞掉，用户无从知晓环境已与出口失配。详见 `shared/proxyDrift.ts`。
 */
export function applyProxyCheckResult(
  p: ProxyEntity,
  result: Awaited<ReturnType<typeof checkProxy>>
): ExitIpChange | null {
  // 必须在覆盖之前比对——覆盖后旧值就没了
  const change = detectExitIpChange(p, result)
  p.status = result.ok ? 'active' : 'invalid'
  p.latency = result.ok ? result.latency : null
  p.country = result.country
  p.region = result.region
  p.city = result.city
  p.isp = result.isp
  p.exitIp = result.exitIp
  p.anonymity = result.anonymity
  p.lastCheckAt = new Date()
  return change
}

/** 统计每个代理被多少个环境绑定（proxyId 计数） */
export async function computeProxyUsage(ds: DataSource, teamId: number): Promise<Map<number, number>> {
  const profileRepo = ds.getRepository(ProfileEntity)
  const rows = await profileRepo
    .createQueryBuilder('p')
    .select('p.proxyId', 'proxyId')
    .addSelect('COUNT(p.id)', 'cnt')
    .where('p.teamId = :tid', { tid: teamId })
    .andWhere('p.proxyId IS NOT NULL')
    .groupBy('p.proxyId')
    .getRawMany()
  const map = new Map<number, number>()
  for (const r of rows) map.set(Number(r.proxyId), Number(r.cnt))
  return map
}

/** 根据检测状态 / 到期时间 / 被占用情况计算 IP 池视角下的状态 */
export function proxyPoolStatus(
  p: ProxyEntity,
  usageCount: number,
  now: number
): 'available' | 'in-use' | 'expired' | 'invalid' | 'unknown' {
  if (p.status === 'invalid') return 'invalid'
  if (p.expiresAt && new Date(p.expiresAt).getTime() < now) return 'expired'
  if (usageCount > 0) return 'in-use'
  return 'available'
}

/**
 * 从 IP 池分配代理（供 /api/proxies/allocate 与 v1 共用，保证分配口径唯一）。
 *
 * excludeProxyId：切换线路场景排除当前绑定的代理，保证换到的是「另一条线路」。
 */
export async function allocateProxy(
  ds: DataSource,
  teamId: number,
  opts: { profileId?: number | null; country?: string; region?: string; excludeProxyId?: number | null }
): Promise<{ proxy: ProxyEntity; profileId: number | null; reused: boolean; poolStatus: 'available' | 'in-use' }> {
  const repo = ds.getRepository(ProxyEntity)
  const now = Date.now()
  const usage = await computeProxyUsage(ds, teamId)
  const all = await repo.find({ where: { teamId } })
  // 候选 = 未失效且未过期的代理（active 或 unknown 均可分配，与 proxyPoolStatus 的「available」定义一致）
  let candidates = all.filter((p) => p.status !== 'invalid' && (!p.expiresAt || new Date(p.expiresAt).getTime() > now))
  if (opts.excludeProxyId) {
    candidates = candidates.filter((p) => p.id !== opts.excludeProxyId)
  }
  if (opts.country) {
    const c = String(opts.country).toLowerCase()
    candidates = candidates.filter((p) => p.country && p.country.toLowerCase().includes(c))
  }
  if (opts.region) {
    const r = String(opts.region).toLowerCase()
    candidates = candidates.filter((p) => p.region && p.region.toLowerCase().includes(r))
  }
  if (!candidates.length)
    throw new ApiError(
      409,
      (opts.excludeProxyId ? 'IP 池中没有可切换的其他线路' : 'IP 池中无可用代理') + (opts.country ? `（地区：${opts.country}）` : '')
    )
  // 优先分配未被任何环境占用的代理
  const free = candidates.filter((p) => (usage.get(p.id) || 0) === 0)
  const reused = free.length === 0
  const chosen = (free.length ? free : candidates)[0]
  let profileId: number | null = null
  let poolStatus: 'available' | 'in-use' = 'available'
  if (opts.profileId) {
    const profileRepo = ds.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number(opts.profileId), teamId } })
    if (!profile) throw new ApiError(404, '环境不存在')
    profile.proxyId = chosen.id
    await profileRepo.save(profile)
    profileId = profile.id
    poolStatus = 'in-use'
  }
  return { proxy: chosen, profileId, reused, poolStatus }
}

/**
 * 解析一行代理配置，支持：
 *   socks5://user:pass@1.2.3.4:1080
 *   http://1.2.3.4:8080
 *   1.2.3.4:8080:user:pass
 *   1.2.3.4:8080
 *   1.2.3.4,8080,user,pass        (CSV)
 *   1.2.3.4,8080,user,pass,socks5 (CSV 带协议)
 */
export function parseProxyLine(line: string): { type: string; host: string; port: number; username: string; password: string } | null {
  const raw = line.trim()
  if (!raw) return null

  // http://user:pass@host:port
  if (/^[a-z]+:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      const type = (u.protocol.replace(':', '') || 'http').toLowerCase()
      return {
        type: type === 'socks' ? 'socks5' : type === 'http' ? 'http' : type === 'https' ? 'https' : 'http',
        host: u.hostname,
        port: Number(u.port) || (type === 'https' ? 443 : type === 'socks5' ? 1080 : 80),
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || '')
      }
    } catch {
      return null
    }
  }

  // CSV：host,port,user,pass[,type]
  if (raw.includes(',')) {
    const parts = raw.split(',').map((s) => s.trim())
    const [host, port, username = '', password = '', type = 'http'] = parts
    if (!host || !Number(port)) return null
    return { type: type.toLowerCase() === 'socks5' ? 'socks5' : type.toLowerCase() === 'https' ? 'https' : 'http', host, port: Number(port), username, password }
  }

  const parts = raw.split(':').map((s) => s.trim())

  // 与 /proxies/export 对应的格式：type:host:port:username:password
  const KNOWN_TYPES = ['http', 'https', 'socks5', 'socks4', 'socks']
  if (parts.length >= 3 && KNOWN_TYPES.includes(parts[0].toLowerCase()) && Number(parts[2])) {
    const t = parts[0].toLowerCase()
    return {
      type: t === 'socks' || t === 'socks4' ? 'socks5' : t,
      host: parts[1],
      port: Number(parts[2]),
      username: parts[3] || '',
      password: parts[4] || ''
    }
  }

  // 冒号分隔：host:port[:user[:pass]]
  if (parts.length >= 2 && parts[0] && Number(parts[1])) {
    return {
      type: 'http',
      host: parts[0],
      port: Number(parts[1]),
      username: parts[2] || '',
      password: parts[3] || ''
    }
  }
  return null
}