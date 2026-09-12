import { contextBridge, ipcRenderer } from 'electron'

export interface NetworkProxyConfig {
  mode: 'system' | 'custom'
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string
  password: string
}

// 向渲染进程暴露本地 API 地址（由主进程在启动时写入环境变量）
contextBridge.exposeInMainWorld('roxy', {
  apiBase: process.env.ROXY_API_BASE || 'http://127.0.0.1:39100',
  platform: process.platform,
  /**
   * 设置客户端自身的出网代理（仅影响主界面 / 默认 session 的请求，
   * 环境窗口的代理仍按各自环境绑定走，不受此设置影响）。
   */
  setNetworkProxy: (cfg: NetworkProxyConfig) => ipcRenderer.invoke('app:set-network-proxy', cfg) as Promise<{ ok: boolean }>,
  /** 任务栏图标显示：icon = 应用图标；name = 窗口（环境）名称 */
  setTrayDisplay: (mode: 'icon' | 'name') => ipcRenderer.invoke('app:set-tray-display', mode) as Promise<{ ok: boolean }>
})
