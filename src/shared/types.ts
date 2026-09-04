// 共享类型定义（主进程 / 渲染进程共用）
import type { LocaleCode } from './locales'

export type OSKind = 'windows' | 'mac' | 'android' | 'ios'
export type WebRTCMode = 'disable' | 'real'

export interface Fingerprint {
  os: OSKind
  userAgent: string
  uaFullVersion: string
  platform: string // 'Win32' | 'MacIntel' | 'Linux armv8l' | 'iPhone'
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
  // ---- 移动端指纹（可选，桌面端不写这些字段） ----
  // 是否注入触摸能力（maxTouchPoints / ontouchstart）
  touch?: boolean
  // 设备像素比（移动端 2~3）
  devicePixelRatio?: number
}

/** OS 展示名（列表/表单/窗口信息共用，避免各处写 if-else） */
export function osLabel(os: string): string {
  return os === 'windows' ? 'Windows' : os === 'mac' ? 'macOS' : os === 'android' ? 'Android' : os === 'ios' ? 'iOS' : os
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

// ===== RPA 脚本 =====
// 步骤在环境窗口内按「稳定 selector + 元素内相对坐标」定位（与多窗口同步同一套编码）
export type RpaStep =
  | { type: 'navigate'; url: string }
  | { type: 'click'; sel: string; rx: number; ry: number }
  | { type: 'input'; sel: string; value: string }
  | { type: 'change'; sel: string; value: string }
  | { type: 'scroll'; x: number; y: number }
  | { type: 'wait'; ms: number }

export interface RpaScriptDTO {
  id: number
  name: string
  remark: string
  steps: RpaStep[]
  createdAt: string
  updatedAt: string
}

// 指纹预设（内置「验证过的指纹组合」，一键套用）
export interface FingerprintPresetDTO {
  id: string
  name: string
  description: string
  fingerprint: Fingerprint
}

// 浏览器环境默认起始页
export const DEFAULT_START_URL = 'https://www.baidu.com'

// ===== 起始页搜索引擎 =====
// 键词搜索的目标引擎。默认 Bing：大陆网络与海外代理下均可直达；
// Google / DuckDuckGo 需环境挂了可用代理才能访问，可在设置页切换。
export type SearchEngine = 'bing' | 'google' | 'baidu' | 'duckduckgo'

export interface SearchEngineDef {
  value: SearchEngine
  /** 展示名（品牌名，不做多语言） */
  label: string
  /** 由搜索关键词生成搜索结果页 URL */
  url: (q: string) => string
}

export const SEARCH_ENGINES: SearchEngineDef[] = [
  { value: 'bing', label: 'Bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { value: 'google', label: 'Google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { value: 'baidu', label: '百度 Baidu', url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
  { value: 'duckduckgo', label: 'DuckDuckGo', url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` }
]

/** 取搜索引擎的搜索 URL；未知引擎回落 Bing */
export function searchUrlFor(engine: string, q: string): string {
  const e = SEARCH_ENGINES.find((x) => x.value === engine) || SEARCH_ENGINES[0]
  return e.url(q)
}

/** 校验并归一化搜索引擎，非法值返回 undefined */
export function normalizeSearchEngine(v: unknown): SearchEngine | undefined {
  return SEARCH_ENGINES.some((e) => e.value === v) ? (v as SearchEngine) : undefined
}

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
  // 所在国家（ISO 3166-1 alpha-2）。自动模式下的白天/黑夜判定按该国的 IANA 时区换算，
  // 冬夏令时由运行时时区库自动处理（见 shared/timezone.ts）
  country: string
  // 界面语言（切换国家时会自动带出该国默认语言，也可单独覆盖）
  language: LocaleCode
  // 环境起始页：输入关键词时使用的搜索引擎（大陆网络下 Google / DuckDuckGo 不可直达）
  searchEngine: SearchEngine
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
  country: 'CN',
  language: 'zh-CN',
  searchEngine: 'bing',
  proxyCheckTimeout: 10,
  proxyCheckInterval: 30,
  logRetentionDays: 90
}
