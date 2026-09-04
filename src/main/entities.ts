import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique
} from 'typeorm'

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

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('teams')
export class TeamEntity {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'varchar', length: 128 })
  name: string

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

  @Column({ type: 'varchar', length: 256, default: '' })
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

  @Column({ type: 'int' })
  createdBy: number

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date
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

  @Column({ type: 'varchar', length: 256, default: '' })
  password: string

  @Column({ type: 'varchar', length: 256, default: '' })
  remark: string

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
}

@Entity('operation_logs')
@Index(['teamId'])
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

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date
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
