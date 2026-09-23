// 在线检测站实战验证：让环境窗口真正去第三方指纹检测站跑一遍，把结果抓回来。
//
// 与环境体检（§2.1）的区别——**谁在判卷**：
//   - 环境体检：拿「数据库里的设定值」对撞「窗口内回读值」，属于自己出题自己判卷，
//     只能证明「注入生效了」，证明不了「组合起来像不像真人」。
//   - 在线检测：由第三方站点从外部视角评判，能发现设定值之间**互相矛盾**、
//     或某项指标落在真实人群分布之外这类体检抓不到的问题。
//
// 设计原则：**证据优先、判定从简**。
//   检测站的 DOM 会改版，任何依赖精确选择器的解析都会腐坏；因此这里只做两件稳的事——
//   ① 抓页面可见文本（innerText，去噪后截断）② 截图留证。
//   再按站点配置的 hints 关键词从文本里**摘录相关行**辅助阅读，
//   但不下绝对的「通过 / 不通过」结论——避免误判，也让改版不至于让整个功能失效。
//
// 注：环境窗口是 BrowserWindow 直接承载页面（win.webContents 即页面），
// 因此导航 / 执行 JS / 截图都可直接使用，无 WebContentsView 嵌套。

import type { BrowserWindow } from 'electron'

export interface ScanSite {
  id: string
  name: string
  url: string
  /** 一句话说明该站看什么维度 */
  desc: string
  /** 页面 load 完成后额外等待（SPA 多为异步渲染），毫秒 */
  waitMs: number
  /** 关注关键词：据此从正文里摘录相关行，便于快速定位结论（不区分大小写） */
  hints: string[]
}

/** 内置检测站：按「一致性 → 综合指纹 → 深度分析 → 唯一性」四类各选一个有代表性的 */
export const SCAN_SITES: ScanSite[] = [
  {
    id: 'pixelscan',
    name: 'PixelScan',
    url: 'https://pixelscan.net/',
    desc: '一致性检测：代理出口 IP 国家 ↔ 时区 ↔ 浏览器语言 是否自洽（最贴近防关联诉求）',
    waitMs: 9000,
    hints: ['consistent', 'inconsistent', 'mismatch', 'anomaly', 'proxy', 'timezone', 'network']
  },
  {
    id: 'browserleaks',
    name: 'BrowserLeaks',
    url: 'https://browserleaks.com/',
    desc: '综合指纹：Canvas / WebGL / 字体 / 媒体设备 / WebRTC 各项实测值',
    waitMs: 5000,
    hints: ['canvas', 'webgl', 'fonts', 'hash', 'signature', 'unique', 'webrtc']
  },
  {
    id: 'creepjs',
    name: 'CreepJS',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    desc: '深度技术分析：trust score、是否被识破（lies）、各项熵值',
    waitMs: 12000,
    hints: ['trust', 'score', 'unique', 'lie', 'lies', 'bot', 'shadow', 'trash']
  },
  {
    id: 'amiunique',
    name: 'AmIUnique',
    url: 'https://amiunique.org/',
    desc: '指纹唯一性：在多少样本中你的指纹是独一无二的（越唯一越易被追踪）',
    waitMs: 7000,
    hints: ['unique', 'fingerprint', 'identical', 'same', 'browser']
  }
]

export function getScanSite(id: string): ScanSite | undefined {
  return SCAN_SITES.find((s) => s.id === id)
}

/** 单个关键词最多摘录几行：防止长页面里同一个词刷屏，同时保证多个关键词都有露脸机会 */
const PER_HINT_LIMIT = 2

/**
 * 从正文里按关键词摘录相关行（纯函数，可离线单测）。
 *
 * 规则：按 hints 顺序遍历，**每个关键词最多取 PER_HINT_LIMIT 行**，总数封顶 max。
 * 这样既避免「一个词刷屏占满全部名额」，也保证靠后的关键词不会被饿死。
 * 行级去重（忽略大小写）；过长的行（>=300 字符）视为正文段落而非结论行，直接跳过。
 */
export function extractHighlights(text: string, hints: string[], max = 10): string[] {
  const body = String(text || '')
  // hints 缺失也要安全返回：这是导出的公共函数，调用方可能来自未受控的入参
  if (!body.trim() || !hints || hints.length === 0) return []
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l.length < 300)
  const out: string[] = []
  const seen = new Set<string>()
  for (const h of hints) {
    // h 可能为 null / undefined（配置里混进空值时不要拿 "null" 去匹配正文）
    const needle = h == null ? '' : String(h).toLowerCase()
    if (!needle) continue
    let taken = 0
    for (const line of lines) {
      if (!line.toLowerCase().includes(needle)) continue
      const key = line.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(line)
      taken++
      if (out.length >= max) return out
      if (taken >= PER_HINT_LIMIT) break
    }
    if (out.length >= max) break
  }
  return out
}

/** 通用页面提取脚本：取标题 + 去噪后的可见文本（不依赖任何具体 DOM 结构） */
export const EXTRACT_PAGE_SCRIPT = `(function(){
  try {
    var t = document.body ? (document.body.innerText || '') : '';
    t = String(t).replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    return {
      title: String(document.title || ''),
      text: t.slice(0, 8000),
      url: String(location.href || '')
    };
  } catch (e) {
    return { error: String(e) };
  }
})()`

export interface ScanResult {
  siteId: string
  name: string
  url: string
  /** 页面 <title> */
  title: string
  /** 实际落地 URL（与 url 不同说明发生了跳转；配合 title 可判断是否撞上人机验证） */
  finalUrl: string
  /** 页面可见文本（去噪后截断 8000 字） */
  text: string
  /** 按 hints 摘录的关键行 */
  highlights: string[]
  /** 截图 data URL（证据留存） */
  screenshot: string
  checkedAt: string
  /** 加载失败等异常时给出中文提示；此时仍会尽力带上截图 */
  error?: string
}

