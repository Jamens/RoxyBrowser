import 'reflect-metadata'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import cors from 'cors'
import http from 'http'
import crypto from 'crypto'
import { homedir } from 'os'
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync, statSync } from 'fs'
import { join, sep } from 'path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import { DataSource, In } from 'typeorm'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AddressInfo } from 'net'
import { app } from 'electron'

import {
  UserEntity,
  TeamEntity,
  TeamMemberEntity,
  GroupEntity,
  ProxyEntity,
  ProfileEntity,
  AccountEntity,
  CookieEntity,
  OperationLogEntity,
  ApiTokenEntity,
  AppSettingsEntity,
  ExtensionEntity,
  RpaScriptEntity
} from './entities'
import { randomFingerprint, defaultFingerprint, listFingerprintPresets } from '../shared/fingerprint'
import { normalizeCountry } from '../shared/countries'
import { normalizeLocale } from '../shared/locales'
import type { Fingerprint, AppSettings, OSKind, RpaStep } from '../shared/types'
import { DEFAULT_START_URL, DEFAULT_SETTINGS, normalizeSearchEngine } from '../shared/types'
import { getSystemStats } from './systemStats'

// ---------- 配置 ----------
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '1234560',
  database: process.env.DB_NAME || 'roxy_browser'
}
const JWT_SECRET = process.env.JWT_SECRET || 'roxy-clone-secret-9f8e7d6c'
const START_PORT = Number(process.env.API_PORT || 39100)

export let AppDataSource: DataSource
export let apiBase = ''

// 浏览器窗口桥（由 main 注入）
export interface BrowserBridge {
  openWindow(profileId: number): Promise<void>
  closeWindow(profileId: number): Promise<void>
}
let browserBridge: BrowserBridge | null = null
export function setBrowserBridge(b: BrowserBridge) {
  browserBridge = b
}

// 窗口同步开关处理（由 main 注入）
type SyncOptions = { enabled: boolean; ids?: number[] }
let syncToggle: ((opts: SyncOptions) => void) | null = null
export function setSyncToggle(fn: (opts: SyncOptions) => void) {
  syncToggle = fn
}
let windowsProvider: (() => { id: number; title: string }[]) | null = null
export function setWindowsProvider(fn: () => { id: number; title: string }[]) {
  windowsProvider = fn
}

// 账户级隔离：普通用户（member）只看到自己 ownerId 的数据；owner/admin 看全部（管理员视角）。
// 团队管理类接口（成员/团队信息/操作日志/设置）保持团队维度，不套用此隔离。
function isAdminRole(role?: string): boolean {
  return role === 'owner' || role === 'admin'
}
function ownerScope(req: AuthedRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (isAdminRole(req.role)) return { ...extra }
  return { ownerId: req.uid, ...extra }
}
// 给 QueryBuilder 追加账户隔离条件（admin 不加）
function ownerAndWhere(qb: { andWhere: (sql: string, params?: Record<string, unknown>) => unknown }, req: AuthedRequest, alias = 'p') {
  if (!isAdminRole(req.role)) qb.andWhere(`${alias}.ownerId = :oid`, { oid: req.uid })
}

// ---------- 工具 ----------
type AuthedRequest = Request & { uid?: number; tid?: number; username?: string; role?: string }

function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '')
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { uid: number; tid: number; username: string; role: string }
    req.uid = payload.uid
    req.tid = payload.tid
    req.username = payload.username
    req.role = payload.role
    next()
  } catch {
    res.status(401).json({ message: '未登录或登录已过期' })
  }
}

function tokenAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '')
  if (!token) return res.status(401).json({ code: 401, message: 'missing api token' })
  const repo = AppDataSource.getRepository(ApiTokenEntity)
  repo
    .findOne({ where: { token } })
    .then((t) => {
      if (!t) return res.status(401).json({ code: 401, message: 'invalid api token' })
      ;(req as AuthedRequest).tid = t.teamId
      ;(req as AuthedRequest).role = 'api'
      next()
    })
    .catch(() => res.status(500).json({ code: 500, message: 'db error' }))
}

/**
 * Express 4 不会捕获 async handler 抛出的异常，会导致请求挂起。
 * 统一包裹所有路由，异常一律转交 next() 由错误中间件返回 500。
 */
function wrapAsync(router: express.Router): express.Router {
  for (const layer of (router as unknown as { stack: Array<{ route?: { stack: Array<{ handle: (...a: unknown[]) => unknown }> } }> }).stack) {
    if (layer.route) {
      for (const routeLayer of layer.route.stack) {
        const original = routeLayer.handle
        routeLayer.handle = ((req: Request, res: Response, next: NextFunction) => {
          Promise.resolve(original(req, res, next)).catch(next)
        }) as unknown as typeof routeLayer.handle
      }
    }
  }
  return router
}

async function writeLog(req: AuthedRequest, action: string, detail: unknown) {
  if (!req.tid || !req.uid) return
  const repo = AppDataSource.getRepository(OperationLogEntity)
  await repo.save(
    repo.create({
      teamId: req.tid,
      userId: req.uid,
      username: req.username || 'api',
      action,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail)
    })
  )
}

function mapProfile(p: ProfileEntity, groupName?: string | null, proxy?: ProxyEntity | null) {
  return {
    id: p.id,
    teamId: p.teamId,
    groupId: p.groupId,
    groupName: groupName || null,
    name: p.name,
    seq: p.seq,
    remark: p.remark,
    platform: p.platform,
    startUrl: p.startUrl,
    proxyId: p.proxyId,
    proxyName: proxy?.name || null,
    proxyInfo: proxy
      ? { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }
      : null,
    fingerprint: p.fingerprint,
    isTemplate: p.isTemplate,
    status: p.status,
    lastOpenedAt: p.lastOpenedAt,
    extensions: p.extensions,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

// ---------- 代理检测 ----------
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

async function checkProxy(
  proxy: ProxyEntity,
  timeoutMs?: number
): Promise<{ ok: boolean; country: string; region: string; city: string; isp: string; exitIp: string; latency: number }> {
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
      return { ok: false, country: '', region: '', city: '', isp: '', exitIp: '', latency: ms }
    return {
      ok: true,
      country: data.country || '',
      region: data.regionName || '',
      city: data.city || '',
      isp: data.isp || '',
      exitIp: data.query || '',
      latency: ms
    }
  } catch {
    return { ok: false, country: '', region: '', city: '', isp: '', exitIp: '', latency: 0 }
  }
}

// 读取合并后的全局设置（兜底默认值）
async function getSettings(): Promise<AppSettings> {
  const repo = AppDataSource.getRepository(AppSettingsEntity)
  const row = await repo.findOne({ where: { key: 'global' } })
  return { ...DEFAULT_SETTINGS, ...((row?.settings as Partial<AppSettings>) || {}) }
}

// 代理定时巡检调度器
let proxyCheckTimer: ReturnType<typeof setInterval> | null = null
async function runProxyCheckAll(): Promise<void> {
  const repo = AppDataSource.getRepository(ProxyEntity)
  const list = await repo.find()
  if (list.length === 0) return
  const settings = await getSettings()
  const timeout = (settings.proxyCheckTimeout as number) * 1000
  for (const p of list) {
    try {
      const result = await checkProxy(p, timeout)
      p.status = result.ok ? 'active' : 'invalid'
      p.latency = result.ok ? result.latency : null
      p.country = result.country
      p.region = result.region
      p.city = result.city
      p.isp = result.isp
      p.exitIp = result.exitIp
      p.lastCheckAt = new Date()
      await repo.save(p)
    } catch (e) {
      console.error(`[roxy] 巡检代理 #${p.id} 失败:`, (e as Error).message)
    }
  }
  console.log(`[roxy] 定时巡检完成，共检测 ${list.length} 个代理`)
}

async function startProxyCheckScheduler(): Promise<void> {
  if (proxyCheckTimer) {
    clearInterval(proxyCheckTimer)
    proxyCheckTimer = null
  }
  const settings = await getSettings()
  const interval = settings.proxyCheckInterval as number
  if (!interval || interval <= 0) {
    console.log('[roxy] 代理定时巡检未启用（间隔为 0）')
    return
  }
  proxyCheckTimer = setInterval(() => {
    runProxyCheckAll().catch((e) => console.error('[roxy] 定时巡检异常:', e))
  }, interval * 60 * 1000)
  console.log(`[roxy] 代理定时巡检已启动，间隔 ${interval} 分钟`)
}

// 定时执行间隔归一化：非法 / 过小一律回到默认 30 分钟（>=1 才有意义）
function normalizeScheduleInterval(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 30
  return Math.max(1, Math.min(525600, Math.round(n)))
}

// ===== RPA 定时执行调度器（对标「定时任务到点自动开工」）=====
// 每 30s 扫一次开启了定时的脚本；到点且目标环境处于运行态才执行。
// 环境未运行 → 跳过本轮（写日志），绝不自动开窗——自动拉起窗口会绕过
// 用户对环境的显式控制，也可能把带代理问题的环境悄悄暴露出来。
const RPA_SCAN_MS = 30 * 1000
const rpaRunningScheduled = new Set<number>() // 正在执行的脚本 id，防止长脚本被重复触发

async function runRpaScheduler(): Promise<void> {
  const repo = AppDataSource.getRepository(RpaScriptEntity)
  const scripts = await repo.find({ where: { scheduleEnabled: true } })
  if (scripts.length === 0) return
  const runningIds = (await import('./browserManager')).getRunningWindowIds()
  const now = Date.now()
  for (const s of scripts) {
    if (rpaRunningScheduled.has(s.id)) continue
    if (!s.scheduleProfileId) continue
    const last = s.lastScheduledRunAt ? new Date(s.lastScheduledRunAt).getTime() : 0
    const due = now - last >= s.scheduleIntervalMin * 60 * 1000
    if (!due) continue
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({
      where: { id: s.scheduleProfileId }
    })
    if (!profile) continue
    // 先落 lastScheduledRunAt，防止本轮执行期间被下一轮扫描再次判定为到期
    s.lastScheduledRunAt = new Date()
    await repo.save(s)
    if (!runningIds.includes(s.scheduleProfileId)) {
      await saveSchedulerLog(s.teamId, s.ownerId, 'rpa_schedule_skip', `定时执行「${s.name}」跳过：环境「${profile.name}」未运行`)
      continue
    }
    rpaRunningScheduled.add(s.id)
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await (await import('./browserManager')).replayRpaScript(s.scheduleProfileId!, s.steps as unknown as RpaStep[])
      } catch (e) {
        err = (e as Error).message
      } finally {
        rpaRunningScheduled.delete(s.id)
      }
      await saveSchedulerLog(
        s.teamId,
        s.ownerId,
        err ? 'rpa_schedule_fail' : 'rpa_schedule_run',
        err
          ? `定时执行「${s.name}」失败（环境「${profile.name}」）：${err}`
          : `定时执行「${s.name}」完成（环境「${profile.name}」，${executed} 步）`
      )
    })()
  }
}

