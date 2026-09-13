// 单窗口 Agent 执行闭环（Route A 状态机）
// PERCEIVE(截图+DOM) → DECIDE(VLM) → ACT(执行) → OBSERVE(再截图) → 循环，直到 finish/ask/达到步数上限
import type { BrowserWindow } from 'electron'
import type { AgentAction, AIAgentSettings } from '../../shared/types'
import { createVisionAdapter } from './vision'
import { extractDom } from './dom'
import { executeAction } from './actions'
import type { RunOptions } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (a: number, b: number) => Math.floor(a + Math.random() * (b - a))

/** 截图：返回给 VLM 的 JPEG base64（视口宽度）与给 UI 的缩略图 dataURL */
async function capture(win: BrowserWindow): Promise<{ vlm: string; thumb: string }> {
  const img = await win.webContents.capturePage()
  const [cw] = win.getContentSize()
  const resized = img.resize({ width: cw })
  const vlm = resized.toJPEG(70).toString('base64')
  const thumb = resized.resize({ width: 360 }).toDataURL()
  return { vlm, thumb }
}

export interface SessionEmit {
  step: (p: { step: number; action: AgentAction; screenshot?: string }) => void
  needApproval: (p: { question: string }) => void
  done: (p: { result: string }) => void
  error: (p: { error: string }) => void
}

export interface SessionControls {
  isAborted: () => boolean
  /** 遇到 ask 时暂停，返回用户是否放行 */
  waitApprove: () => Promise<boolean>
}

export async function runAgentSession(opts: {
  win: BrowserWindow
  profileId: number
  instruction: string
  settings: AIAgentSettings
  options: RunOptions
  emit: SessionEmit
  controls: SessionControls
}): Promise<void> {
  const { win, instruction, settings, options, emit, controls } = opts
  const vision = createVisionAdapter(settings.localVisionModel || 'minicpm-v:latest')
  const maxSteps = options.maxSteps || settings.maxStepsPerRun || 30
  const history: AgentAction[] = []
  let step = 0

  try {
    while (step < maxSteps) {
      if (controls.isAborted()) {
        emit.done({ result: '已停止' })
        return
      }
      // —— PERCEIVE ——
      const { vlm, thumb } = await capture(win)
      const dom = await extractDom(win)
      // —— DECIDE ——
      const action = await vision.understand({ imageBase64: vlm, instruction, dom, history })
      step++
      emit.step({ step, action, screenshot: thumb })
      // —— FINISH / ASK ——
      if (action.action === 'finish') {
        emit.done({ result: action.thought || '任务完成' })
        return
      }
      if (action.action === 'ask') {
        emit.needApproval({ question: action.question || action.thought || '需要人工确认' })
        const ok = await controls.waitApprove()
        if (!ok) {
          emit.done({ result: '已停止（人工中止）' })
          return
        }
        history.push(action)
        continue
      }
      // —— ACT ——
      await executeAction(win, action)
      history.push(action)
      // 拟人化间隔：降低机械感（不保证过风控，仅降机械性）
      await sleep(rand(800, 2500))
    }
    emit.done({
      result: `已达到最大步数（${maxSteps}），自动结束。若任务未完成，可补充指令后再次运行。`
    })
  } catch (e) {
    emit.error({ error: e instanceof Error ? e.message : String(e) })
  }
}
