// 共享类型定义（主进程 / 渲染进程共用）
import type { LocaleCode } from './locales'

export type OSKind = 'windows' | 'mac' | 'android' | 'ios'
export type WebRTCMode = 'disable' | 'real' | 'proxy'

export interface Fingerprint {
  os: OSKind
  userAgent: string
  uaFullVersion: string
  coreVersion: number // 内核版本（Chrome 大版本），驱动 UA / UA-CH 客户端提示一致性
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
  // ---- 字体指纹（防御字体枚举） ----
  // 伪造的「已安装字体」列表。按 OS 取一致基础集 + 随机子集，运行时通过
  // document.fonts.check/load 与 Canvas measureText 防护，杜绝宿主机真实字体泄漏。
  fonts: string[]
  // ---- 地理位置（navigator.geolocation 注入） ----
  // 由时区池给出「该时区代表城市」的坐标，运行时整体替换 geolocation API 回灌给页面。
  // 必须与 timezone 自洽：否则「时区东京、坐标纽约」是自相矛盾的关联信号，比不伪装更可疑。
  geoLatitude: number
  geoLongitude: number
  geoAccuracy: number // 精度（米）
  // ---- 追踪器屏蔽 ----
  // 命中已知分析 / 广告 / 埋点域名的请求直接 cancel。
  // 实现在主进程（session.webRequest），不经过 preload——preload 跑在渲染进程，
  // 只能改 JS、拦不到网络请求。用于避免反复调研竞品时被对方埋点识别。
  blockTrackers: boolean
  // ---- HTTP 安全警告 ----
  // 环境窗口导航到明文 http:// 站点时，在页面顶部注入警告条提示连接未加密、存在被窃听 / 篡改风险
  // （对标竞品 RoxyChrome 154 的「HTTP 安全警告」）。默认开启；localhost / 127.0.0.1 / file:// 不触发。
  httpWarning: boolean
  // ---- 媒体查询偏好（prefers-color-scheme / prefers-reduced-motion）----
  // 这两个媒体查询反映 OS 级偏好，是平台级指纹向量之一。统一由 fp 驱动，
  // 避免「同环境每次读到不同值」或「泄漏宿主真实偏好」的矛盾信号（对标 Tier 2 #5）。
  prefersColorScheme: 'light' | 'dark' | 'no-preference'
  prefersReducedMotion: boolean
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

// 整环境迁移导出 / 导入的数据结构（扁平结构，导入直接按字段映射；所有 id 在导入端重新生成）
export interface ProfileExportDTO {
  version: number
  exportedAt: string
  name: string
  platform?: string
  startUrl?: string
  remark?: string
  fingerprint: Record<string, unknown>
  // 扩展以名称形式带出（导入端按名重映射回 id）
  extensions?: string[]
  // 分组 / 代理以名称形式带出；代理附带完整连接信息，导入端优先按名复用、否则就地新建
  group: string | null
  proxy: string | null
  proxyDetail: {
    type?: string
    host: string
    port: number
    username?: string
    password?: string
    remark?: string
    country?: string
    region?: string
    city?: string
    isp?: string
    expiresAt?: string | null
  } | null
  accounts: Array<{ platform?: string; username: string; password?: string; remark?: string }>
  cookies: Array<{
    domain: string
    name: string
    value: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: string
    expirationDate?: string | null
    hostOnly?: boolean
  }>
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
  anonymity: string
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
  /** 成员角色时后端不返回明文密码，此标记为 true（对标官方 3.8.9 账号权限管理） */
  passwordMasked?: boolean
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
  sensitive?: boolean
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
  // 脚本级变量：键 → 值。回放时把步骤里的 {{键}} 替换成对应值（凭据等参数化复用）。
  variables?: Record<string, string> | null
  // 定时执行（到点仅在目标环境运行态时执行，未运行则跳过并写日志）
  scheduleEnabled?: boolean
  scheduleIntervalMin?: number
  scheduleProfileId?: number | null
  lastScheduledRunAt?: string | null
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

// 主机名样式：多级标签 + 可选端口 / 路径
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d+)?(?:\/\S*)?$/i
// 末段必须是字母型 TLD（2-24 位）：这是「网址」与「带点的关键词」的分界线
const TLD_RE = /\.[a-z]{2,24}(?:[:/]|$)/i
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?$/
const LOCALHOST_RE = /^localhost(?::\d+)?(?:\/\S*)?$/i

/**
 * 判断输入框里的是「网址」还是「搜索关键词」，返回最终要打开的地址。
 *
 * 不能只按「含不含点」判定 —— 那会把 `py3.11`、`node.20`、`v1.2` 这类带点的
 * 关键词拼成 https://py3.11 直接打不开。这里要求主机名的最后一段像 TLD
 * （2-24 个字母，后面接 : 或 / 或结束），另外放行 IPv4 与 localhost
 * （它们没有 TLD，但确实该直接访问）。
 *
 * 放在 shared 层是为了可单测：这段逻辑历史上出过 bug，只靠点 UI 很难回归。
 */
export function normalizeTarget(raw: string, engine: SearchEngine): string {
  const s = (raw || '').trim()
  if (!s) return ''
  // 只有协议没有主体（如 "http://"）既不是网址，也不该拿去搜索
  if (/^https?:\/\/\s*$/i.test(s)) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (IPV4_RE.test(s) || LOCALHOST_RE.test(s)) return `https://${s}`
  if (HOST_RE.test(s) && TLD_RE.test(s)) return `https://${s}`
  return searchUrlFor(engine, s)
}

// ===== AI Agent 设置 =====
// 模型后端：本地 Ollama（零 token，默认）/ 云端 BYOK（用户自带 Key，后续阶段开放）
export type AIAgentBackend = 'local' | 'cloud'
export type AIAgentCloudProvider = 'deepseek' | 'qwen' | 'glm' | 'openai'

export interface AIAgentSettings {
  enabled: boolean
  backend: AIAgentBackend
  // 本地 Ollama 文本模型名（Chat/Support/Planner 用，如 qwen2.5:7b）
  localModel: string
  // 本地 Ollama 视觉模型名（Agent 执行闭环看屏决策用，如 minicpm-v:latest）
  localVisionModel: string
  // 云端 BYOK（P4 阶段开放实际调用）
  cloudProvider: AIAgentCloudProvider
  cloudBaseUrl: string
  cloudApiKey: string
  cloudModel: string
  // 云端 BYOK 视觉模型名（Agent 执行闭环看屏决策用，需多模态，如 gpt-4o / qwen-vl-max / glm-4v）
  cloudVisionModel: string
  // 执行闭环（P1+）默认是否要求人工审批
  needApprovalByDefault: boolean
  // 单次运行最大步数上限
  maxStepsPerRun: number
}

// ===== Agent 执行闭环动作协议（VLM 输出契约）=====
// 坐标均为视口像素，与截图 1:1；由主进程经 sendInputEvent 执行
export type AgentAction =
  | { thought: string; action: 'click'; x: number; y: number }
  | { thought: string; action: 'type'; text: string; x?: number; y?: number }
  | { thought: string; action: 'navigate'; url: string }
  | { thought: string; action: 'scroll'; delta: number }
  | { thought: string; action: 'wait'; ms: number }
  | { thought: string; action: 'finish' }
  | { thought: string; action: 'ask'; question?: string }

// ===== AI 定时自动化任务 =====
// 自然语言指令 + 定时触发 agent 闭环：调度器按 intervalMin 触发，仅驱动运行态环境（未运行自动跳过，绝不自动开窗）；
// 跑完后若 saveRpa=true，则把动作序列沉淀为 RPA 模板，下次可离线回放（零 token）。
export interface AiAutoTask {
  /** 稳定 id（前端生成），用于调度器去抖，避免同一条任务被重复触发 */
  id: string
  /** 任务名（展示用） */
  name: string
  /** 自然语言执行指令 */
  instruction: string
  /** 目标环境 id 列表（仅运行态会被驱动） */
  envIds: number[]
  /** 触发间隔（分钟），最小 1 */
  intervalMin: number
  /** 是否启用 */
  enabled: boolean
  /** 跑完是否把动作序列沉淀为 RPA 模板 */
  saveRpa: boolean
  /** 单次最大步数（0 = 跟随全局默认 maxStepsPerRun） */
  maxSteps: number
}

// ===== Webhook 通知 =====
// 单条 Webhook 订阅配置（持久化在 AppSettings.webhooks 里）
export interface WebhookConfig {
  /** 唯一 ID（uuid） */
  id: string
  /** 展示名 */
  name: string
  /** 接收地址 */
  url: string
  /** HMAC-SHA256 签名密钥；为空表示不签名 */
  secret: string
  /** 是否启用 */
  enabled: boolean
  /**
   * 订阅的事件列表（对应操作日志的 action 字符串）：
   * - 含 '*' 或为空数组 = 全部事件
   * - 精确字符串 = 仅该事件（如 'create_profile'）
   * - 'prefix_*' 形式 = 前缀匹配（如 'profile_*' 匹配 create_profile / open_profile ...，'batch_*' 匹配批量操作）
   */
  events: string[]
}

// Webhook 事件分组（设置页多选 UI 的预设；引擎只做字符串匹配，分组纯属展示用）。
// 每个分组的 events 是「关键词」：事件名按 _ 分词后包含该关键词即命中——
// 这样能自然适配「动词在前」的操作日志命名（create_profile / open_profile / batch_delete_profile 都含 profile 段）。
export type WebhookGroupKey = 'profile' | 'proxy' | 'team' | 'account' | 'cookie' | 'rpa' | 'agent' | 'auth'
export const WEBHOOK_EVENT_GROUPS: { key: WebhookGroupKey; events: string[] }[] = [
  { key: 'profile', events: ['profile', 'template'] },
  { key: 'proxy', events: ['proxy'] },
  { key: 'team', events: ['team', 'member', 'token'] },
  { key: 'account', events: ['account'] },
  { key: 'cookie', events: ['cookie'] },
  { key: 'rpa', events: ['rpa'] },
  { key: 'agent', events: ['agent'] },
  { key: 'auth', events: ['login', '2fa'] }
]

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
  // 客户端网络连接方式：system = 跟随系统代理；custom = 使用下方自定义代理
  networkMode: 'system' | 'custom'
  // 自定义代理（networkMode === 'custom' 时生效）：协议 / 主机 / 端口 / 可选账号密码
  customProxyType: 'http' | 'https' | 'socks5'
  customProxyHost: string
  customProxyPort: number
  customProxyUsername: string
  customProxyPassword: string
  // 任务栏图标显示：icon = 应用图标；name = 显示窗口（环境）名称，多窗口并行时便于定位
  trayDisplay: 'icon' | 'name'
  // AI Agent（本地 Ollama / 云端 BYOK）
  aiAgent: AIAgentSettings
  // 全空间快照定时自动备份：把每个团队空间按间隔写入本地目录的快照 JSON
  snapshotBackupEnabled: boolean
  // 备份目录（绝对路径，须为本机已存在的可写目录）
  snapshotBackupDir: string
  // 备份间隔（小时），最小 1，默认 24
  snapshotBackupIntervalH: number
  // AI 定时自动化任务列表（自然语言指令 + 定时触发 agent 闭环 + 跑完沉淀 RPA 模板）
  aiAutoTasks: AiAutoTask[]
  // Webhook 通知订阅列表（操作日志事件触发外发 POST）
  webhooks: WebhookConfig[]
  // 邮件 SMTP 配置（用于邮箱邀请成员）。字段全空表示未配置，邀请功能不可用。
  smtp: SmtpSettings
}

