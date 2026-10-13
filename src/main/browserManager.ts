import { BrowserWindow, ipcMain, session, shell, Menu, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { AppDataSource } from './server'
import { ProfileEntity, ProxyEntity, CookieEntity, ExtensionEntity } from './entities'
import type { Fingerprint, RpaStep } from '../shared/types'
import type { FingerprintProbe } from '../shared/healthcheck'
import { isTrackerRequest } from '../shared/trackers'
import { collectProbe } from './healthProbe'
import { isAbnormalExit, formatCrashLog } from '../shared/crashReason'
import { canOpenWindow, DEFAULT_MAX_CONCURRENT_WINDOWS } from '../shared/windowLimit'
import {
  canClearPartition,
  formatCleanupLog,
  partitionName,
  type CleanupTrigger
} from '../shared/envPartition'
import { rm } from 'fs/promises'
import { getScanSite, runSiteScan, type ScanResult } from './fingerprintScan'

// 把持久化的 Cookie 写入某个 session（环境打开时调用，或「立即应用」时调用）
async function setElectronCookie(ses: Electron.Session, c: CookieEntity) {
  const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
  const url = `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`
  try {
    await ses.cookies.set({
      url,
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: (c.sameSite as 'unspecified' | 'no_restriction' | 'lax' | 'strict') || 'unspecified',
      expirationDate: c.expirationDate ? Math.floor(new Date(c.expirationDate).getTime() / 1000) : undefined
    })
  } catch {
    /* 单条 Cookie 写入失败（如 domain 非法）不影响其余 */
  }
}

/** 在环境打开（或立即应用）时，把该环境所有持久化 Cookie 注入到对应 session */
export async function seedCookies(ses: Electron.Session, profileId: number): Promise<number> {
  const repo = AppDataSource.getRepository(CookieEntity)
  const list = await repo.find({ where: { profileId } })
  for (const c of list) await setElectronCookie(ses, c)
  return list.length
}

/**
 * 加载某环境启用的扩展。
 * Electron 仅支持加载「解压目录」，且必须在持久 session 中加载（我们的 persist:env-<id> 正是）。
 * 扩展加载失败（损坏/不支持的 API）仅告警，不阻断窗口打开。
 */
async function loadProfileExtensions(ses: Electron.Session, profileId: number): Promise<void> {
  try {
    const profile = await AppDataSource.getRepository(ProfileEntity).findOne({ where: { id: profileId } })
    const ids: number[] = Array.isArray(profile?.extensions) ? (profile!.extensions as number[]) : []
    if (!ids.length) return
    const repo = AppDataSource.getRepository(ExtensionEntity)
    // Electron 不同版本 loadExtension 挂载位置不同：
    //   - 新版在 ses.extensions.loadExtension（this 必须是 extensions 实例，不能改绑）
    //   - 旧版在 ses.loadExtension
    const extApi = (ses as unknown as { extensions?: { loadExtension?: (p: string, o?: object) => Promise<unknown> } }).extensions
    const legacyLoader = (ses as unknown as { loadExtension?: (p: string, o?: object) => Promise<unknown> }).loadExtension
    if (typeof extApi?.loadExtension !== 'function' && typeof legacyLoader !== 'function') {
      console.warn('[roxy] 当前 Electron 不支持 loadExtension，跳过扩展加载')
      return
    }
    for (const id of ids) {
      const ext = await repo.findOne({ where: { id } })
      if (!ext || !ext.extPath) continue
      const abs = join(app.getPath('userData'), ext.extPath)
      if (!existsSync(abs)) continue
      try {
        if (typeof extApi?.loadExtension === 'function') {
          await extApi.loadExtension(abs, { allowFileAccess: true })
        } else {
          await legacyLoader!(abs, { allowFileAccess: true })
        }
      } catch (e) {
        console.warn(`[roxy] 加载扩展「${ext.name}」(#${id}) 失败:`, (e as Error).message)
      }
    }
  } catch (e) {
    console.warn('[roxy] 加载扩展出错:', (e as Error).message)
  }
}

/** 立即把 Cookie 应用到已打开的环境窗口；环境未运行则抛错（提示下次打开自动注入） */
export async function applyCookies(profileId: number): Promise<number> {
  const win = windows.get(profileId)
  if (!win || win.isDestroyed()) throw new Error('环境未运行，无法立即应用（将在下次打开时自动注入）')
  return seedCookies(win.webContents.session, profileId)
}

const windows = new Map<number, BrowserWindow>()
// BrowserWindow.getTitle() 返回的是页面 <title>，所有环境窗口都一样，
// 无法用于区分同步对象，所以单独记录环境名
const windowTitles = new Map<number, string>()
let syncEnabled = false
// 任务栏图标显示模式（软件设置 > 任务栏图标显示）：
// 'icon' = 应用图标（默认）；'name' = 窗口标题锁定为环境名，多窗口并行时便于在任务栏定位
let trayDisplayMode: 'icon' | 'name' = 'icon'
// 参与同步的环境窗口；空集合表示「全部已打开窗口」
const syncTargets = new Set<number>()

export function setSyncMode(enabled: boolean) {
  syncEnabled = enabled
}
export function getSyncMode() {
  return syncEnabled
}
export function setSyncTargets(ids: number[]) {
  syncTargets.clear()
  for (const id of ids || []) syncTargets.add(Number(id))
}
export function getSyncTargets(): number[] {
  return [...syncTargets]
}

/**
 * 任务栏图标显示（软件设置 > 任务栏图标显示）。
 * 'name' 模式下环境窗口标题锁定为环境名：页面 <title> 会覆盖窗口标题，
 * 必须 preventDefault 后重新 setTitle，否则任务栏显示的是网页名而不是环境名。
 * 切换时对已打开的窗口立即生效。
 */
export function setTrayDisplay(mode: 'icon' | 'name') {
  trayDisplayMode = mode
  for (const [id, w] of windows) {
    if (w.isDestroyed()) continue
    const name = windowTitles.get(id)
    if (mode === 'name' && name) w.setTitle(`${name} — RoxyBrowser Clone`)
  }
}
export function getRunningWindowIds(): number[] {
  // 过滤掉已销毁的僵尸条目：渲染进程崩溃时 closed 可能不触发，Map 里会留下
  // 失效的窗口引用。若不过滤，UI 会误报「运行中」，而用户点「打开」反而被
  // status='running' 拦住 —— 与崩溃本身一样变成解不开的死结。
  const ids: number[] = []
  for (const [id, w] of windows) {
    if (w.isDestroyed()) continue
    ids.push(id)
  }
  return ids
}

/** 按环境 id 取运行中的窗口实例（Agent 执行闭环用它直接操作目标窗口的 webContents） */
export function getWindow(profileId: number): BrowserWindow | undefined {
  const w = windows.get(profileId)
  return w && !w.isDestroyed() ? w : undefined
}
/** 环境体检：在目标环境窗口内采集实际生效的指纹值（窗口未运行返回 null） */
export async function probeFingerprint(profileId: number): Promise<FingerprintProbe | null> {
  const w = getWindow(profileId)
  if (!w) return null
  return collectProbe(w)
}
/** 已打开窗口的详细信息，供 UI 选择同步对象 */
export function getRunningWindows(): { id: number; title: string }[] {
  return [...windows.entries()]
    .filter(([, w]) => !w.isDestroyed())
    .map(([id]) => ({ id, title: windowTitles.get(id) || `环境 #${id}` }))
}

/**
 * 每个环境同时只允许一个检测在跑。
 *
 * 为什么必须加锁：同一 webContents 上叠加两次导航会让**前一次 reject**，
 * 而前一次后续的执行 JS / 截图读到的却是后一个站点的页面——
 * 结果是「siteId 写着 A、text 和 screenshot 却是 B」。
 * 本功能的全部价值就在于「证据可信」，这种静默的张冠李戴比直接报错更糟。
 */
const scanInFlight = new Map<number, Promise<ScanResult>>()

/**
 * 在线检测站实战验证：把环境窗口导航到第三方指纹检测站，抓回页面文本与截图。
 * 窗口未运行抛错（与体检 / 截图同约束）；检测站 id 非法亦抛错；重复发起返回「正在检测中」。
 */
export async function scanSite(profileId: number, siteId: string): Promise<ScanResult> {
  if (scanInFlight.has(profileId)) throw new Error('该环境正在检测中，请等上一次完成')
  // 先校验站点再占位：避免非法 siteId 占住锁、把后续正常请求挡在门外
  const site = getScanSite(siteId)
  if (!site) throw new Error(`未知检测站：${siteId}`)
  const win = getWindow(profileId)
  if (!win) throw new Error('环境未运行，请先打开环境窗口')
  const p = runSiteScan(win, site)
  scanInFlight.set(profileId, p)
  try {
    return await p
  } finally {
    scanInFlight.delete(profileId)
  }
}

/** 环境截图：截取运行中环境窗口当前视口，返回 PNG Buffer（窗口未运行抛错） */
export async function captureScreenshot(profileId: number): Promise<Buffer> {
  const win = windows.get(profileId)
  if (!win || win.isDestroyed()) throw new Error('环境未运行，无法截图（请先打开环境窗口）')
  const img = await win.webContents.capturePage()
  return img.toPNG()
}

function rendererEntry(): { url?: string; file?: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { url: devUrl }
  return { file: join(__dirname, '../renderer/index.html') }
}

async function markClosed(profileId: number) {
  try {
    const repo = AppDataSource.getRepository(ProfileEntity)
    await repo.update({ id: profileId }, { status: 'idle' })
  } catch {
    /* ignore */
  }
}

/**
 * 渲染进程崩溃 / 窗口无响应时的兜底：把环境状态从 running 拉回 idle。
 *
 * ## 为什么需要（这是用户解不开的死锁）
 * `win.on('closed')` 是窗口生命周期里**唯一**把 `status` 置 idle 的地方。
 * 但渲染进程崩溃（页面 OOM、GPU 进程挂掉、用户在页面里开了几百个标签耗尽内存）
 * 时，BrowserWindow 本身**不一定**被销毁 —— 崩溃的是它内部的渲染进程，
 * 窗口壳还在。于是：
 *   - `closed` 不触发 → `status` 永远停在 `running`
 *   - 用户点「打开」→ 被 `status === 'running'` 拦下，提示「窗口已在运行中」
 *   - 但界面上根本没有那个窗口 → 用户只能重启应用才能恢复
 *
 * 这与「MySQL 没启动导致建表失败」是同一类问题：**用户被卡住，且自己解不开**。
 *
 * ## 为什么不自动重开
 * 自动重开有两个问题：① 崩溃往往源于该页面本身（内存泄漏的站点），
 * 重开只会陷入「崩溃→重开→崩溃」循环，把内存耗得更干净；
 * ② 崩溃现场（页面状态、未提交的表单）已丢，静默重开用户会困惑。
 * 故只做「状态纠正 + 留痕」，把重开的决定权交回用户。
 */
function attachCrashGuards(win: BrowserWindow, profileId: number, envName: string): void {
  // 渲染进程消失。reason 需甄别：
  //   clean-exit / killed —— 用户主动关闭或我们主动销毁，属正常路径，不该报警
  //   crashed / oom / launch-failed / integrity-failure / memory-eviction —— 异常
  win.webContents.on('render-process-gone', (_e: unknown, details: Electron.RenderProcessGoneDetails) => {
    if (!isAbnormalExit(details.reason)) return
    console.error(formatCrashLog(envName, profileId, details.reason, details.exitCode))
    // 窗口壳若仍在，销毁它以触发 closed → markClosed；
    // 若已随崩溃一并消失，closed 不会来，这里补一次状态纠正。
    if (!win.isDestroyed()) {
      win.destroy()
    } else {
      void markClosed(profileId)
    }
  })

  // 窗口失去响应：不算崩溃，但用户点任何操作都无反应，同样需要给出出口。
  // 只纠状态、不自动销毁 —— 无响应常是一时的，杀掉会丢掉用户正在填的表单。
  win.on('unresponsive', () => {
    console.warn(`[roxy] 环境「${envName}」(#${profileId}) 无响应`)
  })

  // 无响应后又恢复：说明只是一时卡顿，记一笔便于回溯
  win.on('responsive', () => {
    console.log(`[roxy] 环境「${envName}」(#${profileId}) 已恢复响应`)
  })
}

export /**
 * 读取「同时打开环境数上限」；读不到时用默认 3。
 *
 * 实测 3 个即有崩溃风险，故默认取 3 而不是更大——上限的意义是提前拦住，
 * 放得太宽等于没设。用户可到设置里调整，调到 0 表示不限制。
 */
async function resolveMaxWindows(): Promise<number> {
  try {
    const { getSettings } = await import('./server')
    const settings = await getSettings()
    const v = (settings as { maxConcurrentWindows?: number }).maxConcurrentWindows
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MAX_CONCURRENT_WINDOWS
  } catch (e) {
    console.warn('[roxy] 读取环境窗口上限失败，回落默认值:', (e as Error).message)
    return DEFAULT_MAX_CONCURRENT_WINDOWS
  }
}

export async function openWindow(profileId: number): Promise<void> {
  // 已存在窗口则聚焦。**必须同时校验 isDestroyed()**：
// 渲染进程崩溃时窗口壳可能仍留在 Map 里（closed 未触发），此时 focus()
// 会对已销毁的窗口抛错，且永远无法恢复 —— 这是「状态卡在 running」的
// 第二条路径。顺手把僵尸条目清掉，让后续走正常创建流程。
  const existing = windows.get(profileId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  if (existing) {
    windows.delete(profileId)
    windowTitles.delete(profileId)
    // 窗口已消失但 status 可能仍是 running，一并纠正，
    // 否则下面 openWindow 返回后用户点「打开」仍会被 running 拦下
    await markClosed(profileId)
  }

  // 并发上限：实测开到第 3 个环境窗口时**有概率整个应用退出**（崩的是主进程）。
  // 主进程常驻 390MB、单环境窗口的渲染/GPU 进程 180~400MB，资源累积到临界点就崩。
  // 与其等系统崩掉（用户什么都做不了），不如提前拦住并说清怎么��。
  const limit = await resolveMaxWindows()
  const gate = canOpenWindow(getRunningWindowIds().length, limit)
  if (!gate.ok) {
    console.warn(`[roxy] 拒绝打开环境「${existing?.id ?? profileId}」：${gate.reason.split('\n')[0]}`)
    throw new Error(gate.reason)
  }

  const repo = AppDataSource.getRepository(ProfileEntity)
  const profile = await repo.findOne({ where: { id: profileId } })
  if (!profile) throw new Error('环境不存在')

  const fp = profile.fingerprint as unknown as Fingerprint
  const fpArg = Buffer.from(JSON.stringify(fp), 'utf8').toString('base64')
  // 移动端指纹按手机尺寸开窗
  const isMobile = fp.os === 'android' || fp.os === 'ios'

  // 独立 session：每个环境独立 Cookie / 缓存 / 存储
  // 分区名统一由 shared/envPartition 提供 —— 清理逻辑要按同一个名字定位落盘目录，
  // 两处各写一遍字符串迟早会写歪。
  const ses = session.fromPartition(partitionName(profileId))
  ses.setUserAgent(fp.userAgent)

  // ===== 追踪器屏蔽 =====
  // 命中已知分析 / 广告 / 埋点域名直接 cancel，避免反复调研竞品时被对方的埋点、
  // Cookie 或第三方脚本识别出来甚至反监控。
  // 只能在**主进程**用 session.webRequest 做——preload 跑在渲染进程，只能改 JS、拦不到网络请求。
  // 必须在导航前挂上，否则首屏的统计脚本早已发出。
  // 注：本功能上线前的环境没有 blockTrackers 字段（undefined），按「不改变既有环境行为」
  // 的原则默认不拦截，用户在环境表单里开启后生效。
  if (fp.blockTrackers) {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      // 2.0：统一走 isTrackerRequest——主机清单 + 子资源路径签名双路判定，
      // 并对非网络协议 / 私有网段做保护；回调内再包一层 try/catch，
      // 任何异常（畸形 details / 解析失败）都「宁可放过」，绝不因拦截器自身报错而卡死页面导航。
      let cancel = false
      try {
        cancel = isTrackerRequest({ url: details.url, resourceType: (details as any).resourceType })
      } catch {
        cancel = false
      }
      cb({ cancel })
    })
  }

  // 代理
  let proxyRules = ''
  if (profile.proxyId) {
    const proxyRepo = AppDataSource.getRepository(ProxyEntity)
    const proxy = await proxyRepo.findOne({ where: { id: profile.proxyId } })
    if (proxy) {
      const auth =
        proxy.username && proxy.password ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : ''
      const addr = `${auth}${proxy.host}:${proxy.port}`
      proxyRules = proxy.type === 'socks5' ? `socks5://${addr}` : `http=${addr};https=${addr}`
    }
  }

  const win = new BrowserWindow({
    width: isMobile ? 430 : 1280,
    height: isMobile ? 900 : 820,
    minWidth: isMobile ? 320 : 900,
    minHeight: isMobile ? 480 : 600,
    show: false,
    backgroundColor: '#ffffff',
    title: `${profile.name} — RoxyBrowser Clone`,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      preload: join(__dirname, 'browser-preload.js'),
      additionalArguments: [`--roxy-fp=${fpArg}`, `--roxy-profile=${profileId}`],
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  if (proxyRules) {
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules,
      proxyBypassRules: '<local>;127.0.0.1;localhost'
    })
  }

  // 注入该环境持久化的 Cookie（在导航前写入 session，确保首屏即带登录态）
  try {
    await seedCookies(ses, profileId)
  } catch {
    /* Cookie 注入失败不阻断环境打开 */
  }

  // 加载该环境启用的扩展（在导航前，确保扩展随页面生效）
  try {
    await loadProfileExtensions(ses, profileId)
  } catch {
    /* 扩展加载失败不阻断环境打开 */
  }

  // 环境内新窗口也在同一 BrowserWindow 打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'deny' }
    win.webContents.loadURL(url)
    return { action: 'deny' }
  })

  // 外部协议默认用系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  // 右键菜单：后退 / 前进 / 刷新 / 开发者工具
  win.webContents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate([
      { label: '后退', enabled: win.webContents.navigationHistory.canGoBack(), click: () => win.webContents.navigationHistory.goBack() },
      { label: '前进', enabled: win.webContents.navigationHistory.canGoForward(), click: () => win.webContents.navigationHistory.goForward() },
      { label: '刷新', click: () => win.webContents.reload() },
      { type: 'separator' },
      { label: '检查元素', click: () => win.webContents.openDevTools({ mode: 'detach' }) }
    ])
    menu.popup()
  })

  win.on('closed', () => {
    windows.delete(profileId)
    windowTitles.delete(profileId)
    // 录制中的环境被关闭：丢弃录制缓冲，避免脏数据
    rpaRecording.delete(profileId)
    markClosed(profileId)
  })
  win.once('ready-to-show', () => win.show())

  // 崩溃兜底：渲染进程异常退出时把状态拉回 idle，否则用户会被
  // 「窗口已在运行中」永久拦住（详见 attachCrashGuards 的注释）
  attachCrashGuards(win, profileId, profile.name)

  // 任务栏显示窗口名称：页面 <title> 会覆盖窗口标题，开启时锁回环境名
  win.on('page-title-updated', (e) => {
    if (trayDisplayMode !== 'name') return
    e.preventDefault()
    win.setTitle(`${profile.name} — RoxyBrowser Clone`)
  })

  // 录制期间记录页面跳转（包括首次导航，回放时会重新走一遍 URL 序列）
  win.webContents.on('did-navigate', (_e, url) => {
    if (rpaRecording.has(profileId) && /^https?:\/\//i.test(url)) {
      pushRpaStep(rpaRecording.get(profileId)!, { type: 'navigate', url })
    }
  })

  const entry = rendererEntry()
  const hash = `#/browser?profileId=${profileId}`
  if (entry.url) {
    await win.loadURL(`${entry.url}${hash}`)
  } else if (entry.file) {
    await win.loadFile(entry.file, { hash: hash.slice(1) })
  }
  windows.set(profileId, win)
  windowTitles.set(profileId, `${profile.name}`)
}

