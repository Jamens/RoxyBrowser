import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  ValueTransformer
} from 'typeorm'
import { lazySecretCrypto } from './secretKey'

/**
 * 凭据列的透明加解密 Transformer。
 *
 * 为什么放在 ORM 层而不是在每个路由里手动 encrypt/decrypt：
 * 凭据散落在几十条读写路径上（账号 CRUD、代理检测、导出、快照、RPA、AI 助手…），
 * 手动改造必然漏——**漏一处就是明文落库或密文当密码用**。ValueTransformer 让
 * 「进入实体即加密、离开实体即解密」成为默认行为，新增代码无需记得加解密，
 * 也就不会漏。这是唯一能保证「以后也不漏」的做法。
 *
 * 代价：Transformer 对**所有** find/save 生效，包括 `repo.save(整个实体)` 的回写——
 * 但因为解密后的值是明文、再加密后 ciphertext 不同（随机 IV），回写不会造成数据损坏，
 * 只会让 updatedAt 类字段照常更新。
 */
const secretTransformer: ValueTransformer = {
  to: (value?: unknown) => lazySecretCrypto().encrypt(value),
  from: (value?: unknown) => lazySecretCrypto().decrypt(value)
}

/**
 * 凭据列的 varchar 宽度上限。
 *
 * 必须加宽，否则**静默截断**——这是最容易踩的坑：明文 256 字符的密码加密后
 * 约 256*4/3 + 12(IV) + 16(tag) + 前缀 ≈ 385 字符，塞进 varchar(256) 会被 MySQL
 * 截掉尾部，解密时 GCM 认证失败 → 密码错误，且报错点离病因十万八千里。
 * 512 对 256 字符明文留足余量（且账号密码远达不到 256 字符）。
 */
export const SECRET_COLUMN_LENGTH = 512


@Entity('users')
@Unique(['username'])
export class UserEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'varchar', length: 64 })
  username: string

  @Column({ type: 'varchar', length: 128 })
  passwordHash: string

  @Column({ type: 'varchar', length: 64, default: '' })
  nickname: string

  // 登录二次验证（TOTP）：secret 为 base32 编码的 TOTP 密钥；enabled 表示已启用
  // 静态加密：TOTP 密钥泄漏 = 账号被长期接管（攻击者可离线生成任意 6 位动态码），
  // 其敏感度与明文密码同级，不能只保护账号密码却放过它
  @Column({ type: 'varchar', length: SECRET_COLUMN_LENGTH, nullable: true, transformer: secretTransformer })
  twoFactorSecret: string | null

  @Column({ type: 'tinyint', default: 0 })
  twoFactorEnabled: boolean

  /**
   * 会话版本号：递增即吊销该用户**全部**已签发的会话令牌。
   * 登出 / 改密码 / 管理员强制下线都靠它实现——见 `shared/sessionRevoke.ts`。
   * 不用 JWT 黑名单是因为黑名单要无限增长且过期清理出错（漏删 = 死令牌仍有效），
   * 而我们真正需要的语义是「让某个用户的全部会话失效」，一个整数就够了。
   */
  @Column({ type: 'int', default: 0 })
  tokenVersion: number

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('teams')
export class TeamEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'varchar', length: 128 })
  name: string

  // 团队图标：存 data URL（base64），为空表示使用默认图标。
  // 必须用 longtext：MySQL 的 text 上限仅 64KB，而一张图片转 base64 后往往几百 KB 甚至 1MB+，
  // 用 text 会静默截断 / 写入失败（表现为「上传大图没提示也存不进去」）。
  @Column({ type: 'longtext', nullable: true })
  icon: string | null

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('team_members')
@Unique(['teamId', 'userId'])
export class TeamMemberEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  @Column({ type: 'int' })
  userId: number

  // owner | admin | member
  @Column({ type: 'varchar', length: 16, default: 'member' })
  role: string

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

