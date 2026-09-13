import { contextBridge, ipcRenderer } from 'electron'
import type { AgentAction, RpaStep } from '../shared/types'

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
  setTrayDisplay: (mode: 'icon' | 'name') => ipcRenderer.invoke('app:set-tray-display', mode) as Promise<{ ok: boolean }>,
  /** 内核版本信息（应用 / Electron / Chromium / Node / V8 / 平台） */
  getVersions: () => ipcRenderer.invoke('app:get-versions') as Promise<AppVersions>,
  // ===== AI Agent 执行闭环（Route A）=====
  /** 启动一次矩阵运行（可驱动 N 个环境并发）：返回 { runId } 或 { error } */
  agentStart: (payload: {
    envIds: number[]
    instruction: string
    options?: { needApproval?: boolean; maxSteps?: number }
    actor?: { userId: number; username: string }
  }) => ipcRenderer.invoke('agent:start', payload) as Promise<{ runId?: string; error?: string }>,
  /** 中止整次矩阵运行（含所有子会话） */
  agentStop: (runId: string) => ipcRenderer.send('agent:stop', runId),
  /** 审批结果：针对某个具体环境放行（approved=true 继续，false 等同中止该环境） */
  agentApprove: (runId: string, envId: number, approved: boolean) =>
    ipcRenderer.invoke('agent:approve', runId, envId, approved) as Promise<{ ok: boolean }>,
  /** 订阅单步事件（带 envId，按环境分组），返回取消订阅函数 */
  agentOnStep: (cb: (d: { runId: string; envId: number; step: number; action: AgentAction; screenshot?: string; rpaStep?: RpaStep | null }) => void) => {
    const h = (_e: unknown, d: { runId: string; envId: number; step: number; action: AgentAction; screenshot?: string; rpaStep?: RpaStep | null }) => cb(d)
    ipcRenderer.on('agent:step', h)
    return () => ipcRenderer.removeListener('agent:step', h)
  },
  agentOnDone: (cb: (d: { runId: string; envId: number; result: string; rpaSteps?: RpaStep[] }) => void) => {
    const h = (_e: unknown, d: { runId: string; envId: number; result: string; rpaSteps?: RpaStep[] }) => cb(d)
    ipcRenderer.on('agent:done', h)
    return () => ipcRenderer.removeListener('agent:done', h)
  },
  agentOnError: (cb: (d: { runId: string; envId: number; error: string }) => void) => {
    const h = (_e: unknown, d: { runId: string; envId: number; error: string }) => cb(d)
    ipcRenderer.on('agent:error', h)
    return () => ipcRenderer.removeListener('agent:error', h)
  },
  agentOnNeedApproval: (cb: (d: { runId: string; envId: number; question: string }) => void) => {
    const h = (_e: unknown, d: { runId: string; envId: number; question: string }) => cb(d)
    ipcRenderer.on('agent:need-approval', h)
    return () => ipcRenderer.removeListener('agent:need-approval', h)
  },
  /** 订阅矩阵汇总事件（全部环境执行完毕时触发一次），返回取消订阅函数 */
  agentOnAllDone: (cb: (d: { runId: string; results: { envId: number; status: 'done' | 'failed'; result: string; rpaSteps?: RpaStep[] }[] }) => void) => {
    const h = (_e: unknown, d: { runId: string; results: { envId: number; status: 'done' | 'failed'; result: string; rpaSteps?: RpaStep[] }[] }) => cb(d)
    ipcRenderer.on('agent:all-done', h)
    return () => ipcRenderer.removeListener('agent:all-done', h)
  }
})

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
}
