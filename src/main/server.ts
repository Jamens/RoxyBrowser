import 'reflect-metadata'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import cors from 'cors'
import http from 'http'
import crypto from 'crypto'
import { homedir } from 'os'
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs'
import { join, sep } from 'path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import { DataSource, In, IsNull } from 'typeorm'
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
import { randomFingerprint, defaultFingerprint, listFingerprintPresets, normalizeFingerprint, deriveJitteredFingerprint } from '../shared/fingerprint'
import { substituteSteps } from '../shared/rpa'
import { normalizeCountry } from '../shared/countries'
import { normalizeLocale } from '../shared/locales'
import type { Fingerprint, AppSettings, OSKind, RpaStep, AIAgentSettings } from '../shared/types'
import { DEFAULT_START_URL, DEFAULT_SETTINGS, normalizeSearchEngine } from '../shared/types'
import { buildHealthReport, type FingerprintProbe } from '../shared/healthcheck'
import {
  exportProfileFull,
  importProfileItems,
  exportProxiesStructured,
  importProxiesStructured,
  exportRpaStructured,
  importRpaStructured,
  exportExtensionsMeta,
  buildSnapshot
} from './exporters'
import { SNAPSHOT_FORMAT, SNAPSHOT_VERSION, validateSnapshot, normalizeSnapshot, type SnapshotFile } from '../shared/snapshot'
import { getSystemStats } from './systemStats'
import { checkOllamaStatus, ollamaChat, type OllamaMessage } from './agent/ollama'
import { cloudChat, checkCloudStatus } from './agent/cloud'
import { buildSupportSystemPrompt } from './agent/knowledge'

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
  /** 环境体检：在目标窗口内采集实际生效的指纹值，窗口未运行返回 null */
  probeFingerprint(profileId: number): Promise<FingerprintProbe | null>
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

// 实时角色：JWT 里的 role 在「调整成员角色」后会过期，敏感操作以数据库为准，保证权限调整即时生效
async function freshRole(req: AuthedRequest): Promise<string> {
  try {
    const m = await AppDataSource.getRepository(TeamMemberEntity).findOne({ where: { teamId: req.tid, userId: req.uid } })
    return m?.role || req.role || 'member'
  } catch {
    return req.role || 'member'
  }
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

// 敏感操作：导出（数据外泄）/ 删除 / 改角色 / 成员与令牌管理 / 密码重置等
const SENSITIVE_LOG_KEYWORDS = ['delete', 'purge', 'export', 'import', 'role', 'member', 'token', 'password', 'reset']
function isSensitiveAction(action: string): boolean {
  const a = action.toLowerCase()
  return SENSITIVE_LOG_KEYWORDS.some((k) => a.includes(k))
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
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      sensitive: isSensitiveAction(action)
    })
  )
}

/**
 * AI Agent 执行日志：与 writeLog 同一张表，但没有 HTTP 请求上下文（Agent 由主进程 IPC 驱动，
 * 拿不到 req.tid/req.uid）。teamId 取自目标环境所属团队；操作人由渲染进程传入当前登录用户，
 * 缺省记为 0 / 'ai-agent'。
 */
export async function writeAgentLog(input: {
  profileId?: number
  action: string
  detail: string
  actor?: { userId: number; username: string }
}): Promise<void> {
  try {
    if (!AppDataSource?.isInitialized) return
    let teamId = 0
    if (input.profileId) {
      const p = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: input.profileId } })
      teamId = p?.teamId || 0
    }
    // 无明确团队归属就不落库，避免出现 teamId=0 的孤儿日志
    if (!teamId) return
    const repo = AppDataSource.getRepository(OperationLogEntity)
    await repo.save(
      repo.create({
        teamId,
        userId: input.actor?.userId ?? 0,
        username: input.actor?.username || 'ai-agent',
        action: input.action,
        detail: input.detail,
        sensitive: isSensitiveAction(input.action)
      })
    )
  } catch (e) {
    console.error('[agent-log] 写入失败:', e instanceof Error ? e.message : e)
  }
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

async function checkProxy(
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

// 读取合并后的全局设置（兜底默认值）
export async function getSettings(): Promise<AppSettings> {
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
      p.anonymity = result.anonymity
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

// RPA 变量：接受对象或 [key,value] 数组，统一规整成 {k: string}；空 / 非法 → {}
function normalizeVariables(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, string> = {}
  if (Array.isArray(v)) {
    for (const item of v as Array<{ key?: unknown; value?: unknown }>) {
      const k = String(item?.key ?? '').trim()
      if (k) out[k] = String(item?.value ?? '')
    }
  } else {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k) out[k] = String(val ?? '')
    }
  }
  return Object.keys(out).length ? out : null
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
        executed = await (await import('./browserManager')).replayRpaScript(
          s.scheduleProfileId!,
          substituteSteps(s.steps as unknown as RpaStep[], s.variables || {})
        )
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

// ===================== 全空间快照定时自动备份 =====================
let snapshotBackupTimer: ReturnType<typeof setInterval> | null = null

async function runSnapshotBackupAll(): Promise<void> {
  const settings = await getSettings()
  const enabled = !!settings.snapshotBackupEnabled
  const dir = typeof settings.snapshotBackupDir === 'string' ? settings.snapshotBackupDir.trim() : ''
  if (!enabled || !dir) return
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(dir)
  } catch {
    console.error('[roxy] 快照备份目录不可访问:', dir)
    return
  }
  if (!st.isDirectory()) {
    console.error('[roxy] 快照备份路径不是目录:', dir)
    return
  }
  const teamRepo = AppDataSource.getRepository(TeamEntity)
  const teams = await teamRepo.find()
  if (teams.length === 0) return
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  let ok = 0
  for (const team of teams) {
    try {
      const snap = await buildSnapshot({ tid: team.id, role: 'owner' }, '系统定时备份')
      const file = join(dir, `roxy-snapshot-${team.id}-${stamp}.json`)
      writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8')
      pruneSnapshotBackups(dir, team.id)
      ok++
    } catch (e) {
      console.error(`[roxy] 团队 ${team.id} 快照备份失败:`, (e as Error).message)
    }
  }
  console.log(`[roxy] 快照定时备份完成：${ok}/${teams.length} 个团队 -> ${dir}`)
}