// 邮箱邀请：管理员向指定邮箱发送邀请，收件人凭令牌加入团队。
// 令牌一次有效（usedAt 标记），过期时间由 expiresAt 控制（默认 7 天）。
@Entity('team_invites')
export class TeamInviteEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  @Column({ type: 'int' })
  inviterId: number

  @Column({ type: 'varchar', length: 255 })
  email: string

  // owner | admin | member（仅 admin / member 实际可用，owner 不通过邀请下发）
  @Column({ type: 'varchar', length: 16, default: 'member' })
  role: string

  @Column({ type: 'varchar', length: 64, unique: true })
  token: string

  @Column({ type: 'datetime' })
  expiresAt: Date

  // 接受时间；NULL 表示尚未使用
  @Column({ type: 'datetime', nullable: true })
  usedAt: Date | null

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('groups')
@Index(['teamId'])
export class GroupEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 64 })
  name: string

  @Column({ type: 'int', default: 0 })
  sort: number

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('proxies')
@Index(['teamId'])
export class ProxyEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 128, default: '' })
  name: string

  // http | https | socks5
  @Column({ type: 'varchar', length: 16, default: 'http' })
  type: string

  @Column({ type: 'varchar', length: 128 })
  host: string

  @Column({ type: 'int' })
  port: number

  @Column({ type: 'varchar', length: 128, default: '' })
  username: string

  // 静态加密：代理凭据高频出现在「检测代理」「导出池」「环境 DTO」等路径，
  // 走统一 Transformer 避免任何一条路径漏加密
  @Column({ type: 'varchar', length: SECRET_COLUMN_LENGTH, default: '', transformer: secretTransformer })
  password: string

  @Column({ type: 'varchar', length: 256, default: '' })
  remark: string

  @Column({ type: 'varchar', length: 64, default: '' })
  country: string

  // 州/省（ip-api regionName）
  @Column({ type: 'varchar', length: 64, default: '' })
  region: string

  @Column({ type: 'varchar', length: 64, default: '' })
  city: string

  @Column({ type: 'varchar', length: 128, default: '' })
  isp: string

  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  status: string

  @Column({ type: 'int', nullable: true })
  latency: number | null

  // 匿名度：elite 高匿 / anonymous 匿名 / transparent 透明（泄露真实 IP）/ unknown 未测出
  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  anonymity: string

  @Column({ type: 'varchar', length: 64, default: '' })
  exitIp: string

  // 代理到期时间（购买的住宅/数据中心代理常有有效期），为空表示长期有效
  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date | null

  @Column({ type: 'datetime', nullable: true })
  lastCheckAt: Date | null

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('profiles')
@Index(['teamId'])
// 覆盖 `WHERE status = 'running'`：启动自愈与「运行中」筛选都靠它。
// 缺索引时环境一多就是全表扫——这是启动路径上的固定开销。
@Index(['status'])
export class ProfileEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'int', nullable: true })
  groupId: number | null

  @Column({ type: 'varchar', length: 128 })
  name: string

  // 环境序号，如 1001
  @Column({ type: 'int' })
  seq: number

  @Column({ type: 'varchar', length: 512, default: '' })
  remark: string

  @Column({ type: 'varchar', length: 64, default: '' })
  platform: string

  @Column({ type: 'varchar', length: 512, default: '' })
  startUrl: string

  @Column({ type: 'int', nullable: true })
  proxyId: number | null

  @Column({ type: 'json' })
  fingerprint: Record<string, unknown>

  @Column({ type: 'tinyint', default: 0 })
  isTemplate: boolean

  // idle | running
  @Column({ type: 'varchar', length: 16, default: 'idle' })
  status: string

  @Column({ type: 'datetime', nullable: true })
  lastOpenedAt: Date | null

  // 启用的扩展 ID 列表（关联 extensions 表）；null/空数组 = 不加载任何扩展
  @Column({ type: 'json', nullable: true })
  extensions: number[] | null

  @Column({ type: 'int' })
  createdBy: number

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date

  // 软删除时间：null = 正常；非 null = 已进回收站（到期自动清理可后续加定时任务）
  @Column({ type: 'datetime', nullable: true })
  deletedAt: Date | null
}

