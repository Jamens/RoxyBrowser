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
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
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
import { substituteSteps } from '../shared/rpa'
import { MARKET_SCRIPTS } from './rpaMarket'
import type { Fingerprint, AppSettings, OSKind, RpaStep, AIAgentSettings, WebhookConfig, SmtpSettings } from '../shared/types'
import { DEFAULT_START_URL, DEFAULT_SETTINGS, normalizeSearchEngine } from '../shared/types'
import { buildHealthReport, type FingerprintProbe, type HealthReport } from '../shared/healthcheck'
import { allocateProxies } from '../shared/proxyAllocator'
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
import { planAssistant, executeAssistantAction, runSkillPlan, type PlannerCtx } from './assistantPlanner'
import type { Plan } from '../shared/assistantPlan'
import { sendSmtpMail } from './smtp'
import { renderAcceptInvitePage } from './acceptInvitePage'
import { SCAN_SITES, getScanSite, type ScanResult } from './fingerprintScan'
import { runLogArchive } from './logArchiver'
import { registerLogRoutes } from './routes/logs'
import { registerCookieRoutes } from './routes/cookies'
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
  startRpaRecording,
  stopRpaRecording,
  isRpaRecording,
  rpaRecordCount,
  clearProfilePartition
} from './browserManager'

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

