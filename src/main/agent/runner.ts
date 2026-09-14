// Agent 运行管理器（矩阵 / Supervisor）：一次 agent:start 可驱动 N 个独立环境窗口并发执行同一条指令。
// 与 server / browserManager 解耦——通过构造函数注入 getWindow / getSettings。
//
// 事件模型：父子双层 runId——
//   - 父 runId（agent:start 返回的那个）贯穿整次矩阵运行，UI 用它过滤；
//   - 每个事件的 payload 同时带 envId，UI 按 envId 分组聚合；
//   - 各子会话执行完发 per-env 的 agent:done / agent:error，全部结束后由 Supervisor 发一条 agent:all-done 汇总。
import { ipcMain, type WebContents } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings, AgentAction, RpaStep, AiAutoTask } from '../../shared/types'
import { runAgentSession } from './session'
import { checkOllamaStatus } from './ollama'
import { checkCloudStatus } from './cloud'
import type { RunOptions } from './types'

// 矩阵并行默认上限（设计文档 §9 R5 / §11）：超出排队，避免一次性拉起几十个 VLM 会话把机器拖垮。
const MAX_CONCURRENT = 5

// 定时任务落库/日志统一使用的触发者（区别于真人用户触发的 agent:start）
const AUTO_ACTOR = { userId: 0, username: 'ai-scheduler' } as const

/**
 * 事件出口：真实 UI 触发用 WebContents（能 forward 事件到渲染进程）；
 * 定时任务在后台静默执行、没有 UI sender，用空 sink 把事件丢弃（仅落库/日志走完）。
 */
type AgentSink = Pick<WebContents, 'send' | 'isDestroyed'>

/** 把 agent 跑出的动作序列落库为 RPA 模板（零 token 离线回放），由 server 注入以避免 agent 层直接依赖数据源 */
export type SaveRpaScript = (input: {
  sourceEnvId: number
  name: string
  steps: RpaStep[]
  instruction?: string
}) => Promise<{ id: number; name: string }>

export interface AgentStartPayload {
  envIds: number[]
  instruction: string
  options?: RunOptions
  /** 触发者（当前登录用户），用于写操作日志；缺省时日志记为 ai-agent */
  actor?: { userId: number; username: string }
}

/** 写 Agent 操作日志的注入依赖（由 server 提供，避免 agent 层直接依赖数据源） */
export type WriteAgentLog = (input: {
  profileId?: number
  action: string
  detail: string
  actor?: { userId: number; username: string }
}) => Promise<void>

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
  webContents: AgentSink
  instruction: string
  aborted: boolean
  opts: RunOptions
  children: Map<number, ChildRun>
  /** envId → 该环境的最终结果（done / failed 都会写入） */
  results: Record<number, { status: 'done' | 'failed'; result: string; rpaSteps?: RpaStep[] }>
  /** 触发者，用于写操作日志 */
  actor?: { userId: number; username: string }
  /** 定时任务元信息：用于跑完把动作序列沉淀为 RPA 模板 */
  autoTask?: { id: string; name: string; saveRpa: boolean; instruction: string }
  /** 是否把目标窗口提到前台聚焦（定时任务在后台静默执行，不抢焦点） */
  focusWindow: boolean
}

export class AgentRunner {
  private runs = new Map<string, MatrixRunState>()
  // AI 定时自动化调度器
  private autoTaskTimer: ReturnType<typeof setInterval> | null = null
  // 每个任务上次触发时刻（用于按 intervalMin 去抖）；进程内内存态，进程重启后清零属可接受的「立即补跑一次」
  private lastFired = new Map<string, number>()

