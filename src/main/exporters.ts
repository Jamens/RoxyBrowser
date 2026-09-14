/**
 * 可复用的「导出 / 导入」原子操作。
 * 既供各模块独立路由使用（/profiles/export/:id、/profiles/import、/proxies、/rpa …），
 * 也供「全空间快照」拼装单个文件时复用——保证单模块迁移与整团队迁移走的是同一套逻辑，
 * 不会出现「单独导出能还原、快照却丢字段」的偏差。
 *
 * 所有函数仅依赖运行时注入的 AppDataSource（在 initDb 后才可用），不在模块加载期调用。
 */
import { IsNull } from 'typeorm'
import { AppDataSource } from './server'
import {
  ProfileEntity,
  TeamEntity,
  GroupEntity,
  ProxyEntity,
  AccountEntity,
  CookieEntity,
  ExtensionEntity,
  RpaScriptEntity
} from './entities'
import { normalizeFingerprint } from '../shared/fingerprint'
import { DEFAULT_START_URL, type Fingerprint } from '../shared/types'
import { SNAPSHOT_FORMAT, SNAPSHOT_VERSION, type SnapshotFile, type ProfileSnapshot, type ProxySnapshot, type RpaSnapshot, type ExtensionSnapshot } from '../shared/snapshot'

/** 调用上下文：导出/导入都需要团队与操作者信息；role 用于决定账号隔离范围（owner/admin 不过滤） */
export interface ExportCtx {
  tid: number
  uid?: number
  role?: string
}

/** 复刻 server.ts 的 ownerScope：admin/owner 返回 {}（全量），其余仅本人数据 */
function scopeOf(ctx: ExportCtx): Record<string, unknown> {
  const role = ctx.role || 'member'
  if (role === 'owner' || role === 'admin') return {}
  return { ownerId: ctx.uid }
}

// ===================== 环境（整环境导出/导入，含账号 + Cookie + 扩展名）=====================

/** 整环境导出（与 GET /profiles/export/:id 完全一致的结构） */
export async function exportProfileFull(p: ProfileEntity, ctx: ExportCtx): Promise<ProfileSnapshot> {
  const extRepo = AppDataSource.getRepository(ExtensionEntity)
  const groupRepo = AppDataSource.getRepository(GroupEntity)
  const proxyRepo = AppDataSource.getRepository(ProxyEntity)
  const accRepo = AppDataSource.getRepository(AccountEntity)
  const cookieRepo = AppDataSource.getRepository(CookieEntity)

  const group = p.groupId ? await groupRepo.findOne({ where: { id: p.groupId, teamId: ctx.tid } }) : null
  const proxy = p.proxyId ? await proxyRepo.findOne({ where: { id: p.proxyId, teamId: ctx.tid } }) : null
  const accounts = await accRepo.find({ where: { profileId: p.id } })
  const cookies = await cookieRepo.find({ where: { profileId: p.id } })
  const extIds = Array.isArray(p.extensions) ? (p.extensions as number[]) : []
  const extensions = extIds.length ? await extRepo.find({ where: extIds.map((id) => ({ id, teamId: ctx.tid })) }) : []

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    name: p.name,
    platform: p.platform,
    startUrl: p.startUrl,
    remark: p.remark,
    fingerprint: p.fingerprint,
    // 扩展以名称带出，导入端按名重映射回 id
    extensions: extensions.map((e) => e.name),
    group: group ? group.name : null,
    proxy: proxy ? proxy.name : null,
    proxyDetail: proxy
      ? {
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          remark: proxy.remark,
          country: proxy.country,
          region: proxy.region,
          city: proxy.city,
          isp: proxy.isp,
          expiresAt: proxy.expiresAt ? new Date(proxy.expiresAt).toISOString() : null
        }
      : null,
    accounts: accounts.map((a) => ({ platform: a.platform, username: a.username, password: a.password, remark: a.remark })),
    cookies: cookies.map((c) => ({
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
      expirationDate: c.expirationDate ? new Date(c.expirationDate).toISOString() : null,
      hostOnly: c.hostOnly == null ? true : !!c.hostOnly
    }))
  }
}

export interface ImportSummary {
  created: number
  items: Array<{ id: number; name: string }>
  groupsCreated: number
  proxiesCreated: number
  accountsCreated: number
  cookiesCreated: number
}

/**
 * 批量导入整环境（复用 /profiles/import 的全部逻辑）。
 * 分组 / 代理按名称复用，缺失则新建；扩展按名称重映射回 id（目标缺同名扩展则丢弃引用）。
 * 不负责写操作日志——由调用方（路由 / 快照导入）统一记录，保持单一职责。
 */