// 邀请邮件 HTML 正文（纯展示，不含敏感凭据，仅含一次性邀请链接）
function buildInviteEmailHtml(teamName: string, roleText: string, link: string): string {
  const safeTeam = String(teamName).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
  const safeRole = String(roleText).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
  return `<div style="font-family:-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2329">
  <div style="font-size:18px;font-weight:600;margin-bottom:12px">你被邀请加入 RoxyBrowser 团队</div>
  <p style="font-size:14px;line-height:1.6;color:#4e5969">你被邀请以 <b>${safeRole}</b> 身份加入团队 <b style="color:#1677ff">${safeTeam}</b>。</p>
  <p style="font-size:14px;line-height:1.6;color:#4e5969">点击下方按钮接受邀请并设置你的登录账号：</p>
  <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#1677ff;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:15px">接受邀请</a></p>
  <p style="font-size:12px;line-height:1.6;color:#8a8f99">如果按钮无法点击，请复制以下链接到浏览器打开：<br/><span style="word-break:break-all">${link}</span></p>
  <p style="font-size:12px;color:#8a8f99;margin-top:24px">该邀请链接 7 天内有效，且使用一次后失效。</p>
</div>`
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

  // 智能代理分配（负载均衡 + 避免同代理复用）：
  // 对选中的 N 个环境，从「空闲可用代理池」逐一分配**互不相同**的代理，杜绝两个环境共用同一出口 IP（防关联）。
  // 核心分配逻辑抽到纯函数 allocateProxies（src/shared/proxyAllocator.ts），便于离线单测；此处只负责取数、落库、写日志。
  router.post('/profiles/batch-allocate-proxy', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n))
      : []
    if (!ids.length) return res.status(400).json({ message: '请选择至少一个环境' })
    const country = typeof req.body?.country === 'string' ? req.body.country.trim() : ''
    const type = typeof req.body?.type === 'string' ? req.body.type.trim() : ''

    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const profiles = await profileRepo.find({ where: { id: In(ids), ...ownerScope(req) } })
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is ProfileEntity => !!p)

    const usage = await computeProxyUsage(req.tid!)
    const allProxies = await proxyRepo.find({ where: { teamId: req.tid! } })

    const result = allocateProxies(
      ordered.map((p) => ({ id: p.id, name: p.name, status: p.status, proxyId: p.proxyId })),
      allProxies.map((p) => ({ id: p.id, status: p.status, country: p.country, type: p.type, expiresAt: p.expiresAt })),
      usage,
      { country, type }
    )

    if (result.updates.length) {
      const saveMap = new Map(result.updates.map((u) => [u.id, u.proxyId]))
      const toSave = ordered.filter((p) => saveMap.has(p.id))
      for (const p of toSave) p.proxyId = saveMap.get(p.id) ?? null
      await profileRepo.save(toSave)
      await writeLog(
        req,
        'batch_allocate_proxy',
        `智能分配代理：分配 ${result.assigned} 个、保留 ${result.kept} 个、跳过 ${result.skippedRunning + result.skippedNoProxy} 个`
      )
    }

    res.json(result)
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
    const profileIdFilter = req.query.profileId ? Number(req.query.profileId) : null
    const platformFilter = typeof req.query.platform === 'string' ? req.query.platform : ''
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : ''
    const all = await repo.find({ order: { id: 'DESC' } })
    let list = all.filter((a) => profileIds.has(a.profileId))
    // 列表检索：环境(所属环境) + 平台 + 关键词（平台/账号/备注），与前端工具栏筛选叠加
    if (profileIdFilter) list = list.filter((a) => a.profileId === profileIdFilter)
    if (platformFilter) list = list.filter((a) => a.platform === platformFilter)
    if (keyword) {
      const kw = keyword.toLowerCase()
      list = list.filter((a) => `${a.platform} ${a.username} ${a.remark}`.toLowerCase().includes(kw))
    }
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

  // 账号-环境批量关联：把选中的多个账号批量绑定到同一个目标环境（设置 account.profileId）。
  // 仅对 ownerScope 可见的账号生效（member 只能操作自己的账号）；目标环境须为有效的非模板环境。
  router.post('/accounts/batch-associate', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const accountIds = Array.isArray(req.body?.accountIds)
      ? (req.body.accountIds as unknown[]).map((x) => Number(x)).filter((n) => Number.isInteger(n))
      : []
    const profileId = Number(req.body?.profileId)
    if (!accountIds.length) return res.status(400).json({ message: '请选择至少一个账号' })
    if (!Number.isInteger(profileId)) return res.status(400).json({ message: '请选择目标环境' })

    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const target = await profileRepo.findOne({ where: { id: profileId, isTemplate: false, ...ownerScope(req) } })
    if (!target) return res.status(400).json({ message: '目标环境不存在或无权访问' })

    const repo = AppDataSource.getRepository(AccountEntity)
    const accounts = await repo.find({ where: { id: In(accountIds), ...ownerScope(req) } })
    if (!accounts.length) return res.status(404).json({ message: '未找到可操作的账号' })

    for (const a of accounts) a.profileId = target.id
    await repo.save(accounts)
    await writeLog(req, 'batch_associate_account', `批量关联 ${accounts.length} 个账号到环境「${target.name}」`)
    res.json({ updated: accounts.length })
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
  // 路由实现已抽到 src/main/routes/cookies.ts，解析逻辑在 src/main/cookieText.ts（可离线单测）。
  registerCookieRoutes(router, {
    getDs: () => AppDataSource,
    authMiddleware,
    writeLog,
    applyCookies
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

  // ===== 邮箱邀请成员 =====
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  // 创建邀请并发送邮件：管理员向指定邮箱发出邀请，收件人凭令牌加入团队。
  router.post('/team/invites', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const { emails, role } = req.body || {}
    const list = Array.isArray(emails)
      ? emails
      : String(emails || '')
          .split(/[\s,;]+/)
          .map((s: string) => s.trim())
          .filter(Boolean)
    if (list.length === 0) return res.status(400).json({ message: '请填写至少一个邮箱' })
    if (list.length > 50) return res.status(400).json({ message: '单次最多邀请 50 个邮箱' })
    const cleanRole = role === 'admin' ? 'admin' : 'member'
    const settings = await getSettings()
    const smtp = settings.smtp
    if (!smtp || !smtp.host || !smtp.port) {
      return res.status(400).json({ message: '尚未配置 SMTP，请先到「设置 → 邮件 SMTP」填写邮件服务器' })
    }
    const team = await AppDataSource.getRepository(TeamEntity).findOne({ where: { id: req.tid } })
    const teamName = team?.name || '未知团队'
    const inviteRepo = AppDataSource.getRepository(TeamInviteEntity)
    const sent: string[] = []
    const failed: { email: string; error: string }[] = []
    for (const raw of list) {
      const email = String(raw).trim().toLowerCase()
      if (!EMAIL_RE.test(email)) {
        failed.push({ email, error: '邮箱格式不正确' })
        continue
      }
      const token = crypto.randomBytes(24).toString('hex')
      const expiresAt = new Date(Date.now() + 7 * 86_400_000)
      await inviteRepo.save(inviteRepo.create({ teamId: req.tid, inviterId: req.uid, email, role: cleanRole, token, expiresAt, usedAt: null }))
      const link = `${apiBase}/accept-invite?token=${token}`
      const roleText = cleanRole === 'admin' ? '管理员' : '成员'
      const html = buildInviteEmailHtml(teamName, roleText, link)
      const result = await sendSmtpMail(
        { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass, from: smtp.from, rejectUnauthorized: smtp.rejectUnauthorized },
        email,
        'RoxyBrowser 团队邀请',
        html
      )
      if (result.ok) sent.push(email)
      else failed.push({ email, error: result.error || '发送失败' })
    }
    await writeLog(req, 'invite_member', `邮件邀请 ${sent.length} 人${failed.length ? `，${failed.length} 人失败` : ''}`)
    res.json({ ok: true, sent, failed })
  })

  // 列出本团队的待接受邀请（未使用且未过期）
  router.get('/team/invites', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const repo = AppDataSource.getRepository(TeamInviteEntity)
    const rows = await repo.find({ where: { teamId: req.tid }, order: { id: 'DESC' } })
    const now = Date.now()
    res.json(
      rows
        .filter((r) => !r.usedAt && r.expiresAt.getTime() > now)
        .map((r) => ({ id: r.id, email: r.email, role: r.role, expiresAt: r.expiresAt, createdAt: r.createdAt }))
    )
  })

  // 撤销邀请（仅未使用的可撤销）
  router.delete('/team/invites/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const repo = AppDataSource.getRepository(TeamInviteEntity)
    const inv = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!inv) return res.status(404).json({ message: '邀请不存在' })
    if (inv.usedAt) return res.status(400).json({ message: '该邀请已被接受，无法撤销' })
    await repo.remove(inv)
    await writeLog(req, 'revoke_invite', `撤销向 ${inv.email} 的邀请`)
    res.json({ ok: true })
  })

  // 测试 SMTP 配置：向指定邮箱发一封测试邮件（可用表单里的未保存配置覆盖）
  router.post('/team/invites/test', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const settings = await getSettings()
    const override = req.body?.smtp
    const smtp =
      override && typeof override === 'object' && override.host && override.port
        ? (override as SmtpSettings)
        : settings.smtp
    if (!smtp || !smtp.host || !smtp.port) return res.status(400).json({ message: 'SMTP 未配置' })
    const to = String(req.body?.email || smtp.from || '').trim()
    if (!EMAIL_RE.test(to)) return res.status(400).json({ message: '请填写有效的测试收件邮箱' })
    const result = await sendSmtpMail(
      { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass, from: smtp.from, rejectUnauthorized: smtp.rejectUnauthorized },
      to,
      'RoxyBrowser SMTP 测试邮件',
      '<p>这是一封来自 RoxyBrowser 的 SMTP 配置测试邮件，收到即表示配置正确。</p>'
    )
    if (result.ok) return res.json({ ok: true })
    res.status(400).json({ ok: false, error: result.error || '发送失败' })
  })

  // 公开：邀请信息（用于接受页展示团队名 / 角色）。无需登录。
  router.get('/team/invites/accept/info', async (req: Request, res: Response) => {
    const token = String(req.query.token || '')
    if (!token) return res.json({ ok: false, message: '缺少令牌' })
    const inv = await AppDataSource.getRepository(TeamInviteEntity).findOne({ where: { token } })
    if (!inv) return res.json({ ok: false, message: '邀请链接无效或已被撤销' })
    if (inv.usedAt) return res.json({ ok: false, message: '该邀请已被使用' })
    if (inv.expiresAt.getTime() <= Date.now()) return res.json({ ok: false, message: '邀请已过期，请联系邀请人重新发送' })
    const team = await AppDataSource.getRepository(TeamEntity).findOne({ where: { id: inv.teamId } })
    res.json({ ok: true, teamName: team?.name || '未知团队', role: inv.role, email: inv.email })
  })

  // 公开：接受邀请。收件人凭令牌注册 / 加入团队。无需登录。
  router.post('/team/invites/accept', async (req: Request, res: Response) => {
    const { token, username, password, nickname } = req.body || {}
    if (!token || !username || !password) return res.status(400).json({ ok: false, message: '令牌、用户名、密码均为必填' })
    if (!EMAIL_RE.test(String(username)) && !/^[\w.\-]{3,}$/.test(String(username))) {
      return res.status(400).json({ ok: false, message: '用户名需为 3 位以上字母数字或下划线' })
    }
    if (String(password).length < 6) return res.status(400).json({ ok: false, message: '密码至少 6 位' })
    const inviteRepo = AppDataSource.getRepository(TeamInviteEntity)
    const inv = await inviteRepo.findOne({ where: { token: String(token) } })
    if (!inv) return res.status(404).json({ ok: false, message: '邀请链接无效或已被撤销' })
    if (inv.usedAt) return res.status(400).json({ ok: false, message: '该邀请已被使用' })
    if (inv.expiresAt.getTime() <= Date.now()) return res.status(400).json({ ok: false, message: '邀请已过期，请联系邀请人重新发送' })

    const userRepo = AppDataSource.getRepository(UserEntity)
    const memberRepo = AppDataSource.getRepository(TeamMemberEntity)
    let user = await userRepo.findOne({ where: { username: String(username) } })
    if (user) {
      const existing = await memberRepo.findOne({ where: { teamId: inv.teamId, userId: user.id } })
      if (existing) return res.status(400).json({ ok: false, message: '该用户名已在本团队中' })
      await memberRepo.save(memberRepo.create({ teamId: inv.teamId, userId: user.id, role: inv.role }))
    } else {
      user = await userRepo.save(userRepo.create({ username: String(username), passwordHash: await bcrypt.hash(String(password), 10), nickname: String(nickname || username) }))
      await memberRepo.save(memberRepo.create({ teamId: inv.teamId, userId: user.id, role: inv.role }))
    }
    inv.usedAt = new Date()
    await inviteRepo.save(inv)
    const team = await AppDataSource.getRepository(TeamEntity).findOne({ where: { id: inv.teamId } })
    // 接受操作无登录态，单独写一条审计日志（不依赖 req）
    await AppDataSource.getRepository(OperationLogEntity).save(
      AppDataSource.getRepository(OperationLogEntity).create({
        teamId: inv.teamId,
        userId: user!.id,
        username: user!.username,
        action: 'accept_invite',
        detail: `接受邀请加入团队「${team?.name || ''}」（${inv.role}）`,
        sensitive: true
      })
    )
    res.json({ ok: true, teamName: team?.name || '' })
  })

  // ===== 操作日志 =====
  // 路由实现已抽到 src/main/routes/logs.ts（server.ts 过大，按域逐步拆分）。
  // getDs 传函数而非值：AppDataSource 是运行时赋值的 export let，按值捕获会拿到 undefined。
  registerLogRoutes(router, { getDs: () => AppDataSource, authMiddleware, writeLog })

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

  // ===== 智能助手（Planner）：自然语言查询全项目 + 危险动作提案 + 确认后执行 =====
  // body: { message: string, history?: [{role,content}] }
  // 返回 AssistantResult：understanding / reply / queries(带深链) / actions(待确认提案)
  router.post('/assistant/chat', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const settings = await getSettings()
    const a = settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings)
    if (!a.enabled) {
      res.status(400).json({ message: '智能助手未启用，请先在「设置 → AI Agent」开启' })
      return
    }
    const message = typeof (req.body || {}).message === 'string' ? (req.body as { message: string }).message.trim() : ''
    if (!message) {
      res.status(400).json({ message: '请输入要查询的内容' })
      return
    }
    const history: OllamaMessage[] = Array.isArray((req.body || {}).history)
      ? (req.body as { history: OllamaMessage[] }).history.filter((m) => m && m.role && m.content).slice(-12)
      : []
    const ctx: PlannerCtx = { ds: AppDataSource, uid: req.uid!, tid: req.tid!, role: await freshRole(req), username: req.username || 'assistant' }
    try {
      const result = await planAssistant(message, a, ctx, history)
      res.json(result)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      res.status(500).json({ message: `助手处理失败：${detail}` })
    }
  })

  // 执行已确认的动作（前端分级确认后调用）。body: { kind, params }
  router.post('/assistant/action', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const kind = (req.body || {}).kind
    const params = (req.body || {}).params || {}
    if (!kind || typeof kind !== 'string') {
      res.status(400).json({ message: '缺少动作 kind' })
      return
    }
    const ctx: PlannerCtx = { ds: AppDataSource, uid: req.uid!, tid: req.tid!, role: await freshRole(req), username: req.username || 'assistant' }
    try {
      const r = await executeAssistantAction(kind, params, ctx)
      if (!r.ok) {
        res.status(400).json({ message: r.message })
        return
      }
      res.json(r)
    } catch (e) {
      res.status(500).json({ message: `动作执行失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // 智能助手「技能库」：把一条结构化计划模板固化复用（运行时不调 LLM，直接按模板重跑）
  router.get('/assistant/skills', authMiddleware, async (req: AuthedRequest, res: Response) => {
    try {
      const repo = AppDataSource.getRepository(AssistantSkillEntity)
      const list = await repo.find({ where: { teamId: req.tid! }, order: { id: 'DESC' } })
      res.json(list.map((s) => ({ id: s.id, name: s.name, trigger: s.trigger, createdAt: s.createdAt })))
    } catch (e) {
      res.status(500).json({ message: `读取技能库失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  router.post('/assistant/skills', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const name = String((req.body || {}).name || '').trim()
    const trigger = String((req.body || {}).trigger || '').trim()
    const template = (req.body || {}).template
    if (!name) {
      res.status(400).json({ message: '请填写技能名称' })
      return
    }
    if (!template || typeof template !== 'object') {
      res.status(400).json({ message: '缺少计划模板' })
      return
    }
    try {
      const repo = AppDataSource.getRepository(AssistantSkillEntity)
      const entity = repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name,
        trigger,
        steps: JSON.stringify(template)
      })
      const saved = await repo.save(entity)
      res.json({ id: saved.id, name: saved.name, trigger: saved.trigger, createdAt: saved.createdAt })
    } catch (e) {
      res.status(500).json({ message: `保存技能失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  router.delete('/assistant/skills/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id)
    if (!id) {
      res.status(400).json({ message: '缺少技能 ID' })
      return
    }
    try {
      const repo = AppDataSource.getRepository(AssistantSkillEntity)
      const s = await repo.findOne({ where: { id, teamId: req.tid! } })
      if (!s) {
        res.status(404).json({ message: '技能不存在' })
        return
      }
      await repo.remove(s)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ message: `删除技能失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // 运行已保存的技能（复用 executePlan，不调 LLM）
  router.post('/assistant/skills/:id/run', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id)
    if (!id) {
      res.status(400).json({ message: '缺少技能 ID' })
      return
    }
    const repo = AppDataSource.getRepository(AssistantSkillEntity)
    const s = await repo.findOne({ where: { id, teamId: req.tid! } })
    if (!s) {
      res.status(404).json({ message: '技能不存在' })
      return
    }
    let template: Plan
    try {
      template = JSON.parse(s.steps) as Plan
    } catch {
      res.status(400).json({ message: '技能模板损坏，无法解析' })
      return
    }
    const ctx: PlannerCtx = { ds: AppDataSource, uid: req.uid!, tid: req.tid!, role: await freshRole(req), username: req.username || 'assistant' }
    try {
      const result = await runSkillPlan(template, ctx)
      await writeLog(req, 'assistant_skill_run', `运行技能「${s.name}」(#${s.id})`)
      res.json(result)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      res.status(500).json({ message: `技能运行失败：${detail}` })
    }
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

  // ===== RPA 市场（内置预设脚本目录）=====
  // 注意：/rpa/market 与 /rpa/market/install/:id 是静态前缀，必须排在 /rpa/:id 之前（既有约定）。
  router.get('/rpa/market', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    res.json(
      MARKET_SCRIPTS.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category,
        tags: m.tags,
        stepCount: m.steps.length,
        variables: m.variables,
        note: m.note || '',
        steps: m.steps
      }))
    )
  })

  // 从市场安装一个预设脚本到当前团队（克隆为一个新脚本，定时配置重置；用户可随后编辑/回放）
  router.post('/rpa/market/install/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const m = MARKET_SCRIPTS.find((x) => x.id === req.params.id)
    if (!m) return res.status(404).json({ message: '市场脚本不存在' })
    const saved = await rpaRepo().save(
      rpaRepo().create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name: m.name,
        remark: `[市场] ${m.description}`.slice(0, 512),
        steps: m.steps,
        variables: normalizeVariables(m.variables),
        scheduleEnabled: false,
        scheduleIntervalMin: 30,
        scheduleProfileId: null
      })
    )
    await writeLog(req, 'install_rpa_market', `从市场安装脚本「${m.name}」(#${saved.id})`)
    res.json({ ok: true, id: saved.id })
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
      ;startRpaRecording(profileId)
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
    const steps = stopRpaRecording(profileId)
    res.json({ steps })
  })

  // 录制状态（轮询用）
  router.get('/rpa/record/status', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const profileId = Number((req.query || {}).profileId)
    if (!profileId) return res.status(400).json({ message: 'profileId 不能为空' })
    const recording = isRpaRecording(profileId)
    const count = rpaRecordCount(profileId)
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
    const runningIds = getRunningWindowIds()
    if (!runningIds.includes(profileId)) {
      return res.status(400).json({ message: '环境未运行，请先打开环境再回放' })
    }
    // 回放可能持续数分钟，不阻塞请求；完成 / 中止写操作日志
    ;(async () => {
      let executed = 0
      let err = ''
      try {
        executed = await replayRpaScript(profileId, steps)
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
