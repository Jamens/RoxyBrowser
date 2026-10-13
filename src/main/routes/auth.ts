import { Router, type Response, type NextFunction, type Request } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { In } from 'typeorm'
import type { DataSource } from 'typeorm'
import { UserEntity, TeamEntity, TeamMemberEntity, GroupEntity, OperationLogEntity } from '../entities'
import { generateTotpSecret, buildOtpAuthUrl, verifyTotp, totpQrDataUrl } from '../totp'
import { checkLoginLock, clientKeyOf, consumeRateLimit, registerLoginFailure, registerLoginSuccess } from '../../shared/rateLimit'
// 仅类型导入：编译期擦除，不产生运行时循环依赖
import type { BucketStore as LoginBucketStore } from '../../shared/rateLimit'
import { SESSION_TTL_DAYS } from '../../shared/sessionRevoke'
import type { AuthedRequest } from '../authScope'

/** 注册接口限额（每客户端每小时） */
const REGISTER_LIMIT_PER_HOUR = 10

/**
 * 认证域路由（注册 / 登录 / 登出 / 会话 / 团队切换 / 2FA）。
 *
 * 从 server.ts 抽离（原 4140 行文件里约 220 行的一整段）。抽离遵循既有
 * routes/* 的模式：**依赖经 deps 注入**，不反向 import server——
 * 否则 routes → server → routes 形成运行时循环依赖，Node 会在模块求值
 * 阶段拿到 undefined（`AppDataSource` 是 `export let`，initDb 运行时才赋值）。
 */

export interface AuthRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是
   * `export let`，模块加载时按值捕获会拿到 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  /** JWT 签名密钥（由 server 的 getJwtSecret 提供，保持密钥来源唯一） */
  jwtSecret: string
  /**
   * 签发会话令牌的唯一入口。**必须注入而非各自实现**——
   * 各路由手写 jwt.sign 极易漏掉 `ver`（会话版本号）字段，而漏掉不会有任何
   * 编译错误或测试报错，只会让该入口签发的令牌永不被撤销，撤销功能静默破防。
   */
  signSessionToken: (args: {
    uid: number
    username: string
    tokenVersion: number | null
    tid: number
    role: string
  }) => string
  /** 取用户的实时角色（不走 JWT 里的旧角色，避免改了权限却不生效） */
  freshRole: (req: AuthedRequest) => Promise<string>
  isSensitiveAction: (action: string) => boolean
  /** 递增 tokenVersion 吊销该用户全部会话（登出 / 退出所有设备） */
  revokeAllSessions: (uid: number, tid: number, username: string, reason: string) => Promise<void>
  /** 关闭某个环境窗口（切换团队前需关闭旧团队的运行中窗口） */
  closeWindow: (profileId: number) => Promise<void>
  /** 当前所有运行中的环境窗口 id */
  getRunningWindowIds: () => number[]
  /**
   * 登录失败 / 锁定判定所需的桶存储（与通用限流分开：登录按**用户名**计数，
   * 而通用限流按 IP——本地全部来自 127.0.0.1，按 IP 计数等于所有人共用额度，
   * 攻击者猛打任意账号就能把正常用户锁在门外）。
   */
  loginBuckets: LoginBucketStore
  /** 实时读取登录锁定配置（阈值为 0 = 不锁定，仅记录失败次数） */
  getLoginLockConfig: () => Promise<{ threshold: number; lockMs: number }>
  /** 登录被锁定时记审计日志（供安全追溯） */
  onLoginLocked: (username: string, reason: string) => void
}

/** 从实体取签发所需的字段 */
function sessionOf(user: UserEntity, tid: number, role: string) {
  return { uid: user.id, username: user.username, tokenVersion: user.tokenVersion, tid, role }
}