// 调度器写日志：没有请求上下文，直接落库（口径与 writeLog 一致）
async function saveSchedulerLog(teamId: number, userId: number | null, action: string, detail: string) {
  try {
    const repo = AppDataSource.getRepository(OperationLogEntity)
    await repo.save(repo.create({ teamId, userId: userId ?? 0, username: 'scheduler', action, detail }))
  } catch {
    /* 日志失败不影响调度 */
  }
}

let rpaScheduleTimer: ReturnType<typeof setInterval> | null = null
function startRpaScheduleScheduler(): void {
  if (rpaScheduleTimer) return
  rpaScheduleTimer = setInterval(() => {
    runRpaScheduler().catch((e) => console.error('[roxy] RPA 定时调度异常:', e))
  }, RPA_SCAN_MS)
  rpaScheduleTimer.unref?.()
  console.log(`[roxy] RPA 定时执行调度器已启动（每 ${RPA_SCAN_MS / 1000}s 扫描一次）`)
}

// 统计每个代理被多少个环境绑定（proxyId 计数）
async function computeProxyUsage(teamId: number): Promise<Map<number, number>> {
  const profileRepo = AppDataSource.getRepository(ProfileEntity)
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

// 根据检测状态 / 到期时间 / 被占用情况计算 IP 池视角下的状态
function proxyPoolStatus(
  p: ProxyEntity,
  usageCount: number,
  now: number
): 'available' | 'in-use' | 'expired' | 'invalid' | 'unknown' {
  if (p.status === 'invalid') return 'invalid'
  if (p.expiresAt && new Date(p.expiresAt).getTime() < now) return 'expired'
  if (usageCount > 0) return 'in-use'
  return 'available'
}

// 带 HTTP 状态码的业务错误，便于在 handler 中统一转为响应
class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// 从 IP 池分配代理（供 /api/proxies/allocate 与 v1 共用，保证分配口径唯一）
async function allocateProxy(
  teamId: number,
  opts: { profileId?: number | null; country?: string; region?: string }
): Promise<{ proxy: ProxyEntity; profileId: number | null; reused: boolean; poolStatus: 'available' | 'in-use' }> {
  const repo = AppDataSource.getRepository(ProxyEntity)
  const now = Date.now()
  const usage = await computeProxyUsage(teamId)
  const all = await repo.find({ where: { teamId } })
  // 候选 = 未失效且未过期的代理（active 或 unknown 均可分配，与 proxyPoolStatus 的「available」定义一致）
  let candidates = all.filter((p) => p.status !== 'invalid' && (!p.expiresAt || new Date(p.expiresAt).getTime() > now))
  if (opts.country) {
    const c = String(opts.country).toLowerCase()
    candidates = candidates.filter((p) => p.country && p.country.toLowerCase().includes(c))
  }
  if (opts.region) {
    const r = String(opts.region).toLowerCase()
    candidates = candidates.filter((p) => p.region && p.region.toLowerCase().includes(r))
  }
  if (!candidates.length)
    throw new ApiError(409, 'IP 池中无可用代理' + (opts.country ? `（地区：${opts.country}）` : ''))
  // 优先分配未被任何环境占用的代理
  const free = candidates.filter((p) => (usage.get(p.id) || 0) === 0)
  const reused = free.length === 0
  const chosen = (free.length ? free : candidates)[0]
  let profileId: number | null = null
  let poolStatus: 'available' | 'in-use' = 'available'
  if (opts.profileId) {
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
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
function parseProxyLine(line: string): { type: string; host: string; port: number; username: string; password: string } | null {
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

// ---------- 扩展（浏览器插件）存储辅助 ----------
// 扩展以「解压目录」形式存放在 userData/extensions/<id>/（Electron 仅支持解压目录，不支持 .crx）
function extUserDir(): string {
  return join(app.getPath('userData'), 'extensions')
}
function readExtensionManifest(dir: string): Record<string, unknown> | null {
  const mPath = join(dir, 'manifest.json')
  if (!existsSync(mPath)) return null
  try {
    return JSON.parse(readFileSync(mPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
function pickExtensionIcon(manifest: Record<string, unknown> | null): string {
  const icons = (manifest?.icons ?? {}) as Record<string, string>
  if (!icons || Object.keys(icons).length === 0) return ''
  const key = ['128', '96', '64', '48', '32', '16'].find((k) => icons[k]) || Object.keys(icons)[0]
  return icons[key] ? String(icons[key]).replace(/^\//, '') : ''
}
function normalizeRelPath(p: string): string {
  return p.split('/').join(sep)
}

// ---------- API 路由 ----------
function buildApiRouter(): express.Router {
  const router = express.Router()

  // ===== 认证 =====
  router.post('/auth/register', async (req: Request, res: Response) => {
    const { username, password, nickname, teamName } = req.body || {}
    if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' })
    const userRepo = AppDataSource.getRepository(UserEntity)
    const exists = await userRepo.findOne({ where: { username } })
    if (exists) return res.status(400).json({ message: '用户名已存在' })
    const user = await userRepo.save(
      userRepo.create({ username, passwordHash: await bcrypt.hash(password, 10), nickname: nickname || username })
    )
    // 每个注册用户创建自己的团队空间
    const teamRepo = AppDataSource.getRepository(TeamEntity)
    const team = await teamRepo.save(teamRepo.create({ name: teamName || `${username} 的团队` }))
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    await memberRepo.save(memberRepo.create({ teamId: team.id, userId: user.id, role: 'owner' }))
    // 默认分组
    const groupRepo = AppDataSource.getRepository(GroupEntity)
    await groupRepo.save(groupRepo.create({ teamId: team.id, name: 'Default', sort: 0 }))
    const token = jwt.sign({ uid: user.id, tid: team.id, username, role: 'owner' }, JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, user: { id: user.id, username, nickname: user.nickname, role: 'owner' } })
  })

  router.post('/auth/login', async (req: Request, res: Response) => {
    const { username, password } = req.body || {}
    const userRepo = AppDataSource.getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { username } })
    if (!user || !(await bcrypt.compare(password || '', user.passwordHash)))
      return res.status(400).json({ message: '用户名或密码错误' })
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const member = await memberRepo.findOne({ where: { userId: user.id } })
    let teamId = member?.teamId
    if (!teamId) {
      const teamRepo = AppDataSource.getRepository(TeamEntity)
      const team = await teamRepo.save(teamRepo.create({ name: `${user.username} 的团队` }))
      await memberRepo.save(memberRepo.create({ teamId: team.id, userId: user.id, role: 'owner' }))
      const groupRepo = AppDataSource.getRepository(GroupEntity)
      await groupRepo.save(groupRepo.create({ teamId: team.id, name: 'Default', sort: 0 }))
      teamId = team.id
    }
    const token = jwt.sign(
      { uid: user.id, tid: teamId, username: user.username, role: member?.role || 'owner' },
      JWT_SECRET,
      { expiresIn: '7d' }
    )
    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, role: member?.role || 'owner' } })
  })

  router.get('/auth/me', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const userRepo = AppDataSource.getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { id: req.uid } })
    if (!user) return res.status(401).json({ message: '用户不存在' })
    res.json({ id: user.id, username: user.username, nickname: user.nickname, role: req.role })
  })

  // ===== 窗口同步开关 =====
  // body: { enabled: boolean, ids?: number[] } —— ids 为空表示同步到全部已打开窗口
  router.post('/sync', authMiddleware, (req: Request, res: Response) => {
    const body = (req.body || {}) as { enabled?: boolean; ids?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : undefined
    if (syncToggle) syncToggle({ enabled: !!body.enabled, ids })
    res.json({ ok: true, enabled: !!body.enabled, ids: ids || [] })
  })

  // ===== 已打开的环境窗口（用于选择同步对象） =====
  router.get('/windows', authMiddleware, (_req: Request, res: Response) => {
    res.json(windowsProvider ? windowsProvider() : [])
  })

  // ===== 系统资源占用（主窗口顶栏展示） =====
  router.get('/system/stats', authMiddleware, async (_req: Request, res: Response) => {
    res.json(await getSystemStats())
  })

  // ===== 浏览器环境（环境内新标签页信息，无需登录态） =====
  router.get('/browser/profile-info/:id', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const settings = await getSettings()
    // 代理信息一并返回（含检测状态）：起始页据此在「用户点链接之前」就预警。
    // 环境窗口一旦绑定了不可用的代理，所有站点（包括本可直连的国内站）都会
    // ERR_PROXY_CONNECTION_FAILED 全挂；不提前说清楚，用户只会以为是搜索功能坏了。
    let proxy: null | {
      id: number
      label: string
      status: string
      checked: boolean
      country: string
    } = null
    if (p.proxyId) {
      const proxyRepo = AppDataSource.getRepository(ProxyEntity)
      const px = await proxyRepo.findOne({ where: { id: p.proxyId } })
      if (px) {
        proxy = {
          id: px.id,
          // 形如 socks5://1.2.3.4:1080，直接在页面上告诉用户是哪一条
          label: `${px.type}://${px.host}:${px.port}`,
          status: px.status || 'unknown',
          checked: !!px.lastCheckAt && px.status === 'active',
          country: px.country || ''
        }
      }
    }
    res.json({
      id: p.id,
      name: p.name,
      seq: p.seq,
      platform: p.platform,
      startUrl: p.startUrl,
      proxy,
      searchEngine: settings.searchEngine,
      fingerprint: {
        os: p.fingerprint.os,
        timezone: p.fingerprint.timezone,
        languages: p.fingerprint.languages,
        screenWidth: p.fingerprint.screenWidth,
        screenHeight: p.fingerprint.screenHeight,
        userAgent: p.fingerprint.userAgent
      }
    })
  })

  // ===== 分组 =====
  router.get('/groups', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(GroupEntity)
    const list = await repo.find({ where: ownerScope(req), order: { sort: 'ASC' } })
    res.json(list)
  })

  router.post('/groups', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(GroupEntity)
    const g = await repo.save(repo.create({ teamId: req.tid, ownerId: req.uid!, name: req.body.name, sort: req.body.sort || 0 }))
    res.json(g)
  })

  router.delete('/groups/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(GroupEntity)
    const g = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (g) await repo.remove(g)
    if (g) {
      const profileRepo = AppDataSource.getRepository(ProfileEntity)
      await profileRepo.update({ ...ownerScope(req), groupId: g.id }, { groupId: null })
    }
    res.json({ ok: true })
  })

  // ===== 浏览器环境 =====
  router.get('/profiles', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const isTemplate = req.query.templates === '1'
    const qb = repo
      .createQueryBuilder('p')
      .where('p.teamId = :tid', { tid: req.tid })
      .andWhere('p.isTemplate = :tpl', { tpl: isTemplate ? 1 : 0 })
      .orderBy('p.seq', 'ASC')
    if (req.query.groupId) qb.andWhere('p.groupId = :gid', { gid: Number(req.query.groupId) })
    if (req.query.keyword) qb.andWhere('(p.name LIKE :kw OR p.remark LIKE :kw OR p.platform LIKE :kw)', { kw: `%${req.query.keyword}%` })
    ownerAndWhere(qb, req)
    const list = await qb.getMany()

    const groupRepo = AppDataSource.getRepository(GroupEntity)
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const groups = await groupRepo.find({ where: ownerScope(req) })
    const proxies = await proxyRepo.find({ where: ownerScope(req) })
    const groupMap = new Map(groups.map((g) => [g.id, g.name]))
    const proxyMap = new Map(proxies.map((p) => [p.id, p]))
    res.json(list.map((p) => mapProfile(p, p.groupId ? groupMap.get(p.groupId) : null, p.proxyId ? proxyMap.get(p.proxyId) ?? null : null)))
  })

  // 导出环境（JSON，含完整指纹 + 分组 + 代理 + 账号，可直接迁移到另一台设备）
  router.get('/profiles/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const groupRepo = AppDataSource.getRepository(GroupEntity)
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const accountRepo = AppDataSource.getRepository(AccountEntity)
    const tid = req.tid!

    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    const qb = repo.createQueryBuilder('p').where('p.teamId = :tid', { tid }).andWhere('p.isTemplate = 0')
    if (ids.length) qb.andWhere('p.id IN (:...ids)', { ids })
    ownerAndWhere(qb, req)
    const list = await qb.orderBy('p.seq', 'ASC').getMany()

    const groups = await groupRepo.find({ where: ownerScope(req) })
    const proxies = await proxyRepo.find({ where: ownerScope(req) })
    const accounts = await accountRepo.find()
    const groupMap = new Map(groups.map((g) => [g.id, g.name]))
    const proxyMap = new Map(proxies.map((x) => [x.id, x]))

    res.json(
      list.map((p) => {
        const proxy = p.proxyId ? proxyMap.get(p.proxyId) : null
        return {
          name: p.name,
          platform: p.platform,
          startUrl: p.startUrl,
          remark: p.remark,
          group: p.groupId ? groupMap.get(p.groupId) || null : null,
          proxy: proxy?.name || null,
          proxyDetail: proxy
            ? {
                type: proxy.type,
                host: proxy.host,
                port: proxy.port,
                username: proxy.username,
                password: proxy.password
              }
            : null,
          fingerprint: p.fingerprint,
          accounts: accounts
            .filter((a) => a.profileId === p.id)
            .map((a) => ({ platform: a.platform, username: a.username, password: a.password, remark: a.remark }))
        }
      })
    )
  })

  router.post('/profiles/quick-create', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const qbMax = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbMax, req)
    const max = await qbMax.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: `环境 ${seq}`,
        seq,
        remark: '',
        platform: '',
        startUrl: DEFAULT_START_URL,
        proxyId: null,
        fingerprint: randomFingerprint() as unknown as Record<string, unknown>,
        isTemplate: false,
        createdBy: req.uid!
      })
    )
    await writeLog(req, 'quick_create_profile', `快速创建环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })
  router.get('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    res.json(mapProfile(p))
  })

  router.post('/profiles', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const body = req.body || {}
    const qbMax = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbMax, req)
    const max = await qbMax.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const fingerprint = (body.fingerprint || defaultFingerprint()) as Fingerprint
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        groupId: body.groupId || null,
        name: body.name || `环境 ${seq}`,
        seq,
        remark: body.remark || '',
        platform: body.platform || '',
        startUrl: body.startUrl || DEFAULT_START_URL,
        proxyId: body.proxyId || null,
        fingerprint: fingerprint as unknown as Record<string, unknown>,
        isTemplate: !!body.isTemplate,
        createdBy: req.uid!
      })
    )
    await writeLog(req, 'create_profile', `创建环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })

  router.put('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const body = req.body || {}
    const fields = ['name', 'remark', 'platform', 'startUrl', 'groupId', 'proxyId', 'extensions'] as const
    for (const f of fields) {
      if (f in body) (p as any)[f] = body[f] === '' && (f === 'groupId' || f === 'proxyId') ? null : body[f]
    }
    if (body.fingerprint) p.fingerprint = body.fingerprint
    await repo.save(p)
    await writeLog(req, 'update_profile', `修改环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })

  router.delete('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口' })
    await repo.remove(p)
    const accRepo = AppDataSource.getRepository(AccountEntity)
    await accRepo.delete({ profileId: p.id })
    await writeLog(req, 'delete_profile', `删除环境「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  router.post('/profiles/:id/open', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '窗口已在运行中' })
    if (!browserBridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    try {
      await browserBridge.openWindow(p.id)
      p.status = 'running'
      p.lastOpenedAt = new Date()
      await repo.save(p)
      await writeLog(req, 'open_profile', `打开环境「${p.name}」(#${p.id})`)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ message: (e as Error).message })
    }
  })

  router.post('/profiles/:id/close', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (browserBridge) await browserBridge.closeWindow(p.id)
    p.status = 'idle'
    await repo.save(p)
    await writeLog(req, 'close_profile', `关闭环境「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  // 从模板创建环境
  router.post('/profiles/:id/clone', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const tpl = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!tpl) return res.status(404).json({ message: '模板不存在' })
    const qbMax2 = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbMax2, req)
    const max = await qbMax2.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        groupId: tpl.groupId,
        name: (req.body?.name as string) || `${tpl.name} 副本`,
        seq,
        remark: tpl.remark,
        platform: tpl.platform,
        startUrl: tpl.startUrl,
        proxyId: null,
        fingerprint: tpl.fingerprint,
        isTemplate: false,
        createdBy: req.uid!
      })
    )
    await writeLog(req, 'clone_template', `从模板「${tpl.name}」创建环境「${p.name}」(#${p.id})`)
    res.json(mapProfile(p))
  })

  // 生成随机指纹
  router.post('/fingerprint/random', authMiddleware, (req: Request, res: Response) => {
    const os = (req.body || {}).os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    res.json(randomFingerprint(valid as OSKind | undefined))
  })

  // 指纹预设库（内置验证过的指纹组合）
  router.get('/fingerprint/presets', authMiddleware, (_req: Request, res: Response) => {
    res.json(listFingerprintPresets())
  })

  // ===== 代理 =====
  router.get('/proxies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: ownerScope(req), order: { id: 'DESC' } })
    const usage = await computeProxyUsage(req.tid!)
    const now = Date.now()
    res.json(
      list.map((p) => {
        const cnt = usage.get(p.id) || 0
        return { ...p, usageCount: cnt, poolStatus: proxyPoolStatus(p, cnt, now) }
      })
    )
  })

  router.post('/proxies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const b = req.body || {}
    if (!b.host || !b.port) return res.status(400).json({ message: '主机和端口不能为空' })
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: b.name || `${b.host}:${b.port}`,
        type: b.type || 'http',
        host: b.host,
        port: Number(b.port),
        username: b.username || '',
        password: b.password || '',
        remark: b.remark || ''
      })
    )
    await writeLog(req, 'create_proxy', `添加代理「${p.name}」(#${p.id})`)
    res.json(p)
  })

  router.put('/proxies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    const b = req.body || {}
    for (const f of ['name', 'type', 'host', 'username', 'password', 'remark', 'expiresAt'] as const) {
      if (f in b) (p as any)[f] = b[f]
    }
    if (b.port) p.port = Number(b.port)
    await repo.save(p)
    await writeLog(req, 'update_proxy', `修改代理「${p.name}」(#${p.id})`)
    res.json(p)
  })

  router.delete('/proxies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    await repo.remove(p)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    await profileRepo.update({ ...ownerScope(req), proxyId: p.id }, { proxyId: null })
    await writeLog(req, 'delete_proxy', `删除代理「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  router.post('/proxies/:id/check', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    const settings = await getSettings()
    const result = await checkProxy(p, (settings.proxyCheckTimeout as number) * 1000)
    p.status = result.ok ? 'active' : 'invalid'
    p.latency = result.ok ? result.latency : null
    p.country = result.country
    p.region = result.region
    p.city = result.city
    p.isp = result.isp
    p.exitIp = result.exitIp
    p.lastCheckAt = new Date()
    await repo.save(p)
    res.json(p)
  })

  // 从 IP 池一键分配：优先空闲代理，可按地区筛选，可选绑定到指定环境
  router.post('/proxies/allocate', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const b = req.body || {}
    try {
      const { proxy, profileId, reused, poolStatus } = await allocateProxy(req.tid!, {
        profileId: b.profileId,
        country: b.country,
        region: b.region
      })
      const usage = await computeProxyUsage(req.tid!)
      if (profileId) {
        const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, ...ownerScope(req) } })
        await writeLog(req, 'allocate_proxy', `为环境「${profile?.name}」从 IP 池分配代理「${proxy.name}」(#${proxy.id})`)
      } else {
        await writeLog(
          req,
          'allocate_proxy',
          `从 IP 池分配代理「${proxy.name}」(#${proxy.id})` + (reused ? '（池中无空闲代理，复用已占用代理）' : '')
        )
      }
      res.json({
        proxy: { ...proxy, usageCount: (usage.get(proxy.id) || 0) + (profileId ? 1 : 0), poolStatus },
        profileId,
        reused
      })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  })

  // IP 池统计：总数 / 可用 / 占用 / 过期 / 按地区分布
  router.get('/proxies/pool-stats', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: ownerScope(req) })
    const usage = await computeProxyUsage(req.tid!)
    const now = Date.now()
    let available = 0
    let inUse = 0
    let expired = 0
    let invalid = 0
    let unknown = 0
    let active = 0
    const byCountry = new Map<string, { country: string; total: number; available: number }>()
    for (const p of list) {
      const ps = proxyPoolStatus(p, usage.get(p.id) || 0, now)
      if (ps === 'available') available++
      else if (ps === 'in-use') inUse++
      else if (ps === 'expired') expired++
      else if (ps === 'invalid') invalid++
      else unknown++
      if (p.status === 'active') active++
      if (p.country) {
        const c = byCountry.get(p.country) || { country: p.country, total: 0, available: 0 }
        c.total++
        if (ps === 'available') c.available++
        byCountry.set(p.country, c)
      }
    }
    res.json({
      total: list.length,
      active,
      available,
      inUse,
      expired,
      invalid,
      unknown,
      byCountry: [...byCountry.values()].sort((a, b) => b.total - a.total)
    })
  })

  // ===== 账号中心 =====
  router.get('/accounts', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: { ...ownerScope(req), isTemplate: false } })
    const profileIds = new Set(profiles.map((p) => p.id))
    const all = await repo.find({ order: { id: 'DESC' } })
    const list = all.filter((a) => profileIds.has(a.profileId))
    const nameMap = new Map(profiles.map((p) => [p.id, p.name]))
    res.json(list.map((a) => ({ ...a, profileName: nameMap.get(a.profileId) || '' })))
  })

  router.post('/accounts', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number(req.body.profileId), ...ownerScope(req) } })
    if (!profile) return res.status(400).json({ message: '环境不存在' })
    const a = await repo.save(
      repo.create({
        profileId: profile.id,
        ownerId: req.uid!,
        platform: req.body.platform || '',
        username: req.body.username || '',
        password: req.body.password || '',
        remark: req.body.remark || ''
      })
    )
    await writeLog(req, 'create_account', `在环境「${profile.name}」添加账号 ${a.username}`)
    res.json(a)
  })

  router.put('/accounts/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: ownerScope(req) })
    const ids = new Set(profiles.map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ message: '账号不存在' })
    for (const f of ['platform', 'username', 'password', 'remark'] as const) {
      if (f in req.body) (a as any)[f] = req.body[f]
    }
    await repo.save(a)
    res.json(a)
  })

  router.delete('/accounts/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: ownerScope(req) })
    const ids = new Set(profiles.map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ message: '账号不存在' })
    await repo.remove(a)
    res.json({ ok: true })
  })

  // 账号批量导入：每行支持两种格式
  //   格式A（带环境，可还原归属）：`#环境序号|环境名,平台,账号,密码,备注`
  //   格式B（单一环境）：`平台,账号,密码[,备注]`，需配合请求体 profileId 指定归属环境
  router.post('/accounts/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const text: string = req.body?.text || ''
    const defaultProfileId: number | null = req.body?.profileId ? Number(req.body.profileId) : null
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return res.status(400).json({ message: '没有可导入的数据' })

    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: ownerScope(req) })
    const profileByName = new Map(profiles.map((p) => [p.name, p]))
    const profileBySeq = new Map(profiles.map((p) => [`#${p.seq}`, p]))

    let ok = 0
    const failed: string[] = []
    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim())
      let profileId = defaultProfileId
      let platform = ''
      let username = ''
      let password = ''
      let remark = ''
      if (parts.length >= 5) {
        const envPart = parts[0]
        const envName = envPart.includes('|') ? envPart.split('|')[1] : envPart
        const matched = profileByName.get(envName) || profileBySeq.get(envPart)
        if (matched) profileId = matched.id
        platform = parts[1]
        username = parts[2]
        password = parts[3]
        remark = parts[4] || ''
      } else if (parts.length >= 3) {
        platform = parts[0]
        username = parts[1]
        password = parts[2]
        remark = parts[3] || ''
      } else if (parts.length === 2) {
        username = parts[0]
        password = parts[1]
      } else {
        failed.push(line)
        continue
      }
      if (!profileId) {
        failed.push(`${line} (缺少归属环境)`)
        continue
      }
      if (!username) {
        failed.push(line)
        continue
      }
      await repo.save(repo.create({ profileId, ownerId: req.uid!, platform: platform || '其他', username, password, remark }))
      ok += 1
    }
    await writeLog(req, 'import_accounts', `批量导入账号 ${ok} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`)
    res.json({ imported: ok, failed })
  })

  // 账号导出（文本，含环境归属，便于还原）：`#环境序号|环境名,平台,账号,密码,备注`
  router.get('/accounts/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: ownerScope(req) })
    const map = new Map(profiles.map((p) => [p.id, p]))
    const list = await repo.find({ where: { profileId: In(profiles.map((p) => p.id)) }, order: { id: 'ASC' } })
    const text = list
      .map((a) => {
        const p = map.get(a.profileId)
        const env = p ? `#${p.seq}|${p.name}` : ''
        return [env, a.platform, a.username, a.password, a.remark].join(',')
      })
      .join('\n')
    res.json({ text, count: list.length })
  })

  // ===== Cookie 管理（按环境隔离，团队维度鉴权） =====
  // 注入发生在环境打开时（browserManager.openWindow 读取并写入 session.cookies）；
  // 这里负责 Cookie 的持久化、增删改查，以及「立即应用到已打开窗口」。

  function mapCookie(c: CookieEntity) {
    return {
      id: c.id,
      profileId: c.profileId,
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: (c.sameSite as 'no_restriction' | 'lax' | 'strict' | 'unspecified') || 'unspecified',
      expirationDate: c.expirationDate ? new Date(c.expirationDate).toISOString() : null,
      hostOnly: !!c.hostOnly,
      createdAt: new Date(c.createdAt).toISOString()
    }
  }

  // 解析多种格式的 Cookie 文本：Netscape / Set-Cookie（name=value; Domain=...）/ EditThisCookie JSON
  type SameSiteLike = 'no_restriction' | 'lax' | 'strict' | 'unspecified'
  function parseCookieText(text: string): { cookies: Partial<CookieEntity>[]; failed: string[] } {
    const failed: string[] = []
    const cookies: Partial<CookieEntity>[] = []
    const trimmed = text.replace(/^﻿/, '').trim()
    if (!trimmed) return { cookies, failed }

    // 整段是 JSON（数组或对象）→ EditThisCookie / 导出格式
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const arr = Array.isArray(JSON.parse(trimmed)) ? JSON.parse(trimmed) : [JSON.parse(trimmed)]
        for (const o of arr) {
          if (!o || !o.name) {
            failed.push(JSON.stringify(o).slice(0, 80))
            continue
          }
          cookies.push({
            domain: o.domain || '',
            name: String(o.name),
            value: o.value != null ? String(o.value) : '',
            path: o.path || '/',
            secure: !!o.secure,
            httpOnly: !!o.httpOnly,
            sameSite: o.sameSite || 'unspecified',
            expirationDate: o.expirationDate ? new Date(o.expirationDate) : null,
            hostOnly: o.hostOnly == null ? true : !!o.hostOnly
          })
        }
      } catch {
        failed.push('JSON 解析失败')
      }
      return { cookies, failed }
    }

    for (let raw of text.split(/\r?\n/)) {
      raw = raw.trim()
      if (!raw || raw.startsWith('# ') || raw.startsWith('//')) continue
      let line = raw
      let httpOnly = false
      if (line.startsWith('#HttpOnly_')) {
        httpOnly = true
        line = line.slice('#HttpOnly_'.length)
      }

      // Netscape 格式：7 个 tab 分隔字段
      const tab = line.split('\t')
      if (tab.length >= 7) {
        const [domain, flag, path, secureFlag, exp, name, value] = tab
        const expNum = Number(exp)
        cookies.push({
          domain,
          name,
          value: value || '',
          path: path || '/',
          secure: /^TRUE$/i.test(secureFlag),
          httpOnly,
          sameSite: 'unspecified',
          // flag=TRUE 表示包含子域（hostOnly=false）
          hostOnly: !/^TRUE$/i.test(flag),
          expirationDate: expNum > 0 ? new Date(expNum * 1000) : null
        })
        continue
      }

      // Set-Cookie 风格：name=value; Domain=...; Path=...; Expires=...; Secure; HttpOnly; SameSite=...
      const semi = line.split(';').map((s) => s.trim()).filter(Boolean)
      if (semi.length && semi[0].includes('=')) {
        const [name, ...rest] = semi[0].split('=')
        const cookie: Partial<CookieEntity> = {
          name: name.trim(),
          value: rest.join('=').trim(),
          domain: '',
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'unspecified',
          hostOnly: true,
          expirationDate: null
        }
        for (let i = 1; i < semi.length; i++) {
          const seg = semi[i]
          const eq = seg.indexOf('=')
          const key = (eq === -1 ? seg : seg.slice(0, eq)).trim().toLowerCase()
          const val = eq === -1 ? '' : seg.slice(eq + 1).trim()
          if (key === 'domain') {
            cookie.domain = val
            // 带前导点（.example.com）表示含子域 → hostOnly=false；不带点表示仅主机
            cookie.hostOnly = !val.startsWith('.')
          } else if (key === 'path') cookie.path = val || '/'
          else if (key === 'expires') {
            const t = Date.parse(val)
            if (!Number.isNaN(t)) cookie.expirationDate = new Date(t)
          } else if (key === 'max-age') {
            const n = Number(val)
            if (!Number.isNaN(n)) cookie.expirationDate = new Date(Date.now() + n * 1000)
          } else if (key === 'secure') cookie.secure = true
          else if (key === 'httponly') cookie.httpOnly = true
          else if (key === 'samesite') cookie.sameSite = (val.toLowerCase() as SameSiteLike) || 'unspecified'
        }
        if (!cookie.domain) {
          failed.push(raw.slice(0, 80))
          continue
        }
        cookies.push(cookie)
        continue
      }

      failed.push(raw.slice(0, 80))
    }
    return { cookies, failed }
  }

  // 列出某环境的 Cookie（必须传 profileId，且属于当前团队）
  router.get('/cookies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const list = await repo.find({ where: { profileId, ...ownerScope(req) }, order: { domain: 'ASC', name: 'ASC' } })
    res.json(list.map(mapCookie))
  })

  // 新增 Cookie
  router.post('/cookies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number(req.body.profileId), ...ownerScope(req) } })
    if (!profile) return res.status(400).json({ message: '环境不存在' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const c = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        profileId: profile.id,
        domain: (req.body.domain || '').trim(),
        name: (req.body.name || '').trim(),
        value: req.body.value == null ? '' : String(req.body.value),
        path: req.body.path || '/',
        secure: !!req.body.secure,
        httpOnly: !!req.body.httpOnly,
        sameSite: req.body.sameSite || 'unspecified',
        expirationDate: req.body.expirationDate ? new Date(req.body.expirationDate) : null,
        hostOnly: req.body.hostOnly == null ? true : !!req.body.hostOnly
      })
    )
    await writeLog(req, 'create_cookie', `环境「${profile.name}」新增 Cookie ${c.domain} / ${c.name}`)
    res.json(mapCookie(c))
  })

  // 清空某环境的全部 Cookie
  router.delete('/cookies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const r = await repo.delete({ profileId, ...ownerScope(req) })
    await writeLog(req, 'clear_cookies', `清空环境「${profile.name}」的 Cookie（${r.affected || 0} 条）`)
    res.json({ ok: true, deleted: r.affected || 0 })
  })

  // 批量导入 Cookie 文本（Netscape / Set-Cookie / JSON）
  router.post('/cookies/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.body.profileId)
    const text: string = req.body?.text || ''
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    if (!text.trim()) return res.status(400).json({ message: '请粘贴 Cookie 文本' })
    const { cookies, failed } = parseCookieText(text)
    if (!cookies.length) return res.status(400).json({ message: '未解析到任何 Cookie', failed })
    const repo = AppDataSource.getRepository(CookieEntity)
    const saved = await repo.save(
      cookies.map((c) =>
        repo.create({
          teamId: req.tid!,
          ownerId: req.uid!,
          profileId,
          domain: (c.domain || '').trim(),
          name: (c.name || '').trim(),
          value: c.value == null ? '' : String(c.value),
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'unspecified',
          expirationDate: c.expirationDate ? new Date(c.expirationDate) : null,
          hostOnly: c.hostOnly == null ? true : !!c.hostOnly
        })
      )
    )
    await writeLog(req, 'import_cookies', `环境「${profile.name}」导入 ${saved.length} 条 Cookie`)
    res.json({ imported: saved.length, failed })
  })

  // 导出为 Netscape cookie 文本
  router.get('/cookies/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const list = await repo.find({ where: { profileId, ...ownerScope(req) }, order: { domain: 'ASC', name: 'ASC' } })
    const text = list
      .map((c) => {
        const flag = c.hostOnly ? 'FALSE' : 'TRUE'
        const exp = c.expirationDate ? Math.floor(new Date(c.expirationDate).getTime() / 1000) : 0
        return [c.domain, flag, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t')
      })
      .join('\n')
    res.json({ text, count: list.length })
  })

  // 立即把 Cookie 写入已打开的环境窗口（未打开则提示下次打开时自动注入）
  router.post('/cookies/apply', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number(req.query.profileId || req.body.profileId)
    if (!profileId) return res.status(400).json({ message: '请指定 profileId' })
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    try {
      const { applyCookies } = await import('./browserManager')
      const n = await applyCookies(profileId)
      await writeLog(req, 'apply_cookies', `环境「${profile.name}」立即注入 ${n} 条 Cookie`)
      res.json({ ok: true, applied: n })
    } catch (e) {
      res.status(400).json({ message: (e as Error).message })
    }
  })

  router.put('/cookies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!c) return res.status(404).json({ message: 'Cookie 不存在' })
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: c.profileId, ...ownerScope(req) } })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    for (const f of ['domain', 'name', 'value', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate', 'hostOnly'] as const) {
      if (f in req.body) {
        if (f === 'expirationDate') (c as any)[f] = req.body[f] ? new Date(req.body[f]) : null
        else if (f === 'value') (c as any)[f] = req.body[f] == null ? '' : String(req.body[f])
        else (c as any)[f] = req.body[f]
      }
    }
    await repo.save(c)
    res.json(mapCookie(c))
  })

  router.delete('/cookies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!c) return res.status(404).json({ message: 'Cookie 不存在' })
    await repo.remove(c)
    res.json({ ok: true })
  })

  // ===== 团队 =====
  router.get('/team', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const teamRepo = AppDataSource.getRepository(TeamEntity)
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const userRepo = AppDataSource.getRepository(UserEntity)
    const team = await teamRepo.findOne({ where: { id: req.tid } })
    const members = await memberRepo.find({ where: { teamId: req.tid } })
    const users = await userRepo.findByIds(members.map((m) => m.userId))
    const userMap = new Map(users.map((u) => [u.id, u]))
    res.json({
      team,
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        username: userMap.get(m.userId)?.username || '',
        nickname: userMap.get(m.userId)?.nickname || '',
        createdAt: m.createdAt
      }))
    })
  })

  // 邀请成员（直接创建账号并加入团队）
  router.post('/team/members', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const { username, password, nickname, role } = req.body || {}
    if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' })
    const userRepo = AppDataSource.getRepository(UserEntity)
    let user = await userRepo.findOne({ where: { username } })
    if (!user) {
      user = await userRepo.save(
        userRepo.create({ username, passwordHash: await bcrypt.hash(password, 10), nickname: nickname || username })
      )
    }
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const exists = await memberRepo.findOne({ where: { teamId: req.tid, userId: user.id } })
    if (exists) return res.status(400).json({ message: '该用户已在团队中' })
    const m = await memberRepo.save(memberRepo.create({ teamId: req.tid!, userId: user.id, role: role || 'member' }))
    await writeLog(req, 'add_member', `添加成员 ${username}（${role || 'member'}）`)
    res.json(m)
  })

  router.put('/team/members/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const m = await memberRepo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!m) return res.status(404).json({ message: '成员不存在' })
    if (req.body.role) m.role = req.body.role
    await memberRepo.save(m)
    await writeLog(req, 'update_member', `修改成员角色为 ${m.role}`)
    res.json(m)
  })

  router.delete('/team/members/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const m = await memberRepo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!m) return res.status(404).json({ message: '成员不存在' })
    if (m.role === 'owner') return res.status(400).json({ message: '不能移除所有者' })
    await memberRepo.remove(m)
    await writeLog(req, 'remove_member', `移除成员 #${req.params.id}`)
    res.json({ ok: true })
  })

  // ===== 操作日志 =====
  router.get('/logs', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(OperationLogEntity)
    const qb = repo
      .createQueryBuilder('l')
      .where('l.teamId = :tid', { tid: req.tid })
      .orderBy('l.id', 'DESC')
      .take(500)
    if (req.query.keyword) qb.andWhere('(l.username LIKE :kw OR l.action LIKE :kw OR l.detail LIKE :kw)', { kw: `%${req.query.keyword}%` })
    const list = await qb.getMany()
    res.json(list)
  })

  // ===== API 令牌 =====
  router.get('/tokens', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ApiTokenEntity)
    res.json(await repo.find({ where: ownerScope(req) }))
  })

  router.post('/tokens', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ApiTokenEntity)
    const token = 'rb_' + crypto.randomBytes(24).toString('hex')
    const t = await repo.save(repo.create({ teamId: req.tid!, ownerId: req.uid!, name: req.body?.name || '默认令牌', token }))
    await writeLog(req, 'create_token', `创建 API 令牌「${t.name}」`)
    res.json(t)
  })

  router.delete('/tokens/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ApiTokenEntity)
    const t = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (t) await repo.remove(t)
    res.json({ ok: true })
  })

  // 全局设置（单例，key='global'）
  router.get('/settings', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AppSettingsEntity)
    const row = await repo.findOne({ where: { key: 'global' } })
    res.json(row?.settings ? { ...DEFAULT_SETTINGS, ...row.settings } : DEFAULT_SETTINGS)
  })

  router.put('/settings', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AppSettingsEntity)
    const merged = { ...DEFAULT_SETTINGS, ...(req.body || {}) } as Record<string, unknown>
    // 国家 / 语言走白名单：非法值直接回落默认，避免把脏数据写进 JSON 列
    // （theme.ts 与 i18n 都按这些值取时区与词典，脏值会导致界面/主题取不到而崩溃）
    const country = normalizeCountry(merged.country as string) || DEFAULT_SETTINGS.country
    const language = normalizeLocale(merged.language as string) || DEFAULT_SETTINGS.language
    merged.country = country
    merged.language = language
    // 搜索引擎同样走白名单：脏值会让起始页拼出错误的搜索 URL
    merged.searchEngine = normalizeSearchEngine(merged.searchEngine) || DEFAULT_SETTINGS.searchEngine
    let row = await repo.findOne({ where: { key: 'global' } })
    if (!row) row = repo.create({ key: 'global', settings: merged })
    else row.settings = merged
    await repo.save(row)
    // 设置变更后重新调度定时巡检（间隔可能为 0 = 关闭）
    startProxyCheckScheduler().catch((e) => console.error('[roxy] 重启巡检调度失败:', e))
    res.json({ ok: true, settings: merged })
  })

  // ===== 自动化 API (v1，令牌鉴权，供脚本调用) =====
  const v1 = express.Router()
  v1.use(tokenAuthMiddleware)

  v1.get('/profiles', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid, isTemplate: false } })
    res.json({ code: 0, data: list.map((p) => ({ id: p.id, name: p.name, seq: p.seq, status: p.status })) })
  })

  v1.post('/profiles', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const tid = (req as AuthedRequest).tid!
    const b = req.body || {}
    let fingerprint = (b.fingerprint || randomFingerprint()) as Record<string, unknown>
    let platform = b.platform || ''
    let startUrl = b.startUrl || DEFAULT_START_URL
    let remark = b.remark || ''
    if (b.templateId) {
      const tpl = await repo.findOne({ where: { id: Number(b.templateId), teamId: tid, isTemplate: true } })
      if (!tpl) return res.status(404).json({ code: 404, message: 'template not found' })
      fingerprint = tpl.fingerprint as Record<string, unknown>
      platform = b.platform || tpl.platform || ''
      startUrl = b.startUrl || tpl.startUrl || DEFAULT_START_URL
      remark = b.remark || tpl.remark || ''
    }
    const max = await repo.createQueryBuilder('p').select('MAX(p.seq)', 'm').where('p.teamId = :tid', { tid }).getRawOne()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: tid,
        name: b.name || `API环境 ${seq}`,
        seq,
        platform,
        startUrl,
        remark,
        fingerprint,
        createdBy: 0
      })
    )
    res.json({ code: 0, data: { id: p.id, name: p.name } })
  })

  v1.post('/profiles/:id/open', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    if (!browserBridge) return res.status(500).json({ code: 500, message: 'browser engine not ready' })
    await browserBridge.openWindow(p.id)
    p.status = 'running'
    p.lastOpenedAt = new Date()
    await repo.save(p)
    res.json({ code: 0, data: { id: p.id, status: 'running' } })
  })

  v1.post('/profiles/:id/close', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    if (browserBridge) await browserBridge.closeWindow(p.id)
    p.status = 'idle'
    await repo.save(p)
    res.json({ code: 0, data: { id: p.id, status: 'idle' } })
  })

  v1.get('/proxies', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid } })
    res.json({ code: 0, data: list })
  })

  // ===== 自动化 API v1 写入类（供脚本调度） =====
  // 约定：成功返回 { code: 0, data }；失败返回 { code, message }，并记录 HTTP 状态码

  // --- 环境：查询单条 / 更新 / 删除 ---
  v1.get('/profiles/:id', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    res.json({ code: 0, data: mapProfile(p) })
  })

  v1.put('/profiles/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    const b = req.body || {}
    const fields = ['name', 'remark', 'platform', 'startUrl', 'groupId', 'proxyId', 'extensions'] as const
    for (const f of fields) {
      if (f in b) (p as any)[f] = b[f] === '' && (f === 'groupId' || f === 'proxyId') ? null : b[f]
    }
    if (b.fingerprint) p.fingerprint = b.fingerprint
    await repo.save(p)
    res.json({ code: 0, data: { id: p.id, name: p.name } })
  })

  v1.delete('/profiles/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'profile not found' })
    await repo.remove(p)
    // 清理关联数据，避免孤儿记录
    await AppDataSource.getRepository(AccountEntity).delete({ profileId: p.id })
    await AppDataSource.getRepository(CookieEntity).delete({ profileId: p.id })
    await AppDataSource.getRepository(ProfileEntity).update({ teamId: tid, proxyId: p.id }, { proxyId: null })
    res.json({ code: 0, data: { id: p.id } })
  })

  // --- 代理：创建 / 查询单条 / 更新 / 删除 / 分配 / 检测 ---
  v1.post('/proxies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(ProxyEntity)
    const b = req.body || {}
    if (!b.host || !b.port) return res.status(400).json({ code: 400, message: 'host and port required' })
    const p = await repo.save(
      repo.create({
        teamId: tid,
        name: b.name || `${b.host}:${b.port}`,
        type: b.type || 'http',
        host: b.host,
        port: Number(b.port),
        username: b.username || '',
        password: b.password || '',
        remark: b.remark || ''
      })
    )
    res.json({ code: 0, data: p })
  })

  v1.get('/proxies/:id', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    res.json({ code: 0, data: p })
  })

  v1.put('/proxies/:id', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    const b = req.body || {}
    for (const f of ['name', 'type', 'host', 'username', 'password', 'remark', 'expiresAt'] as const) {
      if (f in b) (p as any)[f] = b[f]
    }
    if (b.port) p.port = Number(b.port)
    await repo.save(p)
    res.json({ code: 0, data: p })
  })

  v1.delete('/proxies/:id', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: (req as AuthedRequest).tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    await repo.remove(p)
    await AppDataSource.getRepository(ProfileEntity).update(
      { teamId: (req as AuthedRequest).tid, proxyId: p.id },
      { proxyId: null }
    )
    res.json({ code: 0, data: { id: p.id } })
  })

  v1.post('/proxies/allocate', async (req: Request, res: Response) => {
    const b = req.body || {}
    try {
      const { proxy, profileId, reused, poolStatus } = await allocateProxy((req as AuthedRequest).tid!, {
        profileId: b.profileId,
        country: b.country,
        region: b.region
      })
      const usage = await computeProxyUsage((req as AuthedRequest).tid!)
      res.json({
        code: 0,
        data: { proxy: { ...proxy, usageCount: (usage.get(proxy.id) || 0) + (profileId ? 1 : 0), poolStatus }, profileId, reused }
      })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ code: e.status, message: e.message })
      throw e
    }
  })

  v1.post('/proxies/check', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(ProxyEntity)
    const id = Number((req.body || {}).id)
    const p = await repo.findOne({ where: { id, teamId: tid } })
    if (!p) return res.status(404).json({ code: 404, message: 'proxy not found' })
    const settings = await getSettings()
    const result = await checkProxy(p, (settings.proxyCheckTimeout as number) * 1000)
    p.status = result.ok ? 'active' : 'invalid'
    p.latency = result.ok ? result.latency : null
    p.country = result.country
    p.region = result.region
    p.city = result.city
    p.isp = result.isp
    p.exitIp = result.exitIp
    p.lastCheckAt = new Date()
    await repo.save(p)
    res.json({ code: 0, data: p })
  })

  // --- 指纹：随机生成 ---
  v1.post('/fingerprint/random', async (req: Request, res: Response) => {
    const os = (req.body || {}).os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    res.json({ code: 0, data: randomFingerprint(valid as OSKind | undefined) })
  })

  // --- 账号：列表 / 创建 / 更新 / 删除 ---
  v1.get('/accounts', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: { teamId: tid, isTemplate: false } })
    const profileIds = new Set(profiles.map((p) => p.id))
    const nameMap = new Map(profiles.map((p) => [p.id, p.name]))
    const all = await repo.find({ order: { id: 'DESC' } })
    res.json({ code: 0, data: all.filter((a) => profileIds.has(a.profileId)).map((a) => ({ ...a, profileName: nameMap.get(a.profileId) || '' })) })
  })

  v1.post('/accounts', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number((req.body || {}).profileId), teamId: tid } })
    if (!profile) return res.status(400).json({ code: 400, message: 'profile not found' })
    const a = await repo.save(
      repo.create({
        profileId: profile.id,
        platform: (req.body || {}).platform || '',
        username: (req.body || {}).username || '',
        password: (req.body || {}).password || '',
        remark: (req.body || {}).remark || ''
      })
    )
    res.json({ code: 0, data: a })
  })

  v1.put('/accounts/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const ids = new Set((await profileRepo.find({ where: { teamId: tid } })).map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ code: 404, message: 'account not found' })
    for (const f of ['platform', 'username', 'password', 'remark'] as const) {
      if (f in (req.body || {})) (a as any)[f] = (req.body as any)[f]
    }
    await repo.save(a)
    res.json({ code: 0, data: a })
  })

  v1.delete('/accounts/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const ids = new Set((await profileRepo.find({ where: { teamId: tid } })).map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ code: 404, message: 'account not found' })
    await repo.remove(a)
    res.json({ code: 0, data: { id: a.id } })
  })

  // ===== 批量能力：导入 / 导出 / 复制 / 批量随机指纹 =====

  // 导入环境（JSON）：兼容纯环境数组，也支持带分组 / 代理 / 账号的完整迁移文件
  router.post('/profiles/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const groupRepo = AppDataSource.getRepository(GroupEntity)
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const accountRepo = AppDataSource.getRepository(AccountEntity)
    const payload = req.body || {}
    const items = (Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : []) as Array<Record<string, unknown>>
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: '没有可导入的数据' })

    // 分组 / 代理按名称复用，缺失则新建
    const groupIdByName = new Map((await groupRepo.find({ where: ownerScope(req) })).map((g) => [g.name, g.id]))
    const proxyIdByName = new Map((await proxyRepo.find({ where: ownerScope(req) })).map((x) => [x.name, x.id]))

    const qbImp = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbImp, req)
    let seq = Number((await qbImp.getRawOne<{ m: number | null }>())?.m || 1000)

    const created: Array<{ id: number; name: string }> = []
    let groupsCreated = 0
    let proxiesCreated = 0
    let accountsCreated = 0

    for (const item of items) {
      // 分组
      let groupId: number | null = null
      const groupName = item.group ? String(item.group) : ''
      if (groupName) {
        if (!groupIdByName.has(groupName)) {
          const g = await groupRepo.save(groupRepo.create({ teamId: req.tid!, ownerId: req.uid!, name: groupName, sort: 0 }))
          groupIdByName.set(groupName, g.id)
          groupsCreated++
        }
        groupId = groupIdByName.get(groupName) ?? null
      }

      // 代理：先按名称复用，再按迁移文件里的 proxyDetail 就地新建
      let proxyId: number | null = null
      const proxyName = item.proxy ? String(item.proxy) : ''
      if (proxyName) {
        if (proxyIdByName.has(proxyName)) {
          proxyId = proxyIdByName.get(proxyName) ?? null
        } else {
          const detail = (item.proxyDetail || {}) as Record<string, unknown>
          if (detail.host && detail.port) {
            const x = await proxyRepo.save(
              proxyRepo.create({
                teamId: req.tid!,
                ownerId: req.uid!,
                name: proxyName,
                type: String(detail.type || 'http'),
                host: String(detail.host),
                port: Number(detail.port),
                username: String(detail.username || ''),
                password: String(detail.password || ''),
                remark: String(detail.remark || '')
              })
            )
            proxyIdByName.set(proxyName, x.id)
            proxyId = x.id
            proxiesCreated++
          }
        }
      }

      seq += 1
      const p = await repo.save(
        repo.create({
          teamId: req.tid!,
          ownerId: req.uid!,
          groupId,
          proxyId,
          name: (item.name as string) || `导入环境 ${seq}`,
          seq,
          platform: (item.platform as string) || '',
          startUrl: (item.startUrl as string) || DEFAULT_START_URL,
          remark: (item.remark as string) || '',
          fingerprint:
            (item.fingerprint as Record<string, unknown>) ||
            (randomFingerprint() as unknown as Record<string, unknown>),
          createdBy: req.uid!
        })
      )
      created.push({ id: p.id, name: p.name })

      // 账号
      for (const acc of (item.accounts || []) as Array<Record<string, unknown>>) {
        if (!acc?.username) continue
        await accountRepo.save(
          accountRepo.create({
            profileId: p.id,
            ownerId: req.uid!,
            platform: String(acc.platform || ''),
            username: String(acc.username),
            password: String(acc.password || ''),
            remark: String(acc.remark || '')
          })
        )
        accountsCreated++
      }
    }

    await writeLog(
      req,
      'import_profiles',
      `导入 ${created.length} 个环境（新建分组 ${groupsCreated} 个、代理 ${proxiesCreated} 条、账号 ${accountsCreated} 条）`
    )
    res.json({ created: created.length, items: created, groupsCreated, proxiesCreated, accountsCreated })
  })


  // 复制环境（连同账号一起复制，用于资料迁移）
  router.post('/profiles/:id/duplicate', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const src = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!src) return res.status(404).json({ message: '环境不存在' })
    const qbDup = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbDup, req)
    const max = await qbDup.getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const copy = await repo.save(
      repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        groupId: src.groupId,
        name: `${src.name} 副本`,
        seq,
        remark: src.remark,
        platform: src.platform,
        startUrl: src.startUrl,
        proxyId: null,
        fingerprint: src.fingerprint,
        isTemplate: src.isTemplate,
        createdBy: req.uid!
      })
    )
    // 连同账号资料一起迁移
    const accRepo = AppDataSource.getRepository(AccountEntity)
    const accounts = await accRepo.find({ where: { profileId: src.id } })
    for (const a of accounts) {
      await accRepo.save(
        accRepo.create({
          profileId: copy.id,
          ownerId: req.uid!,
          platform: a.platform,
          username: a.username,
          password: a.password,
          remark: a.remark
        })
      )
    }
    await writeLog(req, 'duplicate_profile', `复制环境「${src.name}」→「${copy.name}」，迁移 ${accounts.length} 个账号`)
    res.json({ id: copy.id, name: copy.name, migratedAccounts: accounts.length })
  })

  // 批量重新生成指纹
  router.post('/profiles/batch-randomize', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids: number[] = req.body?.ids || []
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: '请先选择环境' })
    const repo = AppDataSource.getRepository(ProfileEntity)
    let count = 0
    for (const id of ids) {
      const p = await repo.findOne({ where: { id: Number(id), ...ownerScope(req) } })
      if (!p) continue
      if (p.status === 'running') continue // 运行中的环境不改动
      p.fingerprint = randomFingerprint() as unknown as Record<string, unknown>
      await repo.save(p)
      count += 1
    }
    await writeLog(req, 'batch_randomize', `批量重随机 ${count} 个环境的指纹`)
    res.json({ updated: count })
  })

  // 代理批量导入：支持 host:port:user:pass / url 形式 / CSV
  router.post('/proxies/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const text: string = req.body?.text || ''
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) return res.status(400).json({ message: '没有可导入的数据' })

    const repo = AppDataSource.getRepository(ProxyEntity)
    let ok = 0
    const failed: string[] = []
    for (const line of lines) {
      const parsed = parseProxyLine(line)
      if (!parsed) {
        failed.push(line)
        continue
      }
      await repo.save(repo.create({ teamId: req.tid!, ownerId: req.uid!, name: `${parsed.host}:${parsed.port}`, ...parsed }))
      ok += 1
    }
    await writeLog(req, 'import_proxies', `批量导入代理 ${ok} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`)
    res.json({ imported: ok, failed })
  })

  // 代理导出（文本，便于备份与迁移）
  router.get('/proxies/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: ownerScope(req), order: { id: 'ASC' } })
    const text = list
      .map((p) => [p.type, p.host, p.port, p.username, p.password].join(':'))
      .join('\n')
    res.json({ text, count: list.length })
  })

  // ---------- 扩展管理（浏览器插件） ----------
  router.get('/extensions', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ExtensionEntity)
    const list = await repo.find({ where: ownerScope(req), order: { id: 'DESC' } })
    res.json(
      list.map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        description: e.description,
        createdAt: e.createdAt
      }))
    )
  })

  router.post('/extensions', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const body = req.body || {}
    const repo = AppDataSource.getRepository(ExtensionEntity)
    const ext = repo.create({ teamId: req.tid!, ownerId: req.uid!, name: '', version: '', description: null, extPath: '', iconPath: '' })
    const saved = await repo.save(ext)
    const dest = join(extUserDir(), String(saved.id))
    mkdirSync(dest, { recursive: true })
    try {
      if (body.localPath) {
        const src = String(body.localPath)
        if (!existsSync(src) || !statSync(src).isDirectory()) {
          throw new Error('本地路径不存在或不是目录')
        }
        if (!existsSync(join(src, 'manifest.json'))) {
          throw new Error('该目录不含 manifest.json，不是有效的扩展目录')
        }
        cpSync(src, dest, { recursive: true })
      } else if (Array.isArray(body.files) && body.files.length) {
        for (const f of body.files as Array<{ path: string; data: string }>) {
          if (!f || !f.path) continue
          const target = join(dest, normalizeRelPath(f.path))
          mkdirSync(join(target, '..'), { recursive: true })
          writeFileSync(target, Buffer.from(f.data || '', 'base64'))
        }
        if (!existsSync(join(dest, 'manifest.json'))) {
          throw new Error('上传内容中未找到 manifest.json，不是有效的扩展目录')
        }
      } else {
        throw new Error('请提供 localPath（本地已解压扩展目录）或 files（上传的目录文件列表）')
      }
      const manifest = readExtensionManifest(dest)
      if (!manifest) {
        throw new Error('目录中没有 manifest.json，无法识别为扩展')
      }
      saved.name = String(manifest.name || '未命名扩展').slice(0, 128)
      saved.version = String(manifest.version || '').slice(0, 32)
      saved.description = manifest.description ? String(manifest.description) : null
      saved.extPath = `extensions/${saved.id}`
      const iconRel = pickExtensionIcon(manifest)
      saved.iconPath = iconRel ? `extensions/${saved.id}/${iconRel}` : ''
      await repo.save(saved)
      await writeLog(req, 'create_extension', `添加扩展「${saved.name}」(#${saved.id})`)
      res.json({ id: saved.id, name: saved.name, version: saved.version, description: saved.description, createdAt: saved.createdAt })
    } catch (e) {
      await repo.remove(saved).catch(() => {})
      rmSync(dest, { recursive: true, force: true })
      res.status(400).json({ message: (e as Error).message })
    }
  })

  router.get('/extensions/:id/icon', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ExtensionEntity)
    const ext = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!ext || !ext.iconPath) return res.status(404).end()
    const abs = join(app.getPath('userData'), ext.iconPath)
    if (!existsSync(abs)) return res.status(404).end()
    res.sendFile(abs)
  })

  router.delete('/extensions/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ExtensionEntity)
    const ext = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!ext) return res.status(404).json({ message: '扩展不存在' })
    const dest = join(extUserDir(), String(ext.id))
    // remove 后实体主键会被清空，先取出来写日志
    const { id: extId, name } = ext
    await repo.remove(ext)
    rmSync(dest, { recursive: true, force: true })
    await writeLog(req, 'delete_extension', `删除扩展「${name}」(#${extId})`)
    res.json({ ok: true })
  })

  // ===== RPA 脚本录制 / 回放 =====
  // 注意路由顺序：/rpa/record/* 等静态路径必须排在 /rpa/:id 之前（项目既有约定）
  const rpaRepo = () => AppDataSource.getRepository(RpaScriptEntity)

  router.get('/rpa', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const list = await rpaRepo().find({ where: ownerScope(req), order: { id: 'DESC' } })
    res.json(
      list.map((s) => ({
        id: s.id,
        name: s.name,
        remark: s.remark,
        steps: s.steps as unknown as RpaStep[],
        scheduleEnabled: s.scheduleEnabled,
        scheduleIntervalMin: s.scheduleIntervalMin,
        scheduleProfileId: s.scheduleProfileId,
        lastScheduledRunAt: s.lastScheduledRunAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }))
    )
  })

  router.post('/rpa', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const b = req.body || {}
    if (!b.name || !Array.isArray(b.steps)) return res.status(400).json({ message: '名称和步骤不能为空' })
    const saved = await rpaRepo().save(
      rpaRepo().create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: String(b.name).slice(0, 128),
        remark: String(b.remark || '').slice(0, 512),
        steps: b.steps,
        scheduleEnabled: !!b.scheduleEnabled && !!b.scheduleProfileId,
        scheduleIntervalMin: normalizeScheduleInterval(b.scheduleIntervalMin),
        scheduleProfileId: b.scheduleProfileId || null
      })
    )
    await writeLog(req, 'create_rpa_script', `创建 RPA 脚本「${saved.name}」(#${saved.id})，${b.steps.length} 步`)
    res.json({ id: saved.id })
  })

  router.put('/rpa/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = rpaRepo()
    const s = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    const b = req.body || {}
    if (b.name !== undefined) s.name = String(b.name).slice(0, 128)
    if (b.remark !== undefined) s.remark = String(b.remark).slice(0, 512)
    if (Array.isArray(b.steps)) s.steps = b.steps
    if (b.scheduleIntervalMin !== undefined) s.scheduleIntervalMin = normalizeScheduleInterval(b.scheduleIntervalMin)
    if (b.scheduleProfileId !== undefined) s.scheduleProfileId = b.scheduleProfileId || null
    if (b.scheduleEnabled !== undefined) s.scheduleEnabled = !!b.scheduleEnabled && !!s.scheduleProfileId
    // 开启定时必须已绑定目标环境（save 前校验，避免落库一个永远不会执行的配置）
    if (s.scheduleEnabled && !s.scheduleProfileId) {
      return res.status(400).json({ message: '开启定时执行前请先选择目标环境' })
    }
    await repo.save(s)
    await writeLog(req, 'update_rpa_script', `更新 RPA 脚本「${s.name}」(#${s.id})`)
    res.json({ ok: true })
  })

  router.delete('/rpa/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = rpaRepo()
    const s = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    // remove 后实体主键会被清空，先取出来写日志
    const { id, name } = s
    await repo.remove(s)
    await writeLog(req, 'delete_rpa_script', `删除 RPA 脚本「${name}」(#${id})`)
    res.json({ ok: true })
  })

  // 开始录制（环境需处于运行态）
  router.post('/rpa/record/start', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    // 归属校验（普通用户只能录制自己的环境）
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({
      where: { id: profileId, ...ownerScope(req) }
    })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    try {
      ;(await import('./browserManager')).startRpaRecording(profileId)
    } catch (e) {
      return res.status(400).json({ message: (e as Error).message })
    }
    await writeLog(req, 'rpa_record_start', `开始录制 RPA 脚本（环境「${profile.name}」#${profileId}）`)
    res.json({ ok: true })
  })

  // 停止录制：返回采集到的步骤，由前端命名后调 POST /rpa 保存
  router.post('/rpa/record/stop', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const steps = (await import('./browserManager')).stopRpaRecording(profileId)
    res.json({ steps })
  })

  // 录制状态（轮询用）
  router.get('/rpa/record/status', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.query || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const bm = await import('./browserManager')
    const recording = bm.isRpaRecording(profileId)
    const count = bm.rpaRecordCount(profileId)
    res.json({ recording, count })
  })

  // 回放：在指定环境窗口执行脚本（后台异步执行，结果写操作日志）
  router.post('/rpa/:id/run', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const s = await rpaRepo().findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({
      where: { id: profileId, ...ownerScope(req) }
    })
    if (!profile) return res.status(404).json({ message: '环境不存在' })
    const steps = s.steps as unknown as RpaStep[]
    // 前置校验环境必须处于运行态（否则后台任务会静默失败，用户无从得知）
    const runningIds = (await import('./browserManager')).getRunningWindowIds()
    if (!runningIds.includes(profileId)) {
      return res.status(400).json({ message: '环境未运行，请先打开环境再回放' })
    }
    // 回放可能持续数分钟，不阻塞请求；完成 / 中止写操作日志
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await (await import('./browserManager')).replayRpaScript(profileId, steps)
      } catch (e) {
        err = (e as Error).message
      }
      await writeLog(
        req,
        'rpa_run',
        err
          ? `回放脚本「${s.name}」失败：${err}`
          : `回放脚本「${s.name}」完成（环境「${profile.name}」#${profileId}，执行 ${executed}/${steps.length} 步）`
      )
    })()
    res.json({ started: true, steps: steps.length })
  })

  router.use('/v1', wrapAsync(v1))
  return wrapAsync(router)
}

