import 'reflect-metadata'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import cors from 'cors'
import http from 'http'
import { homedir } from 'os'
import { mkdirSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getJwtSecret } from './jwtSecret'
import { lazySecretCrypto } from './secretKey'
import {
  checkSession,
  nextSessionVersion,
  SESSION_TTL_DAYS,
  addRevokedDevice,
  pruneRevokedDevices,
  deviceFingerprint,
  type SessionClaims,
  type SessionVerdict,
  type RevokedDevice
} from '../shared/sessionRevoke'
import {
  bumpFailureCount,
  planProxyHealing,
  type FailureCounts,
  type ProfileLike,
  type ProxyLike
} from '../shared/proxyHeal'
import { getCdpInfo } from './cdpManager'
import { loginBuckets, rateLimit, startRateLimitSweeper } from './rateLimiter'
import { dispatchWebhook, setCachedWebhooks } from './webhook'
import { apiActionName, apiShouldAudit, apiAuditDetail } from './apiAudit'
import mysql from 'mysql2/promise'
import { DataSource, In, IsNull } from 'typeorm'
import type { AddressInfo } from 'net'
import { app } from 'electron'

import {
  UserEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamInviteEntity,
  GroupEntity,
  ProxyEntity,
  ProfileEntity,
  AccountEntity,
  CookieEntity,
  OperationLogEntity,
  OperationLogArchiveEntity,
  ApiTokenEntity,
  AppSettingsEntity,
  ExtensionEntity,
  RpaScriptEntity,
  AssistantSkillEntity
} from './entities'
import { randomFingerprint, defaultFingerprint, listFingerprintPresets, normalizeFingerprint, deriveJitteredFingerprint } from '../shared/fingerprint'
import { getEnvExpiresAt } from '../shared/envExpiry'
import { planBatch, canPurge, canRestore, type TrashItemLike } from '../shared/trashBatch'
import { substituteSteps, normalizeVariables } from '../shared/rpa'
import type { Fingerprint, AppSettings, OSKind, RpaStep, WebhookConfig } from '../shared/types'
import { DEFAULT_START_URL, DEFAULT_SETTINGS, normalizeSearchEngine } from '../shared/types'
import { buildHealthReport, type FingerprintProbe, type HealthReport } from '../shared/healthcheck'
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
// AI Agent（探针 / 对话）与智能助手 Planner 已拆到 routes/assistant.ts，
// 连带 ollama / cloud / knowledge / assistantPlanner 的引用一并迁走。
import { renderAcceptInvitePage } from './acceptInvitePage'
import { SCAN_SITES, getScanSite, type ScanResult } from './fingerprintScan'
import { runLogArchive } from './logArchiver'
import { registerLogRoutes } from './routes/logs'
import { registerProxyRoutes } from './routes/proxies'
// 代理检测 / 分配的业务逻辑已抽到 proxyService（不依赖 AppDataSource，DataSource 由调用方传入），
// 这样 routes/proxies 与本文件都能直接 import，不必反向引用形成循环依赖。
import { allocateProxy, applyProxyCheckResult, checkProxy, computeProxyUsage, ApiError } from './proxyService'
import { registerCookieRoutes } from './routes/cookies'
import { registerAccountRoutes } from './routes/accounts'
import { registerTeamRoutes } from './routes/team'
import { registerV1CookieRoutes } from './routes/v1Cookie'
import { registerAuthRoutes } from './routes/auth'
import { registerSettingsRoutes } from './routes/settings'
import { isAdminRole, ownerScope, ownerAndWhere, type AuthedRequest } from './authScope'
// browserManager 与 server 存在循环依赖（browserManager 静态引用 server 的 AppDataSource）。
// 经核查：AppDataSource 为 `export let` 运行时赋值，且 browserManager 仅在函数体内使用，
// 循环依赖为良性，可安全静态导入（index.ts 本就静态导入，模块在启动期已就绪）。
import {
  getRunningWindowIds,
  replayRpaScript,
  closeWindow,
  applyCookies,
  clearProfilePartition
} from './browserManager'
// 扩展管理与 RPA 脚本域已拆出；下面这些浏览器侧能力随之只在 routes/rpa.ts 里被引用。
import { registerExtensionRoutes } from './routes/extensions'
import { registerRpaRoutes } from './routes/rpa'
import { registerAssistantRoutes } from './routes/assistant'

// ---------- 配置 ----------
// 默认端口 3306（Docker / 官方安装版的 MySQL 默认监听端口）。环境变量 DB_PORT 仍可覆盖。
// 注：README 早期的 docker run 示例用的是 -p 3307:3306（宿主 3307 → 容器 3306），
// 那是为了避开本机已有的 3306。若你沿用那种映射，用 DB_PORT=3307 覆盖即可。
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '1234560',
  database: process.env.DB_NAME || 'roxy_browser'
}
// 密钥来源：环境变量 > ~/.roxy-clone/jwt-secret 持久化 > 首次随机生成。
// 绝不使用硬编码默认值——否则未配置时任何人可用已知 secret 伪造 JWT 绕过鉴权。
const JWT_SECRET = getJwtSecret()
const START_PORT = Number(process.env.API_PORT || 39100)

export let AppDataSource: DataSource
export let apiBase = ''

// 浏览器窗口桥（由 main 注入）
export interface BrowserBridge {
  openWindow(profileId: number): Promise<void>
  closeWindow(profileId: number): Promise<void>
  /** 环境体检：在目标窗口内采集实际生效的指纹值，窗口未运行返回 null */
  probeFingerprint(profileId: number): Promise<FingerprintProbe | null>
  /** 环境截图：截取运行中环境窗口当前视口，返回 PNG Buffer，窗口未运行抛错 */
  captureScreenshot(profileId: number): Promise<Buffer>
  /** 在线检测站实战验证：导航到第三方检测站并抓回文本与截图，窗口未运行抛错 */
  scanSite(profileId: number, siteId: string): Promise<ScanResult>
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

// 账户隔离的 isAdminRole / ownerScope / ownerAndWhere 与 AuthedRequest 类型已抽到
// src/main/authScope.ts，供 server.ts 与 routes/* 共用——避免 routes 反向 import server，
// 也不必在每个域的 deps 里层层传递 ownerScope。

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

/**
 * 会话鉴权中间件。
 *
 * 签名/过期由 `jwt.verify` 校验；**会话撤销**（登出 / 改密码 / 强制下线）
 * 靠比对 `users.tokenVersion`——版本号落后即视为已撤销。详见 `shared/sessionRevoke.ts`。
 *
 * 异步实现对 105 处调用方完全透明：Express 会捕获中间件返回的 Promise 拒绝。
 * 每请求多一次 `users` 查询是必要代价——无状态 JWT 想支持撤销只能如此，
 * 且可以命中数据库索引（主键查询）。
 */
async function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '')
  let claims: SessionClaims
  try {
    claims = jwt.verify(token, JWT_SECRET) as SessionClaims
  } catch {
    res.status(401).json({ message: '未登录或登录已过期' })
    return
  }
  const verdict = await checkSessionAndRevoked(claims)
  if (!verdict.valid) {
    // 撤销类拒绝带上 code，前端据此清理本地令牌并跳登录页（而不是弹个看不懂的报错）
    // 诊断日志：会话失效是个**结果**，要查的是「哪个接口在什么情况下被拒」。
    // 之前只有前端一句「已退出登录」，排查时无法区分是令牌问题还是别的原因。
    console.warn(`[auth] 会话被拒 (${verdict.code}) ${req.method} ${req.originalUrl}: ${verdict.reason}`)
    res.status(401).json({ message: verdict.reason, code: verdict.code })
    return
  }
  req.uid = claims.uid
  req.tid = claims.tid
  req.username = claims.username
  req.role = claims.role
  // 透传令牌里的设备指纹（而非现算当前 UA）：登出要撤销的正是**这个令牌所属的设备**。
  // 若改成现算，浏览器自动升级导致 UA 变化时就会吊销错设备。
  req.dev = claims.dev || ''
  next()
}