export async function closeWindow(profileId: number): Promise<void> {
  const win = windows.get(profileId)
  if (win && !win.isDestroyed()) win.close()
}

// ===== 环境分区（persist:env-<id>）清理 =====

/**
 * 彻底清理某环境的持久化浏览器数据（Cookie / localStorage / IndexedDB / 缓存）。
 *
 * ## 为什么要两步（clearStorageData + 删目录）
 * `ses.clearStorageData()` 清的是 Chromium 的**存储层**，
 * 但分区目录里还留着 Service Worker 缓存、Code Cache、GPU cache 等一堆磁盘文件，
 * 以及删不干净的残留。实测环境越多跑越久，这些只增不减，是内存/磁盘双高的来源之一。
 * 所以先让 Chromium 自己清（它知道自己的索引结构），再把目录整个删掉兜底。
 *
 * ## 失败不阻断删除
 * 清理失败（文件被占用、权限）**不能**让「彻底删除」整体失败：
 * 数据库记录已经没了，此时把用户卡在报错里毫无意义。改为记日志 + 返回 false，
 * 由调用方决定是否告知用户。
 *
 * @param inTrash 是否处于回收站（trigger='purge' 时必须为 true，否则拒绝清理）
 * @returns 是否清理成功
 */
export async function clearProfilePartition(
  profileId: number,
  trigger: CleanupTrigger,
  inTrash: boolean
): Promise<boolean> {
  // 以「Map 里的活窗口」为准，而不是数据库 status —— status 可能因崩溃而失真，
  // 而这里误清的后果是用户在跑的页面突然掉登录态，必须从严。
  const win = windows.get(profileId)
  const verdict = canClearPartition({
    profileId,
    inTrash,
    running: !!win && !win.isDestroyed(),
    trigger
  })
  if (!verdict.ok) {
    console.warn(formatCleanupLog(profileId, `env-${profileId}`, false, verdict.reason))
    return false
  }
  const dirName = verdict.dirName
  try {
    const ses = session.fromPartition(partitionName(profileId))
    await ses.clearStorageData()
    await ses.clearCache()
  } catch (e) {
    // 继续尝试删目录：存储层清理失败不代表目录删不掉
    console.warn(formatCleanupLog(profileId, dirName, false, `清理存储层出错: ${(e as Error).message}`))
  }
  try {
    const dir = join(app.getPath('userData'), 'Partitions', dirName)
    // force+recursive：Chromium 可能仍持有部分文件的句柄，
    // maxRetries 给它一点自行退出的时间，仍失败则如实记日志。
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    console.log(formatCleanupLog(profileId, dirName, true))
    return true
  } catch (e) {
    console.error(formatCleanupLog(profileId, dirName, false, (e as Error).message))
    return false
  }
}

