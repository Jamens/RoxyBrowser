import { BrowserWindow, ipcMain, session, shell, Menu } from 'electron'
import { join } from 'path'
import { AppDataSource } from './server'
import { ProfileEntity, ProxyEntity } from './entities'
import type { Fingerprint } from '../shared/types'

const windows = new Map<number, BrowserWindow>()
let syncEnabled = false

export function setSyncMode(enabled: boolean) {
  syncEnabled = enabled
}
export function getSyncMode() {
  return syncEnabled
}
export function getRunningWindowIds(): number[] {
  return [...windows.keys()]
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
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
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
    markClosed(profileId)
  })
  win.once('ready-to-show', () => win.show())

  const entry = rendererEntry()
  const hash = `#/browser?profileId=${profileId}`
  if (entry.url) {
    await win.loadURL(`${entry.url}${hash}`)
  } else if (entry.file) {
    await win.loadFile(entry.file, { hash: hash.slice(1) })
  }
  windows.set(profileId, win)
}

export async function closeWindow(profileId: number): Promise<void> {
  const win = windows.get(profileId)
  if (win && !win.isDestroyed()) win.close()
}

// ===== 多窗口同步 =====
ipcMain.on('sync-event', (event, payload) => {
  if (!syncEnabled) return
  const sender = event.sender
  for (const [, win] of windows) {
    if (win.isDestroyed()) continue
    if (win.webContents === sender) continue
    win.webContents.send('sync-apply', payload)
  }
})