/** 查库取当前用户的 tokenVersion，再做撤销判定 */
async function checkSessionAndRevoked(claims: SessionClaims): Promise<SessionVerdict> {
  // 用户不存在也按撤销处理：账号被删除后其令牌不应继续可用
  const user = await AppDataSource.getRepository(UserEntity).findOne({ where: { id: claims.uid } })
  if (!user) return { valid: false, reason: '账号不存在，请重新登录', code: 'session_revoked' }
  return checkSession(claims, user.tokenVersion, parseRevokedDevices(user.revokedDevices))
}

/**
 * 解析 `users.revokedDevices`（JSON 文本）。
 *
 * 故意**不抛错**：这是纯防御性解析——列内容损坏时退化为「无撤销记录」，
 * 最坏结果是让已登出的设备多活 7 天（令牌本就会自然过期），
 * 而抛错会导致**所有用户都无法登录**，两者代价完全不对等。
 */
function parseRevokedDevices(raw: string | null | undefined): RevokedDevice[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d) => !!d && typeof d.dev === 'string' && d.dev.length > 0)
  } catch {
    return []
  }
}

/**
 * 设备指纹：用于「只让本设备失效」的设备级撤销。
 * 实现集中在 shared/sessionRevoke.deviceFingerprint —— **签发侧与校验侧必须共用
 * 同一份实现**，两处各写一遍哈希规则迟早写歪，届时表现为「登出后令牌仍有效」且无任何报错。
 */
function deviceFingerprintOf(req: Request): string {
  return deviceFingerprint(req.headers['user-agent'])
}

/**
 * 签发会话令牌的**唯一入口**。
 *
 * 收敛到一处的原因是：5 个签发点（注册 / 登录 / 2FA 验证 / 切换团队 / 其他）
 * 各自手写 payload 极易漏掉 `ver` 字段——而漏掉的后果是「这个入口签发的令牌
 * 一律被判为版本 0」，用户改密码后这些令牌不会失效，撤销功能静默破防。
 * 漏写不会有任何编译错误或测试报错，只会悄悄地让安全机制失效。
 */
function signSessionToken(
  args: { uid: number; username: string; tokenVersion: number | null; tid: number; role: string; dev?: string },
  ttl: `${number}d` = `${SESSION_TTL_DAYS}d`
): string {
  return jwt.sign(
    {
      uid: args.uid,
      tid: args.tid,
      username: args.username,
      role: args.role,
      ver: args.tokenVersion ?? 0,
      // dev 声明设备指纹：普通「登出」靠它做到只吊销本设备。
      // 缺失（旧签发路径漏传）时该令牌无法被设备级撤销，仍由 tokenVersion 兜底。
      dev: args.dev || ''
    },
    JWT_SECRET,
    { expiresIn: ttl }
  )
}

/**
 * 从请求与用户实体取出签发所需的字段。
 *
 * `dev` 必须在此集中获取：各签发点（注册 / 登录 / 2FA / 切换团队）都漏传的话，
 * 那个入口签发的令牌永远无法被设备级撤销——**编译不报错、测试不报错，
 * 只是悄悄少了一条撤销路径**。
 */
function sessionOf(user: UserEntity, tid: number, role: string, req?: Request) {
  return {
    uid: user.id,
    username: user.username,
    tokenVersion: user.tokenVersion,
    tid,
    role,
    dev: req ? deviceFingerprintOf(req) : ''
  }
}

/**
 * 递增 tokenVersion 吊销该用户全部会话，并写审计日志。
 *
 * 刻意**不给当前调用方返回新令牌**——撤销后当前设备也必须重新登录。
 * 若「退出所有设备」还让本机保持登录，用户会觉得按钮没生效，实际上是自欺欺人。
 *
 * 顺带**清空设备级撤销列表**：tokenVersion 已经让所有旧令牌失效，
 * 列表里每条记录都已无对象可撤销，留着只会在下次登录时误杀同指纹设备。
 */
async function revokeAllSessions(uid: number, tid: number, username: string, reason: string): Promise<void> {
  const userRepo = AppDataSource.getRepository(UserEntity)
  const user = await userRepo.findOne({ where: { id: uid } })
  if (!user) return
  user.tokenVersion = nextSessionVersion(user.tokenVersion ?? 0)
  user.revokedDevices = '[]'
  await userRepo.save(user)
  await writeLog(
    { uid, tid, username, role: 'member' } as AuthedRequest,
    'logout',
    `${reason}：已吊销该用户全部会话（其他设备需重新登录）`
  )
}

/**
 * 只吊销**当前设备**的会话（普通「退出登录」）。
 *
 * ## 为什么与 revokeAllSessions 分开
 * 两者语义完全不同，此前被合并成一个是错的：
 * 用户在 A 电脑点「退出登录」，B 电脑会毫无理由地被踢下线——
 * 换台机器登录就掉线，用户既不解也无法自行恢复。
 * 这与「反复退出登录」「点着点着就掉线」是同一类体验问题。
 *
 * 实现方式：把本设备指纹追加进 `users.revokedDevices`，
 * 令牌里带 `dev` 声明，校验时比对是否命中（见 shared/sessionRevoke.ts）。
 *
 * **不递增 tokenVersion**：那是用户级的，一动就把其他设备全踢了。
 *
 * 顺带做过期回收：撤销记录只在令牌有效期内有意义，
 * 每次追加时按 TTL 清一遍，避免这一列无界增长（黑名单的老毛病）。
 */
