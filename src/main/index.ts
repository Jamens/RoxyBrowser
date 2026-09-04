import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { bootstrap, setBrowserBridge, setSyncToggle } from './server'
import { openWindow, closeWindow, setSyncMode } from './browserManager'

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

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

  win.on('ready-to-show', () => win.show())

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
    const wins = BrowserWindow.getAllWindows()
    const main = wins.find((w) => w.webContents.getURL().includes('#/') || w.webContents.getURL().includes('localhost'))
    if (main) {
      if (main.isMinimized()) main.restore()
      main.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      // 1. 启动本地 API 服务 + MySQL
      const apiBase = await bootstrap()
      process.env.ROXY_API_BASE = apiBase

      // 2. 注入浏览器窗口桥 + 同步开关
      setBrowserBridge({ openWindow, closeWindow })
      setSyncToggle(setSyncMode)

      // 3. 打开主窗口
      await createMainWindow()
    } catch (err) {
      const message = (err as Error).message || String(err)
      console.error('[roxy] 启动失败:', message)
      const { dialog } = require('electron') as typeof import('electron')
      dialog.showErrorBox('RoxyBrowser Clone 启动失败', `无法连接数据库或启动服务：\n\n${message}\n\n请确认 MySQL 已启动（默认 127.0.0.1:3307，root/1234560）`)
      app.quit()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
