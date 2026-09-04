import { contextBridge } from 'electron'

// 向渲染进程暴露本地 API 地址（由主进程在启动时写入环境变量）
contextBridge.exposeInMainWorld('roxy', {
  apiBase: process.env.ROXY_API_BASE || 'http://127.0.0.1:39100',
  platform: process.platform
})