async function revokeCurrentDevice(
  req: AuthedRequest,
  dev: string,
  reason: string
): Promise<void> {
  if (!dev) {
    // 拿不到设备指纹（如经由某些代理剥离 UA 头）时**不能**静默成功：
    // 否则用户点了退出登录、令牌却仍有效 7 天，正是这个功能要修的洞。
    // 降级为全设备撤销——宁可多踢其他设备，也不能让令牌继续有效。
    console.warn('[auth] 缺少 User-Agent，设备指纹为空，降级为退出所有设备')
    await revokeAllSessions(req.uid!, req.tid!, req.username || '', reason)
    return
  }
  const userRepo = AppDataSource.getRepository(UserEntity)
  const user = await userRepo.findOne({ where: { id: req.uid } })
  if (!user) return
  const now = Date.now()
  const pruned = pruneRevokedDevices(parseRevokedDevices(user.revokedDevices), now)
  user.revokedDevices = JSON.stringify(addRevokedDevice(pruned, dev, now))
  await userRepo.save(user)
  await writeLog(req, 'logout', `${reason}：已吊销本设备会话（其他设备不受影响）`)
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
      const r = req as AuthedRequest
      r.tid = t.teamId
      r.role = 'api'
      // 记录令牌身份，供审计日志追溯（ownerId 即创建该令牌的用户）
      r.apiToken = { id: t.id, name: t.name, ownerId: t.ownerId ?? 0 }
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
const SENSITIVE_LOG_KEYWORDS = ['delete', 'purge', 'export', 'import', 'role', 'member', 'token', 'password', 'reset', 'transfer']
function isSensitiveAction(action: string): boolean {
  const a = action.toLowerCase()
  return SENSITIVE_LOG_KEYWORDS.some((k) => a.includes(k))
}

async function writeLog(req: AuthedRequest, action: string, detail: unknown) {
  // API 令牌调用没有登录态、拿不到 uid；原先 `!req.uid` 直接 return 会让令牌操作
  // 完全不留痕——而令牌能建环境 / 删数据 / 导出 Cookie，这是实打实的审计盲区。
  // 改为：有 tid 且（有 uid 或有令牌身份）即记；userId 取令牌创建者（取不到记 0），
  // username 记为 `api:<令牌名>`，界面上一眼能区分是人操作还是脚本操作。
  const api = req.apiToken
  if (!req.tid || (!req.uid && !api)) return
  const actorName = api ? `api:${api.name}` : req.username || 'api'
  const repo = AppDataSource.getRepository(OperationLogEntity)
  await repo.save(
    repo.create({
      teamId: req.tid,
      userId: req.uid ?? api?.ownerId ?? 0,
      username: actorName,
      action,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      sensitive: isSensitiveAction(action)
    })
  )
  // 触发 Webhook 通知（fire-and-forget，绝不阻塞主流程）
  dispatchWebhook(action, {
    teamId: req.tid,
    actor: { uid: req.uid ?? 0, username: actorName, role: req.role || 'member' },
    detail
  })
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
    // 触发 Webhook 通知（fire-and-forget）
    dispatchWebhook(input.action, {
      teamId,
      actor: input.actor
        ? { uid: input.actor.userId, username: input.actor.username, role: 'ai-agent' }
        : null,
      detail: input.detail
    })
  } catch (e) {
    console.error('[agent-log] 写入失败:', e instanceof Error ? e.message : e)
  }
}

// 把 agent 执行闭环跑出的动作序列落库为 RPA 脚本（零 token 离线回放），供 AI 定时自动化调用。
// 脚本默认关闭定时（避免沉淀出来的模板又被自动调度），归属取源环境的团队与创建者。
export async function saveRpaFromSteps(input: {
  sourceEnvId: number
  name: string
  steps: RpaStep[]
  instruction?: string
}): Promise<{ id: number; name: string }> {
  const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: input.sourceEnvId } })
  if (!profile) throw new Error(`环境 #${input.sourceEnvId} 不存在`)
  const repo = AppDataSource.getRepository(RpaScriptEntity)
  const saved = await repo.save(
    repo.create({
      teamId: profile.teamId,
      ownerId: profile.ownerId ?? 0,
      name: String(input.name).slice(0, 128),
      remark: `由 AI 定时任务沉淀 · 源指令：${(input.instruction || '').slice(0, 480)}`,
      steps: input.steps as Record<string, unknown>[],
      variables: null,
      scheduleEnabled: false,
      scheduleIntervalMin: 30,
      scheduleProfileId: null
    })
  )
  return { id: saved.id, name: saved.name }
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
    expiresAt: getEnvExpiresAt(p.fingerprint as Record<string, unknown>),
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

// ---------- 设置里的凭据字段（JSON 列，无法用 ORM Transformer）----------
// app_settings.settings 是 json 列，TypeORM 的 ValueTransformer 只作用于独立标量列，
// 因此 cloudApiKey 必须在这两个入口手动加解密。入口只有 getSettings()（读）与
// PUT /settings（写）两处，收敛在此避免遗漏。
const SETTINGS_SECRET_PATHS: string[][] = [['aiAgent', 'cloudApiKey']]

/** 深拷贝后加密设置内的凭据字段（不可原地改：merged 可能是调用方持有的对象） */
function encryptSettingsSecrets<T extends Record<string, unknown>>(settings: T): T {
  const clone = { ...settings } as Record<string, unknown>
  for (const path of SETTINGS_SECRET_PATHS) {
    let holder = clone
    for (let i = 0; i < path.length - 1; i++) {
      const next = holder[path[i]]
      if (!next || typeof next !== 'object') break
      holder = { ...(next as Record<string, unknown>) } as Record<string, unknown>
      // 逐层回填，保证在原对象上也能看到替换后的子对象
      clone[path[i]] = holder
    }
    const last = path[path.length - 1]
    if (holder[last] !== undefined) holder[last] = lazySecretCrypto().encrypt(holder[last])
  }
  return clone as T
}

/** 解密设置内的凭据字段（与 encryptSettingsSecrets 对称） */
function decryptSettingsSecrets<T extends Record<string, unknown>>(settings: T): T {
  const clone = { ...settings } as Record<string, unknown>
  for (const path of SETTINGS_SECRET_PATHS) {
    let holder = clone
    for (let i = 0; i < path.length - 1; i++) {
      const next = holder[path[i]]
      if (!next || typeof next !== 'object') break
      holder = { ...(next as Record<string, unknown>) } as Record<string, unknown>
      clone[path[i]] = holder
    }
    const last = path[path.length - 1]
    if (holder[last] !== undefined) holder[last] = lazySecretCrypto().decrypt(holder[last])
  }
  return clone as T
}

// 读取合并后的全局设置（兜底默认值）
export async function getSettings(): Promise<AppSettings> {
  const repo = AppDataSource.getRepository(AppSettingsEntity)
  const row = await repo.findOne({ where: { key: 'global' } })
  const settings = { ...DEFAULT_SETTINGS, ...((row?.settings as Partial<AppSettings>) || {}) }
  // 解密凭据字段：调用方（AI Agent / 连通性探针 / 助手 Planner）拿到的必须是可直接用的明文
  const decrypted = decryptSettingsSecrets(settings as unknown as Record<string, unknown>) as unknown as AppSettings
  // 每次读取设置都刷新 webhook 内存缓存（启动 / PUT /settings 后自动生效，无需单独查库）
  setCachedWebhooks(Array.isArray(decrypted.webhooks) ? decrypted.webhooks : [])
  return decrypted
}

// ---------- 接口限流配置缓存 ----------
// 限流中间件在每个请求前执行，若每次都 await getSettings() 会多一次 MySQL
// 查询，高频轮询下成为瓶颈。故缓存限额，仅在 PUT /settings 后失效重取。
let rateLimitPerMinCache = DEFAULT_SETTINGS.rateLimitPerMin
let rateLimitLoaded = false

function cachedRateLimitPerMin(): number {
  if (!rateLimitLoaded) {
    // 同步兜底值；bootstrap 完成后 refreshRateLimitConfig() 会覆盖
    rateLimitPerMinCache = DEFAULT_SETTINGS.rateLimitPerMin
    rateLimitLoaded = true
  }
  return rateLimitPerMinCache
}

/** 从 DB 重取限流配置（启动后与 PUT /settings 后调用） */
export async function refreshRateLimitConfig(): Promise<void> {
  try {
    const s = await getSettings()
    const n = Number(s.rateLimitPerMin)
    rateLimitPerMinCache = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_SETTINGS.rateLimitPerMin
    rateLimitLoaded = true
  } catch (e) {
    console.warn('[roxy] 读取限流配置失败，沿用默认值:', (e as Error).message)
  }
}

// 代理定时巡检调度器
let proxyCheckTimer: ReturnType<typeof setInterval> | null = null
/** 连续失败计数（代理 id → 连续失败轮数）。进程内维护即可：重启后从 0 开始，
 *  意味着重启不会误触发自愈（宁可晚一点动手，也不要刚启动就批量换 IP）。 */
