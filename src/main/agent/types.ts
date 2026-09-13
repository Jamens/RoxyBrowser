// Agent 执行闭环内部类型（主进程 agent/ 模块专用）
import type { AgentAction } from '../../shared/types'

/** DOM 元素快照（含视口中心坐标，与截图像素 1:1 对齐） */
export interface DomEl {
  tag: string
  text: string
  /** 视口中心坐标（与截图像素 1:1，VLM 给出的点击坐标基准） */
  x: number
  y: number
  w: number
  h: number
  /** 元素左上角坐标（用于换算 RPA 的盒内相对坐标 rx/ry） */
  left: number
  top: number
  /** 稳定 CSS 选择器，用于归一化为 RPA 步骤（点击/输入经 document.querySelector 解析） */
  sel: string
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
