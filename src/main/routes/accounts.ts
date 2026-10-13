import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { AccountEntity, ProfileEntity } from '../entities'
import { isAdminRole, ownerScope } from '../authScope'
import type { AuthedRequest } from '../authScope'

export interface AccountRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /** 取用户的实时角色（不走 JWT 里的旧角色，避免改了权限却不生效） */
  freshRole: (req: AuthedRequest) => Promise<string>
}

/**
 * 账号中心路由：列表 / 增删改 / 批量关联环境 / 批量导入导出。
 *
 * 从 server.ts 抽离，遵循既有 routes/* 模式：**依赖经 deps 注入**，
 * 不反向 import server（否则 routes → server → routes 运行时循环依赖）。
 *
 * ## 权限口径（两条不能混淆的规则）
 * 1. **看得到明文密码** 只给 owner/admin（`isAdminRole`）。member 在列表里
 *    拿到的 `password` 是空串 + `passwordMasked: true`，由前端展示「无权限查看」——
 *    宁可让前端显式提示，也不要让成员以为密码真的为空。
 * 2. **改密码** 同样只给管理员（见 PUT /accounts/:id 的 fields 白名单）。
 *    若允许 member 提交 password 字段，他看不到旧值却能覆盖它——
 *    一次「保存」就把管理员设的密码清成他自己填的值。
 */

export function registerAccountRoutes(router: Router, deps: AccountRouteDeps): void {
  const { getDs, authMiddleware, writeLog, freshRole } = deps

  router.get('/accounts', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
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
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
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
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
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
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
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

    const profileRepo = getDs().getRepository(ProfileEntity)
    const target = await profileRepo.findOne({ where: { id: profileId, isTemplate: false, ...ownerScope(req) } })
    if (!target) return res.status(400).json({ message: '目标环境不存在或无权访问' })

    const repo = getDs().getRepository(AccountEntity)
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

    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
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
    const repo = getDs().getRepository(AccountEntity)
    const profileRepo = getDs().getRepository(ProfileEntity)
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
}
