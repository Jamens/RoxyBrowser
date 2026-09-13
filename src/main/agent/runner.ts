// Agent 运行管理器（矩阵 / Supervisor）：一次 agent:start 可驱动 N 个独立环境窗口并发执行同一条指令。
// 与 server / browserManager 解耦——通过构造函数注入 getWindow / getSettings。
//
// 事件模型：父子双层 runId——
//   - 父 runId（agent:start 返回的那个）贯穿整次矩阵运行，UI 用它过滤；
//   - 每个事件的 payload 同时带 envId，UI 按 envId 分组聚合；
//   - 各子会话执行完发 per-env 的 agent:done / agent:error，全部结束后由 Supervisor 发一条 agent:all-done 汇总。
import { ipcMain, type WebContents } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings, AgentAction, RpaStep } from '../../shared/types'
import { runAgentSession } from './session'
import { checkOllamaStatus } from './ollama'
import type { RunOptions } from './types'

// 矩阵并行默认上限（设计文档 §9 R5 / §11）：超出排队，避免一次性拉起几十个 VLM 会话把机器拖垮。
const MAX_CONCURRENT = 5

export interface AgentStartPayload {
  envIds: number[]
  instruction: string
  options?: RunOptions
}

/** 单个子会话的运行态（按 envId 索引） */
interface ChildRun {
  envId: number
  childRunId: string
  aborted: boolean
  /** ask 等待人工审批时的放行回调 */
  approveResolve?: (ok: boolean) => void
}

/** 一次矩阵运行的父级状态 */
interface MatrixRunState {
  runId: string
  webContents: WebContents
  instruction: string
  aborted: boolean
  opts: RunOptions
  children: Map<number, ChildRun>
  /** envId → 该环境的最终结果（done / failed 都会写入） */
  results: Record<number, { status: 'done' | 'failed'; result: string; rpaSteps?: RpaStep[] }>
}

export class AgentRunner {
  private runs = new Map<string, MatrixRunState>()

  constructor(
    private deps: {
      getWindow: (id: number) => BrowserWindow | undefined
      getSettings: () => Promise<AppSettings>
    }
  ) {}

  registerIpc(): void {
    // 启动一次矩阵运行：返回 { runId } 或 { error }
    ipcMain.handle('agent:start', async (_e, payload: AgentStartPayload) => {
      const envIds = Array.isArray(payload?.envIds)
        ? payload.envIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
        : []
      const instruction = (payload?.instruction || '').trim()
      if (!envIds.length || !instruction) return { error: '请提供至少一个目标环境与执行指令' }
      // 去重，避免同一环境被重复驱动
      const uniq = Array.from(new Set(envIds))
      const settings = await this.deps.getSettings()
      // 运行前预检视觉模型：提前给出可执行提示，而不是等执行到第一步才在循环里炸 404。
      // 经验证：Chat 用文本模型、Agent 用视觉模型，两套互不相干；且预检必须同时覆盖
      // 「Ollama 没启动」与「模型没 pull」两种情况——31c8d7c 只覆盖了后者，导致 Ollama 未运行时不报错、
      // 直接进循环才炸 404「model not found」，用户完全看不到下载提示（正是本 bug 的起点）。
      const visionModel = settings.aiAgent.localVisionModel || 'minicpm-v:latest'
      const pull = visionModel.includes(':') ? visionModel.split(':')[0] : visionModel
      const st = await checkOllamaStatus({ model: visionModel })
      if (!st.reachable) {
        return {
          error: `未能连接本地 Ollama（${st.baseUrl} 无响应）。请先启动 Ollama，再执行：ollama pull ${pull}（或在「设置 → AI Agent → 视觉模型」中改为已安装的名称）`
        }
      }
      if (!st.modelPulled) {
        const hint = st.models.length
          ? `，本机已安装：${st.models.join('、')}`
          : '，本机尚未拉取任何模型'
        return {
          error: `视觉模型「${visionModel}」未安装${hint}。请先执行：ollama pull ${pull}（或在 设置 → AI Agent → 视觉模型 中改为已安装的名称）`
        }
      }
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const state: MatrixRunState = {
        runId,
        webContents: _e.sender,
        instruction,
        aborted: false,
        opts: payload.options || {},
        children: new Map(),
        results: {}
      }
      this.runs.set(runId, state)

      // 异步逐批启动（MAX_CONCURRENT 限流，超出排队）
      void this.launchAll(state, uniq, settings)
      return { runId }
    })

    // 中止整次矩阵运行（含所有子会话）
    ipcMain.on('agent:stop', (_e, runId: string) => {
      const r = this.runs.get(runId)
      if (r) {
        r.aborted = true
        r.children.forEach((c) => {
          c.aborted = true
          // 若正卡在 ask 等待审批，放行(false)以便循环读到 aborted 后结束
          c.approveResolve?.(false)
        })
      }
    })

    // 审批结果：针对某个具体环境放行（approved=true 继续；false 等同中止该环境）
    ipcMain.handle('agent:approve', async (_e, runId: string, envId: number, approved: boolean) => {
      const r = this.runs.get(runId)
      const c = r?.children.get(envId)
      if (c && c.approveResolve) {
        c.approveResolve(!!approved)
        c.approveResolve = undefined
      }
      return { ok: true }
    })
  }

