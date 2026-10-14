/**
 * 全空间快照：单一 JSON 文件承载整个团队空间（环境 + 代理 + RPA + 扩展引用），
 * 新机器一键灌入即还原。本模块为纯函数层（不依赖数据库 / Electron），便于单测。
 *
 * 设计要点：
 * - 环境沿用 /profiles/export/:id 的「整环境」结构（含指纹 / 分组 / 代理 / 账号 / Cookie / 扩展名），
 *   这样导入端可直接复用环境导入器，保证「导出 → 导入」往返一致。
 * - 代理池单独成段：环境只按「名称」引用代理，导入端优先复用已有同名代理、否则按 proxyDetail 新建，
 *   避免多个环境各自新建出 N 份重复代理。
 * - RPA 脚本单独成段（不与特定环境强绑定，定时配置重置为关闭）。
 * - extensions 仅为「名称 / 版本 / 描述」元数据引用，实际扩展文件不进快照（无法序列化），
 *   导入端按名重映射，目标缺同名扩展则丢弃该引用（与 /profiles/import 行为一致）。
 */

export const SNAPSHOT_FORMAT = 'roxy-snapshot'
export const SNAPSHOT_VERSION = 1

/**
 * 环境条目（ProfileSnapshot）自身的结构版本，与文件级 version 独立演进。
 * 为什么要单独一个版本号：文件级管的是「整包结构」（proxies/rpa/extensions 这几段的增删），
 * 环境级管的是「单个环境内部字段」的演进。整包结构没变、只有环境字段改名的情况很常见
 * （例如将来把 expiresAt 从环境顶层挪进 fingerprint），此时不该无谓地升文件版本。
 * 导入端按本字段判断条目是否来自更新版本。
 */
export const PROFILE_SNAPSHOT_VERSION = 1

export interface ProxySnapshot {
  name: string
  type: string
  host: string
  port: number
  username?: string
  password?: string
  remark?: string
  country?: string | null
  region?: string | null
  city?: string | null
  isp?: string | null
  expiresAt?: string | null
  status?: string | null
  anonymity?: string | null
}

export interface RpaSnapshot {
  name: string
  remark?: string
  steps: unknown[]
  variables?: Record<string, string> | null
}

export interface ExtensionSnapshot {
  name: string
  version?: string
  description?: string | null
}

/** 整环境导出（与 /profiles/export/:id 完全对齐） */
export interface ProfileSnapshot {
  version: number
  exportedAt: string
  name: string
  platform?: string
  startUrl?: string
  remark?: string
  fingerprint?: Record<string, unknown> | null
  extensions?: string[]
  group?: string | null
  proxy?: string | null
  proxyDetail?: Record<string, unknown> | null
  accounts?: Array<{ platform?: string; username: string; password?: string; remark?: string }>
  cookies?: Array<Record<string, unknown>>
}

export interface SnapshotFile {
  format: typeof SNAPSHOT_FORMAT
  version: number
  exportedAt: string
  appVersion?: string
  team: { id: number; name: string; icon?: string | null }
  exportedBy?: string
  proxies: ProxySnapshot[]
  rpa: RpaSnapshot[]
  extensions: ExtensionSnapshot[]
  profiles: ProfileSnapshot[]
}

export interface SnapshotSummary {
  profileCount: number
  proxyCount: number
  rpaCount: number
  extensionCount: number
  cookieCount: number
  accountCount: number
  teamName: string
  exportedAt: string
  formatVersion: number
}

export interface SnapshotValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  summary: SnapshotSummary
}

const EMPTY_SUMMARY: SnapshotSummary = {
  profileCount: 0,
  proxyCount: 0,
  rpaCount: 0,
  extensionCount: 0,
  cookieCount: 0,
  accountCount: 0,
  teamName: '',
  exportedAt: '',
  formatVersion: 0
}

/**
 * 版本迁移阶梯：键为「来源版本」，值为把该版本升到下一版的纯函数。
 *
 * 目前只发布过 v1，故阶梯为空。但**入口必须提前就位**：等真要升版时，老快照已经躺在
 * 用户磁盘上，而导入端没有任何机制把它们升到新结构——只能靠「缺失字段当 null」硬扛，
 * 一旦字段改名就是静默数据丢失（更糟的情况：整段被改名，缺失被当成空数组，
 * 代理池/ RPA 全丢，导入还报「成功」）。空阶梯 ≠ 不需要阶梯，是它还没被需要。
 */
const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {}

export interface SnapshotMigrationResult {
  /** 迁移后的数据；补齐可选段、version 已归一到当前版本 */
  data: SnapshotFile
  /** 迁移前的文件级版本（缺 version 的极早期文件按 v1 处理） */
  from: number
  /** 实际到达的版本；小于当前版本说明阶梯有缺口，导入端应拒绝 */
  to: number
  /** 实际执行的迁移步骤，用于回传给用户确认 */
  applied: string[]
}

/**
 * 把任意历史版本的快照升级到当前版本。纯函数，不改入参。
 * 与 validateSnapshot 分工：后者管「能不能导」（结构 + 版本窗口），
 * 本函数管「导进来之后怎么升」。两者都过才允许真正写库。
 */
