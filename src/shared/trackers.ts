/**
 * 追踪器屏蔽：常见「分析 / 广告 / 埋点 / 用户行为录制」域名清单与判定。
 *
 * 纯函数、不依赖 Electron / DB，便于离线单测。
 * 用途：环境窗口的 session 挂 `webRequest.onBeforeRequest`，命中即 cancel，
 * 避免反复访问竞品站点时被对方的埋点、Cookie 或第三方脚本识别出来甚至反监控。
 *
 * 清单原则（很重要，别乱加）：
 * - **只拦明确的分析 / 广告子域，绝不拦主域**。拦 `facebook.com` 会直接让用户登不上号，
 *   拦 `connect.facebook.net` 才只是干掉 SDK 而不影响登录。
 * - 错误上报类（sentry / bugsnag）不拦——那是开发者工具，不是追踪，且拦了会让站点报错刷屏。
 * - CDN 类（jsdelivr / unpkg / cdnjs）不拦——它们是正常资源，拦了页面会碎。
 *
 * 拦截口径（2.0 升级，对标 RoxyChrome 153/154「WebSocket 与后台抓取安全控制」精神）：
 * - 主机清单（TRACKER_HOSTS）：任何资源类型命中即拦，覆盖 http(s) / ws(s) / fetch / beacon
 *   （这些请求在 Chromium 里都带可解析的 hostname，onBeforeRequest 统一拦截）。
 * - 路径签名（TRACKER_PATH_HINTS）：仅对「子资源（脚本 / xhr / ping / websocket，非顶层文档）」
 *   命中已知追踪 SDK 文件名（如 /gtag/js、/matomo.php）时拦截，用于捕捉「第一方可疑 / CDN 托管的
 *   追踪 SDK」——这类用主机清单会误伤主域，故只按文件名精准拦，绝不拦整个主机。
 * - 保护本地 / 内网（localhost / 127.0.0.1 / .local / 私有网段），避免误杀开发 / 调试流量。
 * - 非网络协议（blob: / data: / about: / javascript:）一律放过，绝不误杀。
 */
export const TRACKER_HOSTS: string[] = [
  // ---- Google 分析 / 广告 ----
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'googletagservices.com',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'doubleclick.net',
  'ad.doubleclick.net',
  'pagead2.googlesyndication.com',
  // ---- Meta ----
  'connect.facebook.net',
  'facebook.net',
  'facebook-pixel.net',
  // ---- 用户行为录制 / 热力图 ----
  'hotjar.com',
  'clarity.ms',
  'c.clarity.ms',
  'fullstory.com',
  'mouseflow.com',
  'crazyegg.com',
  'smartlook.com',
  'luckyorange.com',
  // ---- 统计分析平台 ----
  'segment.com',
  'cdn.segment.com',
  'api.segment.io',
  'mixpanel.com',
  // Mixpanel 的 SDK / 上报实际走 mxpnl.com（cdn.mxpnl.com、api.mixpanel.com）
  'mxpnl.com',
  'amplitude.com',
  'cdn.amplitude.com',
  'statcounter.com',
  'clicky.com',
  'quantcast.com',
  'quantserve.com',
  'scorecardresearch.com',
  'chartbeat.com',
  'parsely.com',
  // ---- 广告交易 / 定向 ----
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'criteo.com',
  'outbrain.com',
  'taboola.com',
  'advertising.com',
  'bidswitch.net',
  'adsrvr.org',
  'adroll.com',
  'bluekai.com',
  'crwdcntrl.net',
  'rlcdn.com',
  'mathtag.com',
  'contextweb.com',
  'adsystem.com',
  // ---- 国内外常见统计 ----
  'hm.baidu.com',
  'cnzz.com',
  '51.la',
  'bat.bing.com',
  'mc.yandex.ru',
  'analytics.tiktok.com',
  'snap.licdn.com'
]

/**
 * 已知追踪 SDK 的文件名签名（大小写不敏感子串匹配，只比对 URL pathname）。
 * 用于「主机清单漏掉的第一方 / CDN 托管追踪 SDK」——只拦文件名，不拦整个主机，
 * 因此不会误伤同主机的正常资源。清单刻意保持高置信度、短，避免误杀。
 */
export const TRACKER_PATH_HINTS: string[] = [
  '/gtm.js', // Google Tag Manager
  '/gtag/js', // Google Analytics 4 (gtag)
  '/analytics.js', // Google Analytics
  '/ga.js', // 旧版 GA
  '/matomo.js',
  '/piwik.js', // Matomo / Piwik
  '/matomo.php',
  '/piwik.php', // Matomo 上报端点
  '/__utm.gif' // 旧版 GA 像素
]

/**
 * 判断一个 URL 是否为追踪请求（按主机命中）。
 * 匹配规则：hostname 等于该域名，或以其子域结尾（`x.doubleclick.net` 命中 `doubleclick.net`）。
 * URL 非法 / 非 http(s) 一律返回 false（宁可放过，不可误杀）。
 */
export function isTrackerUrl(url: string, extraHosts: string[] = []): boolean {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  const list = extraHosts.length ? [...TRACKER_HOSTS, ...extraHosts] : TRACKER_HOSTS
  return list.some((d) => host === d || host.endsWith(`.${d}`))
}

/** onBeforeRequest 回调收到的请求描述（仅取我们关心的字段，便于单测传普通对象） */
export interface TrackerRequestDetails {
  url?: string
  /** Electron / Chromium 资源类型：mainFrame / subFrame / script / xhr / ping / websocket / ... */
  resourceType?: string
}

/** 私有 / 保留网段（避免误拦本地与内网调试流量） */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  return false
}

/**
 * 是否应拦截该请求（追踪器屏蔽 2.0 统一判定入口）。
 *
 * 相比 isTrackerUrl 的纯主机匹配，这里额外做：
 * 1. 协议白名单：只拦 http/https/ws/wss，其余（blob/data/about/javascript）放过；
 * 2. 私有网段保护：localhost / 127.0.0.1 / .local / 10.x / 192.168.x / 172.16-31.x 不放过；
 * 3. 主机清单命中即拦（任何资源类型）；
 * 4. 路径签名：仅对「非顶层文档」的子资源命中已知追踪 SDK 文件名时拦，
 *    捕捉第一方 / CDN 托管的追踪 SDK（顶层文档与 iframe 导航不靠路径签名拦，避免误杀正常页面）。
 *
 * 纯函数、无副作用，离线可单测。
 */
export function isTrackerRequest(details: TrackerRequestDetails, extraHosts: string[] = []): boolean {
  const url = details && details.url
  if (!url || typeof url !== 'string') return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const scheme = (u.protocol || '').replace(':', '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') return false
  const host = u.hostname.toLowerCase()
  if (isPrivateHost(host)) return false
  // 1) 主机命中：任何资源类型都拦（清单只含分析 / 广告子域，不拦主域）
  if (isTrackerUrl(url, extraHosts)) return true
  // 2) 路径签名：仅子资源（脚本 / xhr / ping / websocket 等，非顶层文档）
  const rt = (details.resourceType || '').toLowerCase()
  if (rt === 'mainframe' || rt === 'subframe') return false
  const path = (u.pathname || '').toLowerCase()
  if (TRACKER_PATH_HINTS.some((h) => path.includes(h))) return true
  return false
}

/** 新建环境的默认开关：默认开启（与 canvasNoise / audioNoise 一致，主打防关联） */
export const DEFAULT_BLOCK_TRACKERS = true
