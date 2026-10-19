// 隔离实验：最小 Electron 主进程，只做一件事 —— 加载 dev server URL 并回报结果
// 用来判断「白屏 / ERR_FAILED」是 Electron 环境问题还是本应用代码问题。
const { app, BrowserWindow } = require('electron')

const URL_TO_LOAD = process.argv[2] || 'http://127.0.0.1:5173/'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[did-fail-load] code=' + code + ' desc=' + desc + ' url=' + url)
  })
  win.webContents.on('did-finish-load', () => {
    void (async () => {
      try {
        const title = win.webContents.getTitle()
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length')
        const rootLen = await win.webContents.executeJavaScript(
          "document.getElementById('root') ? document.getElementById('root').innerHTML.length : -1"
        )
        console.log('[did-finish-load] title=' + title + ' htmlLen=' + html + ' #root.innerHTML长度=' + rootLen)
      } catch (e) {
        console.log('[did-finish-load] 读取 DOM 失败:', e.message)
      }
      app.exit(0)
    })()
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[render-process-gone]', JSON.stringify(details))
    app.exit(1)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[console]', message)
  })
  try {
    await win.loadURL(URL_TO_LOAD)
    console.log('[loadURL] 成功')
  } catch (e) {
    console.log('[loadURL] 抛错:', e.message)
  }
  setTimeout(() => { console.log('[timeout] 未收到任何事件'); app.exit(2) }, 15000)
})