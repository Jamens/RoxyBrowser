// 动作执行层：把 VLM 决策的动作映射到可信输入（webContents.sendInputEvent）
// 用真实输入事件而非 DOM dispatch——与 sync-event 测试台一致，React 受控组件也能正常响应。
import type { BrowserWindow } from 'electron'
import type { MouseInputEvent, KeyboardInputEvent, MouseWheelInputEvent } from 'electron'
import type { AgentAction } from '../../shared/types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (a: number, b: number) => Math.floor(a + Math.random() * (b - a))

/** 调试日志：把动作安全地转成单行描述（避免访问不存在的字段触发 TS 窄化报错） */
function actionDebug(a: AgentAction): string {
  const parts: string[] = [a.action]
  if (a.action === 'click' || a.action === 'type') {
    parts.push(`(${(a as { x?: number }).x ?? '-'},${(a as { y?: number }).y ?? '-'})`)
  }
  if (a.action === 'type') parts.push(`text=${(a as { text?: string }).text ?? ''}`)
  if (a.action === 'scroll') parts.push(`delta=${(a as { delta?: number }).delta ?? 0}`)
  if (a.action === 'wait') parts.push(`ms=${(a as { ms?: number }).ms ?? 0}`)
  if (a.action === 'navigate') parts.push(`url=${(a as { url?: string }).url ?? ''}`)
  return parts.join(' ')
}

/**
 * 每次输入前确保目标窗口聚焦：webContents.sendInputEvent 的键盘事件依赖窗口焦点，
 * 否则按键会落到当前真正聚焦的窗口（通常是别的程序或别的 Agent 环境窗口），
 * 表现为「窗口没真正执行」。鼠标/滚轮事件是按窗口坐标系投递的，不依赖焦点，但为稳妥起见也一并聚焦。
 */
function ensureFocused(win: BrowserWindow): void {
  try {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.focus()
  } catch {
    /* 窗口可能正在销毁，忽略 */
  }
}

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
  console.log(`[agent:action] ${actionDebug(a)}`)
  switch (a.action) {
    case 'click':
      ensureFocused(win)
      await clickAt(win, a.x, a.y)
      break
    case 'type':
      // 先聚焦窗口，再点进输入框并键入——保证键盘事件落到正确目标
      ensureFocused(win)
      if (typeof a.x === 'number' && typeof a.y === 'number') await clickAt(win, a.x, a.y)
      await typeText(win, a.text || '')
      break
    case 'navigate': {
      // 直接在主进程侧跳转：与 BrowserTab.go → env-navigate 主进程分支一致（都是
      // win.webContents.loadURL），但 agent 不挂 did-fail-load 回退起始页——失败就
      // 停在错误页由 Agent 自己截图判断，避免把上下文刷回起始页丢失进度。
      // 注意只放行 http(s)，与 env-navigate 的收窄口径保持一致，杜绝 file:/javascript: 注入。
      const url = a.url || ''
      if (/^https?:\/\//i.test(url)) {
        try {
          await win.webContents.loadURL(url)
          await sleep(rand(1500, 3000))
        } catch (e) {
          console.error('[agent:action] navigate 失败:', e instanceof Error ? e.message : e)
        }
      } else {
        console.warn('[agent:action] navigate 忽略非 http(s) 地址:', url)
      }
      break
    }
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