export async function importProfileItems(
  items: Array<Record<string, unknown>>,
  ctx: ExportCtx
): Promise<ImportSummary> {
  if (!Array.isArray(items) || items.length === 0) {
    return { created: 0, items: [], groupsCreated: 0, proxiesCreated: 0, accountsCreated: 0, cookiesCreated: 0 }
  }
  const repo = AppDataSource.getRepository(ProfileEntity)
  const groupRepo = AppDataSource.getRepository(GroupEntity)
  const proxyRepo = AppDataSource.getRepository(ProxyEntity)
  const accountRepo = AppDataSource.getRepository(AccountEntity)
  const cookieRepo = AppDataSource.getRepository(CookieEntity)
  const extRepo = AppDataSource.getRepository(ExtensionEntity)

  const groupIdByName = new Map((await groupRepo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) } })).map((g) => [g.name, g.id]))
  const proxyIdByName = new Map((await proxyRepo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) } })).map((x) => [x.name, x.id]))
  const extIdByName = new Map((await extRepo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) } })).map((e) => [e.name, e.id]))

  const qbImp = repo.createQueryBuilder('p').select('MAX(p.seq)', 'm').where('p.teamId = :tid', { tid: ctx.tid })
  if (ctx.role !== 'owner' && ctx.role !== 'admin') qbImp.andWhere('p.ownerId = :oid', { oid: ctx.uid })
  let seq = Number((await qbImp.getRawOne<{ m: number | null }>())?.m || 1000)

  const created: Array<{ id: number; name: string }> = []
  let groupsCreated = 0
  let proxiesCreated = 0
  let accountsCreated = 0
  let cookiesCreated = 0

  for (const item of items) {
    // 分组
    let groupId: number | null = null
    const groupName = item.group ? String(item.group) : ''
    if (groupName) {
      if (!groupIdByName.has(groupName)) {
        const g = await groupRepo.save(groupRepo.create({ teamId: ctx.tid, ownerId: ctx.uid ?? 0, name: groupName, sort: 0 }))
        groupIdByName.set(groupName, g.id)
        groupsCreated++
      }
      groupId = groupIdByName.get(groupName) ?? null
    }

    // 代理：先按名称复用，再按 proxyDetail 就地新建
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
              teamId: ctx.tid,
              ownerId: ctx.uid ?? 0,
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

    // 扩展：按名称重映射回 id（目标环境没有同名扩展则丢弃该引用）
    const extNames = Array.isArray(item.extensions) ? (item.extensions as string[]) : []
    const extIds = extNames.map((n) => extIdByName.get(n)).filter((v): v is number => v != null)

    seq += 1
    const p = await repo.save(
      repo.create({
        teamId: ctx.tid,
        ownerId: ctx.uid ?? 0,
        groupId,
        proxyId,
        extensions: extIds,
        name: (item.name as string) || `导入环境 ${seq}`,
        seq,
        platform: (item.platform as string) || '',
        startUrl: (item.startUrl as string) || DEFAULT_START_URL,
        remark: (item.remark as string) || '',
        fingerprint: normalizeFingerprint(item.fingerprint as Partial<Fingerprint> | null) as unknown as Record<string, unknown>,
        createdBy: ctx.uid ?? 0
      })
    )
    created.push({ id: p.id, name: p.name })

    // Cookie：逐条重建并绑定新环境
    for (const c of (item.cookies || []) as Array<Record<string, unknown>>) {
      if (!c?.name || !c?.domain) continue
      await cookieRepo.save(
        cookieRepo.create({
          profileId: p.id,
          ownerId: ctx.uid ?? 0,
          teamId: ctx.tid,
          domain: String(c.domain),
          name: String(c.name),
          value: String(c.value || ''),
          path: String(c.path || '/'),
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: String(c.sameSite || 'unspecified'),
          expirationDate: c.expirationDate ? new Date(c.expirationDate as string | number) : null,
          hostOnly: c.hostOnly == null ? true : !!c.hostOnly
        })
      )
      cookiesCreated++
    }

    // 账号
    for (const acc of (item.accounts || []) as Array<Record<string, unknown>>) {
      if (!acc?.username) continue
      await accountRepo.save(
        accountRepo.create({
          profileId: p.id,
          ownerId: ctx.uid ?? 0,
          platform: String(acc.platform || ''),
          username: String(acc.username),
          password: String(acc.password || ''),
          remark: String(acc.remark || '')
        })
      )
      accountsCreated++
    }
  }

  return { created: created.length, items: created, groupsCreated, proxiesCreated, accountsCreated, cookiesCreated }
}

// ===================== 代理池（结构化，保留国家/地区/到期等元信息）=====================

export async function exportProxiesStructured(ctx: ExportCtx): Promise<ProxySnapshot[]> {
  const repo = AppDataSource.getRepository(ProxyEntity)
  const list = await repo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) }, order: { id: 'ASC' } })
  return list.map((p) => ({
    name: p.name,
    type: p.type,
    host: p.host,
    port: p.port,
    username: p.username || '',
    password: p.password || '',
    remark: p.remark || '',
    country: p.country ?? null,
    region: p.region ?? null,
    city: p.city ?? null,
    isp: p.isp ?? null,
    expiresAt: p.expiresAt ? new Date(p.expiresAt).toISOString() : null,
    status: p.status ?? null,
    anonymity: p.anonymity ?? null
  }))
}

