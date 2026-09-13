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

/**
 * 把光标真正聚焦到目标「输入框」：sendInputEvent 的键盘事件只会投递到已聚焦的 DOM 元素，
 * 仅聚焦窗口/webContents 不够——这正是「输入框填不进字」的根因。
 * 优先用坐标 elementFromPoint 精确定位，再向上找到最近的 input/textarea/select/contenteditable
 * 并 .focus()；无坐标时回退到当前 activeElement 或页面第一个输入控件。
 */
async function focusInputAt(win: BrowserWindow, x?: number, y?: number): Promise<void> {
  const sx = typeof x === 'number' ? String(x) : 'null'
  const sy = typeof y === 'number' ? String(y) : 'null'
  const script = `(function(x, y){
    try {
      var el = (x !== null && y !== null) ? document.elementFromPoint(x, y) : document.activeElement;
      if (!el || el === document.body) el = document.querySelector('input,textarea,select,[contenteditable="true"]');
      var guard = 0;
      while (el && el !== document.body && guard++ < 6) {
        var ce = el.getAttribute && el.getAttribute('contenteditable');
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || ce === 'true' || ce === '') break;
        el = el.parentElement;
      }
      if (el && el.focus) {
        el.focus();
        if (el.setSelectionRange && typeof el.value === 'string') {
          try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
        }
      }
    } catch (e) {}
  })(${sx}, ${sy})`
  try {
    await win.webContents.executeJavaScript(script)
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

/** 读取当前聚焦元素的值（用于校验「字有没有真的填进去」） */
async function readFocusedValue(win: BrowserWindow): Promise<string | null> {
  const script = `(function(){var el=document.activeElement;if(!el||el===document.body)return null;return (typeof el.value==='string')?el.value:null;})()`
  try {
    return (await win.webContents.executeJavaScript(script)) as string | null
  } catch {
    return null
  }
}

/** 清空当前聚焦输入框（清空对可信性要求低，用原生 setter + input 事件即可） */
async function clearFocused(win: BrowserWindow): Promise<void> {
  const script = `(function(){var el=document.activeElement;if(!el)return;var tg=el.tagName;if(tg!=="INPUT"&&tg!=="TEXTAREA"&&el.getAttribute("contenteditable")!=="true")return;var proto=(tg==="TEXTAREA")?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;try{Object.getOwnPropertyDescriptor(proto,"value").set.call(el,"");}catch(e){el.value="";}el.dispatchEvent(new Event("input",{bubbles:true}));})()`
  try {
    await win.webContents.executeJavaScript(script)
  } catch {
    /* 窗口可能正在销毁，忽略 */
  }
}

/** 最后兜底：直接设值 + input/change 事件（不可信事件，仅保证 DOM 值与视觉一致） */
async function jsSetValue(win: BrowserWindow, v: string): Promise<void> {
  const script = `(function(v){var el=document.activeElement;if(!el)return;var tg=el.tagName;if(tg!=="INPUT"&&tg!=="TEXTAREA"&&el.getAttribute("contenteditable")!=="true")return;var proto=(tg==="TEXTAREA")?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;try{Object.getOwnPropertyDescriptor(proto,"value").set.call(el,v);}catch(e){el.value=v;}el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));})`
  try {
    await win.webContents.executeJavaScript(`${script}(${JSON.stringify(v)})`)
  } catch {
    /* 窗口可能正在销毁，忽略 */
  }
}

/**
 * 判断当前聚焦元素是否为「搜索类输入框」。
 * 用途：弱视觉模型经常忘了给文本加 \n 回车（日志里就是 text=Electron 而非 Electron\n），
 * 于是「字填进去了但没触发搜索」。检测到是搜索框时自动补一次回车作为兜底。
 */
async function isSearchLikeInput(win: BrowserWindow): Promise<boolean> {
  const script = `(function(){
    try {
      var el = document.activeElement;
      if (!el) return false;
      var tg = el.tagName;
      if (tg !== 'INPUT' && tg !== 'TEXTAREA') return false;
      var t = (el.type || '').toLowerCase();
      var nm = (el.getAttribute('name') || '').toLowerCase();
      var role = (el.getAttribute('role') || '').toLowerCase();
      var al = (el.getAttribute('aria-label') || '').toLowerCase();
      var ph = (el.getAttribute('placeholder') || '').toLowerCase();
      var id = (el.id || '').toLowerCase();
      if (t === 'search' || role === 'searchbox') return true;
      if (nm === 'q' || nm === 'query' || nm === 's' || nm === 'wd' || nm === 'keyword') return true;
      if (/search|搜索|查询|搜一搜/.test(al + ' ' + ph + ' ' + id + ' ' + nm)) return true;
      var f = el.form;
      if (f) {
        if ((f.getAttribute('role') || '').toLowerCase() === 'search') return true;
        if (/\\/search|\\/results|\\/s\\?|search\\./i.test(f.action || '')) return true;
      }
      return false;
    } catch (e) { return false; }
  })()`
  try {
    return Boolean(await win.webContents.executeJavaScript(script))
  } catch {
    return false
  }
}

async function typeText(win: BrowserWindow, text: string): Promise<void> {
  // 末尾的 \n 视为「回车提交」，从填入内容里剥离，单独发 Enter（避免把换行真的写进输入框）
  const submit = /\r?\n$/.test(text)
  const value = text.replace(/\r?\n$/, '')
  // 1) 真实键盘事件：拟人、触发框架受控输入与输入联想
  for (const ch of value) {
    const kc = mapKey(ch)
    const kd: KeyboardInputEvent = { type: 'keyDown', keyCode: kc, modifiers: [] }
    win.webContents.sendInputEvent(kd)
    await sleep(rand(30, 80))
    const ku: KeyboardInputEvent = { type: 'keyUp', keyCode: kc, modifiers: [] }
    win.webContents.sendInputEvent(ku)
    await sleep(rand(40, 110))
  }
  // 2) 校验：真实按键到底有没有把字填进去
  let filled = (await readFocusedValue(win)) === value
  if (!filled) {
    // 3) 清掉残留后用 webContents.insertText 走「浏览器真实输入通道」可信插入。
    //    关键点：JS 直接改 value + dispatchEvent 属于不可信事件，站点框架（React/Vue/站点自研）
    //    的内部状态不会更新，于是「看起来填进去了，但回车/点搜索实际提交的是空查询」。
    //    insertText 与真实键入同源，能正确触发受控输入的 onChange。
    await clearFocused(win)
    try {
      win.webContents.insertText(value)
    } catch {
      /* 窗口可能正在销毁，忽略 */
    }
    await sleep(rand(120, 320))
    filled = (await readFocusedValue(win)) === value
  }
  if (!filled) await jsSetValue(win, value)
  // 4) 提交：必须等「值真的填好之后」再回车。原先 Enter 发在兜底之前，一旦真实按键失效，
  //    Enter 就打在空输入框上，搜索完全不触发——这正是「填进去了但搜索没反应」的根因。
  //    另外：弱模型常忘记给文本加 \n（实测日志是 text=Electron），所以检测到焦点在
  //    「搜索类输入框」时即使没有 \n 也自动补一次回车，保证真的发起搜索。
  const shouldSubmit = submit || (await isSearchLikeInput(win))
  if (shouldSubmit) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: [] })
    await sleep(rand(40, 110))
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: [] })
    await sleep(rand(150, 400))
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
      // 先聚焦窗口；再（可选）点进输入框；最后用坐标精确定位 + JS 聚焦把目标输入框真正聚焦，
      // 否则 sendInputEvent 的键盘事件只会落到 body/当前焦点，表现为「输入框填不进字」。
      ensureFocused(win)
      if (typeof a.x === 'number' && typeof a.y === 'number') await clickAt(win, a.x, a.y)
      await focusInputAt(win, a.x, a.y)
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
