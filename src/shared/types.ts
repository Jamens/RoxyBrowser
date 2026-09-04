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
  status: 'unknown' | 'active' | 'invalid'
  latency: number | null
  exitIp: string
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

// 浏览器环境默认起始页
export const DEFAULT_START_URL = 'https://www.baidu.com'