// ===== 起始页导航 =====
// 以前起始页直接改 window.location.href。但环境窗口没有地址栏、没有加载进度条，
// 一旦目标打不开（代理不通、站点被墙、域名错），Chromium 在收到首个响应前会保持
// 原页面不变 —— 用户看到的就是「点了完全没反应」，无法判断是点错还是网络问题。
// 改走主进程后：加载由我们发起，失败时能在 did-fail-load 拿到 Chromium 的错误码
// （多为 ERR_PROXY_CONNECTION_FAILED 一类），带着错误码回到起始页明确告知原因。
//
// 每次导航挂上的一次性监听统一登记到 navCleanups：「取消」时要先摘监听再 stop()，
// 否则 stop() 触发的 did-fail-load（ERR_ABORTED）会被当成真实失败，把起始页刷成错误页。
const navCleanups = new Map<number, () => void>()

ipcMain.on('env-navigate', (event, rawUrl: unknown) => {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  // 只接受 http(s)，避免 file:// / javascript: 之类被拼进地址栏带进来
  if (!/^https?:\/\//i.test(url)) return

  let profileId = 0
  for (const [id, win] of windows) {
    if (win.webContents === event.sender) {
      profileId = id
      break
    }
  }
  const win = profileId ? windows.get(profileId) : undefined
  if (!win || win.isDestroyed()) return
  // 收窄出一份 webContents：下面的 onFail/onDone 是函数声明（会提升），
  // TS 不会把外层 `if (!win) return` 的收窄带进提升函数的闭包里，直接用 win 会报
  // "possibly undefined"。这里在收窄之后取出一个新的 const，闭包里用它就安全了。
  const wc = win.webContents

  // 用函数声明而不是 const 箭头函数：cleanup 被 onFail/onDone 引用，
  // 函数声明会提升，不用操心声明顺序（const 版要么触发 TDZ，要么得把 cleanup 提到最前）
  function onFail(
    _e: Electron.Event,
    _errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean
  ) {
    if (!isMainFrame) return
    cleanup()
    const entry = rendererEntry()
    const hash = `#/browser?profileId=${profileId}&navError=${encodeURIComponent(
      errorDescription || 'ERR_UNKNOWN'
    )}&navUrl=${encodeURIComponent(url)}`
    if (entry.url) void wc.loadURL(`${entry.url}${hash}`)
    else if (entry.file) void wc.loadFile(entry.file, { hash: hash.slice(1) })
  }
  // 加载成功（或后续任何一次成功加载）后摘掉监听，避免越积越多
  function onDone() {
    cleanup()
  }
  function cleanup() {
    wc.off('did-fail-load', onFail)
    wc.off('did-finish-load', onDone)
    if (navCleanups.get(profileId) === cleanup) navCleanups.delete(profileId)
  }
  // 同一次导航重复进入时先清掉上一轮的监听
  navCleanups.get(profileId)?.()
  navCleanups.set(profileId, cleanup)
  wc.on('did-fail-load', onFail)
  wc.on('did-finish-load', onDone)
  void wc.loadURL(url)
})

// 起始页加载遮罩上的「取消」：只 stop() 不够，监听还在，停掉触发的 ERR_ABORTED
// 会走失败分支把页面刷成错误页 —— 必须先 cleanup() 再 stop()。
ipcMain.on('env-navigate-cancel', (event) => {
  let profileId = 0
  for (const [id, win] of windows) {
    if (win.webContents === event.sender) {
      profileId = id
      break
    }
  }
  const win = profileId ? windows.get(profileId) : undefined
  if (!win || win.isDestroyed()) return
  navCleanups.get(profileId)?.()
  win.webContents.stop()
})

// ===== 多窗口同步（键鼠轨迹级） =====
// 事件量很大（mousemove 约 20/s），这里只做转发，不做序列化排队：
// 丢弃过期事件比堆积延迟更重要，否则鼠标轨迹会明显滞后。
ipcMain.on('sync-event', (event, payload: Record<string, unknown>) => {
  if (!syncEnabled) return
  if (!payload || typeof payload !== 'object') return

  // 反查来源窗口，避免回声；同时给接收端标注来源
  let sourceId = 0
  for (const [id, win] of windows) {
    if (win.webContents === event.sender) {
      sourceId = id
      break
    }
  }
  // 只转发「在同步组内、且已打开」的窗口；未指定同步组时广播到全部
  const scoped = syncTargets.size > 0

  for (const [id, win] of windows) {
    if (win.isDestroyed()) continue
    if (id === sourceId) continue
    if (scoped && !syncTargets.has(id)) continue
    try {
      win.webContents.send('sync-apply', { ...payload, __from: sourceId })
    } catch {
      /* 窗口正在关闭，忽略 */
    }
  }
})

// ===== RPA 脚本录制 / 回放 =====
// 录制：preload 在收到 rpa-recording 后采集 click/input/change/scroll，经 rpa-event 上报；
//      页面跳转由主进程 did-navigate 记录（preload 看不到跨页的导航意图）。
// 回放：复用多窗口同步的 sync-apply 通道把步骤重放进窗口（同一套 selector 解码与拟人化输入）。

const rpaRecording = new Map<number, RpaStep[]>()

/** 步骤合并：input 连续输入只保留最终值；scroll 只保留最终位置 */
function pushRpaStep(steps: RpaStep[], step: RpaStep) {
  const last = steps[steps.length - 1]
  if (step.type === 'input' && last && last.type === 'input' && last.sel === step.sel) {
    last.value = step.value
    return
  }
  if (step.type === 'scroll' && last && last.type === 'scroll') {
    last.x = step.x
    last.y = step.y
    return
  }
  steps.push(step)
}

ipcMain.on('rpa-event', (event, step: RpaStep) => {
  if (!step || typeof step !== 'object' || typeof step.type !== 'string') return
  for (const [id, win] of windows) {
    if (win.webContents === event.sender) {
      const steps = rpaRecording.get(id)
      if (steps) pushRpaStep(steps, step)
      return
    }
  }
})

export function startRpaRecording(profileId: number): void {
  const win = windows.get(profileId)
  if (!win || win.isDestroyed()) throw new Error('环境未运行，请先打开环境再开始录制')
  rpaRecording.set(profileId, [])
  win.webContents.send('rpa-recording', { enabled: true })
}

export function stopRpaRecording(profileId: number): RpaStep[] {
  const win = windows.get(profileId)
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('rpa-recording', { enabled: false })
    } catch {
      /* ignore */
    }
  }
  const steps = rpaRecording.get(profileId) || []
  rpaRecording.delete(profileId)
  return steps
}