const proxyFailureCounts: FailureCounts = new Map()

/**
 * 系统级操作日志（定时任务触发，无登录态）。
 * `writeLog` 需要完整的 AuthedRequest，而自愈是调度器主动执行的、没有请求上下文，
 * 因此单独走这个入口，操作人固定记为 `system`。
 */
async function writeSystemLog(teamId: number, action: string, detail: string): Promise<void> {
  const repo = AppDataSource.getRepository(OperationLogEntity)
  await repo.save(
    repo.create({
      teamId,
      userId: 0,
      username: 'system',
      action,
      detail,
      sensitive: isSensitiveAction(action)
    })
  )
  dispatchWebhook(action, { teamId, actor: null, detail })
}

/** 把实体转成纯函数判定用的最小结构 */
function toProxyLike(p: ProxyEntity): ProxyLike {
  return {
    id: p.id,
    teamId: p.teamId,
    type: p.type,
    host: p.host,
    port: p.port,
    country: p.country,
    region: p.region,
    status: p.status,
    exitIp: p.exitIp,
    expiresAt: p.expiresAt ?? null
  }
}

function toProfileLike(p: ProfileEntity): ProfileLike {
  return { id: p.id, teamId: p.teamId, name: p.name, proxyId: p.proxyId, status: p.status }
}

/**
 * 代理故障自愈：巡检发现代理失效后，把绑定的环境换绑到其他可用代理。
 *
 * 判定逻辑全在 `shared/proxyHeal.ts` 纯函数里（可离线单测），此处只负责
 * 查库、落库、告警。三条安全约束（不共用出口 IP / 不换到同 IP / 连续失败
 * 阈值）都在纯函数侧强制，实现细节见该文件注释。
 */
async function healProxies(failedProxies: ProxyEntity[], settings: AppSettings): Promise<void> {
  if (!settings.proxyHealEnabled) return
  if (failedProxies.length === 0) return
  const threshold = Math.max(1, Number(settings.proxyHealThreshold) || 2)

  const proxyRepo = AppDataSource.getRepository(ProxyEntity)
  const profileRepo = AppDataSource.getRepository(ProfileEntity)
  const allProxies = (await proxyRepo.find()).map(toProxyLike)
  const allProfiles = (await profileRepo.find({ where: { isTemplate: false } })).map(toProfileLike)

  const decisions = planProxyHealing(
    failedProxies.map(toProxyLike),
    allProfiles,
    allProxies,
    proxyFailureCounts,
    { threshold }
  )
  if (decisions.length === 0) return

  for (const d of decisions) {
    // webhook 由 writeSystemLog 内部统一触发，此处不再重复 dispatch
    const badProxy = failedProxies.find((p) => p.id === d.fromProxyId)
    if (d.toProxyId === null) {
      // 找不到合规替代：只告警不换绑。这里的 reason 会明确写出「池中 IP 已被占用」，
      // 用户据此判断是补代理还是手动指定
      const detail = `代理「${d.fromProxyName}」失效影响环境「${d.profileName}」，未能自动换绑：${d.reason}`
      console.warn(`[roxy] ${detail}`)
      await writeSystemLog(badProxy?.teamId ?? 0, 'proxy_heal_failed', detail)
      continue
    }

    const target = await profileRepo.findOne({ where: { id: d.profileId } })
    if (!target) continue
    target.proxyId = d.toProxyId
    await profileRepo.save(target)
    const detail = `代理「${d.fromProxyName}」失效，环境「${d.profileName}」已自动换绑到「${d.toProxyName}」（${d.reason}）`
    console.log(`[roxy] ${detail}`)
    await writeSystemLog(target.teamId, 'proxy_heal', detail)
  }
}