/**
 * 结构化导入代理池：按名称复用已有代理（跳过），缺失则新建。
 * 与快照导入流程配合——先建代理池，环境导入时即可按名复用，避免重复创建。
 */
export async function importProxiesStructured(items: ProxySnapshot[], ctx: ExportCtx): Promise<{ imported: number; skipped: number; failed: string[] }> {
  const repo = AppDataSource.getRepository(ProxyEntity)
  const existing = await repo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) } })
  const byName = new Map(existing.map((x) => [x.name, x]))
  let imported = 0
  let skipped = 0
  const failed: string[] = []
  for (const it of items || []) {
    if (!it || !it.name) {
      failed.push('缺少 name')
      continue
    }
    if (byName.has(it.name)) {
      skipped++
      continue
    }
    if (!it.host || !it.port) {
      failed.push(`${it.name}: 缺少 host/port`)
      continue
    }
    await repo.save(
      repo.create({
        teamId: ctx.tid,
        ownerId: ctx.uid ?? 0,
        name: it.name,
        type: String(it.type || 'http'),
        host: String(it.host),
        port: Number(it.port),
        username: String(it.username || ''),
        password: String(it.password || ''),
        remark: String(it.remark || ''),
        country: it.country || '',
        region: it.region || '',
        city: it.city || '',
        isp: it.isp || '',
        expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
        status: it.status || 'unknown',
        anonymity: it.anonymity || 'unknown'
      })
    )
    imported++
  }
  return { imported, skipped, failed }
}

// ===================== RPA 脚本 =====================

export async function exportRpaStructured(ctx: ExportCtx): Promise<RpaSnapshot[]> {
  const repo = AppDataSource.getRepository(RpaScriptEntity)
  const list = await repo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) }, order: { id: 'ASC' } })
  return list.map((s) => ({ name: s.name, remark: s.remark || '', steps: s.steps as unknown[], variables: (s.variables as Record<string, string>) || null }))
}

/**
 * 导入 RPA 脚本（与 POST /rpa/import 一致：新建到当前团队，定时配置重置为关闭）。
 * 不绑定具体目标环境（快照不保留定时调度归属，避免在新机器上指向不存在的环境）。
 */
export async function importRpaStructured(items: RpaSnapshot[], ctx: ExportCtx): Promise<{ created: number }> {
  const repo = AppDataSource.getRepository(RpaScriptEntity)
  let created = 0
  for (const it of items || []) {
    if (!it || !it.name || !Array.isArray(it.steps)) continue
    const variables = it.variables && typeof it.variables === 'object' && !Array.isArray(it.variables) ? it.variables : null
    await repo.save(
      repo.create({
        teamId: ctx.tid,
        ownerId: ctx.uid ?? 0,
        name: String(it.name).slice(0, 128),
        remark: String(it.remark || '').slice(0, 512),
        steps: it.steps as Record<string, unknown>[],
        variables,
        scheduleEnabled: false,
        scheduleIntervalMin: 30,
        scheduleProfileId: null
      })
    )
    created++
  }
  return { created }
}

// ===================== 扩展（仅元数据引用，实际文件不进快照）=====================

export async function exportExtensionsMeta(ctx: ExportCtx): Promise<ExtensionSnapshot[]> {
  const repo = AppDataSource.getRepository(ExtensionEntity)
  const list = await repo.find({ where: { teamId: ctx.tid, ...scopeOf(ctx) }, order: { id: 'DESC' } })
  return list.map((e) => ({ name: e.name, version: e.version || '', description: e.description || null }))
}

// ===================== 全空间快照：拼装单个团队空间的完整 JSON =====================

/**
 * 把整个团队空间（环境 + 代理 + RPA + 扩展引用）拼装成单个 SnapshotFile。
 * GET /api/snapshot/export 与「定时自动备份」共用此函数，保证手动导出与自动备份同源。
 * `exportedBy` 用于标记来源（手动导出传用户名，自动备份传「系统定时备份」）。
 */
export async function buildSnapshot(ctx: ExportCtx, exportedBy?: string): Promise<SnapshotFile> {
  const teamRepo = AppDataSource.getRepository(TeamEntity)
  const team = await teamRepo.findOne({ where: { id: ctx.tid } })
  const profileRepo = AppDataSource.getRepository(ProfileEntity)
  const profileList = await profileRepo.find({
    where: { teamId: ctx.tid, isTemplate: false, deletedAt: IsNull(), ...scopeOf(ctx) },
    order: { seq: 'ASC' }
  })
  const profiles = await Promise.all(profileList.map((p) => exportProfileFull(p, ctx)))
  const proxies = await exportProxiesStructured(ctx)
  const rpa = await exportRpaStructured(ctx)
  const extensions = await exportExtensionsMeta(ctx)
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    team: { id: ctx.tid, name: team?.name || 'team', icon: team?.icon || null },
    exportedBy,
    proxies,
    rpa,
    extensions,
    profiles
  }
}