export function isRpaRecording(profileId: number): boolean {
  return rpaRecording.has(profileId)
}

/** 当前已录制但未停止的步骤数（用于前端实时展示「已录制 N 步」） */
export function rpaRecordCount(profileId: number): number {
  return rpaRecording.get(profileId)?.length ?? 0
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 在指定环境窗口回放脚本。navigate/wait 在主进程执行；
 * click/input/change/scroll 经 sync-apply 通道重放（preload 里是同一套解码逻辑）。
 */
export async function replayRpaScript(profileId: number, steps: RpaStep[]): Promise<number> {
  const win = windows.get(profileId)
  if (!win || win.isDestroyed()) throw new Error('环境未运行，请先打开环境再回放')
  let executed = 0
  for (const s of steps) {
    switch (s.type) {
      case 'navigate':
        if (/^https?:\/\//i.test(s.url)) await win.webContents.loadURL(s.url)
        break
      case 'wait':
        await sleep(Math.min(60000, Math.max(0, s.ms)))
        break
      case 'click':
      case 'input':
      case 'change':
      case 'scroll':
        try {
          win.webContents.send('sync-apply', { ...s, __rpa: true })
        } catch {
          /* 窗口关闭则中止 */
          return executed
        }
        await sleep(900)
        break
      default:
        break
    }
    executed++
  }
  return executed
}