async function runProxyCheckAll(): Promise<void> {
  const repo = AppDataSource.getRepository(ProxyEntity)
  const list = await repo.find()
  if (list.length === 0) return
  const settings = await getSettings()
  const timeout = (settings.proxyCheckTimeout as number) * 1000
  const failed: ProxyEntity[] = []
  for (const p of list) {
    try {
      const result = await checkProxy(p, timeout)
      bumpFailureCount(proxyFailureCounts, p.id, result.ok)
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
      if (!result.ok) failed.push(p)
    } catch (e) {
      console.error(`[roxy] 巡检代理 #${p.id} 失败:`, (e as Error).message)
      // 检测本身抛错（超时 / 解析失败）也算一轮失败，否则网络异常会导致自愈永不触发
      bumpFailureCount(proxyFailureCounts, p.id, false)
      failed.push(p)
    }
  }
  console.log(`[roxy] 定时巡检完成，共检测 ${list.length} 个代理，失效 ${failed.length} 个`)

  try {
    await healProxies(failed, settings)
  } catch (e) {
    // 自愈失败绝不能让巡检整体中断：巡检本身已把 status 落库了
    console.error('[roxy] 代理故障自愈异常:', (e as Error).message)
  }
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
  const runningIds = getRunningWindowIds()
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
        executed = await replayRpaScript(
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
    // 触发 Webhook 通知（fire-and-forget）
    dispatchWebhook(action, {
      teamId,
      actor: userId ? { uid: userId, username: 'scheduler', role: 'member' } : null,
      detail
    })
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

let logArchiveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 操作日志归档调度器。
 *
 * 每天凌晨 3:10 执行一次。选这个点有三个理由：
 * - 凌晨业务空闲，搬移过程对用户无感；
 * - **故意避开 3:00 整点**——整点是各类定时任务的扎堆时刻，错开可避免与
 *   代理巡检、RPA 调度同时抢磁盘 IO；
 * - 3:10 意味着前一天的日志已完整落库，跨天归档不会漏当天数据。
 *
 * 归档是**搬运而非删除**（见 logArchiver.ts），即使跑错也只是数据挪了位置，
 * 且每批次都可撤销——但仍不做「启动时立刻执行」，避免拖慢应用首屏启动。
 */
async function startLogArchiveScheduler(): Promise<void> {
  if (logArchiveTimer) {
    clearTimeout(logArchiveTimer)
    logArchiveTimer = null
  }
  const msUntilNextRun = () => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 10, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next.getTime() - now.getTime()
  }
  const arm = () => {
    const delay = msUntilNextRun()
    logArchiveTimer = setTimeout(() => {
      runLogArchive(AppDataSource)
        .then((r) => console.log(`[roxy] 日志归档：${r.reason}`))
        .catch((e) => console.error('[roxy] 日志归档异常:', e))
        .finally(arm) // 递归重新武装：setInterval 的间隔是固定的，
        // 跑一次后就偏离 3:10 越来越远；递归 setTimeout 才能每天都准点触发
    }, delay)
  }
  arm()
  console.log(`[roxy] 操作日志归档已启动（每日 3:10，首次 ${(msUntilNextRun() / 3600 / 1000).toFixed(1)} 小时后）`)
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

// ---------- API 路由 ----------
function buildApiRouter(): express.Router {
  const router = express.Router()

  // 认证域（注册 / 登录 / 登出 / 会话 / 团队切换 / 2FA）见 routes/auth.ts。
  // 必须在任何 /:id 之类的动态路由之前注册，否则会被抢先匹配。
  registerAuthRoutes(router, {
    getDs: () => AppDataSource,
    authMiddleware,
    jwtSecret: JWT_SECRET,
    signSessionToken,
    freshRole,
    isSensitiveAction,
    revokeAllSessions,
    revokeCurrentDevice,
    closeWindow,
    getRunningWindowIds,
    loginBuckets,
    getLoginLockConfig: async () => {
      const s = await getSettings()
      return {
        threshold: Number(s.loginLockoutThreshold) || 0,
        lockMs: (Number(s.loginLockoutMinutes) || 15) * 60 * 1000
      }
    },
    onLoginLocked: (username: string, reason: string) => {
      // 锁定属安全事件：写日志 + 推 webhook，便于用户及时察觉账号正被爆破。
      // 此刻可能尚未登录（甚至在爆破一个不存在的用户名），拿不到登录态的 tid，
      // 故用系统日志入口并记 tid=0 —— 「谁被攻击」比「记在哪个团队下」更重要。
      const detail = `账号「${username}」触发登录锁定：${reason}`
      console.warn(`[roxy] ${detail}`)
      // writeSystemLog 内部已 dispatch webhook，此处不重复发
      void writeSystemLog(0, 'login_locked', detail)
    }
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
        deletedAt: p.deletedAt,
        // 必须带上 status：批量彻底删除要拦「窗口正在运行」的环境。
        // 回收站里的环境理论上都是 idle，但软删除后仍可能被 RPA / 自动化
        // 重新拉起，此时不带上就会漏判，把运行中的环境删掉。
        status: p.status
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
    // 清理该环境的持久化分区（Cookie/localStorage/缓存）。
    // 必须做：数据库里的 Cookie 记录删了，但 Chromium 自己写的 localStorage、
    // IndexedDB、Service Worker 缓存还在分区目录里。id 被复用时新环境会继承旧环境的
    // 登录态 —— 指纹浏览器最不能容忍的串号。清理失败不阻断删除（记录已没了，
    // 此时把用户卡在报错里毫无意义），只把结果如实回报。
    const partitionCleared = await clearProfilePartition(p.id, 'purge', true)
    await writeLog(
      req,
      'purge_profile',
      `彻底删除环境「${p.name}」(#${p.id})（含账号与 Cookie）` +
        (partitionCleared ? '，已清理浏览器数据分区' : '，浏览器数据分区清理失败')
    )
    res.json({ ok: true, partitionCleared })
  })

  /**
   * 手动清理某环境的浏览器数据分区（Cookie / localStorage / 缓存）。
   *
   * ## 为什么需要「不删环境也能清」
   * 自动清理只在彻底删除时发生，但真实场景里磁盘压力往往来自**还在用**的环境：
   * 跑了一周的账号环境缓存能到几百 MB，用户不会为了清缓存去删环境。
   * 给一个显式入口，让用户在不丢环境的前提下回收空间。
   *
   * 注意这是**破坏性**操作：清完该环境的站点登录态会没（数据库里持久化的
   * Cookie 会保留？——不会，Chromium 层清掉后 seedCookies 下次开窗会重新注入，
   * 所以导入型 Cookie 仍在；仅本地存储/缓存/未持久化的会话丢失）。
   */
  router.post('/profiles/:id/clear-partition', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id)
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const cleared = await clearProfilePartition(id, 'manual', !!p.deletedAt)
    if (!cleared) {
      const win = getRunningWindowIds().includes(id)
      return res.status(400).json({
        message: win ? '窗口正在运行，请先关闭该环境窗口再清理浏览器数据' : '清理失败，请查看主进程日志'
      })
    }
    await writeLog(req, 'clear_partition', `清理环境「${p.name}」(#${id}) 的浏览器数据分区`)
    res.json({ ok: true, partitionCleared: true })
  })

  /** Date | null → ISO 字符串 | null（批量判定只关心「是否为空」，统一成字符串好过类型） */
function isoOf(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

// ===== 回收站批量操作 =====
  // 为什么需要批量接口而不是前端循环调单条：
  // ① 循环 50 次单条接口 = 50 次鉴权 + 50 次日志写入，慢且容易撞限流；
  // ② 单条接口中途失败时前端无法区分「已删」与「未删」，重试会造成重复操作；
  // ③ 批量审计日志需要聚合成一条，否则 50 个环境删除会刷出 50 行日志。
  //
  // **逐条独立判定**（见 shared/trashBatch.ts）：一条失败不影响其他，
  // 但拒绝原因必须如实回报——否则用户以为全删了，实际有几个还在。
  const readTrashBatch = async (req: AuthedRequest): Promise<ProfileEntity[]> => {
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      : []
    // 上限保护：一次删太多会长时间持锁，且用户多半是误操作
    if (!ids.length) throw new Error('请选择至少一个环境')
    if (ids.length > 200) throw new Error('一次最多操作 200 个环境')
    const repo = AppDataSource.getRepository(ProfileEntity)
    // ownerScope 必带：批量是批量越权的高发路径，绝不能只信前端传来的 id
    return repo.find({ where: { id: In(ids), ...ownerScope(req) } })
  }

  router.post('/profiles/batch-restore', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profiles = await readTrashBatch(req)
    const plan = planBatch(
      profiles.map((p) => ({ id: p.id, name: p.name, deletedAt: isoOf(p.deletedAt), status: p.status })),
      canRestore
    )
    const repo = AppDataSource.getRepository(ProfileEntity)
    let done = 0
    for (const id of plan.okIds) {
      try {
        await repo.update({ id }, { deletedAt: null })
        done++
      } catch (e) {
        console.error(`[roxy] 批量恢复失败 #${id}:`, (e as Error).message)
      }
    }
    if (done > 0) {
      await writeLog(req, 'restore_profile', `批量恢复 ${done} 个环境（回收站）${plan.rejected.length ? `，${plan.rejected.length} 个未成功` : ''}`)
    }
    res.json({ ok: true, restored: done, rejected: plan.rejected })
  })

  router.post('/profiles/batch-purge', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profiles = await readTrashBatch(req)
    const plan = planBatch(
      profiles.map((p) => ({ id: p.id, name: p.name, deletedAt: isoOf(p.deletedAt), status: p.status })),
      canPurge
    )
    const repo = AppDataSource.getRepository(ProfileEntity)
    const accRepo = AppDataSource.getRepository(AccountEntity)
    const cookieRepo = AppDataSource.getRepository(CookieEntity)
    let done = 0
    let partitionCleared = 0
    for (const id of plan.okIds) {
      const p = profiles.find((x) => x.id === id)
      if (!p) continue
      try {
        // 与单条 purge 保持完全一致的级联语义：账号、Cookie 一并清理
        await repo.remove(p)
        await accRepo.delete({ profileId: id })
        await cookieRepo.delete({ profileId: id })
        // 分区清理与单条同路径；失败只计数，不影响 done（数据库已删，卡住用户没意义）
        if (await clearProfilePartition(id, 'purge', true)) partitionCleared++
        done++
      } catch (e) {
        console.error(`[roxy] 批量彻底删除失败 #${id}:`, (e as Error).message)
      }
    }
    if (done > 0) {
      await writeLog(
        req,
        'purge_profile',
        `批量彻底删除 ${done} 个环境（含账号与 Cookie，已清理 ${partitionCleared} 个浏览器数据分区）` +
          `${plan.rejected.length ? `，${plan.rejected.length} 个未成功` : ''}`
      )
    }
    res.json({ ok: true, purged: done, partitionCleared, rejected: plan.rejected })
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
      const { proxy, reused } = await allocateProxy(AppDataSource, req.tid!, {
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
    // 生命周期管理（候选③）：到期环境拒绝打开，提示用户在编辑中延长或清空到期时间
    const exp = getEnvExpiresAt(p.fingerprint as Record<string, unknown>)
    if (exp && new Date(exp).getTime() < Date.now()) {
      const when = exp.slice(0, 16).replace('T', ' ')
      return res.status(400).json({ message: `环境已过期（到期时间 ${when}），请在编辑中延长或清空到期时间后重试` })
    }
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
    // audioSeed 必须与 preload 注入端的 seed 同源（profileId * 2654435761），
    // 否则体检算出的音频期望值与窗口内实际注入的值对不上，会永远判不合格。
    const report = buildHealthReport(p.fingerprint as unknown as Partial<Fingerprint>, actual, {
      proxyCountry,
      audioSeed: p.id * 2654435761
    })
    res.json(report)
  })

  // 批量体检总览：一次对 N 个选中环境跑体检，聚合出「系统级问题分布」+ 逐环境报告。
  // 每个环境需处于 running（探针必须在真实窗口内执行，与单环境体检一致）；未运行的环境标记为 skipped，
  // 不自动开关窗口以免改动用户状态。探针并发受限（默认 10），避免同时几十个窗口 JS 采集把主进程打爆。
  router.post('/profiles/batch-healthcheck', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n))
      : []
    if (!ids.length) return res.status(400).json({ message: '请选择至少一个环境' })
    if (!browserBridge) return res.status(500).json({ message: '浏览器引擎未就绪' })

    const repo = AppDataSource.getRepository(ProfileEntity)
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const profiles = await repo.find({ where: { id: In(ids), ...ownerScope(req) } })
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is ProfileEntity => !!p)

    const PASS = 80
    const results: Array<{
      id: number
      name: string
      status: string
      skipped: boolean
      reason?: string
      report?: HealthReport
    }> = []
    const itemStats = new Map<string, { passed: number; failed: number; na: number }>()
    let probed = 0, skipped = 0, scoreSum = 0, passCount = 0

    const probeOne = async (p: ProfileEntity) => {
      if (p.status !== 'running') return { skipped: true as const, reason: '环境未运行', report: undefined as HealthReport | undefined }
      const actual = await browserBridge!.probeFingerprint(p.id)
      if (!actual) return { skipped: true as const, reason: '窗口未运行', report: undefined }
      if (actual.error) return { skipped: true as const, reason: `采集失败：${actual.error}`, report: undefined }
      let proxyCountry = ''
      if (p.proxyId) {
        const px = await proxyRepo.findOne({ where: { id: p.proxyId } })
        proxyCountry = px?.country || ''
      }
      const report = buildHealthReport(p.fingerprint as unknown as Partial<Fingerprint>, actual, {
        proxyCountry,
        audioSeed: p.id * 2654435761
      })
      return { skipped: false as const, reason: undefined as string | undefined, report }
    }

    const CONCURRENCY = 10
    for (let i = 0; i < ordered.length; i += CONCURRENCY) {
      const chunk = ordered.slice(i, i + CONCURRENCY)
      const chunkRes = await Promise.all(chunk.map((p) => probeOne(p).then((r) => ({ p, r }))))
      for (const { p, r } of chunkRes) {
        if (r.skipped || !r.report) {
          skipped++
          results.push({ id: p.id, name: p.name, status: p.status, skipped: true, reason: r.reason })
          continue
        }
        const report = r.report
        probed++
        scoreSum += report.score
        if (report.score >= PASS) passCount++
        for (const it of report.items) {
          const st = itemStats.get(it.key) || { passed: 0, failed: 0, na: 0 }
          if (it.weight === 0) st.na++
          else if (it.ok) st.passed++
          else st.failed++
          itemStats.set(it.key, st)
        }
        results.push({ id: p.id, name: p.name, status: p.status, skipped: false, report })
      }
    }

    const itemStatsArr = Array.from(itemStats.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.failed - a.failed || b.passed - a.passed)

    res.json({
      total: ordered.length,
      probed,
      skipped,
      avgScore: probed ? Math.round(scoreSum / probed) : 0,
      passCount,
      passThreshold: PASS,
      itemStats: itemStatsArr,
      profiles: results
    })
  })

  // 环境截图：截取运行中环境窗口当前视口，返回 PNG（data URL）。
  // 用于 SEO 报告 / 收录检测 / A-B 测试证据 / 竞品调研留痕等；必须在环境运行时执行——
  // capturePage 只能在真实窗口上下文里截到页面内容（与体检同理）。
  router.post('/profiles/:id/screenshot', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    if (p.status !== 'running') return res.status(400).json({ message: '请先打开环境窗口，再截图' })
    if (!browserBridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    try {
      const buf = await browserBridge.captureScreenshot(p.id)
      const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
      await writeLog(req, 'screenshot_profile', `对环境「${p.name}」(#${p.id}) 截图`)
      res.json({ ok: true, image: dataUrl, capturedAt: new Date().toISOString() })
    } catch (e) {
      res.status(400).json({ message: (e as Error).message })
    }
  })

  // ===== 在线检测站实战验证 =====
  // 与环境体检互补：体检是「自己出题自己判卷」（设定值 ↔ 回读值），
  // 这里则是让第三方检测站从外部视角评判，能发现设定值互相矛盾、
  // 或某项指标落在真实人群分布之外这类体检抓不到的问题。
  // 站点清单不含凭据，直接下发即可；扫描结果含截图，故需登录鉴权。
  router.get('/scan-sites', authMiddleware, (_req: AuthedRequest, res: Response) => {
    res.json(
      SCAN_SITES.map((s) => ({ id: s.id, name: s.name, url: s.url, desc: s.desc }))
    )
  })

  router.post('/profiles/:id/scan', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.deletedAt) return res.status(400).json({ message: '该环境已删除，请先从回收站恢复' })
    if (p.status !== 'running') return res.status(400).json({ message: '请先打开环境窗口，再执行在线检测' })
    if (!browserBridge) return res.status(500).json({ message: '浏览器引擎未就绪' })
    const siteId = String((req.body || {}).siteId || '')
    const site = getScanSite(siteId)
    if (!site) return res.status(400).json({ message: `未知检测站：${siteId}` })
    try {
      const result: ScanResult = await browserBridge.scanSite(p.id, siteId)
      // 抓取异常（网络不通 / 被验证拦截）同样要留痕：这类记录恰恰最需要追溯
      const tail = result.error ? `（抓取异常：${result.error}）` : ''
      await writeLog(req, 'scan_profile', `对环境「${p.name}」(#${p.id}) 执行在线检测（${site.name}）${tail}`)
      res.json(result)
    } catch (e) {
      const detail = (e as Error).message
      await writeLog(req, 'scan_profile', `对环境「${p.name}」(#${p.id}) 执行在线检测失败（${site.name}）：${detail}`)
      res.status(400).json({ message: detail })
    }
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

  // 环境转移到其他团队：团队切换器打通的多团队模型下，数据按 teamId 强隔离，
  // 「转移」= 把环境及其关联 Cookie / 账号的归属 teamId 改写为目标团队（即把数据分享给目标团队）。
  // 仅当操作人本人也是目标团队成员时才允许移入，避免把数据塞进无权访问的团队；
  // 转移前必须关闭运行中的窗口（与删除同等约束），并级联迁移关联数据，避免产生跨团队孤儿记录。
  router.post('/profiles/:id/transfer', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid, ...ownerScope(req) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    if (p.status === 'running') return res.status(400).json({ message: '请先关闭正在运行的窗口，再转移' })
    const targetTeamId = Number((req.body || {}).teamId)
    if (!targetTeamId || targetTeamId === req.tid) return res.status(400).json({ message: '请选择不同的目标团队' })
    // 操作人必须是目标团队成员，否则无权把数据移入该团队
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    const targetMember = await memberRepo.findOne({ where: { userId: req.uid, teamId: targetTeamId } })
    if (!targetMember) return res.status(403).json({ message: '你不是目标团队成员，无法转移' })
    const targetTeam = await AppDataSource.getRepository(TeamEntity).findOne({ where: { id: targetTeamId } })
    // 改写环境归属
    p.teamId = targetTeamId
    p.ownerId = req.uid!
    await repo.save(p)
    // 级联：该环境的 Cookie / 账号一并归属到目标团队（保持同团队，避免孤儿数据）。
    // Cookie 自带 teamId 列需改写；账号无 teamId 列、靠 profileId 隐式归属新团队，只同步 ownerId。
    await AppDataSource.getRepository(CookieEntity).update({ profileId: p.id }, { teamId: targetTeamId, ownerId: req.uid! })
    await AppDataSource.getRepository(AccountEntity).update({ profileId: p.id }, { ownerId: req.uid! })
    await writeLog(req, 'transfer_profile', `将环境「${p.name}」(#${p.id}) 转移到团队「${targetTeam?.name || targetTeamId}」`)
    res.json({ ok: true, profile: mapProfile(p) })
  })

  // 生成随机指纹
  router.post('/fingerprint/random', authMiddleware, (req: Request, res: Response) => {
    const body = req.body || {}
    const os = body.os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    const cv = typeof body.coreVersion === 'number' ? body.coreVersion : undefined
    res.json(randomFingerprint(valid as OSKind | undefined, cv))
  })

  // 指纹预设库（内置验证过的指纹组合）
  router.get('/fingerprint/presets', authMiddleware, (_req: Request, res: Response) => {
    res.json(listFingerprintPresets())
  })

  // ===== Cookie 管理（按环境隔离，团队维度鉴权） =====
  // 路由实现已抽到 src/main/routes/cookies.ts，解析逻辑在 src/main/cookieText.ts（可离线单测）。
  registerCookieRoutes(router, {
    getDs: () => AppDataSource,
    authMiddleware,
    writeLog,
    applyCookies
  })

  // ===== 操作日志 =====
  // 路由实现已抽到 src/main/routes/logs.ts（server.ts 过大，按域逐步拆分）。
  // getDs 传函数而非值：AppDataSource 是运行时赋值的 export let，按值捕获会拿到 undefined。
  registerLogRoutes(router, { getDs: () => AppDataSource, authMiddleware, writeLog })

  // 账号中心域（列表 / 增删改 / 批量关联环境 / 批量导入导出）见 routes/accounts.ts。
  // 密码可见性口径（明文只给管理员、改密码也只给管理员）就写在该文件的注释里，
  // 与路由实现放在一起，避免日后被「顺手优化」掉。
  registerAccountRoutes(router, { getDs: () => AppDataSource, authMiddleware, writeLog, freshRole })

  // 团队与成员域（团队信息 / 成员增删改 / 邮箱邀请 / 接受邀请 / SMTP 测试）见 routes/team.ts。
  // 邀请邮件模板（buildInviteEmailHtml）随之迁走——全项目只有这里用它。
  // getApiBase 传函数而非值：apiBase 是 listen() 之后才赋值的 export let，
  // 按值捕获会得到空串，邮件里的邀请链接会退化成相对路径，收件人点了没反应且无任何报错。
  registerTeamRoutes(router, {
    getDs: () => AppDataSource,
    authMiddleware,
    writeLog,
    getSettings,
    getApiBase: () => apiBase
  })

  // 代理域（CRUD / 检测 / IP 池分配 / 智能批量分配 / 池统计 / 批量导入导出）见 routes/proxies.ts。
  // 业务逻辑在 proxyService 中，同样不依赖 AppDataSource —— 这样拆分后本文件只是装配层，
  // 不再是所有模块的隐性依赖中心。
  // 注：/profiles/batch-allocate-proxy 也归在这一路由文件里（它操作的是代理分配语义，
  // 而非环境 CRUD），保持「一处分配逻辑」不被拆到两个文件里各自演化。
  registerProxyRoutes(router, { getDs: () => AppDataSource, authMiddleware, writeLog, getSettings })

  // 设置域（API 令牌 / 全局设置 / CDP 调试端口 / Webhook 测试）见 routes/settings.ts。
  registerSettingsRoutes(router, {
    getDs: () => AppDataSource,
    authMiddleware,
    writeLog,
    getSettings,
    encryptSettingsSecrets,
    restartSchedulers: () => {
      // 设置变更后重新调度定时巡检（间隔可能为 0 = 关闭）
      startProxyCheckScheduler().catch((e) => console.error('[roxy] 重启巡检调度失败:', e))
      // 限流限额同步刷新：改设置后立即生效，不需重启应用
      void refreshRateLimitConfig()
      // 保留期变了，归档范围随之改变——重启调度器让新的保留期尽快生效
      void startLogArchiveScheduler()
    },
    defaultSettings: DEFAULT_SETTINGS,
    normalizeSearchEngine
  })

  // AI Agent（探针 / 对话）与智能助手 Planner（查询 / 动作 / 技能库）见 routes/assistant.ts。
  registerAssistantRoutes(router, {
    getDs: () => AppDataSource,
    getSettings,
    authMiddleware,
    writeLog,
    freshRole
  })

  // ===== 自动化 API (v1，令牌鉴权，供脚本调用) =====
  const v1 = express.Router()
  v1.use(tokenAuthMiddleware)

  // ===== v1 审计：令牌调用统一留痕 =====
  // 令牌能创建 / 删除环境、导出 Cookie、跑 RPA，若完全不落日志就无法追溯
  // 「谁在何时用哪个令牌做了什么」——这是实打实的审计盲区。
  // 用中间件统一兜底而不是逐个路由手写 writeLog：既省事，也杜绝以后新增 v1 接口漏记。
  // 推导逻辑抽到 `apiAudit.ts` 纯函数模块（与 webhook.ts / logExport.ts 同构），可离线单测。
  v1.use((req, res, next) => {
    res.on('finish', () => {
      if (!apiShouldAudit(req.method, req.path)) return
      const action = apiActionName(req.method, req.path)
      if (!action) return
      void writeLog(req as AuthedRequest, action, apiAuditDetail(req.method, req.path, req.body))
    })
    next()
  })

  // ===== CDP 调试端点（供 Playwright / Puppeteer 连接）=====
  // 返回连接地址与「当前打开的环境 → targetId」映射。只读接口，不改任何数据，
  // 故不进 apiShouldAudit 的写审计；但返回的 profileId 列表属于环境元信息，
  // 令牌本身是按 teamId 鉴权的，跨团队拿不到别人的环境 id。
  v1.get('/cdp', async (_req: Request, res: Response) => {
    res.json({ code: 0, data: await getCdpInfo() })
  })

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
      const { proxy, profileId, reused, poolStatus } = await allocateProxy(AppDataSource, (req as AuthedRequest).tid!, {
        profileId: b.profileId,
        country: b.country,
        region: b.region
      })
      const usage = await computeProxyUsage(AppDataSource, (req as AuthedRequest).tid!)
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
    applyProxyCheckResult(p, result)
    await repo.save(p)
    res.json({ code: 0, data: p })
  })

  // --- 指纹：随机生成 ---
  v1.post('/fingerprint/random', async (req: Request, res: Response) => {
    const body = req.body || {}
    const os = body.os
    const valid = ['windows', 'mac', 'android', 'ios'].includes(os) ? os : undefined
    const cv = typeof body.coreVersion === 'number' ? body.coreVersion : undefined
    res.json({ code: 0, data: randomFingerprint(valid as OSKind | undefined, cv) })
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
  // 已抽到 src/main/routes/v1Cookie.ts；解析/映射复用 cookieText.ts，与内部接口同一套语义。
  registerV1CookieRoutes(v1, { getDs: () => AppDataSource, applyCookies })

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
    const runningIds = getRunningWindowIds()
    if (!runningIds.includes(profileId)) {
      return res.status(400).json({ code: 400, message: 'profile not running' })
    }
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await replayRpaScript(profileId, steps)
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
        // 生命周期管理（候选③）：到期环境在批量打开时同样跳过
        const exp = getEnvExpiresAt(p.fingerprint as Record<string, unknown>)
        if (exp && new Date(exp).getTime() < Date.now()) continue
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

  // ---------- 扩展管理（浏览器插件） ----------
  registerExtensionRoutes(router, { getDs: () => AppDataSource, authMiddleware, writeLog })

  // ===== RPA 脚本录制 / 回放 =====
  registerRpaRoutes(router, { getDs: () => AppDataSource, authMiddleware, writeLog })

  router.use('/v1', wrapAsync(v1))
  return wrapAsync(router)
}

// ---------- 启动 ----------
/**
 * 决定本次启动是否需要 synchronize。
 *
 * ## 为什么不用无脑 `synchronize: true`
 * 实测开/关差 ~156ms（163ms → 7ms），是启动阶段最大的一笔开销——
 * synchronize 每次启动都要把 16 个实体的表结构与库逐一比对。
 * 但关掉会让新装用户首次启动直接崩在 ER_NO_SUCH_TABLE。
 *
 * ## 这里的取巧：只查「表在不在」，不比对结构
 * 结构比对（synchronize 本身做的事）很贵，而「表存在与否」只需一条
 * `SHOW TABLES LIKE` —— 成本约 1~2ms，换来 150ms+ 的节省。
 *
 * ## 代价与补救（重要）
 * 改了实体结构后，本次启动**不会**自动改表，包括「旧版本库升级」这种场景——
 * 表已存在但缺新列时同样跳过。此时症状是 `ER_BAD_FIELD_ERROR`，且启动无提示，
 * 不好排查。三条出路：
 *   1. 开发期：`pnpm db:check` 看差异 → `pnpm db:sync` 执行；
 *   2. 正式发布：发版脚本执行 `pnpm db:sync`；
 *   3. 临时：设 `ROXY_FORCE_SYNC=1` 强制本次启动走 synchronize。
 *
 * 之所以敢这么取舍：synchronize 在发版时改实体**可能静默丢列**，
 * 把结构变更变成显式、可审阅的动作反而更安全。
 */
async function shouldSynchronizeSchema(): Promise<boolean> {
  // 逃生口：任何时候都能强制打开，无需改代码
  if (process.env.ROXY_FORCE_SYNC === '1') return true
  try {
    // 任一核心表缺失即视为「需要同步」（全新库 / 旧版本库）
    const conn = await mysql.createConnection({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
      database: DB_CONFIG.database
    })
    // SHOW TABLES 在 mysql2 里返回的是结果集（RowDataPacket[]），
    // 但通用签名给的是 QueryResult，需显式标注才能取 .length
    const [rows] = (await conn.query('SHOW TABLES LIKE ?', ['users'])) as unknown as [unknown[]]
    await conn.end()
    return rows.length === 0
  } catch (e) {
    // 连不上库时返回 true：让 TypeORM 自己去报错，错误信息比这里的模糊提示更准确
    return true
  }
}

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
    // 自动同步表结构。实测 synchronize 开/关差 ~156ms（163ms → 7ms），
    // 是启动阶段最大的一笔开销——它每次启动都要比对全部 16 个实体的表结构。
    //
    // 但**不能简单关掉**：新装用户首次启动时表还不存在，会直接崩在
    // ER_NO_SUCH_TABLE。故改为「按需同步」——
    //   · 首次启动（表还没建）→ 开，同步建表；
    //   · 之后启动（表已存在）→ 跳过，把 156ms 省下来；
    //   · 需要改实体时 → 走 `pnpm db:sync` 显式执行，与 README 的
    //     「db:check 检查差异 → db:sync 执行」工作流一致。
    synchronize: await shouldSynchronizeSchema(),
    // 同上，开发模式下不打印 SQL，避免刷屏拖慢启动
    entities: [
      UserEntity,
      TeamEntity,
      TeamMemberEntity,
      TeamInviteEntity,
      GroupEntity,
      ProxyEntity,
      ProfileEntity,
      AccountEntity,
      CookieEntity,
      OperationLogEntity,
      OperationLogArchiveEntity,
      ApiTokenEntity,
      AppSettingsEntity,
      ExtensionEntity,
      RpaScriptEntity,
      AssistantSkillEntity
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
  /**
   * 通用接口限流（滑动窗口，按客户端 IP）。
   *
   * 挂在 /api 之前，覆盖业务 API 与 v1 自动化接口。`/healthz` 在其外——
   * 健康检查不该被限流（外部调度器可能高频探测，超限会导致误判服务已死）。
   *
   * **限额走内存缓存而非每次查库**：限流在每个请求前执行，若每次都 await
   * getSettings() 就多一次 MySQL 查询，在高频轮询下会成瓶颈。缓存在
   * PUT /settings 时由 refreshRateLimitConfig() 失效重取，兼顾「改设置立即生效」。
   *
   * **注意本桶防不住登录爆破**——本地请求全部来自 127.0.0.1，按 IP 计数等于
   * 所有人共用额度；登录防护见 routes/auth.ts 的「按用户名锁定」。
   */
  app.use('/api', rateLimit('api', () => cachedRateLimitPerMin()))
  app.use('/api', buildApiRouter())
  app.get('/healthz', (_req, res) => res.json({ ok: true }))
  // 定期清理空桶，避免长期运行时 Map 无限增长
  startRateLimitSweeper()
  // 接受邀请页：纯 HTML，由 Express 直接返回，无需渲染进程参与（详见 acceptInvitePage.ts）
  app.get('/accept-invite', (_req, res) => {
    res.type('html').send(renderAcceptInvitePage())
  })

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
  // 5.5 加载限流配置（此前中间件只能读到默认值）
  await refreshRateLimitConfig()
  // 6. 启动 RPA 定时执行调度器（每 30s 扫描到点脚本；环境未运行则跳过并写日志）
  startRpaScheduleScheduler()
  // 7. 启动全空间快照定时自动备份调度（按间隔写入本地目录，目录为空/未启用则跳过）
  startSnapshotBackupScheduler().catch((e) => console.error('[roxy] 启动快照备份调度失败:', e))
  // 8. 启动操作日志归档调度（把过期整月搬到归档区，不删除数据）
  startLogArchiveScheduler().catch((e) => console.error('[roxy] 启动日志归档调度失败:', e))

  return apiBase
}
