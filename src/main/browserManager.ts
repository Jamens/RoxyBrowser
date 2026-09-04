import { BrowserWindow, ipcMain, session, shell, Menu, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { AppDataSource } from './server'
import { ProfileEntity, ProxyEntity, CookieEntity, ExtensionEntity } from './entities'
import type { Fingerprint, RpaStep } from '../shared/types'

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
export function getRunningWindowIds(): number[] {
  return [...windows.keys()]
}
/** 已打开窗口的详细信息，供 UI 选择同步对象 */
export function getRunningWindows(): { id: number; title: string }[] {
  return [...windows.entries()]
    .filter(([, w]) => !w.isDestroyed())
    .map(([id]) => ({ id, title: windowTitles.get(id) || `环境 #${id}` }))
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

export async function openWindow(profileId: number): Promise<void> {
  if (windows.has(profileId)) {
    windows.get(profileId)!.focus()
    return
  }
  const repo = AppDataSource.getRepository(ProfileEntity)
  const profile = await repo.findOne({ where: { id: profileId } })
  if (!profile) throw new Error('环境不存在')

  const fp = profile.fingerprint as unknown as Fingerprint
  const fpArg = Buffer.from(JSON.stringify(fp), 'utf8').toString('base64')
  // 移动端指纹按手机尺寸开窗
  const isMobile = fp.os === 'android' || fp.os === 'ios'

  // 独立 session：每个环境独立 Cookie / 缓存 / 存储
  const ses = session.fromPartition(`persist:env-${profileId}`)
  ses.setUserAgent(fp.userAgent)

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