export function registerAuthRoutes(router: Router, deps: AuthRouteDeps): void {
  const { getDs, authMiddleware, jwtSecret, signSessionToken, freshRole, isSensitiveAction, revokeAllSessions, closeWindow, getRunningWindowIds, loginBuckets, getLoginLockConfig, onLoginLocked } =
    deps

  /**
   * 登录保护：在查密码**之前**先查锁定。
   *
   * 顺序很关键——若先比对密码再查锁定，攻击者即便被锁住也能不断发送密码尝试
   * （虽然拿不到会话，但等于保留了密码爆破的探测能力）。先查锁定可直接拒掉。
   */
  const guardLogin = async (username: string) => {
    const cfg = await getLoginLockConfig()
    const bucket = loginBuckets.get(`login:${username}`)
    const lock = checkLoginLock(bucket, Date.now())
    if (!lock.allowed) {
      onLoginLocked(username, lock.reason)
      return lock
    }
    return null
  }

  /** 登录失败处理：累加计数，达阈值则锁定 */
  const noteLoginFailure = async (username: string) => {
    const cfg = await getLoginLockConfig()
    const result = registerLoginFailure(loginBuckets.get(`login:${username}`), Date.now(), cfg.threshold, cfg.lockMs)
    if (!result.allowed) onLoginLocked(username, `连续登录失败达阈值，已锁定：${result.reason}`)
    return result
  }

  router.post('/auth/register', async (req: Request, res: Response) => {
    const { username, password, nickname, teamName } = req.body || {}
    if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' })
    // 注册同样限流：不限流的话，登录锁定可被「换个用户名重试」完全绕过
    const regBucket = loginBuckets.get(`register:${clientKeyOf(req.headers as Record<string, unknown>, req.ip || 'unknown')}`)
    const regLimit = consumeRateLimit(regBucket, Date.now(), REGISTER_LIMIT_PER_HOUR, 60 * 60 * 1000)
    if (!regLimit.allowed) {
      if (regLimit.retryAfterSec > 0) res.setHeader('Retry-After', String(regLimit.retryAfterSec))
      return res.status(429).json({ message: '注册过于频繁，请稍后再试', code: 'rate_limited' })
    }
    const ds = getDs()
    const userRepo = ds.getRepository(UserEntity)
    const exists = await userRepo.findOne({ where: { username } })
    if (exists) return res.status(400).json({ message: '用户名已存在' })
    const user = await userRepo.save(
      userRepo.create({ username, passwordHash: await bcrypt.hash(password, 10), nickname: nickname || username })
    )
    // 每个注册用户创建自己的团队空间
    const teamRepo = ds.getRepository(TeamEntity)
    const team = await teamRepo.save(teamRepo.create({ name: teamName || `${username} 的团队` }))
    const memberRepo = ds.getRepository(TeamMemberEntity)
    await memberRepo.save(memberRepo.create({ teamId: team.id, userId: user.id, role: 'owner' }))
    // 默认分组
    const groupRepo = ds.getRepository(GroupEntity)
    await groupRepo.save(groupRepo.create({ teamId: team.id, name: 'Default', sort: 0 }))
    const token = signSessionToken(sessionOf(user, team.id, 'owner'))
    res.json({ token, user: { id: user.id, username, nickname: user.nickname, role: 'owner' } })
  })

  router.post('/auth/login', async (req: Request, res: Response) => {
    const { username, password } = req.body || {}
    // 锁定检查必须在比对密码之前
    const locked = await guardLogin(String(username || ''))
    if (locked) {
      if (locked.retryAfterSec > 0) res.setHeader('Retry-After', String(locked.retryAfterSec))
      return res.status(locked.status).json({ message: locked.reason, code: 'account_locked' })
    }
    const ds = getDs()
    const userRepo = ds.getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { username } })
    if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
      // 失败计数按**用户名**而非 IP：本地全部来自 127.0.0.1，
      // 按 IP 计数等于所有人共用额度，攻击者猛打任意账号就能锁死正常用户
      const fail = await noteLoginFailure(String(username || ''))
      const body: Record<string, unknown> = { message: '用户名或密码错误' }
      // 仅在接近阈值时提示剩余次数（见 shared/rateLimit.ts 注释：避免帮爆破者定位阈值）
      if (fail.reason) body.message = `用户名或密码错误。${fail.reason}`
      if (fail.retryAfterSec > 0) res.setHeader('Retry-After', String(fail.retryAfterSec))
      return res.status(fail.allowed ? 400 : fail.status).json(body)
    }
    // 登录成功：清空该账号的失败计数与锁定
    registerLoginSuccess(loginBuckets.get(`login:${String(username)}`))
    const memberRepo = ds.getRepository(TeamMemberEntity)
    const member = await memberRepo.findOne({ where: { userId: user.id } })
    let teamId = member?.teamId
    if (!teamId) {
      const teamRepo = ds.getRepository(TeamEntity)
      const team = await teamRepo.save(teamRepo.create({ name: `${user.username} 的团队` }))
      await memberRepo.save(memberRepo.create({ teamId: team.id, userId: user.id, role: 'owner' }))
      const groupRepo = ds.getRepository(GroupEntity)
      await groupRepo.save(groupRepo.create({ teamId: team.id, name: 'Default', sort: 0 }))
      teamId = team.id
    }
    // 登录二次验证（TOTP）：已启用则只发短期挑战令牌，需再用动态码换取正式令牌。
    // 挑战令牌同样带上 ver —— 否则用户改密码后，5 分钟内已发出的挑战令牌
    // 仍能换成正式令牌，撤销机制被绕过。
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const challengeToken = jwt.sign(
        {
          uid: user.id,
          tid: teamId,
          username: user.username,
          role: member?.role || 'owner',
          purpose: '2fa',
          ver: user.tokenVersion ?? 0
        },
        jwtSecret,
        { expiresIn: '5m' }
      )
      return res.json({ twoFactorRequired: true, challengeToken })
    }
    const token = signSessionToken(sessionOf(user, teamId, member?.role || 'owner'))
    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, role: member?.role || 'owner' } })
  })

  // ===== 会话撤销 =====
  // 此前「登出」只是前端清 localStorage，令牌在服务端依然有效满 7 天——
  // 令牌一旦被截获（XSS / 日志泄漏 / 备份文件），攻击者可在有效期内完整使用该账号。
  // 递增 users.tokenVersion 即吊销该用户全部已签发令牌（O(1)，无需黑名单）。
  router.post('/auth/logout', authMiddleware, async (req: AuthedRequest, res: Response) => {
    await revokeAllSessions(req.uid!, req.tid!, req.username || '', '用户登出')
    res.json({ ok: true })
  })

  router.post('/auth/logout-all', authMiddleware, async (req: AuthedRequest, res: Response) => {
    await revokeAllSessions(req.uid!, req.tid!, req.username || '', '退出所有设备')
    res.json({ ok: true })
  })

  // 当前会话状态：供设置页展示「登录有效期」「会话是否仍有效」
  router.get('/auth/session', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const user = await getDs().getRepository(UserEntity).findOne({ where: { id: req.uid } })
    res.json({
      ok: true,
      ttlDays: SESSION_TTL_DAYS,
      twoFactorEnabled: !!user?.twoFactorEnabled,
      username: req.username,
      teamId: req.tid
    })
  })

  router.get('/auth/me', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const userRepo = getDs().getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { id: req.uid } })
    if (!user) return res.status(401).json({ message: '用户不存在' })
    res.json({
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: await freshRole(req),
      twoFactorEnabled: !!user.twoFactorEnabled
    })
  })

  // 列出当前登录用户所属的全部团队（成员关系），并标注哪个是当前团队。
  // 当前团队上下文来自登录时下发的 JWT（req.tid），切换团队需走 /auth/switch-team 重发令牌。
  router.get('/auth/teams', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const ds = getDs()
    const memberRepo = ds.getRepository(TeamMemberEntity)
    const members = await memberRepo.find({ where: { userId: req.uid } })
    const teamRepo = ds.getRepository(TeamEntity)
    const teams = await teamRepo.find({ where: { id: In(members.map((m) => m.teamId)) } })
    const nameById = new Map(teams.map((t) => [t.id, t.name]))
    res.json(
      members.map((m) => ({
        id: m.teamId,
        name: nameById.get(m.teamId) || `团队 ${m.teamId}`,
        role: m.role,
        isCurrent: m.teamId === req.tid
      }))
    )
  })

  // 切换当前工作团队：校验用户确为该团队成员，用其在该团队的实时角色重发会话令牌（tid 变更）。
  // 切换前关闭所有运行中的环境窗口（它们属于旧团队，若不关，切换后其请求会因 teamId 不匹配而报错），
  // 并写一条审计日志（switch_team）记在新团队下。前端拿到新令牌后整页 reload，所有数据自然重新归属新团队。
  router.post('/auth/switch-team', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const teamId = Number((req.body || {}).teamId)
    if (!teamId) return res.status(400).json({ message: '缺少 teamId' })
    const ds = getDs()
    const memberRepo = ds.getRepository(TeamMemberEntity)
    const member = await memberRepo.findOne({ where: { userId: req.uid, teamId } })
    if (!member) return res.status(403).json({ message: '你不是该团队成员，无法切换' })
    const teamRepo = ds.getRepository(TeamEntity)
    const team = await teamRepo.findOne({ where: { id: teamId } })
    // 关闭旧团队运行中的环境窗口。browserManager 已在启动期经 index.ts 静态导入就绪；
    // 其与 server 的循环依赖（引用 AppDataSource）为良性，无需动态 import。
    try {
      for (const id of getRunningWindowIds()) {
        try {
          await closeWindow(id)
        } catch {
          /* 忽略单个窗口关闭失败 */
        }
      }
    } catch {
      /* 窗口关闭异常时跳过 */
    }
    // 重发令牌必须带上当前 tokenVersion：否则切换团队签出的新令牌会「领先」
    // 于库里版本，下一次校验会被判为 session_revoked 而把用户踢下线
    const swUser = await ds.getRepository(UserEntity).findOne({ where: { id: req.uid } })
    if (!swUser) return res.status(401).json({ message: '账号不存在' })
    const token = signSessionToken(sessionOf(swUser, teamId, member.role))
    await ds.getRepository(OperationLogEntity).save({
      teamId,
      userId: req.uid,
      username: req.username || 'api',
      action: 'switch_team',
      detail: `切换到团队「${team?.name || teamId}」`,
      sensitive: isSensitiveAction('switch_team')
    })
    res.json({ token, user: { id: req.uid, username: req.username, nickname: req.username, role: member.role } })
  })

  // ===== 登录二次验证（TOTP）=====
  // 生成密钥 + 二维码（pending：写入 secret 但暂不启用，待 confirm 通过再置 enabled）
  router.post('/auth/2fa/setup', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const userRepo = getDs().getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { id: req.uid } })
    if (!user) return res.status(401).json({ message: '用户不存在' })
    const secret = generateTotpSecret()
    user.twoFactorSecret = secret
    user.twoFactorEnabled = false
    await userRepo.save(user)
    const otpauth = buildOtpAuthUrl('RoxyBrowserClone', user.username, secret)
    const qrCodeDataUrl = await totpQrDataUrl(otpauth)
    res.json({ secret, otpauthUrl: otpauth, qrCodeDataUrl })
  })

  // 用首个动态码确认启用（防止用户没扫上就误开）
  router.post('/auth/2fa/confirm', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const { code } = req.body || {}
    const userRepo = getDs().getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { id: req.uid } })
    if (!user || !user.twoFactorSecret) return res.status(400).json({ message: '请先发起 2FA 设置' })
    if (!verifyTotp(user.twoFactorSecret, code)) return res.status(400).json({ message: '动态码不正确' })
    user.twoFactorEnabled = true
    await userRepo.save(user)
    res.json({ ok: true, twoFactorEnabled: true })
  })

  // 关闭 2FA（需提供当前动态码）
  router.post('/auth/2fa/disable', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const { code } = req.body || {}
    const userRepo = getDs().getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { id: req.uid } })
    if (!user || !user.twoFactorEnabled) return res.status(400).json({ message: '未启用 2FA' })
    if (!verifyTotp(user.twoFactorSecret || '', code)) return res.status(400).json({ message: '动态码不正确' })
    user.twoFactorEnabled = false
    user.twoFactorSecret = null
    await userRepo.save(user)
    res.json({ ok: true, twoFactorEnabled: false })
  })

  // 登录第二步：用挑战令牌 + 动态码换取正式令牌
  router.post('/auth/2fa/verify', async (req: Request, res: Response) => {
    const { challengeToken, code } = req.body || {}
    if (!challengeToken) return res.status(400).json({ message: '缺少挑战令牌' })
    let payload: { uid: number; tid: number; username: string; role: string; purpose?: string }
    try {
      payload = jwt.verify(challengeToken, jwtSecret) as typeof payload
    } catch {
      return res.status(401).json({ message: '挑战已过期，请重新登录' })
    }
    if (payload.purpose !== '2fa') return res.status(401).json({ message: '无效挑战' })
    const userRepo = getDs().getRepository(UserEntity)
    const user = await userRepo.findOne({ where: { id: payload.uid } })
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret)
      return res.status(401).json({ message: '2FA 状态异常，请重新登录' })
    if (!verifyTotp(user.twoFactorSecret, code)) return res.status(400).json({ message: '动态码不正确' })
    const token = signSessionToken(sessionOf(user, payload.tid, payload.role))
    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, role: payload.role } })
  })
}