  /** 逐批启动子会话（每批最多 MAX_CONCURRENT 个并发） */
  private async launchAll(state: MatrixRunState, envIds: number[], settings: AppSettings): Promise<void> {
    const runOne = async (envId: number) => {
      if (state.aborted) return
      await this.launchOne(state, envId, settings)
    }
    for (let i = 0; i < envIds.length; i += MAX_CONCURRENT) {
      if (state.aborted) break
      const batch = envIds.slice(i, i + MAX_CONCURRENT)
      await Promise.all(batch.map((e) => runOne(e)))
    }
    this.finish(state)
  }

  /** 启动单个环境的子会话，并把它的事件转发到渲染进程（统一带 envId + 父 runId） */
  private launchOne(state: MatrixRunState, envId: number, settings: AppSettings): Promise<void> {
    return new Promise<void>((resolve) => {
      const win = this.deps.getWindow(envId)
      if (!win || win.isDestroyed()) {
        state.results[envId] = { status: 'failed', result: '该环境窗口未运行，请先在「环境」列表打开它' }
        resolve()
        return
      }
      const childRunId = `${state.runId}-${envId}`
      const child: ChildRun = { envId, childRunId, aborted: false }
      state.children.set(envId, child)

      // 把目标窗口提到前台并聚焦，让用户看到执行过程，更关键的是让 sendInputEvent 的
      // 键盘事件可靠投递（复现：窗口在后台时，type 动作的按键会落到别的窗口，
      // 表现为「窗口没真正执行」——用户报告的核心现象）。
      try {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
      } catch {
        /* 窗口可能正在销毁，忽略 */
      }

      const send = (type: string, payloadObj: object) => {
        if (!state.webContents.isDestroyed()) {
          state.webContents.send(`agent:${type}`, { runId: state.runId, envId, ...payloadObj })
        }
      }

      void runAgentSession({
        win,
        profileId: envId,
        instruction: state.instruction,
        settings: settings.aiAgent,
        options: state.opts,
        emit: {
          step: (p: { step: number; action: AgentAction; screenshot?: string; rpaStep?: RpaStep | null }) =>
            send('step', p),
          needApproval: (p: { question: string }) => send('need-approval', p),
          done: (p: { result: string; rpaSteps?: RpaStep[] }) => {
            state.results[envId] = { status: 'done', result: p.result, rpaSteps: p.rpaSteps }
            send('done', p)
          },
          error: (p: { error: string }) => {
            state.results[envId] = { status: 'failed', result: p.error }
            send('error', p)
          }
        },
        controls: {
          isAborted: () => state.aborted || child.aborted,
          waitApprove: () => new Promise<boolean>((res) => { child.approveResolve = res })
        }
      }).then(() => resolve())
    })
  }

  /** 全部子会话结束后，向 UI 发一条汇总事件 */
  private finish(state: MatrixRunState): void {
    if (!state.webContents.isDestroyed()) {
      state.webContents.send('agent:all-done', {
        runId: state.runId,
        results: Object.entries(state.results).map(([envId, r]) => ({ envId: Number(envId), ...r }))
      })
    }
    this.runs.delete(state.runId)
  }
}
