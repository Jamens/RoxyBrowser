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
  "action": "click" | "type" | "navigate" | "scroll" | "wait" | "finish" | "ask",
  "x": <int>, "y": <int>,            // click
  "text": "<string>", "x"?: <int>, "y"?: <int>,  // type（可选先点 x,y 聚焦输入框）
  "url": "<string>",                 // navigate（完整 URL，含 https://）
  "delta": <int>,                     // scroll（正=向下，负=向上）
  "ms": <int>,                       // wait
  "question": "<string>"             // ask
}
Guidance:
- "finish" 当指令已完成或无法完成时，把结果/原因写进 thought。
- "ask" 当你需要人工决策（如验证码、需登录、歧义）时，把问题写进 question。
- "navigate" 当指令要求打开某个网站/网页时（如「打开必应」「进入百度」「打开 https://example.com」），直接用 navigate 跳转到目标 URL，不要只在地址栏里输入。url 必须填完整、含协议的地址（如 https://www.bing.com）。若指令是「搜索 X」，先 navigate 到搜索引擎主页，再用 type 在搜索框输入 X 并加 "\\n" 提交；不要直接打开环境预设的起始页就 finish。
- "type" 填入当前聚焦的输入框；若给了 x,y 则先点该输入框再输入。直接写原文（含空格）。若目标是地址栏、搜索框，或用户指令包含「打开/搜索/进入」等需要提交的内容，输入末尾必须加 "\\n" 来按回车提交；普通表单输入不要擅自提交。
- 不要过早 finish：若当前页面仍是环境预设的起始页（通常是 baidu.com）而你的指令尚未执行，先 navigate 到目标站点，不要直接输出 finish。只有指令真正完成后再 finish。
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
    case 'navigate':
      return { thought, action: 'navigate', url: typeof r.url === 'string' ? r.url : '' }
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
        // 不传 format:'json'：structured output 与 vision/images 在多个 Ollama/llama.cpp 构建里
        // 会冲突，产生不透明的内部错误（如 UnknownVizError）。已用 extractJson 容错解析，
        // 由 system prompt 强制「只输出 JSON」即可，避免触发该问题。
        body: JSON.stringify({ model, messages, stream: false })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        lastErr = `视觉模型调用失败 (${res.status})${text ? ': ' + text : ''}`
        // 500/模型未找到等可重试一次
        continue
      }
      // 先读原始文本再解析：Ollama 出错时 body 可能不是合法 JSON，直接 res.json() 会吞掉真实错误
      const raw = await res.text()
      let data: { message?: { content?: string }; error?: string }
      try {
        data = JSON.parse(raw) as { message?: { content?: string }; error?: string }
      } catch {
        lastErr = `视觉模型返回非 JSON 响应: ${raw.slice(0, 300)}`
        continue
      }
      if (data.error) {
        // Ollama 在 200 响应里带 error 字段（如 UnknownVizError）。同一请求重试结果必然相同，
        // 直接把原始错误透传给 UI，不再掩盖成「未 pull 模型」。
        throw new Error(`视觉模型返回错误：${data.error}（模型：${model}）`)
      }
      const parsed = coerce(extractJson(data.message?.content || ''))
      if (parsed) return parsed
      lastErr = `视觉模型未返回可解析的动作 JSON，原始输出：${String(data.message?.content || '').slice(0, 200)}`
    } catch (e) {
      // 已带「视觉模型返回错误：」前缀的是确定性的模型错误，直接上抛，不进重试
      if (e instanceof Error && e.message.startsWith('视觉模型返回错误：')) throw e
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(
    `${lastErr}\n（请确认：① Ollama 已启动；② 已执行 ollama pull ${model}；③ 该模型支持视觉/多模态，且「设置→AI Agent→视觉模型」名称正确）`
  )
}