// ---------- 启动 ----------
export async function bootstrap(): Promise<string> {
  // 1. 建库
  const conn = await mysql.createConnection({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password
  })
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await conn.end()

  // 2. 初始化 TypeORM
  AppDataSource = new DataSource({
    type: 'mysql',
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    username: DB_CONFIG.user,
    password: DB_CONFIG.password,
    database: DB_CONFIG.database,
    synchronize: true, // 开发模式自动同步表结构
    logging: false,
    entities: [
      UserEntity,
      TeamEntity,
      TeamMemberEntity,
      GroupEntity,
      ProxyEntity,
      ProfileEntity,
      AccountEntity,
      CookieEntity,
      OperationLogEntity,
      ApiTokenEntity,
      AppSettingsEntity,
      ExtensionEntity,
      RpaScriptEntity
    ]
  })
  await AppDataSource.initialize()

  // 重启自愈：进程退出时所有 BrowserWindow 都会被销毁，但 DB 里可能残留
  // status='running'。若不清理，UI 会显示「运行中」却无真实窗口，导致打开/
  // 关闭/RPA 回放全部失灵。启动时把残留 running 重置为 idle。
  await AppDataSource.getRepository(ProfileEntity)
    .update({ status: 'running' }, { status: 'idle' })
    .catch(() => undefined)

  // 3. 种子数据：默认管理员
  const userRepo = AppDataSource.getRepository(UserEntity)
  const adminCount = await userRepo.count()
  if (adminCount === 0) {
    const admin = await userRepo.save(
      userRepo.create({ username: 'admin', passwordHash: await bcrypt.hash('123456', 10), nickname: '管理员' })
    )
    const teamRepo = AppDataSource.getRepository(TeamEntity)
    const team = await teamRepo.save(teamRepo.create({ name: '默认团队' }))
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    await memberRepo.save(memberRepo.create({ teamId: team.id, userId: admin.id, role: 'owner' }))
    const groupRepo = AppDataSource.getRepository(GroupEntity)
    await groupRepo.save(groupRepo.create({ teamId: team.id, name: 'Default', sort: 0 }))
    console.log('[roxy] 已创建默认账号 admin / 123456')
  }

  // 4. 启动 HTTP 服务（端口占用则递增）
  const app: Express = express()
  app.use(cors())
  app.use(express.json({ limit: '2mb' }))
  app.use('/api', buildApiRouter())
  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  // 统一错误处理
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[roxy] 请求处理异常:', err)
    if (!res.headersSent) res.status(500).json({ message: err.message || '服务器内部错误' })
  })

  let port = START_PORT
  const server = await new Promise<http.Server>((resolve, reject) => {
    const tryListen = (): void => {
      const s = http.createServer(app)
      s.once('error', () => {
        port++
        if (port > START_PORT + 20) return reject(new Error('无法找到可用端口'))
        tryListen()
      })
      s.listen(port, '127.0.0.1', () => resolve(s))
    }
    tryListen()
  })
  const realPort = (server.address() as AddressInfo).port
  apiBase = `http://127.0.0.1:${realPort}`

  // 端口可能被占用而自动递增，把真实地址落盘，方便外部脚本 / 自动化工具发现
  try {
    const dir = join(homedir(), '.roxy-clone')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'api-base.json'),
      JSON.stringify({ apiBase, port: realPort, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
  } catch (e) {
    console.warn('[roxy] 写入 API 地址文件失败:', (e as Error).message)
  }

  console.log(`[roxy] API 服务已启动: ${apiBase}`)

  // 5. 启动代理定时巡检调度（间隔由设置决定，0 表示关闭）
  startProxyCheckScheduler().catch((e) => console.error('[roxy] 启动巡检调度失败:', e))
  // 6. 启动 RPA 定时执行调度器（每 30s 扫描到点脚本；环境未运行则跳过并写日志）
  startRpaScheduleScheduler()

  return apiBase
}