// 每个团队仅保留最近 7 份备份，避免目录无限增长（文件名含固定宽度时间戳，字典序即时间序）
function pruneSnapshotBackups(dir: string, teamId: number): void {
  try {
    const prefix = `roxy-snapshot-${teamId}-`
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .sort()
    while (files.length > 7) {
      const old = files.shift()
      if (old) {
        try {
          unlinkSync(join(dir, old))
        } catch {
          /* 忽略单文件删除失败 */
        }
      }
    }
  } catch {
    /* 忽略目录读取失败 */
  }
}

async function startSnapshotBackupScheduler(): Promise<void> {
  if (snapshotBackupTimer) {
    clearInterval(snapshotBackupTimer)
    snapshotBackupTimer = null
  }
  const settings = await getSettings()
  const enabled = !!settings.snapshotBackupEnabled
  const dir = typeof settings.snapshotBackupDir === 'string' ? settings.snapshotBackupDir.trim() : ''
  const intervalH = Number(settings.snapshotBackupIntervalH) || 24
  if (!enabled || !dir || !(intervalH > 0)) {
    console.log('[roxy] 全空间快照定时备份未启用')
    return
  }
  snapshotBackupTimer = setInterval(() => {
    runSnapshotBackupAll().catch((e) => console.error('[roxy] 快照定时备份异常:', e))
  }, intervalH * 3600 * 1000)
  console.log(`[roxy] 全空间快照定时备份已启动，间隔 ${intervalH} 小时，目录 ${dir}`)
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
// excludeProxyId：切换线路场景排除当前绑定的代理，保证换到的是「另一条线路」
async function allocateProxy(
  teamId: number,
  opts: { profileId?: number | null; country?: string; region?: string; excludeProxyId?: number | null }
): Promise<{ proxy: ProxyEntity; profileId: number | null; reused: boolean; poolStatus: 'available' | 'in-use' }> {
  const repo = AppDataSource.getRepository(ProxyEntity)
  const now = Date.now()
  const usage = await computeProxyUsage(teamId)
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
// AI Agent Dispatcher（P0 关键词版）：判定一条消息走 Chat（通用对话）还是 Support（产品客服）。
// 规则来自设计文档 §3.5：问「XX 功能是什么 / 怎么用 / 怎么做」→ Support；其余 → Chat。
// Agent 执行模式（操作动词 + @窗口）属 P1，届时在此扩展第三个分支。
const AI_PRODUCT_TERMS = [
  '环境', '窗口', '指纹', '代理', 'proxy', 'ip', '账号', 'cookie', '扩展', '插件',
  'rpa', '模板', '分组', '团队', '日志', '设置', '看板', 'api', '自动化', '登录', '注册',
  '起始页', '搜索引擎', '任务栏', '网络', '同步', '迁移', '导入', '导出', '检测', '巡检'
]
function aiAgentDispatch(question: string): 'chat' | 'support' {
  const q = question.toLowerCase()
  // 命中产品相关词 → 产品客服；纯闲聊 / 通用问题 → 通用对话。
  // 疑问句式（怎么/是什么…）不单独触发路由，避免「怎么写 Python」这类通用问题被误路由。
  return AI_PRODUCT_TERMS.some((term) => q.includes(term)) ? 'support' : 'chat'
}

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
    res.json({ id: user.id, username: user.username, nickname: user.nickname, role: await freshRole(req) })
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
      // 回收站（软删除）的环境不出现在常规列表；templates 查询同样排除
      .andWhere('p.deletedAt IS NULL')
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
    const qb = repo
      .createQueryBuilder('p')
      .where('p.teamId = :tid', { tid })
      .andWhere('p.isTemplate = 0')
      .andWhere('p.deletedAt IS NULL')
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
  // ===== 回收站（软删除）：列表 / 恢复 / 彻底删除 =====
  // 注意路由顺序：静态段 /trash 必须排在参数段 /:id 之前
  router.get('/profiles/trash', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const qb = repo
      .createQueryBuilder('p')
      .where('p.teamId = :tid', { tid: req.tid })
      .andWhere('p.isTemplate = 0')
      .andWhere('p.deletedAt IS NOT NULL')
      .orderBy('p.deletedAt', 'DESC')
    ownerAndWhere(qb, req)
    const list = await qb.getMany()
    res.json(
      list.map((p) => ({
        id: p.id,
        name: p.name,
        seq: p.seq,
        platform: p.platform,
        proxyId: p.proxyId,
        deletedAt: p.deletedAt
      }))
    )
  })

  router.post('/profiles/:id/restore', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (!p.deletedAt) return res.status(400).json({ message: '该环境不在回收站中' })
    p.deletedAt = null
    await repo.save(p)
    await writeLog(req, 'restore_profile', `从回收站恢复环境「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  router.delete('/profiles/:id/purge', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (!p.deletedAt) return res.status(400).json({ message: '仅回收站中的环境可彻底删除' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口' })
    // 彻底删除：级联清理关联账号与 Cookie，并把绑定该代理的其他环境解绑（沿用旧删除语义）
    await repo.remove(p)
    const accRepo = AppDataSource.getRepository(AccountEntity)
    await accRepo.delete({ profileId: p.id })
    const cookieRepo = AppDataSource.getRepository(CookieEntity)
    await cookieRepo.delete({ profileId: p.id })
    await writeLog(req, 'purge_profile', `彻底删除环境「${p.name}」(#${p.id})（含账号与 Cookie）`)
    res.json({ ok: true })
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

  // 整环境迁移：导出（含指纹 / 分组 / 代理 / 账号 / Cookie / 扩展名；扩展以名称带出，导入按名重映射）
  router.get('/profiles/export/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    // 复用导出器，保证「单环境导出」与「全空间快照」走同一套结构，往返一致
    const data = await exportProfileFull(p, { tid: req.tid!, uid: req.uid, role: req.role })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="profile-${p.id}-${encodeURIComponent(p.name)}.json"`)
    res.send(JSON.stringify(data, null, 2))
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

  // 手动切换线路（对标官方）：从 IP 池分配一条「不同的」可用代理替换当前绑定。
  // 旧代理随 proxyId 覆盖自动释放回池（占用数 -1）。运行中的环境只改绑定，
  // 窗口代理在打开时注入，需重启环境才生效（响应里带 running 标记由前端提示）。
  router.post('/profiles/:id/switch-line', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    try {
      const { proxy, reused } = await allocateProxy(req.tid!, {
        excludeProxyId: p.proxyId,
        country: (req.body || {}).country,
        region: (req.body || {}).region
      })
      const oldProxy = p.proxyId ? await AppDataSource.getRepository(ProxyEntity).findOne({ where: { id: p.proxyId } }) : null
      p.proxyId = proxy.id
      await repo.save(p)
      const running = p.status === 'running'
      await writeLog(
        req,
        'switch_line',
        `环境「${p.name}」(#${p.id})切换线路：${oldProxy ? `「${oldProxy.name}」` : '（无代理）'} → 「${proxy.name}」(#${proxy.id})${reused ? '（池中无空闲代理，复用已占用代理）' : ''}${running ? '；环境运行中，重启后生效' : ''}`
      )
      res.json({ proxy, running, oldProxyId: oldProxy?.id ?? null })
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ message: e.message })
      throw e
    }
  })

  router.delete('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口' })
    // 软删除：进回收站，关联账号 / Cookie 原样保留，恢复即完整还原
    p.deletedAt = new Date()
    await repo.save(p)
    await writeLog(req, 'delete_profile', `删除环境「${p.name}」(#${p.id})（已进回收站）`)
    res.json({ ok: true, trashed: true })
  })

  router.post('/profiles/:id/open', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
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

  // 环境体检：把「数据库里的设定指纹」与「窗口内实测回读值」对撞，
  // 输出伪装度分与一致性红绿灯（IP国家 ↔ 时区 ↔ 语言 ↔ UA 是否自洽）。
  // 必须在环境窗口运行时执行——注入生效与否只有在真实页面上下文里才读得准。
  router.post('/profiles/:id/healthcheck', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    if (!browserBridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    if (p.status !== 'running') return res.status(400).json({ message: '请先打开环境窗口，再执行体检' })
    const actual = await browserBridge.probeFingerprint(p.id)
    if (!actual) return res.status(400).json({ message: '环境窗口未运行，请打开后再体检' })
    if (actual.error) return res.status(500).json({ message: `指纹采集失败：${actual.error}` })
    let proxyCountry = ''
    if (p.proxyId) {
      const px = await AppDataSource.getRepository(ProxyEntity).findOne({ where: { id: p.proxyId } })
      proxyCountry = px?.country || ''
    }
    const report = buildHealthReport(p.fingerprint as unknown as Partial<Fingerprint>, actual, { proxyCountry })
    res.json(report)
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
    p.anonymity = result.anonymity
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
    // 成员角色不返回明文密码（对标官方 3.8.9 账号权限管理），仅打标记由前端展示「无权限查看」
    const canView = isAdminRole(await freshRole(req))
    res.json(
      list.map((a) => ({
        ...a,
        password: canView ? a.password : '',
        passwordMasked: !canView,
        profileName: nameMap.get(a.profileId) || ''
      }))
    )
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
    // 成员角色不允许改密码（看不到明文，避免误清空/越权修改）
    const fields = (await freshRole(req)) === 'member' ? (['platform', 'username', 'remark'] as const) : (['platform', 'username', 'password', 'remark'] as const)
    for (const f of fields) {
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
      // 跳过模板表头与注释行（对标官方模板批量导入：模板第一行是表头，; 或 // 开头为注释）
      if (line.startsWith(';') || line.startsWith('//') || /^(环境|平台)\s*[,，]/.test(line)) continue
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
  // 含明文密码，仅 owner/admin 可用（对标官方 3.8.9 批量导出按角色控权）
  router.get('/accounts/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (!isAdminRole(await freshRole(req))) return res.status(403).json({ message: '无权限：仅管理员可导出账号' })
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

  // 更新团队信息（名称 / 图标）
  router.put('/team', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const repo = AppDataSource.getRepository(TeamEntity)
    const team = await repo.findOne({ where: { id: req.tid } })
    if (!team) return res.status(404).json({ message: '团队不存在' })
    const { name, icon } = req.body || {}
    if (typeof name === 'string' && name.trim()) team.name = name.trim()
    if (icon !== undefined) team.icon = icon ? String(icon) : null
    await repo.save(team)
    await writeLog(req, 'update_team', `更新团队信息`)
    res.json({ ok: true, team: { id: team.id, name: team.name, icon: team.icon } })
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

  // 可邀请的已有成员：系统中已存在、但尚未加入当前团队的账号（供「勾选已有成员」使用）
  router.get('/team/candidates', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const userRepo = AppDataSource.getRepository(UserEntity)
    const members = await memberRepo.find({ where: { teamId: req.tid } })
    const inTeam = new Set(members.map((m) => m.userId))
    const users = await userRepo.find({ order: { id: 'ASC' } })
    res.json(
      users
        .filter((u) => !inTeam.has(u.id))
        .map((u) => ({ id: u.id, username: u.username, nickname: u.nickname }))
    )
  })

  // 批量把已有账号加入本团队（勾选已有成员一键邀请）
  router.post('/team/members/batch', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const { userIds, role } = req.body || {}
    if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ message: '请选择要邀请的成员' })
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const userRepo = AppDataSource.getRepository(UserEntity)
    let added = 0
    for (const raw of userIds) {
      const uid = Number(raw)
      if (!uid) continue
      const user = await userRepo.findOne({ where: { id: uid } })
      if (!user) continue
      const exists = await memberRepo.findOne({ where: { teamId: req.tid, userId: uid } })
      if (exists) continue
      await memberRepo.save(memberRepo.create({ teamId: req.tid!, userId: uid, role: role || 'member' }))
      added++
    }
    if (added === 0) return res.status(400).json({ message: '所选成员均已在团队中' })
    await writeLog(req, 'add_member', `批量邀请 ${added} 位已有成员`)
    res.json({ ok: true, added })
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
    // AI Agent 子对象深合并默认值：UI 仅暴露部分字段，避免未展示字段被覆盖成 undefined
    if (merged.aiAgent && typeof merged.aiAgent === 'object') {
      merged.aiAgent = { ...DEFAULT_SETTINGS.aiAgent, ...(merged.aiAgent as Record<string, unknown>) }
    }
    let row = await repo.findOne({ where: { key: 'global' } })
    if (!row) row = repo.create({ key: 'global', settings: merged })
    else row.settings = merged
    await repo.save(row)
    // 设置变更后重新调度定时巡检（间隔可能为 0 = 关闭）
    startProxyCheckScheduler().catch((e) => console.error('[roxy] 重启巡检调度失败:', e))
    res.json({ ok: true, settings: merged })
  })

  // ===== AI Agent：连通性探针（本地 Ollama 或 云端 BYOK）=====
  router.post('/ai-agent/status', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const settings = await getSettings()
    // 优先用前端表单（可能尚未保存）传入的 aiAgent 配置做检测：避免「选了云端、没保存就点检测」
    // 却用旧的已保存后端配置（本地）探活，误报为「本地已连接」。
    const override = (req.body && (req.body as { aiAgent?: Partial<AIAgentSettings> }).aiAgent) || null
    const a = override
      ? { ...(settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings)), ...override }
      : (settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings))
    // 探活需同时校验「文本模型（对话用）」与「视觉模型（Agent 执行闭环看屏用）」，
    // 与 runner.ts 的 agent:start 预检保持一致：避免出现「状态显示正常、真正执行才报错」。
    if (a.backend === 'cloud') {
      const text = await checkCloudStatus({
        provider: a.cloudProvider, baseUrl: a.cloudBaseUrl, apiKey: a.cloudApiKey, model: a.cloudModel
      })
      const vision = await checkCloudStatus({
        provider: a.cloudProvider, baseUrl: a.cloudBaseUrl, apiKey: a.cloudApiKey, model: a.cloudVisionModel
      })
      const reachable = text.reachable && vision.reachable
      const error = !text.reachable
        ? `文本模型自检失败（${text.model || '未配置'}）：${text.error || '未知错误'}`
        : !vision.reachable
          ? `视觉模型自检失败（${vision.model || '未配置'}）：${vision.error || '未知错误'}`
          : undefined
      res.json({
        backend: 'cloud',
        reachable,
        baseUrl: text.baseUrl,
        model: text.model,
        modelPulled: text.reachable,
        models: [],
        error,
        visionModel: vision.model,
        visionReachable: vision.reachable,
        visionError: !vision.reachable ? vision.error : undefined
      })
      return
    }
    // 本地：文本模型与视觉模型都走本机 Ollama，需各自确认已拉取
    const visionModel = a.localVisionModel || 'minicpm-v:latest'
    const text = await checkOllamaStatus({ model: a.localModel })
    const vision = await checkOllamaStatus({ model: visionModel })
    const reachable = text.reachable
    const modelPulled = text.modelPulled && vision.modelPulled
    const error = !text.reachable
      ? text.error
      : !text.modelPulled
        ? `文本模型「${a.localModel}」未安装（本机已安装：${text.models.join('、') || '无'}）`
        : !vision.modelPulled
          ? `视觉模型「${visionModel}」未安装（本机已安装：${vision.models.join('、') || '无'}）`
          : undefined
    res.json({
      backend: 'local',
      reachable,
      baseUrl: text.baseUrl,
      model: text.model,
      modelPulled,
      models: text.models,
      error,
      visionModel,
      visionReachable: vision.reachable,
      visionError: !vision.reachable ? vision.error : (!vision.modelPulled ? '视觉模型未安装' : undefined)
    })
  })

  // ===== AI Agent：Chat/Support 对话（本地 Ollama，零 token）=====
  // body: { messages: [{role,content}], mode?: 'chat' | 'support' | 'auto' }
  // mode=auto 时由 Dispatcher 做轻量意图路由（P0 用关键词规则，见 aiAgentDispatch）
  router.post('/ai-agent/chat', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const settings = await getSettings()
    const a = settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings)
    if (!a.enabled) {
      res.status(400).json({ message: 'AI Agent 未启用，请先在「设置 → AI Agent」开启' })
      return
    }
    // 白名单校验消息结构，最多带最近 20 条历史（本地模型上下文有限，防撑爆）
    const raw = Array.isArray((req.body || {}).messages) ? req.body.messages : []
    const msgs: OllamaMessage[] = []
    for (const m of raw.slice(-20)) {
      const role = (m && m.role) as string
      const content = typeof (m && m.content) === 'string' ? m.content : ''
      if ((role === 'user' || role === 'assistant' || role === 'system') && content.trim()) {
        msgs.push({ role, content })
      }
    }
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
      res.status(400).json({ message: '消息列表为空或最后一条不是用户消息' })
      return
    }
    // 模式路由：显式指定优先；auto 走 Dispatcher 关键词规则
    const reqMode = (req.body || {}).mode
    const lastQuestion = msgs[msgs.length - 1].content
    const mode: 'chat' | 'support' =
      reqMode === 'support' || reqMode === 'chat' ? reqMode : aiAgentDispatch(lastQuestion)
    // Support 模式：检索产品文档片段，作为 system 消息注入（不透传历史里的旧 system）
    const finalMsgs: OllamaMessage[] =
      mode === 'support'
        ? [{ role: 'system', content: buildSupportSystemPrompt(lastQuestion) }, ...msgs.filter((m) => m.role !== 'system')]
        : msgs
    // 云端 BYOK：OpenAI 兼容 chat/completions，用户自带 Key（会产生 token 费用）
    if (a.backend === 'cloud') {
      if (!a.cloudApiKey?.trim() || !a.cloudModel?.trim()) {
        res.status(400).json({ message: '云端模型未配置：请在「设置 → AI Agent」填写 API Key 与模型名' })
        return
      }
      try {
        const reply = await cloudChat({
          provider: a.cloudProvider,
          baseUrl: a.cloudBaseUrl,
          apiKey: a.cloudApiKey,
          model: a.cloudModel,
          messages: finalMsgs
        })
        res.json({ reply, mode })
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        res.status(502).json({ message: `云端模型调用失败：${detail}` })
      }
      return
    }
    try {
      const reply = await ollamaChat({ model: a.localModel, messages: finalMsgs })
      res.json({ reply, mode })
    } catch (e) {
      // Ollama 未启动 / 模型未拉取等场景给可操作的提示
      const detail = e instanceof Error ? e.message : String(e)
      res.status(502).json({ message: `本地模型调用失败：${detail}（请确认 Ollama 已启动且已 pull 模型 ${a.localModel}）` })
    }
  })

  // ===== 自动化 API (v1，令牌鉴权，供脚本调用) =====
  const v1 = express.Router()
  v1.use(tokenAuthMiddleware)

  v1.get('/profiles', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    // 排除回收站中的环境（软删除）：TypeORM 需显式用 IsNull() 表达 IS NULL
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid, isTemplate: false, deletedAt: IsNull() } })
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
    p.anonymity = result.anonymity
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

  // ===== Cookie（v1 自动化读写，按环境隔离）=====
  v1.get('/cookies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const list = await repo.find({ where: { teamId: tid, profileId }, order: { domain: 'ASC', name: 'ASC' } })
    res.json({ code: 0, data: list.map(mapCookie) })
  })

  v1.post('/cookies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const b = req.body || {}
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: Number(b.profileId), teamId: tid } })
    if (!profile) return res.status(400).json({ code: 400, message: 'profile not found' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const c = await repo.save(
      repo.create({
        teamId: tid,
        ownerId: 0,
        profileId: profile.id,
        domain: (b.domain || '').trim(),
        name: (b.name || '').trim(),
        value: b.value == null ? '' : String(b.value),
        path: b.path || '/',
        secure: !!b.secure,
        httpOnly: !!b.httpOnly,
        sameSite: b.sameSite || 'unspecified',
        expirationDate: b.expirationDate ? new Date(b.expirationDate) : null,
        hostOnly: b.hostOnly == null ? true : !!b.hostOnly
      })
    )
    res.json({ code: 0, data: mapCookie(c) })
  })

  v1.put('/cookies/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!c) return res.status(404).json({ code: 404, message: 'cookie not found' })
    const b = req.body || {}
    for (const f of ['domain', 'name', 'value', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate', 'hostOnly'] as const) {
      if (f in b) {
        if (f === 'expirationDate') (c as any)[f] = b[f] ? new Date(b[f]) : null
        else if (f === 'value') (c as any)[f] = b[f] == null ? '' : String(b[f])
        else (c as any)[f] = b[f]
      }
    }
    await repo.save(c)
    res.json({ code: 0, data: mapCookie(c) })
  })

  v1.delete('/cookies/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(CookieEntity)
    const c = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!c) return res.status(404).json({ code: 404, message: 'cookie not found' })
    await repo.remove(c)
    res.json({ code: 0, data: { id: c.id } })
  })

  v1.delete('/cookies', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const r = await repo.delete({ teamId: tid, profileId })
    res.json({ code: 0, data: { deleted: r.affected || 0 } })
  })

  v1.post('/cookies/import', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const b = req.body || {}
    const profileId = Number(b.profileId)
    const text: string = b.text || ''
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    if (!text.trim()) return res.status(400).json({ code: 400, message: 'empty cookie text' })
    const { cookies, failed } = parseCookieText(text)
    if (!cookies.length) return res.status(400).json({ code: 400, message: 'no cookie parsed', data: { failed } })
    const repo = AppDataSource.getRepository(CookieEntity)
    const saved = await repo.save(
      cookies.map((c) =>
        repo.create({
          teamId: tid,
          ownerId: 0,
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
    res.json({ code: 0, data: { imported: saved.length, failed } })
  })

  v1.get('/cookies/export', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const repo = AppDataSource.getRepository(CookieEntity)
    const list = await repo.find({ where: { teamId: tid, profileId }, order: { domain: 'ASC', name: 'ASC' } })
    const text = list
      .map((c) => {
        const flag = c.hostOnly ? 'FALSE' : 'TRUE'
        const exp = c.expirationDate ? Math.floor(new Date(c.expirationDate).getTime() / 1000) : 0
        return [c.domain, flag, c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t')
      })
      .join('\n')
    res.json({ code: 0, data: { text, count: list.length } })
  })

  v1.post('/cookies/apply', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.query as Record<string, string>).profileId || (req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    try {
      const { applyCookies } = await import('./browserManager')
      const n = await applyCookies(profileId)
      res.json({ code: 0, data: { applied: n } })
    } catch (e) {
      res.status(400).json({ code: 400, message: (e as Error).message })
    }
  })

  // ===== RPA 脚本（v1 自动化触发）=====
  // 列出当前团队的脚本（用于外部自动化查找 id / 步数 / 是否含变量）
  v1.get('/rpa', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(RpaScriptEntity)
    const list = await repo.find({ where: { teamId: tid }, order: { id: 'DESC' } })
    res.json({
      code: 0,
      data: list.map((s) => ({
        id: s.id,
        name: s.name,
        steps: (s.steps as unknown as RpaStep[]).length,
        hasVariables: !!(s.variables && Object.keys(s.variables).length)
      }))
    })
  })

  // 脚本详情（含完整步骤与变量，供外部自动化取用）
  v1.get('/rpa/:id', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const repo = AppDataSource.getRepository(RpaScriptEntity)
    const s = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!s) return res.status(404).json({ code: 404, message: 'script not found' })
    res.json({
      code: 0,
      data: {
        id: s.id,
        name: s.name,
        remark: s.remark,
        steps: s.steps,
        variables: s.variables || {},
        scheduleEnabled: s.scheduleEnabled
      }
    })
  })

  // 触发回放（Bearer 鉴权，供外部自动化调用）。body: { profileId, variables? }
  v1.post('/rpa/:id/run', async (req: Request, res: Response) => {
    const tid = (req as AuthedRequest).tid!
    const profileId = Number((req.body || {}).profileId)
    if (!profileId) return res.status(400).json({ code: 400, message: 'profileId required' })
    const repo = AppDataSource.getRepository(RpaScriptEntity)
    const s = await repo.findOne({ where: { id: Number(req.params.id), teamId: tid } })
    if (!s) return res.status(404).json({ code: 404, message: 'script not found' })
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: tid } })
    if (!profile) return res.status(404).json({ code: 404, message: 'profile not found' })
    const reqVars = (req.body || {}).variables
    const vars = reqVars && typeof reqVars === 'object' && Object.keys(reqVars).length
      ? normalizeVariables(reqVars) || {}
      : s.variables || {}
    const steps = substituteSteps(s.steps as unknown as RpaStep[], vars)
    const runningIds = (await import('./browserManager')).getRunningWindowIds()
    if (!runningIds.includes(profileId)) {
      return res.status(400).json({ code: 400, message: 'profile not running' })
    }
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await (await import('./browserManager')).replayRpaScript(profileId, steps)
      } catch (e) {
        err = (e as Error).message
      }
      await writeLog(
        req as AuthedRequest,
        'rpa_run',
        err
          ? `v1 回放脚本「${s.name}」失败：${err}`
          : `v1 回放脚本「${s.name}」完成（环境「${profile.name}」#${profileId}，执行 ${executed}/${steps.length} 步）`
      )
    })()
    res.json({ code: 0, data: { started: true, steps: steps.length } })
  })

  // ===== 批量能力：导入 / 导出 / 复制 / 批量随机指纹 =====

  // 导入环境（JSON）：兼容纯环境数组，也支持带分组 / 代理 / 账号的完整迁移文件
  router.post('/profiles/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const payload = req.body || {}
    // 支持三种入参：{ items: [...] }（批量）、整环境导出单对象（含 name 字段）、裸数组 [...]
    const items = (Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : payload && payload.name
          ? [payload]
          : []) as Array<Record<string, unknown>>
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: '没有可导入的数据' })
    // 复用导出器里的导入实现，保证与全空间快照导入同源
    const summary = await importProfileItems(items, { tid: req.tid!, uid: req.uid, role: req.role })
    if (summary.created === 0) return res.status(400).json({ message: '没有有效的环境可导入' })
    await writeLog(
      req,
      'import_profiles',
      `导入 ${summary.created} 个环境（新建分组 ${summary.groupsCreated} 个、代理 ${summary.proxiesCreated} 条、账号 ${summary.accountsCreated} 条、Cookie ${summary.cookiesCreated} 条）`
    )
    res.json({
      created: summary.created,
      items: summary.items,
      groupsCreated: summary.groupsCreated,
      proxiesCreated: summary.proxiesCreated,
      accountsCreated: summary.accountsCreated,
      cookiesCreated: summary.cookiesCreated
    })
  })

  // ===== 全空间快照：把整个团队空间打包为单一 JSON（环境 + 代理 + RPA + 扩展引用）=====
  // 复用各模块导出器拼装；导入端同样复用各模块导入器，保证「整环境迁移」与「整团队迁移」同源。
  router.get('/snapshot/export', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const snap = await buildSnapshot({ tid: req.tid!, uid: req.uid, role: req.role }, req.username)
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="roxy-snapshot-${req.tid}-${stamp}.json"`)
    res.send(JSON.stringify(snap, null, 2))
  })

  // 一键灌入：先恢复代理池（按名称复用），再导入环境（引用同名代理），最后导入 RPA。
  // 扩展为名称引用，目标缺同名扩展则自动丢弃引用（与单环境导入行为一致）。
  router.post('/snapshot/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const v = validateSnapshot(req.body)
    if (!v.ok) return res.status(400).json({ message: '快照文件不合法：' + v.errors.join('；'), detail: v })
    const data = normalizeSnapshot(req.body as SnapshotFile)
    const proxyRes = await importProxiesStructured(data.proxies, { tid: req.tid!, uid: req.uid, role: req.role })
    const profRes = await importProfileItems(data.profiles as unknown as Array<Record<string, unknown>>, {
      tid: req.tid!,
      uid: req.uid,
      role: req.role
    })
    const rpaRes = await importRpaStructured(data.rpa, { tid: req.tid!, uid: req.uid, role: req.role })
    if (profRes.created === 0 && proxyRes.imported === 0 && rpaRes.created === 0) {
      return res.status(400).json({ message: '快照中没有可导入的内容' })
    }
    await writeLog(
      req,
      'import_snapshot',
      `导入快照（团队「${data.team.name || req.tid}」）：环境 ${profRes.created} 个、代理 ${proxyRes.imported} 条、RPA ${rpaRes.created} 个`
    )
    res.json({
      ok: true,
      profiles: profRes.created,
      groupsCreated: profRes.groupsCreated,
      proxiesCreated: proxyRes.imported,
      proxiesSkipped: proxyRes.skipped,
      rpaCreated: rpaRes.created,
      extensionsReferenced: data.extensions.length
    })
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

  // 环境克隆工厂：以某环境为母本批量派生 N 个副本。
  // 与 /duplicate（单个、指纹原样复制）的关键区别——每个副本都做「指纹微抖动」：
  // 行为一致（系统 / UA / 语言 / 时区 / 噪声开关），指纹各异（分辨率 / CPU / 内存 / 显卡 / 字体），
  // 避免批量号共用同一套设备特征被一锅端。
  // 明确不复制 Cookie：登录态复制过去等于主动制造关联。
  router.post('/profiles/:id/duplicate-batch', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const src = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!src) return res.status(404).json({ message: '环境不存在' })
    if (src.isTemplate) return res.status(400).json({ message: '模板环境不支持批量克隆' })
    const body = req.body || {}
    const count = Math.max(1, Math.min(50, Number(body.count) || 1))
    const namePrefix = String(body.namePrefix || src.name).trim() || src.name
    const copyAccounts = !!body.copyAccounts
    const srcFp = (src.fingerprint || {}) as unknown as Fingerprint

    const accRepo = AppDataSource.getRepository(AccountEntity)
    const accounts = copyAccounts ? await accRepo.find({ where: { profileId: src.id } }) : []

    const qbBatch = repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
    ownerAndWhere(qbBatch, req)
    let seq = ((await qbBatch.getRawOne<{ m: number | null }>())?.m || 1000) + 1

    const created: { id: number; name: string }[] = []
    for (let i = 1; i <= count; i++) {
      const copy = await repo.save(
        repo.create({
          teamId: req.tid!,
          ownerId: req.uid!,
          groupId: src.groupId,
          name: `${namePrefix} ${i}`,
          seq: seq++,
          remark: src.remark,
          platform: src.platform,
          startUrl: src.startUrl,
          proxyId: null,
          fingerprint: deriveJitteredFingerprint(srcFp) as unknown as Record<string, unknown>,
          isTemplate: false,
          createdBy: req.uid!
        })
      )
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
      created.push({ id: copy.id, name: copy.name })
    }
    await writeLog(
      req,
      'duplicate_batch',
      `从「${src.name}」批量克隆 ${created.length} 个环境（指纹微抖动${copyAccounts ? `，账号资料一并复制` : ''}）`
    )
    res.json({ created: created.length, items: created })
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

  // 批量操作：moveGroup / bindProxy / delete（软删除进回收站）/ open
  // 路由顺序：/profiles/batch 是静态段，与 /profiles/:id/* 不冲突
  router.post('/profiles/batch', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids: unknown[] = req.body?.ids || []
    const action: string = req.body?.action
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: '请先选择环境' })
    const repo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await repo.find({ where: { id: In(ids.map(Number)), ...ownerScope(req) } })
    if (profiles.length === 0) return res.status(404).json({ message: '未找到所选环境' })
    const now = new Date()

    if (action === 'moveGroup') {
      const raw = req.body?.groupId
      const groupId = raw === null || raw === undefined ? null : Number(raw)
      if (groupId != null) {
        const g = await AppDataSource.getRepository(GroupEntity).findOne({ where: { id: groupId, teamId: req.tid } })
        if (!g) return res.status(400).json({ message: '目标分组不存在' })
      }
      for (const p of profiles) {
        p.groupId = groupId
        await repo.save(p)
      }
      await writeLog(req, 'batch_move_group', `批量移动 ${profiles.length} 个环境到分组 #${groupId ?? '无'}`)
      return res.json({ updated: profiles.length })
    }

    if (action === 'bindProxy') {
      const raw = req.body?.proxyId
      const proxyId = raw === null || raw === undefined ? null : Number(raw)
      if (proxyId != null) {
        const pr = await AppDataSource.getRepository(ProxyEntity).findOne({ where: { id: proxyId, ...ownerScope(req) } })
        if (!pr) return res.status(400).json({ message: '目标代理不存在' })
      }
      let updated = 0
      for (const p of profiles) {
        if (p.status === 'running') continue // 运行中的环境不改动绑定
        p.proxyId = proxyId
        await repo.save(p)
        updated += 1
      }
      await writeLog(req, 'batch_bind_proxy', `批量绑定 ${updated} 个环境到代理 #${proxyId ?? '无'}`)
      return res.json({ updated })
    }

    if (action === 'delete') {
      let updated = 0
      for (const p of profiles) {
        if (p.status === 'running') continue
        if (p.deletedAt) continue
        p.deletedAt = now
        await repo.save(p)
        updated += 1
      }
      await writeLog(req, 'batch_delete_profile', `批量删除 ${updated} 个环境（进回收站）`)
      return res.json({ updated })
    }

    if (action === 'open') {
      if (!browserBridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
      let opened = 0
      for (const p of profiles) {
        if (p.status === 'running' || p.deletedAt) continue
        try {
          await browserBridge.openWindow(p.id)
          p.status = 'running'
          p.lastOpenedAt = now
          await repo.save(p)
          opened += 1
        } catch {
          /* 单个窗口打开失败不影响其他 */
        }
      }
      await writeLog(req, 'batch_open_profile', `批量打开 ${opened} 个环境`)
      return res.json({ updated: opened })
    }

    return res.status(400).json({ message: '未知批量操作' })
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

  // 导出单个脚本为 JSON 文件（按 :id 路由在下方，但 export 是两段式，必须放在 /rpa/:id 之前）
  router.get('/rpa/export/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const s = await rpaRepo().findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!s) return res.status(404).json({ message: '脚本不存在' })
    const data = {
      id: s.id,
      name: s.name,
      remark: s.remark,
      steps: s.steps,
      variables: s.variables || {}
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="rpa-${s.id}-${encodeURIComponent(s.name)}.json"`)
    res.send(JSON.stringify(data, null, 2))
  })

  // 导入脚本（接受单个对象、{items:[...]} 或数组）。新建到当前团队，定时配置重置。
  router.post('/rpa/import', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const payload = req.body || {}
    const arr = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { items?: unknown }).items)
        ? (payload as { items: unknown[] }).items
        : [payload]
    if (!Array.isArray(arr) || !arr.length) return res.status(400).json({ message: '没有可导入的数据' })
    const created: number[] = []
    for (const item of arr as Array<Record<string, unknown>>) {
      if (!item || !item.name || !Array.isArray(item.steps)) continue
      const saved = await rpaRepo().save(
        rpaRepo().create({
          teamId: req.tid!,
          ownerId: req.uid!,
          name: String(item.name).slice(0, 128),
          remark: String(item.remark || '').slice(0, 512),
          steps: item.steps,
          variables: normalizeVariables(item.variables),
          scheduleEnabled: false,
          scheduleIntervalMin: 30,
          scheduleProfileId: null
        })
      )
      created.push(saved.id)
    }
    if (!created.length) return res.status(400).json({ message: '没有有效的脚本可导入（需含 name 与 steps）' })
    await writeLog(req, 'import_rpa_script', `导入 RPA 脚本 ${created.length} 个`)
    res.json({ ok: true, created })
  })

  router.get('/rpa', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const list = await rpaRepo().find({ where: ownerScope(req), order: { id: 'DESC' } })
    res.json(
      list.map((s) => ({
        id: s.id,
        name: s.name,
        remark: s.remark,
        steps: s.steps as unknown as RpaStep[],
        variables: s.variables || {},
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
        variables: normalizeVariables(b.variables),
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
    if (b.variables !== undefined) s.variables = normalizeVariables(b.variables)
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
    // 变量替换：回放时可传入覆盖变量；否则用脚本自带变量
    const reqVars = (req.body || {}).variables
    const vars = reqVars && typeof reqVars === 'object' && Object.keys(reqVars).length
      ? normalizeVariables(reqVars) || {}
      : s.variables || {}
    const steps = substituteSteps(s.steps as unknown as RpaStep[], vars)
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
    // DATETIME 列无时区信息，统一按 UTC 解释（读/写一致，且不依赖运行机器的系统时区）。
    // 否则 mysql2 默认 local 会把库里存的 UTC 瞬间当成「机器本地墙钟」读出，
    // 导致前端按国家时区换算后整体偏移 8 小时（如中国用户看到 12:28 而非 20:28）。
    timezone: '+00:00',
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
  // 7. 启动全空间快照定时自动备份调度（按间隔写入本地目录，目录为空/未启用则跳过）
  startSnapshotBackupScheduler().catch((e) => console.error('[roxy] 启动快照备份调度失败:', e))

  return apiBase
}
