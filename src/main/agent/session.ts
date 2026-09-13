// 单窗口 Agent 执行闭环（Route A 状态机）
// PERCEIVE(截图+DOM) → DECIDE(VLM) → ACT(执行) → OBSERVE(再截图) → 循环，直到 finish/ask/达到步数上限
import type { BrowserWindow } from 'electron'
import type { AgentAction, AIAgentSettings, RpaStep } from '../../shared/types'
import { createVisionAdapter } from './vision'
import { buildNavHint } from './navHint'
import { extractDom } from './dom'
import { executeAction } from './actions'
import type { DomEl, DomSnapshot, RunOptions } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (a: number, b: number) => Math.floor(a + Math.random() * (b - a))

/** 在 DOM 快照里找离 (x,y) 最近、且优先命中所给点所在盒的元素 */
function findElAt(dom: DomSnapshot, x: number, y: number): DomEl | null {
  const els = dom.els
  if (!els.length) return null
  let best: DomEl | null = null
  let bestDist = Infinity
  for (const e of els) {
    const inside = x >= e.left && x <= e.left + e.w && y >= e.top && y <= e.top + e.h
    if (inside) {
      if (!best || e.w * e.h < best.w * best.h) best = e
    } else {
      const cx = e.left + e.w / 2
      const cy = e.top + e.h / 2
      const d = (cx - x) * (cx - x) + (cy - y) * (cy - y)
      if (d < bestDist) {
        bestDist = d
        best = e
      }
    }
  }
  return best
}

/**
 * 把一次 AgentAction 归一化为 RPA 步骤（与现有 sync-apply 回放引擎对齐）：
 * - click/type：用本步 DOM 快照解析稳定 selector + 盒内相对坐标；解析不出时回退占位，用户可在 RPA 编辑器补 selector
 * - scroll：RPA 是绝对滚动位置（window.scrollTo），读取执行后的真实 scrollX/Y
 * - wait：直转
 */
async function buildRpaStep(a: AgentAction, dom: DomSnapshot, win: BrowserWindow): Promise<RpaStep | null> {
  if (a.action === 'click') {
    const el = findElAt(dom, a.x, a.y)
    if (!el) return { type: 'click', sel: '', rx: a.x, ry: a.y }
    return { type: 'click', sel: el.sel, rx: Math.round(a.x - el.left), ry: Math.round(a.y - el.top) }
  }
  if (a.action === 'type') {
    const el = a.x != null && a.y != null ? findElAt(dom, a.x, a.y) : null
    return { type: 'input', sel: el?.sel || '', value: a.text || '' }
  }
  if (a.action === 'navigate') {
    return { type: 'navigate', url: a.url || '' }
  }
  if (a.action === 'wait') {
    return { type: 'wait', ms: Math.min(60000, Math.max(0, a.ms || 1000)) }
  }
  if (a.action === 'scroll') {
    try {
      const sp = (await win.webContents.executeJavaScript(
        'JSON.stringify([window.scrollX||0, window.scrollY||0])'
      )) as string
      const [x, y] = JSON.parse(sp) as [number, number]
      return { type: 'scroll', x: x || 0, y: y || 0 }
    } catch {
      return { type: 'scroll', x: 0, y: 0 }
    }
  }
  return null
}

/**
 * 截图：返回给 VLM 的 JPEG base64 与给 UI 的缩略图 dataURL。
 * 关键：只截「视口」(capturePage 传 rect)，不是整页——整页可能高达数千 px，
 * 既违背「坐标是视口像素、与截图 1:1」的约定，又会让超大图触发 Ollama/llama.cpp
 * 内部视觉错误（如 UnknownVizError）。视口尺寸即有界，坐标也与截图严格对齐。
 */
async function capture(win: BrowserWindow): Promise<{ vlm: string; thumb: string }> {
  const [cw, ch] = win.getContentSize()
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: cw, height: ch })
  // VLM 用视口原分辨率（坐标 1:1 对齐）；UI 缩略图另缩到 360 宽。
  const vlm = img.toJPEG(70).toString('base64')
  const thumb = img.resize({ width: 360 }).toDataURL()
  return { vlm, thumb }
}

