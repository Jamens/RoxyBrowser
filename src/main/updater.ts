import { app, ipcMain } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'

// 主进程 → 渲染端 的事件发送器（由 index.ts 注入，指向主窗口 webContents）
type Send = (channel: string, payload: unknown) => void

// 自动更新 feed 地址：默认占位，可用环境变量 UPDATE_FEED_URL 覆盖（指向你托管的 generic feed）。
// 配合 electron-builder 的 publish.generic，构建时会把 latest.yml 与安装包上传到该地址；
// 安装版运行时由 electron-updater 自动据此检查更新，无需在代码里硬编码正式地址。
const DEFAULT_FEED_URL = 'https://update.roxyclone.com'

/**
 * 初始化自动更新。
 * - 仅在打包安装版（app.isPackaged）生效；开发态只暴露返回 { state: 'dev' } 的桩，避免找不到 latest.yml 报错。
 * - 采用 manual 模式：自动检查但不自动下载，由用户在 UI 上确认后再下载/安装，
 *   避免打断正在进行的多账号防关联操作。
 */
export function setupAutoUpdater(send: Send): void {
  if (!app.isPackaged) {
    ipcMain.handle('app:check-update', async () => {
      send('app:update-status', { state: 'dev' })
      return { state: 'dev' }
    })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const feed = process.env.UPDATE_FEED_URL || DEFAULT_FEED_URL
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  } catch (e) {
    console.warn('[roxy] 设置更新源失败:', (e as Error).message)
  }

  const push = (payload: unknown) => send('app:update-status', payload)

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))
  autoUpdater.on('update-available', (info: UpdateInfo) => push({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', (info: UpdateInfo) => push({ state: 'latest', version: info.version }))
  autoUpdater.on('download-progress', (p) => push({ state: 'downloading', percent: Math.floor(p.percent) }))
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => push({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (e: Error) => push({ state: 'error', message: e.message }))

  ipcMain.handle('app:check-update', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { state: 'checking' }
    } catch (e) {
      push({ state: 'error', message: (e as Error).message })
      return { state: 'error', message: (e as Error).message }
    }
  })

  ipcMain.handle('app:download-update', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      push({ state: 'error', message: (e as Error).message })
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.on('app:quit-and-install', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // 启动后静默检查一次（仅推送状态，不打扰用户；无网络 / 无更新时静默失败）
  void autoUpdater.checkForUpdates().catch(() => {})
}
