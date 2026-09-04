// 共享类型定义（主进程 / 渲染进程共用）

export type OSKind = 'windows' | 'mac'
export type WebRTCMode = 'disable' | 'real'

export interface Fingerprint {
  os: OSKind
  userAgent: string
  uaFullVersion: string
  platform: string // 'Win32' | 'MacIntel'
  languages: string[]
  timezone: string // IANA 时区
  tzOffset: number // 分钟（与 Date.getTimezoneOffset 一致）
  screenWidth: number
  screenHeight: number
  hardwareConcurrency: number
  deviceMemory: number
  canvasNoise: boolean
  webglVendor: string
  webglRenderer: string
  audioNoise: boolean
  webrtc: WebRTCMode
  doNotTrack: '1' | 'unspecified'
}

export interface ProfileDTO {
  id: number
  teamId: number
  groupId: number | null
  groupName?: string | null
  name: string
  seq: number
  remark: string
  platform: string
  startUrl: string
  proxyId: number | null
  proxyName?: string | null
  proxyInfo?: {
    type: string
    host: string
    port: number
    username?: string
    password?: string
  } | null
  fingerprint: Fingerprint
  isTemplate: boolean
  status: 'idle' | 'running'
  lastOpenedAt: string | null
  // 启用的扩展 ID 列表（关联 extensions 表）
  extensions?: number[] | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ProxyDTO {
  id: number
  teamId: number
  name: string
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string
  password: string
  remark: string
  country: string
  region: string
  city: string
  isp: string
  status: 'unknown' | 'active' | 'invalid'
  latency: number | null
  exitIp: string
  expiresAt: string | null
  // IP 池衍生字段（列表接口附带，非持久列）
  usageCount?: number
  poolStatus?: 'available' | 'in-use' | 'expired' | 'invalid' | 'unknown'
  lastCheckAt: string | null
  createdAt: string
}

export interface UserDTO {
  id: number
  username: string
  nickname: string
  role: 'owner' | 'admin' | 'member'
  createdAt: string
}

export interface AccountDTO {
  id: number
  profileId: number
  profileName?: string
  platform: string
  username: string
  password: string
  remark: string
  createdAt: string
}

// Cookie 同站点策略（与 Electron session.cookies.set 取值一致）
export type SameSite = 'no_restriction' | 'lax' | 'strict' | 'unspecified'

export interface CookieDTO {
  id: number
  profileId: number
  profileName?: string
  domain: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: SameSite
  // ISO 字符串，空表示会话级
  expirationDate: string | null
  hostOnly: boolean
  createdAt: string
}

export interface LogDTO {
  id: number
  username: string
  action: string
  detail: string
  createdAt: string
}

export interface GroupDTO {
  id: number
  teamId: number
  name: string
  sort: number
}

export interface TokenDTO {
  id: number
  name: string
  token: string
  createdAt: string
}

// 浏览器扩展（插件）元数据。扩展以「解压目录」形式存储在 userData/extensions/<id>/
export interface ExtensionDTO {
  id: number
  name: string
  version: string
  description: string | null
  createdAt: string
}

// 浏览器环境默认起始页
export const DEFAULT_START_URL = 'https://www.baidu.com'

// 全局设置（设置页持久化到 app_settings 表）
export interface AppSettings {
  // 新建环境随机指纹时的默认操作系统
  defaultFingerprintOs: 'windows' | 'macos' | 'linux'
  // 新建环境窗口默认尺寸
  defaultWindowWidth: number
  defaultWindowHeight: number
  // 界面主题：浅色 / 深色 / 自动（自动时段见 autoDayStart / autoNightStart）
  theme: 'light' | 'dark' | 'auto'
  // 自动模式时段：白天起始小时（含）/ 黑夜起始小时（含），区间 [dayStart, nightStart) 为白天
  autoDayStart: number
  autoNightStart: number
  // 代理检测超时（秒）
  proxyCheckTimeout: number
  // 代理定时巡检间隔（分钟），0 表示关闭
  proxyCheckInterval: number
  // 操作日志保留天数
  logRetentionDays: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultFingerprintOs: 'windows',
  defaultWindowWidth: 1280,
  defaultWindowHeight: 800,
  theme: 'auto',
  autoDayStart: 7,
  autoNightStart: 18,
  proxyCheckTimeout: 10,
  proxyCheckInterval: 30,
  logRetentionDays: 90
}
