// 视觉理解适配器（Route A：截图 + DOM → VLM → 下一个原子动作）
// P1 默认本地 Ollama 视觉模型（minicpm-v / llama3.2-vision / qwen3-vl），零 token。
// 统一接口便于 P4 接入云端 BYOK 视觉模型。
import type { AgentAction } from '../../shared/types'
import type { DomSnapshot } from './types'

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'

export interface VisionRequest {
  /** 给 VLM 用的截图（JPEG base64，已缩放到视口宽度） */
  imageBase64: string
  instruction: string
  dom: DomSnapshot
  history: AgentAction[]
}

const SYSTEM_PROMPT = `You are a precise browser-automation agent that controls ONE browser window via screenshots.
You receive the current screenshot plus a DOM element list. Each DOM element has its center coordinate (x, y) in VIEWPORT PIXELS that exactly match the screenshot's pixel coordinates (origin top-left 0,0).
Decide the NEXT single atomic action that moves toward the user's instruction.

Coordinate rules (IMPORTANT):
- All coordinates are viewport pixels matching the screenshot 1:1.
- Prefer clicking a listed DOM element: use its provided (x, y) center. Only invent coordinates when no element fits.

Output ONLY a JSON object (no prose, no markdown fences) with this schema:
{
  "thought": "简短说明你要做什么、为什么（中文）",
  "action": "click" | "type" | "scroll" | "wait" | "finish" | "ask",
  "x": <int>, "y": <int>,            // click
  "text": "<string>", "x"?: <int>, "y"?: <int>,  // type（可选先点 x,y 聚焦输入框）
  "delta": <int>,                     // scroll（正=向下，负=向上）
  "ms": <int>,                       // wait
  "question": "<string>"             // ask
}
Guidance:
- "finish" 当指令已完成或无法完成时，把结果/原因写进 thought。
- "ask" 当你需要人工决策（如验证码、需登录、歧义）时，把问题写进 question。
- "type" 填入当前聚焦的输入框；若给了 x,y 则先点该输入框再输入。直接写原文（含空格），除非用户要求提交，否则不要按回车。
- 只输出 JSON，不要任何额外文字。`

function buildUserText(req: VisionRequest): string {
  const dom = req.dom
  const elLines = dom.els
    .map((e, i) => `#${i} ${e.tag} "${e.text}" @(${e.x},${e.y}) ${e.w}x${e.h}`)
    .join('\n')
  const hist = req.history.length
    ? req.history.map((h, i) => `step ${i + 1}: ${h.action}${h.thought ? ` - ${h.thought}` : ''}`).join('\n')
    : '(none)'
  return `当前页面标题: ${dom.title}\nURL: ${dom.url}\n视口: ${dom.vw}x${dom.vh}\n\n用户指令: ${req.instruction}\n\n可交互元素（中心坐标，与截图对齐）:\n${elLines || '(未检测到)'}\n\n已执行动作:\n${hist}\n\n请输出下一个动作（仅 JSON）。`
}

function extractJson(text: string): unknown {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    /* 可能带 markdown 围栏或前后文字，下面再抠 */
  }
  const m = t.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch {
      /* ignore */
    }
  }
  return null
}

function coerce(raw: unknown): AgentAction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const thought = typeof r.thought === 'string' ? r.thought : ''
  switch (r.action) {
    case 'click':
      if (typeof r.x === 'number' && typeof r.y === 'number') {
        return { thought, action: 'click', x: Math.round(r.x), y: Math.round(r.y) }
      }
      return null
    case 'type':
      return {
        thought,
        action: 'type',
        text: typeof r.text === 'string' ? r.text : '',
        x: typeof r.x === 'number' ? Math.round(r.x) : undefined,
        y: typeof r.y === 'number' ? Math.round(r.y) : undefined
      }
    case 'scroll':
      return { thought, action: 'scroll', delta: typeof r.delta === 'number' ? r.delta : 0 }
    case 'wait':
      return { thought, action: 'wait', ms: typeof r.ms === 'number' ? r.ms : 1000 }
    case 'finish':
      return { thought, action: 'finish' }
    case 'ask':
      return { thought, action: 'ask', question: typeof r.question === 'string' ? r.question : thought }
    default:
      return null
  }
}

export function createVisionAdapter(model: string) {
  return { understand: (req: VisionRequest) => understand(req, model) }
}

async function understand(req: VisionRequest, model: string): Promise<AgentAction> {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserText(req), images: [req.imageBase64] }
  ]
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, format: 'json' })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        lastErr = `视觉模型调用失败 (${res.status})${text ? ': ' + text : ''}`
        // 500/模型未找到等可重试一次
        continue
      }
      const data = (await res.json()) as { message?: { content?: string }; error?: string }
      if (data.error) {
        lastErr = data.error
        continue
      }
      const parsed = coerce(extractJson(data.message?.content || ''))
      if (parsed) return parsed
      lastErr = '视觉模型未返回可解析的动作 JSON'
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(`${lastErr}（请确认已 pull 视觉模型 ${model}，且 Ollama 已启动）`)
}