@Entity('cookies')
@Index(['teamId'])
@Index(['profileId'])
export class CookieEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'int' })
  profileId: number

  // 域名，可带前导点（.example.com 表示包含子域）
  @Column({ type: 'varchar', length: 255, default: '' })
  domain: string

  @Column({ type: 'varchar', length: 255, default: '' })
  name: string

  // TEXT 列在 MySQL 5.7 下不允许设 DEFAULT，去掉 default（插入时显式赋值即可）
  @Column({ type: 'text' })
  value: string

  @Column({ type: 'varchar', length: 512, default: '/' })
  path: string

  @Column({ type: 'tinyint', default: 0 })
  secure: boolean

  @Column({ type: 'tinyint', default: 0 })
  httpOnly: boolean

  // 'no_restriction' | 'lax' | 'strict' | 'unspecified'
  @Column({ type: 'varchar', length: 16, default: 'unspecified' })
  sameSite: string

  // 过期时间（绝对时间），为空表示会话级 Cookie
  @Column({ type: 'datetime', nullable: true })
  expirationDate: Date | null

  // 仅作用于精确主机（不含子域）
  @Column({ type: 'tinyint', default: 1 })
  hostOnly: boolean

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('accounts')
@Index(['profileId'])
export class AccountEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  profileId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 64, default: '' })
  platform: string

  @Column({ type: 'varchar', length: 128 })
  username: string

  // 静态加密：账号密码是本项目最敏感的数据（防关联场景下等于全部店铺资产）
  @Column({ type: 'varchar', length: SECRET_COLUMN_LENGTH, default: '', transformer: secretTransformer })
  password: string

  @Column({ type: 'varchar', length: 256, default: '' })
  remark: string

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('operation_logs')
@Index(['teamId'])
// 列表按 id 倒序取前 500 条本身走主键，但归档按时间扫描「哪些记录该搬」、
// 保留期校验要取最老的一条，都走 createdAt——无索引时后者是全表扫描。
@Index(['createdAt'])
export class OperationLogEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  @Column({ type: 'int' })
  userId: number

  @Column({ type: 'varchar', length: 64 })
  username: string

  @Column({ type: 'varchar', length: 64 })
  action: string

  @Column({ type: 'text' })
  detail: string

  // 敏感操作标记：导出 / 删除 / 改角色 / 成员与令牌管理等，便于前端高亮与筛选
  @Column({ type: 'tinyint', default: 0 })
  sensitive: boolean

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

// ===== 操作日志归档区 =====
// 热区（operation_logs）只保留最近 N 天，更早的按**自然月**整月搬到这里。
// 不直接删除的理由：审计日志的全部价值在于「事后可查」，删掉等于毁掉证据——
// 出了安全事故回头查「三个月前谁导出了 Cookie」，发现已被清理，是不可接受的。
@Entity('operation_log_archives')
// 归档查询几乎总是「按团队 + 按时间范围」，这两列组成复合索引覆盖列表与导出
@Index(['teamId', 'createdAt'])
// batchId 支撑「按批次回溯 / 撤销」与前端展示归档批次
@Index(['batchId'])
export class OperationLogArchiveEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  @Column({ type: 'int' })
  userId: number

  @Column({ type: 'varchar', length: 64 })
  username: string

  @Column({ type: 'varchar', length: 64 })
  action: string

  @Column({ type: 'text' })
  detail: string

  @Column({ type: 'tinyint', default: 0 })
  sensitive: boolean

  // 原始发生时间（从热区原样搬来，不因归档而改变——否则时间线会对不上）
  @Column({ type: 'datetime' })
  createdAt: Date

  // 归档批次号：同一次归档的所有记录共享，便于回溯与按批撤销
  @Column({ type: 'varchar', length: 96 })
  batchId: string

  // 该记录所属自然月（'2026-07'）：归档单元的语义标识，
  // 让「2026 年 7 月的全部日志」成为一个可交付的审计时间段
  @Column({ type: 'varchar', length: 7 })
  month: string
}

