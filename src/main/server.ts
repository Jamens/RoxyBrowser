import 'reflect-metadata'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import cors from 'cors'
import http from 'http'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import { DataSource } from 'typeorm'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { AddressInfo } from 'net'

import {
  UserEntity,
  TeamEntity,
  TeamMemberEntity,
  GroupEntity,
  ProxyEntity,
  ProfileEntity,
  AccountEntity,
  OperationLogEntity,
  ApiTokenEntity
} from './entities'
import { randomFingerprint, defaultFingerprint } from '../shared/fingerprint'
import type { Fingerprint } from '../shared/types'
import { DEFAULT_START_URL } from '../shared/types'

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
let syncToggle: ((enabled: boolean) => void) | null = null
export function setSyncToggle(fn: (enabled: boolean) => void) {
  syncToggle = fn
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

async function checkProxy(proxy: ProxyEntity): Promise<{ ok: boolean; country: string; exitIp: string; latency: number }> {
  try {
    const { body, ms } = await httpGetViaProxy('http://ip-api.com/json/?fields=status,country,query', {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password
    })
    const data = JSON.parse(body)
    if (data.status !== 'success') return { ok: false, country: '', exitIp: '', latency: ms }
    return { ok: true, country: data.country || '', exitIp: data.query || '', latency: ms }
  } catch {
    return { ok: false, country: '', exitIp: '', latency: 0 }
  }
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
  router.post('/sync', authMiddleware, (req: Request, res: Response) => {
    if (syncToggle) syncToggle(!!(req.body || {}).enabled)
    res.json({ ok: true })
  })

  // ===== 浏览器环境（环境内新标签页信息，无需登录态） =====
  router.get('/browser/profile-info/:id', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    let proxyCountry = ''
    if (p.proxyId) {
      const proxyRepo = AppDataSource.getRepository(ProxyEntity)
      const proxy = await proxyRepo.findOne({ where: { id: p.proxyId } })
      proxyCountry = proxy?.country || ''
    }
    res.json({
      id: p.id,
      name: p.name,
      seq: p.seq,
      platform: p.platform,
      startUrl: p.startUrl,
      proxyCountry,
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
    const list = await repo.find({ where: { teamId: req.tid }, order: { sort: 'ASC' } })
    res.json(list)
  })

  router.post('/groups', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(GroupEntity)
    const g = await repo.save(repo.create({ teamId: req.tid, name: req.body.name, sort: req.body.sort || 0 }))
    res.json(g)
  })

  router.delete('/groups/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(GroupEntity)
    const g = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (g) await repo.remove(g)
    if (g) {
      const profileRepo = AppDataSource.getRepository(ProfileEntity)
      await profileRepo.update({ teamId: req.tid, groupId: g.id }, { groupId: null })
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
    const list = await qb.getMany()

    const groupRepo = AppDataSource.getRepository(GroupEntity)
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const groups = await groupRepo.find({ where: { teamId: req.tid } })
    const proxies = await proxyRepo.find({ where: { teamId: req.tid } })
    const groupMap = new Map(groups.map((g) => [g.id, g.name]))
    const proxyMap = new Map(proxies.map((p) => [p.id, p]))
    res.json(list.map((p) => mapProfile(p, p.groupId ? groupMap.get(p.groupId) : null, p.proxyId ? proxyMap.get(p.proxyId) ?? null : null)))
  })

  router.get('/profiles/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    res.json(mapProfile(p))
  })

  router.post('/profiles', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProfileEntity)
    const body = req.body || {}
    const max = await repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
      .getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const fingerprint = (body.fingerprint || defaultFingerprint()) as Fingerprint
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
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
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!p) return res.status(404).json({ message: '环境不存在' })
    const body = req.body || {}
    const fields = ['name', 'remark', 'platform', 'startUrl', 'groupId', 'proxyId'] as const
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
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
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
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
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
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
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
    const tpl = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!tpl) return res.status(404).json({ message: '模板不存在' })
    const max = await repo
      .createQueryBuilder('p')
      .select('MAX(p.seq)', 'm')
      .where('p.teamId = :tid', { tid: req.tid })
      .getRawOne<{ m: number | null }>()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
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
    res.json(randomFingerprint(os === 'mac' ? 'mac' : os === 'windows' ? 'windows' : undefined))
  })

  // ===== 代理 =====
  router.get('/proxies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: { teamId: req.tid }, order: { id: 'DESC' } })
    res.json(list)
  })

  router.post('/proxies', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const b = req.body || {}
    if (!b.host || !b.port) return res.status(400).json({ message: '主机和端口不能为空' })
    const p = await repo.save(
      repo.create({
        teamId: req.tid!,
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
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    const b = req.body || {}
    for (const f of ['name', 'type', 'host', 'username', 'password', 'remark'] as const) {
      if (f in b) (p as any)[f] = b[f]
    }
    if (b.port) p.port = Number(b.port)
    await repo.save(p)
    await writeLog(req, 'update_proxy', `修改代理「${p.name}」(#${p.id})`)
    res.json(p)
  })

  router.delete('/proxies/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    await repo.remove(p)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    await profileRepo.update({ teamId: req.tid, proxyId: p.id }, { proxyId: null })
    await writeLog(req, 'delete_proxy', `删除代理「${p.name}」(#${p.id})`)
    res.json({ ok: true })
  })

  router.post('/proxies/:id/check', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const p = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!p) return res.status(404).json({ message: '代理不存在' })
    const result = await checkProxy(p)
    p.status = result.ok ? 'active' : 'invalid'
    p.latency = result.ok ? result.latency : null
    p.country = result.country
    p.exitIp = result.exitIp
    p.lastCheckAt = new Date()
    await repo.save(p)
    res.json(p)
  })

  // ===== 账号中心 =====
  router.get('/accounts', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profiles = await profileRepo.find({ where: { teamId: req.tid, isTemplate: false } })
    const profileIds = new Set(profiles.map((p) => p.id))
    const all = await repo.find({ order: { id: 'DESC' } })
    const list = all.filter((a) => profileIds.has(a.profileId))
    const nameMap = new Map(profiles.map((p) => [p.id, p.name]))
    res.json(list.map((a) => ({ ...a, profileName: nameMap.get(a.profileId) || '' })))
  })

  router.post('/accounts', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(AccountEntity)
    const profileRepo = AppDataSource.getRepository(ProfileEntity)
    const profile = await profileRepo.findOne({ where: { id: Number(req.body.profileId), teamId: req.tid } })
    if (!profile) return res.status(400).json({ message: '环境不存在' })
    const a = await repo.save(
      repo.create({
        profileId: profile.id,
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
    const profiles = await profileRepo.find({ where: { teamId: req.tid } })
    const ids = new Set(profiles.map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id) } })
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
    const profiles = await profileRepo.find({ where: { teamId: req.tid } })
    const ids = new Set(profiles.map((p) => p.id))
    const a = await repo.findOne({ where: { id: Number(req.params.id) } })
    if (!a || !ids.has(a.profileId)) return res.status(404).json({ message: '账号不存在' })
    await repo.remove(a)
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
    res.json(await repo.find({ where: { teamId: req.tid } }))
  })

  router.post('/tokens', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ApiTokenEntity)
    const token = 'rb_' + crypto.randomBytes(24).toString('hex')
    const t = await repo.save(repo.create({ teamId: req.tid!, name: req.body?.name || '默认令牌', token }))
    await writeLog(req, 'create_token', `创建 API 令牌「${t.name}」`)
    res.json(t)
  })

  router.delete('/tokens/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = AppDataSource.getRepository(ApiTokenEntity)
    const t = await repo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (t) await repo.remove(t)
    res.json({ ok: true })
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
    const max = await repo.createQueryBuilder('p').select('MAX(p.seq)', 'm').where('p.teamId = :tid', { tid }).getRawOne()
    const seq = (max?.m || 1000) + 1
    const p = await repo.save(
      repo.create({
        teamId: tid,
        name: b.name || `API环境 ${seq}`,
        seq,
        platform: b.platform || '',
        startUrl: b.startUrl || DEFAULT_START_URL,
        fingerprint: (b.fingerprint || randomFingerprint()) as Record<string, unknown>,
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

  v1.get('/proxxies', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid } })
    res.json({ code: 0, data: list })
  })
  v1.get('/proxies', async (req: Request, res: Response) => {
    const repo = AppDataSource.getRepository(ProxyEntity)
    const list = await repo.find({ where: { teamId: (req as AuthedRequest).tid } })
    res.json({ code: 0, data: list })
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
      OperationLogEntity,
      ApiTokenEntity
    ]
  })
  await AppDataSource.initialize()

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
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  console.log(`[roxy] API 服务已启动: ${apiBase}`)
  return apiBase
}
