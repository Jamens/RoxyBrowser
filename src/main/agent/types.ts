// Agent 执行闭环内部类型（主进程 agent/ 模块专用）
import type { AgentAction } from '../../shared/types'

/** DOM 元素快照（含视口中心坐标，与截图像素 1:1 对齐） */
export interface DomEl {
  tag: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** 一次页面感知的 DOM/无障碍树摘要 */
export interface DomSnapshot {
  url: string
  title: string
  vw: number
  vh: number
  els: DomEl[]
  error?: string
}

/** 启动一次 Agent 运行的选项 */
export interface RunOptions {
  /** 遇 ask/高风险动作是否暂停请求人工确认 */
  needApproval?: boolean
  /** 单次运行最大步数上限（防死循环），不传用设置里的 maxStepsPerRun */
  maxSteps?: number
}

export type { AgentAction }