export function migrateSnapshot(raw: unknown): SnapshotMigrationResult {
  const src = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const rawVer = Number(src.version)
  // 缺 version 的极早期文件按 v1 处理（v1 是首个发布版本，之前没有更早的形态）
  let v = Number.isFinite(rawVer) && rawVer >= 1 ? Math.floor(rawVer) : 1
  const from = v

  let current = src
  const applied: string[] = []
  // 上界由 validateSnapshot 拦截（更未来的快照一律拒绝，不做「尽力而为」的降级导入）
  while (v < SNAPSHOT_VERSION) {
    const step = MIGRATIONS[v]
    // 无对应步骤说明阶梯有缺口（升了 SNAPSHOT_VERSION 却忘了加迁移）。
    // 此时停止升级并如实返回 to < SNAPSHOT_VERSION，由导入端拒绝，不能假装成功。
    if (!step) break
    current = step(current)
    applied.push(`v${v} → v${v + 1}`)
    v += 1
  }
  if (v >= SNAPSHOT_VERSION && Number(current.version) !== SNAPSHOT_VERSION) {
    current = { ...current, version: SNAPSHOT_VERSION }
  }
  return { data: current as unknown as SnapshotFile, from, to: v, applied }
}

/**
 * 校验快照文件结构是否合法（纯函数，不改任何状态）。
 * 宽松校验：缺失的 proxies / rpa / extensions 视为空数组（向后兼容），
 * 仅对必填项（format / version / profiles[]）做强校验。
 */
export function validateSnapshot(data: unknown): SnapshotValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['快照数据不是合法的对象'], warnings, summary: EMPTY_SUMMARY }
  }
  const d = data as Record<string, unknown>

  if (d.format !== SNAPSHOT_FORMAT) {
    errors.push(`format 应为 "${SNAPSHOT_FORMAT}"，实际为 ${JSON.stringify(d.format)}`)
  }
  const version = Number(d.version)
  if (!Number.isFinite(version) || version < 1) {
    errors.push('version 非法或缺失')
  } else if (version > SNAPSHOT_VERSION) {
    // 上界闸门：来自更新版本的快照一律拒绝，不做「尽力而为」的降级导入。
    // 理由：若新版把某一段改名（如 proxies → proxyPool），本版本会把「缺失」当成
    // 空数组 —— 代理池无声丢失，接口却返回成功。用户只能靠升级应用解决。
    errors.push(`快照版本 ${version} 高于当前应用支持的 ${SNAPSHOT_VERSION}，请升级应用后再导入`)
  }

  const profiles = Array.isArray(d.profiles) ? (d.profiles as unknown[]) : null
  if (!profiles) errors.push('profiles 必须为数组')
  let cookieCount = 0
  let accountCount = 0
  if (profiles) {
    profiles.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null) {
        errors.push(`profiles[${i}] 不是对象`)
        return
      }
      const p = raw as Record<string, unknown>
      if (typeof p.name !== 'string' || !p.name) errors.push(`profiles[${i}] 缺少 name`)
      // 环境条目版本超前：只告警不阻断 —— 单个条目不该让整次迁移失败。
      // 但必须让用户看见，否则他以为环境被完整还原了。
      const pv = Number(p.version)
      if (Number.isFinite(pv) && pv > PROFILE_SNAPSHOT_VERSION) {
        warnings.push(`profiles[${i}]「${p.name}」条目版本 ${pv} 高于当前支持的 ${PROFILE_SNAPSHOT_VERSION}，部分字段可能无法还原`)
      }
      if (p.cookies != null && !Array.isArray(p.cookies)) errors.push(`profiles[${i}].cookies 应为数组`)
      else if (Array.isArray(p.cookies)) cookieCount += p.cookies.length
      if (p.accounts != null && !Array.isArray(p.accounts)) errors.push(`profiles[${i}].accounts 应为数组`)
      else if (Array.isArray(p.accounts)) accountCount += p.accounts.length
    })
  }

  if (d.proxies != null && !Array.isArray(d.proxies)) errors.push('proxies 应为数组')
  if (d.rpa != null && !Array.isArray(d.rpa)) errors.push('rpa 应为数组')
  if (d.extensions != null && !Array.isArray(d.extensions)) errors.push('extensions 应为数组')

  const team = d.team && typeof d.team === 'object' ? (d.team as Record<string, unknown>) : null
  if (!team || typeof team.name !== 'string') warnings.push('team.name 缺失，导入时将回退到当前团队')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      profileCount: profiles?.length ?? 0,
      proxyCount: Array.isArray(d.proxies) ? d.proxies.length : 0,
      rpaCount: Array.isArray(d.rpa) ? d.rpa.length : 0,
      extensionCount: Array.isArray(d.extensions) ? d.extensions.length : 0,
      cookieCount,
      accountCount,
      teamName: team?.name ? String(team.name) : '',
      exportedAt: typeof d.exportedAt === 'string' ? d.exportedAt : '',
      formatVersion: Number.isFinite(version) ? version : 0
    }
  }
}

/** 规整快照（缺失可选段补空数组），便于导入端无脑消费 */
export function normalizeSnapshot(data: SnapshotFile): SnapshotFile {
  return {
    format: SNAPSHOT_FORMAT,
    version: Number(data.version) || SNAPSHOT_VERSION,
    exportedAt: data.exportedAt || new Date().toISOString(),
    appVersion: data.appVersion,
    team: data.team && typeof data.team === 'object' ? data.team : { id: 0, name: '' },
    exportedBy: data.exportedBy,
    proxies: Array.isArray(data.proxies) ? data.proxies : [],
    rpa: Array.isArray(data.rpa) ? data.rpa : [],
    extensions: Array.isArray(data.extensions) ? data.extensions : [],
    profiles: Array.isArray(data.profiles) ? data.profiles : []
  }
}