export interface SessionEmit {
  step: (p: { step: number; action: AgentAction; screenshot?: string; rpaStep?: RpaStep | null }) => void
  needApproval: (p: { question: string }) => void
  done: (p: { result: string; rpaSteps?: RpaStep[] }) => void
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
  const vision = createVisionAdapter({
    backend: settings.backend,
    localVisionModel: settings.localVisionModel || 'minicpm-v:latest',
    cloudProvider: settings.cloudProvider,
    cloudBaseUrl: settings.cloudBaseUrl,
    cloudApiKey: settings.cloudApiKey,
    cloudVisionModel: settings.cloudVisionModel
  })
  const maxSteps = options.maxSteps || settings.maxStepsPerRun || 30
  // 确定性解析指令里点名的站点与搜索词，作为强指令注入每一步（绕过弱模型把当前
  // 已打开页面误当目标的系统性误判）。无明确站点时 hint 为空串，交给模型自行判断。
  const navInfo = buildNavHint(instruction)
  console.log(`[agent] navHint: ${navInfo.hint || '(none)'}`)
  console.log(`[agent] searchUrl: ${navInfo.searchUrl || '(none)'}`)
  const encodedTerm = navInfo.term ? encodeURIComponent(navInfo.term) : ''
  const history: AgentAction[] = []
  const recordedSteps: RpaStep[] = []
  let step = 0
  // 本地视觉模型偶发抖动容错：要连续失败这么多次才判定本轮失败（单次抖动不再 abort 整轮）
  const MAX_VISION_FAIL = 3
  let visionFailStreak = 0

  try {
    while (step < maxSteps) {
      if (controls.isAborted()) {
        emit.done({ result: '已停止', rpaSteps: recordedSteps })
        return
      }
      // —— PERCEIVE ——
      const { vlm, thumb } = await capture(win)
      const dom = await extractDom(win)
      console.log(`[agent] step ${step + 1} perceive: ${dom.title} | ${dom.url} | ${dom.els.length} elements`)
      // —— DECIDE ——
      // 导航强指令的注入时机：一直注入到「搜索已完成」为止。
      //   ① 已执行过 type（模型自己选择手动输入）→ 撤掉，避免与手输冲突；
      //   ② 当前 URL 已含关键词，或已 navigate 到含关键词的地址（即已到结果页）→ 撤掉。
      // 这样模型可以先 navigate 到站点、再 navigate 到「搜索直达 URL」，两步都拿得到提示；
      // 一旦到站/到结果页就立即撤掉，避免每步被逼着重复 navigate 造成死循环重载。
      const alreadyTyped = history.some((a) => a.action === 'type')
      const reachedSearch =
        !!encodedTerm &&
        (dom.url.includes(encodedTerm) ||
          history.some(
            (a) => a.action === 'navigate' && typeof a.url === 'string' && a.url.includes(encodedTerm)
          ))
      const nav = alreadyTyped || reachedSearch ? undefined : navInfo.hint
      let action: AgentAction
      try {
        action = await vision.understand({ imageBase64: vlm, instruction, dom, history, navHint: nav })
        visionFailStreak = 0
      } catch (ve) {
        // 本地视觉模型偶发失败（如 UnknownVizError）常是瞬时抖动，直接 abort 会让整轮
        // 执行前功尽弃。允许连续失败 MAX_VISION_FAIL 次，期间跳过本步、保留进度稍后重试。
        visionFailStreak++
        const msg = ve instanceof Error ? ve.message : String(ve)
        console.error(`[agent] 视觉模型调用失败 (${visionFailStreak}/${MAX_VISION_FAIL}): ${msg}`)
        if (visionFailStreak >= MAX_VISION_FAIL) {
          emit.error({ error: `视觉模型连续失败 ${visionFailStreak} 次：${msg}` })
          return
        }
        await sleep(rand(1500, 3000))
        continue
      }
      step++
      console.log(`[agent] step ${step} decide: ${action.action}${action.thought ? ' | ' + action.thought : ''}`)
      // —— FINISH / ASK（不执行动作，仅下发结果）——
      if (action.action === 'finish') {
        emit.step({ step, action, screenshot: thumb, rpaStep: null })
        emit.done({ result: action.thought || '任务完成', rpaSteps: recordedSteps })
        return
      }
      if (action.action === 'ask') {
        emit.step({ step, action, screenshot: thumb, rpaStep: null })
        emit.needApproval({ question: action.question || action.thought || '需要人工确认' })
        const ok = await controls.waitApprove()
        if (!ok) {
          emit.done({ result: '已停止（人工中止）', rpaSteps: recordedSteps })
          return
        }
        history.push(action)
        continue
      }
      // —— ACT ——
      console.log(`[agent] step ${step} execute: ${action.action}`)
      await executeAction(win, action)
      const rpaStep = await buildRpaStep(action, dom, win)
      if (rpaStep) recordedSteps.push(rpaStep)
      emit.step({ step, action, screenshot: thumb, rpaStep })
      history.push(action)
      // 拟人化间隔：降低机械感（不保证过风控，仅降机械性）
      await sleep(rand(800, 2500))
    }
    emit.done({
      result: `已达到最大步数（${maxSteps}），自动结束。若任务未完成，可补充指令后再次运行。`,
      rpaSteps: recordedSteps
    })
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    console.error('[agent] session error:', err)
    emit.error({ error: err })
  }
}