@Entity('api_tokens')
@Index(['teamId'])
export class ApiTokenEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 128 })
  name: string

  @Column({ type: 'varchar', length: 128 })
  token: string

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('extensions')
@Index(['teamId'])
export class ExtensionEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 128 })
  name: string

  @Column({ type: 'varchar', length: 32, default: '' })
  version: string

  @Column({ type: 'text', nullable: true })
  description: string | null

  // 解压后扩展目录在 userData 下的相对路径，如 extensions/5
  @Column({ type: 'varchar', length: 512, default: '' })
  extPath: string

  // 图标在 userData 下的相对路径（取自 manifest.json icons），空表示无图标
  @Column({ type: 'varchar', length: 512, default: '' })
  iconPath: string

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('rpa_scripts')
@Index(['teamId'])
export class RpaScriptEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  // 创建者用户 ID，用于账户级隔离（可为空：历史数据归管理员视角）
  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 128 })
  name: string

  @Column({ type: 'varchar', length: 512, default: '' })
  remark: string

  // RpaStep[]：navigate / click / input / change / scroll / wait
  @Column({ type: 'json' })
  steps: Record<string, unknown>[]

  // 脚本级变量：回放时把步骤里的 {{变量名}} 替换成对应值（凭据等可参数化，脚本可复用）。
  // 可空：历史脚本与未配置变量的脚本均为 null。
  @Column({ type: 'json', nullable: true })
  variables: Record<string, string> | null

  // ===== 定时执行（对标 4.0.2「定时任务到点自动开工」）=====
  // 到点只在该环境处于运行态时执行；未运行则跳过本轮并写日志，
  // 不自动开窗——自动拉起窗口会绕过用户对环境的显式控制。
  @Column({ type: 'boolean', default: false })
  scheduleEnabled: boolean

  // 执行间隔（分钟），>= 1
  @Column({ type: 'int', default: 30 })
  scheduleIntervalMin: number

  // 定时执行的目标环境
  @Column({ type: 'int', nullable: true })
  scheduleProfileId: number | null

  // 上次定时执行时间（调度器据此判断是否到点）
  @Column({ type: 'datetime', nullable: true })
  lastScheduledRunAt: Date | null

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date
}

@Entity('app_settings')
export class AppSettingsEntity {
  @PrimaryGeneratedColumn()
  id: number

  // 单例键，固定为 'global'
  @Column({ type: 'varchar', length: 32, default: 'global' })
  key: string

  @Column({ type: 'json' })
  settings: Record<string, unknown>

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date
}

/**
 * 智能助手「技能」：把一次成功的结构化计划（查询 + 动作模板）固化下来复用。
 * steps 存 JSON 字符串（Plan 模板：queries + actions + forEach），运行时不依赖 LLM，
 * 直接用模板重跑查询并展开动作，结果对应当前最新数据。
 */
@Entity('assistant_skills')
@Index(['teamId'])
export class AssistantSkillEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'int' })
  teamId: number

  @Column({ type: 'int', nullable: true })
  ownerId: number

  @Column({ type: 'varchar', length: 128 })
  name: string

  // 触发指令的自然语言描述（仅展示，帮助用户回忆这条技能做什么）
  @Column({ type: 'varchar', length: 255, default: '' })
  trigger: string

  // 结构化计划模板（JSON 字符串）：{ queries: PlanQuery[], actions: PlanAction[] }
  @Column({ type: 'longtext' })
  steps: string

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}
