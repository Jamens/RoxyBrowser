import { Router, type Response, type NextFunction, type Request } from 'express'
import type { DataSource } from 'typeorm'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { OperationLogEntity, TeamEntity, TeamInviteEntity, TeamMemberEntity, UserEntity } from '../entities'
import { sendSmtpMail } from '../smtp'
import type { AppSettings, SmtpSettings } from '../../shared/types'
import type { AuthedRequest } from '../authScope'

export interface TeamRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  getSettings: () => Promise<AppSettings>
  /**
   * API 基址（服务端监听地址），用于拼邮件里的邀请链接。
   *
   * 必须**取函数**而非传值：`apiBase` 在 server.ts 里是 `export let`，
   * 在 listen() 之后才被赋值。注册路由那一刻按值捕获会拿到空串，
   * 于是邮件里的链接变成 `/accept-invite?token=...`——收件人点开是相对路径，
   * **点了没反应**，且没有任何报错。
   */
  getApiBase: () => string
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

/**
 * 团队与成员域路由：团队信息 / 成员增删改 / 邮箱邀请 / 接受邀请 / SMTP 测试。
 *
 * 从 server.ts 抽离，遵循既有 routes/* 模式：**依赖经 deps 注入**，
 * 不反向 import server（否则 routes → server → routes 运行时循环依赖）。
 *
 * ## 三条不能混淆的口径
 * 1. **权限判定用 `req.role`（JWT 内的角色）**，而非 `isAdminRole` + 查库的实时角色。
 *    这里判的是「能不能改团队成员」这种**管理动作**，与账号明文可见性是两件事。
 * 2. **接受邀请的两个接口是公开的**（不带 authMiddleware）——收件人此时还没有账号，
 *    凭一次性 token 注册。这是全站仅有两处免鉴权写接口之一。
 * 3. **不能移除 owner**（DELETE /team/members/:id）：否则团队会失去唯一的所有者，
 *    谁都再也改不了成员权限——用户把自己锁在门外且无法恢复。
 */
export function registerTeamRoutes(router: Router, deps: TeamRouteDeps): void {
  const { getDs, authMiddleware, writeLog, getSettings, getApiBase } = deps

  router.get('/team', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const teamRepo = getDs().getRepository(TeamEntity)
    const memberRepo = getDs().getRepository(TeamMemberEntity)
    const userRepo = getDs().getRepository(UserEntity)
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
    const repo = getDs().getRepository(TeamEntity)
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
    const userRepo = getDs().getRepository(UserEntity)
    let user = await userRepo.findOne({ where: { username } })
    if (!user) {
      user = await userRepo.save(
        userRepo.create({ username, passwordHash: await bcrypt.hash(password, 10), nickname: nickname || username })
      )
    }
    const memberRepo = getDs().getRepository(TeamMemberEntity)
    const exists = await memberRepo.findOne({ where: { teamId: req.tid, userId: user.id } })
    if (exists) return res.status(400).json({ message: '该用户已在团队中' })
    const m = await memberRepo.save(memberRepo.create({ teamId: req.tid!, userId: user.id, role: role || 'member' }))
    await writeLog(req, 'add_member', `添加成员 ${username}（${role || 'member'}）`)
    res.json(m)
  })

  // 可邀请的已有成员：系统中已存在、但尚未加入当前团队的账号（供「勾选已有成员」使用）
  router.get('/team/candidates', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const memberRepo = getDs().getRepository(TeamMemberEntity)
    const userRepo = getDs().getRepository(UserEntity)
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
    const memberRepo = getDs().getRepository(TeamMemberEntity)
    const userRepo = getDs().getRepository(UserEntity)
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
    const memberRepo = getDs().getRepository(TeamMemberEntity)
    const m = await memberRepo.findOne({ where: { id: Number(req.params.id), teamId: req.tid } })
    if (!m) return res.status(404).json({ message: '成员不存在' })
    if (req.body.role) m.role = req.body.role
    await memberRepo.save(m)
    await writeLog(req, 'update_member', `修改成员角色为 ${m.role}`)
    res.json(m)
  })

  router.delete('/team/members/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    if (req.role === 'member') return res.status(403).json({ message: '无权限' })
    const memberRepo = getDs().getRepository(TeamMemberEntity)
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
    const team = await getDs().getRepository(TeamEntity).findOne({ where: { id: req.tid } })
    const teamName = team?.name || '未知团队'
    const inviteRepo = getDs().getRepository(TeamInviteEntity)
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
      const link = `${getApiBase()}/accept-invite?token=${token}`
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
    const repo = getDs().getRepository(TeamInviteEntity)
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
    const repo = getDs().getRepository(TeamInviteEntity)
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
    const inv = await getDs().getRepository(TeamInviteEntity).findOne({ where: { token } })
    if (!inv) return res.json({ ok: false, message: '邀请链接无效或已被撤销' })
    if (inv.usedAt) return res.json({ ok: false, message: '该邀请已被使用' })
    if (inv.expiresAt.getTime() <= Date.now()) return res.json({ ok: false, message: '邀请已过期，请联系邀请人重新发送' })
    const team = await getDs().getRepository(TeamEntity).findOne({ where: { id: inv.teamId } })
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
    const inviteRepo = getDs().getRepository(TeamInviteEntity)
    const inv = await inviteRepo.findOne({ where: { token: String(token) } })
    if (!inv) return res.status(404).json({ ok: false, message: '邀请链接无效或已被撤销' })
    if (inv.usedAt) return res.status(400).json({ ok: false, message: '该邀请已被使用' })
    if (inv.expiresAt.getTime() <= Date.now()) return res.status(400).json({ ok: false, message: '邀请已过期，请联系邀请人重新发送' })

    const userRepo = getDs().getRepository(UserEntity)
    const memberRepo = getDs().getRepository(TeamMemberEntity)
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
    const team = await getDs().getRepository(TeamEntity).findOne({ where: { id: inv.teamId } })
    // 接受操作无登录态，单独写一条审计日志（不依赖 req）
    await getDs().getRepository(OperationLogEntity).save(
      getDs().getRepository(OperationLogEntity).create({
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
}
