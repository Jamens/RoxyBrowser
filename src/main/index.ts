import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import { join, resolve } from 'path'
import { bootstrap, setBrowserBridge, setSyncToggle } from './server'
import { openWindow, closeWindow, setSyncMode } from './browserManager'

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false

function trayIconPath(): string {
  // 主进程始终从 out/main 运行，resources 位于项目根目录
  return resolve(__dirname, '../../resources/tray.png')
}

function createTray(apiBase: string) {
  try {
    const image = nativeImage.createFromPath(trayIconPath())
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip(`RoxyBrowser Clone — API ${apiBase}`)
    tray.on('double-click', () => showMainWindow())
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开主窗口', click: () => showMainWindow() },
        { type: 'separator' },
        {
          label: `本地 API：${apiBase}`,
          enabled: false
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuiting = true
            app.quit()
          }
        }
      ])
    )
  } catch (e) {
    console.warn('[roxy] 托盘创建失败:', (e as Error).message)
  }
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createMainWindow()
  }
}

async function createMainWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'RoxyBrowser Clone — 指纹浏览器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())

  // 关闭主窗口 → 最小化到托盘，保持本地 API 与自动化接口继续可用
  win.on('close', (e) => {
    if (isQuiting) return
    e.preventDefault()
    win.hide()
    if (process.platform === 'darwin') app.dock?.hide()
  })

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'deny' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    await win.loadURL(devUrl)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    try {
      // 1. 启动本地 API 服务 + MySQL
      const apiBase = await bootstrap()
      process.env.ROXY_API_BASE = apiBase

      // 2. 注入浏览器窗口桥 + 同步开关
      setBrowserBridge({ openWindow, closeWindow })
      setSyncToggle(setSyncMode)

      // 3. 托盘（支持关闭到后台常驻）
      createTray(apiBase)

      // 4. 打开主窗口
      await createMainWindow()
    } catch (err) {
      const message = (err as Error).message || String(err)
      console.error('[roxy] 启动失败:', message)
      const { dialog } = require('electron') as typeof import('electron')
      dialog.showErrorBox('RoxyBrowser Clone 启动失败', `无法连接数据库或启动服务：\n\n${message}\n\n请确认 MySQL 已启动（默认 127.0.0.1:3307，root/1234560）`)
      app.quit()
    }

    app.on('activate', () => {
      showMainWindow()
    })
  })

  // 所有窗口关闭后不退出：驻留托盘，保证本地 API / 自动化接口持续可用
  // （注意：此处不能调用 app.quit()，退出统一走托盘菜单）
  app.on('window-all-closed', () => {
    console.log('[roxy] 主窗口已关闭，程序驻留托盘，本地 API 继续提供服务')
  })

  app.on('before-quit', () => {
    isQuiting = true
  })
}