  constructor(
    private deps: {
      getWindow: (id: number) => BrowserWindow | undefined
      getSettings: () => Promise<AppSettings>
      writeAgentLog?: WriteAgentLog
      saveRpaScript?: SaveRpaScript
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
      // 运行前预检视觉模型：提前给出可执行提示，而不是等执行到第一步才在循环里炸。
      const visionErr = await this.checkVision(settings)
      if (visionErr) return { error: visionErr }
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const state: MatrixRunState = {
        runId,
        webContents: _e.sender,
        instruction,
        aborted: false,
        opts: payload.options || {},
        children: new Map(),
        results: {},
        actor: payload.actor,
        focusWindow: true
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

  /**
   * 执行闭环前的视觉模型预检：本地 Ollama 与云端 BYOK 两类失败都覆盖，与 /api/ai-agent/status 一致。
   * 返回错误文案（需中止）或 null（预检通过）。UI 触发（agent:start）与定时触发共用同一份逻辑。
   */
  private async checkVision(settings: AppSettings): Promise<string | null> {
    const a = settings.aiAgent
    if (!a?.enabled) return 'AI Agent 未启用，请在「设置 → AI Agent」开启'
    if (a.backend === 'cloud') {
      if (!a.cloudApiKey?.trim() || !a.cloudVisionModel?.trim()) {
        return '云端视觉模型未配置：Agent 执行闭环需要多模态模型，请在「设置 → AI Agent」填写 API Key 与视觉模型名（如 gpt-4o / qwen-vl-max / glm-4v）'
      }
      const cs = await checkCloudStatus({
        provider: a.cloudProvider,
        baseUrl: a.cloudBaseUrl,
        apiKey: a.cloudApiKey,
        model: a.cloudVisionModel
      })
      if (!cs.reachable) {
        return `云端视觉模型连通性自检失败（${a.cloudVisionModel}）：${cs.error || '未知错误'}。请确认 API Key 有效、模型名正确且支持图像输入。`
      }
    } else {
      const visionModel = a.localVisionModel || 'minicpm-v:latest'
      const pull = visionModel.includes(':') ? visionModel.split(':')[0] : visionModel
      const st = await checkOllamaStatus({ model: visionModel })
      if (!st.reachable) {
        return `未能连接本地 Ollama（${st.baseUrl} 无响应）。请先启动 Ollama，再执行：ollama pull ${pull}（或在「设置 → AI Agent → 视觉模型」中改为已安装的名称）`
      }
      if (!st.modelPulled) {
        const hint = st.models.length
          ? `，本机已安装：${st.models.join('、')}`
          : '，本机尚未拉取任何模型'
        return `视觉模型「${visionModel}」未安装${hint}。请先执行：ollama pull ${pull}（或在 设置 → AI Agent → 视觉模型 中改为已安装的名称）`
      }
    }
    return null
  }

  /** 逐批启动子会话（每批最多 MAX_CONCURRENT 个并发） */
  private async launchAll(state: MatrixRunState, envIds: number[], settings: AppSettings): Promise<void> {
    // 整次矩阵运行落一条开始日志（teamId 取首个目标环境所属团队）
    void this.deps.writeAgentLog?.({
      profileId: envIds[0],
      action: 'agent_start',
      detail: `AI 执行开始：「${state.instruction}」· 目标环境 ${envIds.map((id) => `#${id}`).join('、')}`,
      actor: state.actor
    })
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
      // 每个环境结束/失败各落一条日志，便于在日志页按环境追溯
      const logEnv = (action: string, detail: string) => {
        void this.deps.writeAgentLog?.({ profileId: envId, action, detail, actor: state.actor })
      }
      const win = this.deps.getWindow(envId)
      if (!win || win.isDestroyed()) {
        state.results[envId] = { status: 'failed', result: '该环境窗口未运行，请先在「环境」列表打开它' }
        logEnv('agent_failed', `AI 执行失败：「${state.instruction}」· 环境 #${envId} · 该环境窗口未运行`)
        resolve()
        return
      }
      const childRunId = `${state.runId}-${envId}`
      const child: ChildRun = { envId, childRunId, aborted: false }
      state.children.set(envId, child)

      // 把目标窗口提到前台并聚焦，让用户看到执行过程，更关键的是让 sendInputEvent 的
      // 键盘事件可靠投递（复现：窗口在后台时，type 动作的按键会落到别的窗口，
      // 表现为「窗口没真正执行」——用户报告的核心现象）。
      // 定时任务在后台静默执行（focusWindow=false），不抢焦点、不打扰当前操作。
      try {
        if (state.focusWindow) {
          if (win.isMinimized()) win.restore()
          if (!win.isVisible()) win.show()
          win.focus()
          win.webContents.focus()
        }
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
            logEnv(
              'agent_done',
              `AI 执行完成：「${state.instruction}」· 环境 #${envId} · ${p.rpaSteps?.length || 0} 步 · ${p.result}`
            )
            send('done', p)
            // 定时任务且开启「沉淀 RPA」：把动作序列落库为 RPA 模板，下次离线回放零 token
            if (state.autoTask?.saveRpa && p.rpaSteps && p.rpaSteps.length > 0) {
              void this.persistRpa(state, envId, p.rpaSteps)
            }
          },
          error: (p: { error: string }) => {
            state.results[envId] = { status: 'failed', result: p.error }
            logEnv('agent_failed', `AI 执行失败：「${state.instruction}」· 环境 #${envId} · ${p.error}`)
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

  /** 把定时任务跑出的动作序列沉淀为 RPA 模板（下次离线回放零 token） */
  private async persistRpa(state: MatrixRunState, envId: number, steps: RpaStep[]): Promise<void> {
    const task = state.autoTask!
    try {
      const res = await this.deps.saveRpaScript?.({
        sourceEnvId: envId,
        name: `${task.name} · AI模板(#${envId}) ${new Date().toISOString().slice(0, 10)}`,
        steps,
        instruction: task.instruction
      })
      void this.deps.writeAgentLog?.({
        profileId: envId,
        action: 'agent_rpa_saved',
        detail: `AI 定时任务「${task.name}」已沉淀 RPA 模板「${res?.name}」(#${res?.id})，${steps.length} 步`,
        actor: state.actor
      })
    } catch (e) {
      void this.deps.writeAgentLog?.({
        profileId: envId,
        action: 'agent_rpa_save_fail',
        detail: `AI 定时任务「${task.name}」沉淀 RPA 模板失败：${e instanceof Error ? e.message : String(e)}`,
        actor: state.actor
      })
    }
  }

  // ===================== AI 定时自动化调度 =====================
  // 每 scanMs 扫描一次 settings.aiAutoTasks，按各任务 intervalMin 决定是否触发；
  // 触发后只驱动运行态环境，未运行自动跳过（绝不自动开窗）。

  /** 启动调度器（幂等：重复调用不会叠加多个定时器） */
  startAutoTaskScheduler(scanMs = 60_000): void {
    if (this.autoTaskTimer) return
    this.autoTaskTimer = setInterval(() => {
      void this.tickAutoTasks().catch((e) => console.error('[roxy] AI 定时自动化调度异常:', e))
    }, scanMs)
    this.autoTaskTimer.unref?.()
    console.log(`[roxy] AI 定时自动化调度器已启动（每 ${scanMs / 1000}s 扫描一次）`)
  }

  /** 停止调度器并清空去抖记录 */
  stopAutoTaskScheduler(): void {
    if (this.autoTaskTimer) {
      clearInterval(this.autoTaskTimer)
      this.autoTaskTimer = null
    }
    this.lastFired.clear()
  }

  private async tickAutoTasks(): Promise<void> {
    const settings = await this.deps.getSettings()
    const tasks = Array.isArray(settings.aiAutoTasks) ? settings.aiAutoTasks : []
    if (tasks.length === 0) return
    const now = Date.now()
    for (const task of tasks) {
      if (!task.enabled) continue
      const intervalMin = Number(task.intervalMin) || 0
      if (!(intervalMin > 0)) continue
      const last = this.lastFired.get(task.id) || 0
      if (now - last < intervalMin * 60 * 1000) continue
      this.lastFired.set(task.id, now)
      // 异步执行，不阻塞扫描循环；失败由 runScheduledTask 内部兜底
      void this.runScheduledTask(task)
    }
  }

  /** 执行一条定时任务：预检视觉模型 → 过滤运行态环境 → 后台静默跑闭环 → 跑完按需沉淀 RPA */
  async runScheduledTask(task: AiAutoTask): Promise<void> {
    const envIds = Array.isArray(task.envIds)
      ? task.envIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
      : []
    if (!task.instruction?.trim() || envIds.length === 0) {
      console.warn(`[roxy] AI 定时任务「${task.name}」缺少指令或目标环境，跳过`)
      return
    }
    const settings = await this.deps.getSettings()
    const visionErr = await this.checkVision(settings)
    if (visionErr) {
      void this.deps.writeAgentLog?.({
        action: 'agent_scheduled_skip',
        detail: `AI 定时任务「${task.name}」跳过：${visionErr}`,
        actor: AUTO_ACTOR
      })
      return
    }
    // 仅驱动运行态环境；未运行自动跳过并写日志（绝不自动开窗）
    const running: number[] = []
    for (const id of envIds) {
      const win = this.deps.getWindow(id)
      if (win && !win.isDestroyed()) running.push(id)
      else
        void this.deps.writeAgentLog?.({
          profileId: id,
          action: 'agent_scheduled_skip',
          detail: `AI 定时任务「${task.name}」跳过环境 #${id}：窗口未运行`,
          actor: AUTO_ACTOR
        })
    }
    if (running.length === 0) {
      console.log(`[roxy] AI 定时任务「${task.name}」无运行态目标，本次跳过`)
      return
    }
    const runId = `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const state: MatrixRunState = {
      runId,
      // 定时任务没有 UI sender，用空 sink 丢弃事件（落库/日志在 done 内部完成）
      webContents: { send: () => {}, isDestroyed: () => false },
      instruction: task.instruction.trim(),
      aborted: false,
      opts: task.maxSteps > 0 ? { maxSteps: task.maxSteps } : {},
      children: new Map(),
      results: {},
      actor: AUTO_ACTOR,
      autoTask: { id: task.id, name: task.name, saveRpa: !!task.saveRpa, instruction: task.instruction.trim() },
      focusWindow: false
    }
    this.runs.set(runId, state)
    console.log(`[roxy] AI 定时任务「${task.name}」启动，驱动 ${running.length}/${envIds.length} 个运行态环境`)
    void this.launchAll(state, running, settings)
  }
}
