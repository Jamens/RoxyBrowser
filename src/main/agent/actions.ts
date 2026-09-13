// 动作执行层：把 VLM 决策的动作映射到可信输入（webContents.sendInputEvent）
// 用真实输入事件而非 DOM dispatch——与 sync-event 测试台一致，React 受控组件也能正常响应。
import type { BrowserWindow } from 'electron'
import type { MouseInputEvent, KeyboardInputEvent, MouseWheelInputEvent } from 'electron'
import type { AgentAction } from '../../shared/types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (a: number, b: number) => Math.floor(a + Math.random() * (b - a))

/** 把单个字符映射成 sendInputEvent 的 keyCode 字符串 */
function mapKey(ch: string): string {
  if (ch === '\n' || ch === '\r') return 'Enter'
  if (ch === '\t') return 'Tab'
  if (ch === '\b') return 'Backspace'
  if (ch === ' ') return 'Space'
  return ch
}

async function clickAt(win: BrowserWindow, x: number, y: number): Promise<void> {
  const cx = Math.round(x + rand(-2, 2))
  const cy = Math.round(y + rand(-2, 2))
  // 先移动过去，更像真人；坐标抖动降低机械感
  const move: MouseInputEvent = { type: 'mouseMove', x: cx, y: cy, modifiers: [] }
  win.webContents.sendInputEvent(move)
  await sleep(rand(30, 90))
  const down: MouseInputEvent = { type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: [] }
  win.webContents.sendInputEvent(down)
  await sleep(rand(40, 120))
  const up: MouseInputEvent = { type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1, modifiers: [] }
  win.webContents.sendInputEvent(up)
  await sleep(rand(120, 360))
}

async function typeText(win: BrowserWindow, text: string): Promise<void> {
  for (const ch of text) {
    const kc = mapKey(ch)
    const kd: KeyboardInputEvent = { type: 'keyDown', keyCode: kc, modifiers: [] }
    win.webContents.sendInputEvent(kd)
    await sleep(rand(30, 80))
    const ku: KeyboardInputEvent = { type: 'keyUp', keyCode: kc, modifiers: [] }
    win.webContents.sendInputEvent(ku)
    await sleep(rand(40, 110))
  }
}

async function scrollBy(win: BrowserWindow, delta: number): Promise<void> {
  const [w, h] = win.getContentSize()
  const wheel: MouseWheelInputEvent = {
    type: 'mouseWheel',
    x: Math.round(w / 2),
    y: Math.round(h / 2),
    deltaX: 0,
    deltaY: delta,
    modifiers: []
  }
  win.webContents.sendInputEvent(wheel)
  await sleep(rand(200, 500))
}

/** 执行单个原子动作（click/type/scroll/wait）；finish/ask 由上层处理 */
export async function executeAction(win: BrowserWindow, a: AgentAction): Promise<void> {
  switch (a.action) {
    case 'click':
      await clickAt(win, a.x, a.y)
      break
    case 'type':
      if (typeof a.x === 'number' && typeof a.y === 'number') await clickAt(win, a.x, a.y)
      await typeText(win, a.text || '')
      break
    case 'scroll':
      await scrollBy(win, a.delta || 0)
      break
    case 'wait':
      await sleep(Math.min(30000, Math.max(0, a.ms || 1000)))
      break
    default:
      break
  }
}