// 邮件 SMTP 配置
export interface SmtpSettings {
  // 服务器主机
  host: string
  // 端口：465 为隐式 TLS；587 通常为 STARTTLS
  port: number
  // true = 465 隐式 TLS；false = 明文连接后升级 STARTTLS（587 常用）
  secure: boolean
  // 登录账号
  user: string
  // 登录密码 / 授权码
  pass: string
  // 发件人邮箱（同时作为信封 MAIL FROM）
  from: string
  // 自签 / 内网证书常需关闭证书校验（true = 严格校验）
  rejectUnauthorized: boolean
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
  logRetentionDays: 90,
  networkMode: 'system',
  customProxyType: 'http',
  customProxyHost: '',
  customProxyPort: 8080,
  customProxyUsername: '',
  customProxyPassword: '',
  trayDisplay: 'icon',
  aiAgent: {
    enabled: false,
    backend: 'local',
    localModel: 'qwen2.5:7b',
    localVisionModel: 'minicpm-v:latest',
    cloudProvider: 'deepseek',
    cloudBaseUrl: '',
    cloudApiKey: '',
    cloudModel: '',
    cloudVisionModel: '',
    needApprovalByDefault: false,
    maxStepsPerRun: 30
  },
  snapshotBackupEnabled: false,
  snapshotBackupDir: '',
  snapshotBackupIntervalH: 24,
  aiAutoTasks: [],
  webhooks: [],
  smtp: {
    host: '',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: '',
    rejectUnauthorized: true
  }
}

// ===== 自动更新（electron-updater）状态推送 =====
// 主进程经 IPC（app:update-status）把更新状态推给渲染端；dev 态不检查更新。
export type UpdaterStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'dev' }
  | { state: 'latest'; version: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
