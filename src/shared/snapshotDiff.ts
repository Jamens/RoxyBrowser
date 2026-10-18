/**
 * 快照导入「差异预演」：在真正写库之前，算清楚这次导入会发生什么。
 *
 * 为什么需要：导入是一个**黑盒按钮**——传文件、弹一个成功数字。
 * 但导入并不总是无损的：
 *   - 同名代理连接信息不同 → 保留现有配置（用户可能已手工改过），导入静默跳过
 *   - 环境引用了目标团队没有的扩展 → 该扩展引用被丢弃
 *   - 环境引用了代理池里没有的代理名 → 代理不会建成，环境将无代理
 *   - 条目版本超前 → 部分字段无法还原
 * 这些以前只能在导入**之后**从日志/告警里零散看到，而那时数据已经写进去了。
 *
 * 设计约束（重要）：
 * **判定口径必须与 src/main/exporters.ts 的真实导入器逐条对齐**，否则预览会骗人——
 * 那比没有预览更糟。importProxiesStructured 的「同名即跳过 + 比对 host:port」、
 * importProfileItems 的「先按名复用代理、再按 proxyDetail 新建」「按名复用分组」
 * 「按名重映射扩展、缺失即丢弃」等规则，这里都按同一套条件复刻。
 *
 * 本模块为纯函数（零依赖），便于离线单测。
 */

import { SNAPSHOT_VERSION, PROFILE_SNAPSHOT_VERSION, type SnapshotFile } from './snapshot'

/** 预演所需的「目标团队现状」快照，由主进程查询后传入 */
export interface DiffContext {
  /** 现有代理：名称 → host:port（判定「同名但连接信息不同」用） */
  proxies: Array<{ name: string; host: string; port: number }>
  /** 现有分组名 */
  groups: string[]
  /** 现有扩展名 */
  extensions: string[]
}

/** 单个代理的预演结果 */
export interface ProxyDiffItem {
  name: string
  /** 'create' = 会新建；'reuse' = 按名复用现有；'conflict' = 同名但连接信息不同（保留现有）；'invalid' = 缺 host/port 建不出来 */
  action: 'create' | 'reuse' | 'conflict' | 'invalid'
  /** 现有连接信息（reuse/conflict 时有值） */
  currentHost?: string
  currentPort?: number
  /** 快照里的连接信息 */
  incomingHost?: string
  incomingPort?: number
  /** 不可建的原因（invalid 时有值） */
  reason?: string
}

export interface ProfileDiffItem {
  name: string
  /** 所属分组名；空表示无分组 */
  group: string
  /** 分组是否会被新建 */
  groupWillCreate: boolean
  /** 代理名；空表示该环境无代理 */
  proxy: string
  /** 代理的处理方式：'reuse' 复用现有 / 'create' 按 proxyDetail 新建 / 'missing' 池中无同名且无 detail 建不出来 */
  proxyAction: 'reuse' | 'create' | 'missing' | 'none'
  /** 扩展名 → 是否会在目标团队找到同名扩展 */
  extensions: Array<{ name: string; found: boolean }>
  /** 条目版本；高于当前支持版本时部分字段无法还原 */
  version: number
  /** version > PROFILE_SNAPSHOT_VERSION */
  versionAhead: boolean
}

export interface SnapshotDiff {
  /** 快照文件级版本（迁移后应为 SNAPSHOT_VERSION） */
  formatVersion: number
  /** 迁移来源版本 → 目标版本 */
  sourceVersion: number
  /** 实际执行的迁移步骤 */
  migrations: string[]
  /** 快照来自哪个团队（可能与当前团队不同） */
  sourceTeam: string
  proxies: ProxyDiffItem[]
  profiles: ProfileDiffItem[]
  /** rpa 脚本名 */
  rpaNames: string[]
  /** 汇总计数，便于 UI 一行展示 */
  counts: {
    proxyCreate: number
    proxyReuse: number
    proxyConflict: number
    proxyInvalid: number
    profileTotal: number
    groupCreate: number
    profileProxyCreate: number
    /** 引用了不存在的扩展，将被丢弃的引用条数 */
    extensionDropped: number
    rpaTotal: number
    versionAhead: number
  }
  /** 人类可读的注意事项（连接信息冲突、扩展引用丢失等） */
  notes: string[]
}

