// Agent 运行管理器：持有各 run 的状态（中止标志 / 审批等待），并注册 IPC 通道。
// 与 server / browserManager 解耦——通过构造函数注入 getWindow / getSettings。
import { ipcMain, type WebContents } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings } from '../../shared/types'
import { runAgentSession } from './session'
import type { RunOptions } from './types'

export interface AgentStartPayload {
  envId: number
  instruction: string
  options?: RunOptions
}

interface RunState {
  runId: string
  webContents: WebContents
  aborted: boolean
  approveResolve?: (ok: boolean) => void
}

export class AgentRunner {
  private runs = new Map<string, RunState>()

  constructor(
    private deps: {
      getWindow: (id: number) => BrowserWindow | undefined
      getSettings: () => Promise<AppSettings>
    }
  ) {}

  registerIpc(): void {
    // 启动一次执行闭环；返回 { runId } 或 { error }
    ipcMain.handle('agent:start', async (_e, payload: AgentStartPayload) => {
      const envId = Number(payload?.envId)
      const instruction = (payload?.instruction || '').trim()
      if (!envId || !instruction) return { error: '请提供目标环境与执行指令' }
      const win = this.deps.getWindow(envId)
      if (!win || win.isDestroyed()) {
        return { error: '目标环境未运行，请先在「环境」列表打开该环境窗口后再执行' }
      }
      const settings = await this.deps.getSettings()
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const state: RunState = { runId, webContents: _e.sender, aborted: false }
      this.runs.set(runId, state)

      const send = (type: string, payloadObj: object) => {
        if (!state.webContents.isDestroyed()) state.webContents.send(`agent:${type}`, { runId, ...payloadObj })
      }

      void runAgentSession({
        win,
        profileId: envId,
        instruction,
        settings: settings.aiAgent,
        options: payload.options || {},
        emit: {
          step: (p) => send('step', p),
          needApproval: (p) => send('need-approval', p),
          done: (p) => send('done', p),
          error: (p) => send('error', p)
        },
        controls: {
          isAborted: () => state.aborted,
          waitApprove: () => new Promise<boolean>((resolve) => { state.approveResolve = resolve })
        }
      }).then(() => this.runs.delete(runId))

      return { runId }
    })

    // 中止某次运行
    ipcMain.on('agent:stop', (_e, runId: string) => {
      const r = this.runs.get(runId)
      if (r) {
        r.aborted = true
        // 若正卡在 ask 等待审批，放行以便循环读到 aborted 后结束
        r.approveResolve?.(false)
      }
    })

    // 审批结果：approved=true 放行继续；false 等同于中止
    ipcMain.handle('agent:approve', async (_e, runId: string, approved: boolean) => {
      const r = this.runs.get(runId)
      if (r && r.approveResolve) {
        r.approveResolve(!!approved)
        r.approveResolve = undefined
      }
      return { ok: true }
    })
  }
}