interface Extracted {
  title?: string
  text?: string
  url?: string
  error?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 单次扫描的总时限：任何一步悬挂都不能让这次 HTTP 请求永久挂起（与 healthProbe 的 3s race 同思路） */
const TOTAL_TIMEOUT_MS = 40000
/** 主帧加载等待上限 */
const LOAD_TIMEOUT_MS = 15000
/** 导航失败时仍短暂等待，让错误页 / 人机验证页画出来再截图取证 */
const ERROR_PAGE_WAIT_MS = 1500

/** 窗口是否已销毁（每步之前检查，避免关窗后还要空转几十秒才报错） */
const destroyed = (win: BrowserWindow) => win.isDestroyed() || win.webContents.isDestroyed()

/** 把 Chromium 网络错误码翻译成人话（项目既有先例：起始页的代理失败原因提示） */
export function describeLoadError(msg: string): string {
  const m = String(msg || '')
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(m)) return '代理连接失败（请检查该环境绑定的代理是否可用）'
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return '域名解析失败（DNS 不通，或代理未生效）'
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(m)) return '连接超时（网络不通或代理响应慢）'
  if (/ERR_CONNECTION_REFUSED/.test(m)) return '连接被拒绝'
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(m)) return '连接被重置（可能被代理或防火墙中断）'
  if (/ERR_CERT_/.test(m)) return '证书校验失败（可能是代理做了 HTTPS 中间人）'
  if (/ERR_ABORTED/.test(m)) return '导航被打断（可能同时发起了另一次扫描）'
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(m)) return '网络不可用'
  return m
}

/**
 * 等待**主帧**加载完成。
 *
 * 两个坑：
 * 1. 必须判 `isMainFrame` —— iframe / 子资源失败很常见，不能让它提前放行（否则 SPA 还没渲染就抓文本）；
 * 2. 必须用 `on` + 显式 `off`，不能用 `once` —— `once` 会被第一次（子帧）事件消耗掉，
 *    真正的主帧失败反而没人接，且每次超时还会泄漏监听器。
 */
function waitForMainFrame(win: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const onFinish = () => done()
    const onFail = (_e: Electron.Event, _code: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return
      done()
    }
    const cleanup = () => {
      clearTimeout(timer)
      win.webContents.off('did-finish-load', onFinish)
      win.webContents.off('did-fail-load', onFail)
    }
    const done = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    win.webContents.on('did-finish-load', onFinish)
    win.webContents.on('did-fail-load', onFail)
  })
}

/**
 * 在指定环境窗口跑一次检测站扫描。
 * 会把窗口导航到检测站——这是有意为之（结果页本身就是证据），
 * 但不自动跳回原页面：跳回会重新加载，可能丢失用户的登录态或表单。
 *
 * 并发安全由调用方 `browserManager.scanSite` 的 in-flight 锁保证：
 * 同一窗口上叠加两次导航会让前一次 reject，而后续的 执行JS / 截图 会读到后一个站点，
 * 造成「站点名是 A、内容是 B」的张冠李戴——对本功能（卖点就是证据）是致命的。
 */
export async function runSiteScan(win: BrowserWindow, site: ScanSite): Promise<ScanResult> {
  const base = { siteId: site.id, name: site.name, url: site.url }
  let error: string | undefined
  let extracted: Extracted = {}

  const steps = async () => {
    // 1) 导航：失败**不中断**，仍要继续截图取证（用户需要知道页面到底成了什么样）
    try {
      await win.webContents.loadURL(site.url)
    } catch (e) {
      error = describeLoadError(e instanceof Error ? e.message : String(e))
    }
    // loadURL 已等过 did-finish-load，这里再兜一层主帧等待（此时可能还有挂起的子资源）
    if (destroyed(win)) return
    await waitForMainFrame(win, LOAD_TIMEOUT_MS)
    if (destroyed(win)) return
    // 2) 等 SPA 异步渲染；导航失败时只需短等，让错误页 / 验证页画出来
    await sleep(error ? ERROR_PAGE_WAIT_MS : site.waitMs)
    if (destroyed(win)) return
    // 3) 提取文本
    try {
      extracted = (await win.webContents.executeJavaScript(EXTRACT_PAGE_SCRIPT)) as Extracted
      if (extracted && extracted.error) error = error || extracted.error
    } catch (e) {
      error = error || describeLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  try {
    await Promise.race([
      steps(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`检测超时（超过 ${TOTAL_TIMEOUT_MS / 1000} 秒），页面一直未加载完成`)), TOTAL_TIMEOUT_MS)
      )
    ])
  } catch (e) {
    error = error || describeLoadError(e instanceof Error ? e.message : String(e))
  }
  if (destroyed(win)) error = error || '环境窗口已被关闭'

  // 截图始终尝试：即使文本抓取失败，截图也能说明页面到底渲染成了什么样。
  // 失败原因要回填给 error，不能静默吞掉——否则用户拿到「无截图 + 无文本」的零证据结果。
  let screenshot = ''
  try {
    if (!destroyed(win)) {
      const img = await win.webContents.capturePage()
      screenshot = `data:image/png;base64,${img.toPNG().toString('base64')}`
    }
  } catch (e) {
    error = error || `截图失败：${e instanceof Error ? e.message : String(e)}`
  }

  const text = String(extracted.text || '')
  return {
    ...base,
    title: String(extracted.title || ''),
    finalUrl: String(extracted.url || ''),
    text,
    highlights: extractHighlights(text, site.hints),
    screenshot,
    checkedAt: new Date().toISOString(),
    error
  }
}