/** 端口比较：两边都转数字再比，避免 "8080" 与 8080 被判为不同 */
function samePort(a: unknown, b: unknown): boolean {
  return Number(a) === Number(b)
}

/** 代理连接信息是否一致（host 与 port 都同） */
function sameEndpoint(cur: { host: string; port: number }, host: string, port: number): boolean {
  return cur.host === host && samePort(cur.port, port)
}

/**
 * 计算导入差异。
 *
 * @param data      已通过 validateSnapshot + migrateSnapshot 的快照
 * @param ctx       目标团队现状（代理 / 分组 / 扩展）
 * @param migration 迁移结果（from / applied），由 migrateSnapshot 提供——本函数不重复实现迁移
 */
export function diffSnapshot(
  data: SnapshotFile,
  ctx: DiffContext,
  migration?: { from: number; applied: string[] }
): SnapshotDiff {
  const proxies = Array.isArray(data.proxies) ? data.proxies : []
  const profiles = Array.isArray(data.profiles) ? data.profiles : []
  const rpa = Array.isArray(data.rpa) ? data.rpa : []

  const proxyByName = new Map((ctx.proxies || []).map((p) => [p.name, p]))
  const groupSet = new Set(ctx.groups || [])
  const extSet = new Set(ctx.extensions || [])

  const notes: string[] = []
  const counts = {
    proxyCreate: 0, proxyReuse: 0, proxyConflict: 0, proxyInvalid: 0,
    profileTotal: profiles.length, groupCreate: 0, profileProxyCreate: 0,
    extensionDropped: 0, rpaTotal: rpa.length, versionAhead: 0
  }

  // ===== 代理池段 =====
  // 口径对齐 importProxiesStructured：无 name / 无 host:port → 计入 failed 不创建；
  // 同名 → 跳过（若连接信息不同则记 conflict 并产出 note）。
  const proxyDiff: ProxyDiffItem[] = proxies.map((p) => {
    const name = String(p?.name || '')
    if (!name) return { name: '', action: 'invalid' as const, reason: '缺少 name' }
    const cur = proxyByName.get(name)
    if (cur) {
      const host = String(p.host || '')
      const port = Number(p.port)
      // 注意：真实导入器对同名代理一律跳过，**不做 host:port 校验后覆盖**，
      // 只在 warnings 里告知差异。这里必须如实反映「保留现有配置」。
      if (p.host && p.port && !sameEndpoint(cur, host, port)) {
        counts.proxyConflict++
        return {
          name, action: 'conflict' as const,
          currentHost: cur.host, currentPort: cur.port,
          incomingHost: host, incomingPort: port
        }
      }
      counts.proxyReuse++
      return { name, action: 'reuse' as const, currentHost: cur.host, currentPort: cur.port }
    }
    if (!p.host || !p.port) {
      counts.proxyInvalid++
      return { name, action: 'invalid' as const, reason: '缺少 host/port' }
    }
    counts.proxyCreate++
    return { name, action: 'create' as const, incomingHost: String(p.host), incomingPort: Number(p.port) }
  })

  // 导入后这些名字就会存在于目标团队（新建的也要计入），
  // 否则 profile 引用它们时会被误判成「池中无同名」。
  const proxyNameAfter = new Set(proxyByName.keys())
  for (const d of proxyDiff) if (d.action === 'create') proxyNameAfter.add(d.name)

  // ===== 环境段 =====
  // 口径对齐 importProfileItems：分组按名复用/新建；代理按名复用，
  // 池中无同名时才看 proxyDetail 能否新建；扩展按名重映射，缺失即丢弃。
  const groupsAfter = new Set(groupSet)
  const profileDiff: ProfileDiffItem[] = profiles.map((raw) => {
    // ProfileSnapshot 是具体接口（无索引签名），转成宽松记录以统一取值口径
    const p = (raw || {}) as unknown as Record<string, unknown>
    const name = String(p.name || '')
    const group = p.group ? String(p.group) : ''
    let groupWillCreate = false
    if (group) {
      if (!groupsAfter.has(group)) { groupsAfter.add(group); groupWillCreate = true; counts.groupCreate++ }
    }

    const proxy = p.proxy ? String(p.proxy) : ''
    let proxyAction: ProfileDiffItem['proxyAction'] = 'none'
    if (proxy) {
      if (proxyNameAfter.has(proxy)) {
        proxyAction = 'reuse'
      } else {
        // 池里没有这个名字：只有 profile 自带 proxyDetail 才建得出来
        const detail = (p.proxyDetail || {}) as Record<string, unknown>
        if (detail.host && detail.port) {
          proxyAction = 'create'
          counts.profileProxyCreate++
        } else {
          // 真实导入器此时 proxyId 保持 null —— 环境会被建成但没有代理，且不报错
          proxyAction = 'missing'
        }
      }
    }

    const extNames = Array.isArray(p.extensions) ? (p.extensions as unknown[]).map((x) => String(x)) : []
    const extensions = extNames.map((n) => ({ name: n, found: extSet.has(n) }))
    counts.extensionDropped += extensions.filter((e) => !e.found).length

    const version = Number(p.version) || 1
    const versionAhead = version > PROFILE_SNAPSHOT_VERSION
    if (versionAhead) counts.versionAhead++

    return { name, group, groupWillCreate, proxy, proxyAction, extensions, version, versionAhead }
  })

  // ===== 注意事项文案 =====
  for (const d of proxyDiff) {
    if (d.action === 'conflict') {
      notes.push(
        `代理「${d.name}」已存在且连接信息不同（现有 ${d.currentHost}:${d.currentPort}，快照 ${d.incomingHost}:${d.incomingPort}），导入时保留现有配置`
      )
    } else if (d.action === 'invalid') {
      notes.push(`代理「${d.name || '(未命名)'}」${d.reason}，将被跳过`)
    }
  }
  for (const p of profileDiff) {
    if (p.proxyAction === 'missing') {
      notes.push(`环境「${p.name}」引用了代理「${p.proxy}」，但代理池中没有同名项且快照未带该代理明细，将导入为无代理环境`)
    }
  }
  // 扩展引用丢失按名称去重，避免同一个缺失扩展被 N 个环境重复提示
  const droppedExtNames = new Set<string>()
  for (const p of profileDiff) {
    for (const e of p.extensions) if (!e.found) droppedExtNames.add(e.name)
  }
  for (const n of droppedExtNames) {
    notes.push(`扩展「${n}」在当前团队不存在，相关引用将被丢弃`)
  }
  for (const p of profileDiff) {
    if (p.versionAhead) {
      notes.push(`环境「${p.name}」条目版本 ${p.version} 高于当前支持的 ${PROFILE_SNAPSHOT_VERSION}，部分字段可能无法还原`)
    }
  }
  if (data.team?.name && data.team.name) {
    notes.push(`快照来自团队「${data.team.name}」，将导入到当前团队（团队成员、角色等不随快照迁移）`)
  }

  return {
    // 迁移后 data.version 已是当前版本；sourceVersion 保留「这份文件原本是第几版」
    formatVersion: SNAPSHOT_VERSION,
    sourceVersion: migration?.from ?? (Number(data.version) || SNAPSHOT_VERSION),
    migrations: migration?.applied ?? [],
    sourceTeam: data.team?.name || '',
    proxies: proxyDiff,
    profiles: profileDiff,
    rpaNames: rpa.map((x) => String(x?.name || '')).filter(Boolean),
    counts,
    notes
  }
}