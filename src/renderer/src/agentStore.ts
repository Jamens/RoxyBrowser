// AI Agent 执行态的模块级单例 store。
//
// 背景：原先 AgentPanel 把执行状态（步骤 / 截图 / 状态 / runId）全放在组件 useState +
// useRef 里，切到别的标签（路由卸载重建）后状态清空；IPC 订阅在卸载时被清理、且新实例
// 的 runIdRef 为 null，会把主进程仍在推送的事件全部忽略，于是「切走再切回，执行数据没了」。
//
// 这里把执行态提到模块作用域，组件卸载也不丢；IPC 订阅只注册一次（进程级常驻），
// 事件持续累加到 store，组件用 useSyncExternalStore 读取，切回时立即拿到最新进度。
import { useSyncExternalStore } from 'react'
import type { AgentAction, RpaStep } from '@shared/types'

export type EnvStatus = { status: 'running' | 'done' | 'failed'; result?: string }
export type EnvStep = { step: number; action: AgentAction; screenshot?: string }
export interface MatrixResult {
  envId: number
  status: 'done' | 'failed'
  result: string
  rpaSteps?: RpaStep[]
}

export interface AgentSnapshot {
  runId: string | null
  running: boolean
  envIds: number[]
  instruction: string
  needApproval: boolean
  envStatus: Record<number, EnvStatus>
  envSteps: Record<number, EnvStep[]>
  envRpa: Record<number, RpaStep[]>
  matrix: { results: MatrixResult[] } | null
  ask: { envId: number; question: string } | null
  status: string
}

const EMPTY: AgentSnapshot = {
  runId: null,
  running: false,
  envIds: [],
  instruction: '',
  needApproval: false,
  envStatus: {},
  envSteps: {},
  envRpa: {},
  matrix: null,
  ask: null,
  status: ''
}

let snapshot: AgentSnapshot = EMPTY
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** 不可变更新：每次都生成新的 snapshot 引用，配合 useSyncExternalStore 触发重渲染 */
function set(patch: Partial<AgentSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  emit()
}

export const agentStore = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  getSnapshot: () => snapshot,

  /** 用户点击「开始」：初始化一次运行的本地视图（保留指令/目标/审批开关，清空上轮步骤） */
  start(envIds: number[], instruction: string, needApproval: boolean) {
    const envStatus: Record<number, EnvStatus> = {}
    for (const id of envIds) envStatus[id] = { status: 'running' }
    snapshot = {
      ...EMPTY,
      running: true,
      envIds,
      instruction,
      needApproval,
      envStatus,
      status: ''
    }
    emit()
  },
  setRunId(id: string | null) {
    set({ runId: id })
  },
  setRunning(b: boolean) {
    set({ running: b })
  },
  setStatus(s: string) {
    set({ status: s })
  },
  setEnvIds(v: number[]) {
    set({ envIds: v })
  },
  setInstruction(v: string) {
    set({ instruction: v })
  },
  setNeedApproval(v: boolean) {
    set({ needApproval: v })
  },
  setAsk(a: { envId: number; question: string } | null) {
    set({ ask: a })
  },

  onStep(d: { runId: string; envId: number; step: number; action: AgentAction; screenshot?: string; rpaStep?: RpaStep | null }) {
    if (d.runId !== snapshot.runId) return
    const e = d.envId
    const steps = snapshot.envSteps[e] || []
    const envSteps = { ...snapshot.envSteps, [e]: [...steps, { step: d.step, action: d.action, screenshot: d.screenshot }] }
    let envRpa = snapshot.envRpa
    if (d.rpaStep) {
      const rp = snapshot.envRpa[e] || []
      envRpa = { ...snapshot.envRpa, [e]: [...rp, d.rpaStep] }
    }
    set({ envSteps, envRpa })
  },
  onDone(d: { runId: string; envId: number; result: string; rpaSteps?: RpaStep[] }) {
    if (d.runId !== snapshot.runId) return
    const envStatus = { ...snapshot.envStatus, [d.envId]: { status: 'done' as const, result: d.result } }
    let envRpa = snapshot.envRpa
    if (d.rpaSteps?.length) envRpa = { ...snapshot.envRpa, [d.envId]: d.rpaSteps }
    set({ envStatus, envRpa })
  },
  onError(d: { runId: string; envId: number; error: string }) {
    if (d.runId !== snapshot.runId) return
    const envStatus = { ...snapshot.envStatus, [d.envId]: { status: 'failed' as const, result: d.error } }
    set({ envStatus })
  },
  onNeedApproval(d: { runId: string; envId: number; question: string }) {
    if (d.runId !== snapshot.runId) return
    set({ ask: { envId: d.envId, question: d.question } })
  },
  onAllDone(d: { runId: string; results: MatrixResult[] }) {
    if (d.runId !== snapshot.runId) return
    snapshot = { ...snapshot, runId: null, running: false, matrix: { results: d.results }, ask: null }
    emit()
  },
  /** 用户手动停止：保留已产生的步骤用于查看，仅标记停止并清 runId 让事件不再注入 */
  stop() {
    set({ running: false, runId: null, status: 'idle' })
  }
}

// IPC 订阅只注册一次（进程级常驻）。window.roxy 可能在模块加载时尚不可用，故惰性注册。
let subscribed = false
export function ensureAgentSubscriptions() {
  if (subscribed) return
  const roxy = window.roxy
  if (!roxy) return
  subscribed = true
  roxy.agentOnStep((d) => agentStore.onStep(d))
  roxy.agentOnDone((d) => agentStore.onDone(d))
  roxy.agentOnError((d) => agentStore.onError(d))
  roxy.agentOnNeedApproval((d) => agentStore.onNeedApproval(d))
  roxy.agentOnAllDone((d) => agentStore.onAllDone(d))
}

export function useAgentStore(): AgentSnapshot {
  return useSyncExternalStore(agentStore.subscribe, agentStore.getSnapshot, agentStore.getSnapshot)
}
