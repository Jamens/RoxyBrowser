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
 * 判断一个 URL 是否为追踪请求。
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

/** 新建环境的默认开关：默认开启（与 canvasNoise / audioNoise 一致，主打防关联） */
export const DEFAULT_BLOCK_TRACKERS = true
