// 视觉理解适配器（Route A：截图 + DOM → VLM → 下一个原子动作）
// P1 默认本地 Ollama 视觉模型（minicpm-v / llama3.2-vision / qwen3-vl），零 token。
// 统一接口便于 P4 接入云端 BYOK 视觉模型。
import type { AgentAction, AIAgentBackend, AIAgentCloudProvider } from '../../shared/types'
import { cloudVisionChat } from './cloud'
import type { DomSnapshot } from './types'
import {
  VISION_MIN_NUM_CTX,
  parseContextOverflow,
  describeContextOverflow,
  estimateVisionTokens,
  computeVisionNumCtx
} from '../../shared/ollamaModels'

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'

export interface VisionRequest {
  /** 给 VLM 用的截图（JPEG base64，已缩放到视口宽度） */
  imageBase64: string
  instruction: string
  dom: DomSnapshot
  history: AgentAction[]
  /** 由 navHint.buildNavHint 确定性算出的导航强指令（点名站点 + 搜索词 + 步骤顺序） */
  navHint?: string
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
- 站点别名对照（务必按指令点名的站点跳转，不要拿当前已打开的页面顶替）：必应=Bing=https://www.bing.com；谷歌=Google=https://www.google.com；百度=Baidu=https://www.baidu.com；DuckDuckGo=https://duckduckgo.com；GitHub=https://github.com；YouTube=https://www.youtube.com；Bilibili=https://www.bilibili.com。
- "type" 填入当前聚焦的输入框；若给了 x,y 则先点该输入框再输入。直接写原文（含空格）。若目标是地址栏、搜索框，或用户指令包含「打开/搜索/进入」等需要提交的内容，输入末尾必须加 "\\n" 来按回车提交；普通表单输入不要擅自提交。
- 不要过早 finish：若当前页面仍是环境预设的起始页（通常是 baidu.com）而你的指令尚未执行，先 navigate 到目标站点，不要直接输出 finish。只有指令真正完成后再 finish。
- 复合指令（如「搜索必应，并搜索 Electron，点击搜索到的第一条链接」）必须逐步执行，不可跳步：① navigate 到指令点名的站点（必应→bing.com，绝不用百度等其它已开页面顶替）→ ② 在该站点搜索框输入关键词（Electron）并按回车 → ③ 等待搜索结果加载 → ④ 点击第一条结果。**在未真正完成「搜索」之前，严禁去点页面上的任何链接**；若当前页面已经是目标站点，则跳过第①步直接进入第②步。
- 若提示词里出现「【导航要求】…」，那是系统为你算出的确定目标，优先级高于你的推测，请严格照做。
- 只输出 JSON，不要任何额外文字。`

function buildUserText(req: VisionRequest): string {
  const dom = req.dom
  const elLines = dom.els
    .map((e, i) => `#${i} ${e.tag} "${e.text}" @(${e.x},${e.y}) ${e.w}x${e.h}`)
    .join('\n')
  const hist = req.history.length
    ? req.history.map((h, i) => `step ${i + 1}: ${h.action}${h.thought ? ` - ${h.thought}` : ''}`).join('\n')
    : '(none)'
  const navBlock = req.navHint
    ? `\n【导航要求】${req.navHint}\n`
    : ''
  return `当前页面标题: ${dom.title}\nURL: ${dom.url}\n视口: ${dom.vw}x${dom.vh}\n\n用户指令: ${req.instruction}${navBlock}\n可交互元素（中心坐标，与截图对齐）:\n${elLines || '(未检测到)'}\n\n已执行动作:\n${hist}\n\n请输出下一个动作（仅 JSON）。`
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

export interface VisionAdapterConfig {
  backend: AIAgentBackend
  localVisionModel: string
  cloudProvider: AIAgentCloudProvider
  cloudBaseUrl: string
  cloudApiKey: string
  cloudVisionModel: string
}

export function createVisionAdapter(cfg: VisionAdapterConfig) {
  return { understand: (req: VisionRequest) => understand(req, cfg) }
}

/**
 * 看屏决策：本地走 Ollama 视觉模型，云端走 BYOK 多模态模型。
 * 两套共用同一份动作协议（SYSTEM_PROMPT / buildUserText / extractJson / coerce）。
 */
async function understand(req: VisionRequest, cfg: VisionAdapterConfig): Promise<AgentAction> {
  if (cfg.backend === 'cloud') return understandCloud(req, cfg)
  return understandOllama(req, cfg.localVisionModel)
}

async function understandCloud(req: VisionRequest, cfg: VisionAdapterConfig): Promise<AgentAction> {
  if (!cfg.cloudApiKey?.trim() || !cfg.cloudVisionModel?.trim()) {
    throw new Error(
      '云端视觉模型未配置：Agent 执行闭环需要多模态模型，请在「设置 → AI Agent」填写 API Key 与视觉模型名（如 gpt-4o / qwen-vl-max / glm-4v）'
    )
  }
  const text = await cloudVisionChat({
    provider: cfg.cloudProvider,
    baseUrl: cfg.cloudBaseUrl,
    apiKey: cfg.cloudApiKey,
    model: cfg.cloudVisionModel,
    systemPrompt: SYSTEM_PROMPT,
    userText: buildUserText(req),
    imageBase64: req.imageBase64
  })
  const parsed = coerce(extractJson(text))
  if (parsed) return parsed
  throw new Error(`云端视觉模型未返回可解析的动作 JSON，原始输出：${text.slice(0, 200)}`)
}

async function understandOllama(req: VisionRequest, model: string): Promise<AgentAction> {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserText(req), images: [req.imageBase64] }
  ]
  /**
   * 动态决定 num_ctx：按「本次请求的估算 token 数 × 1.5 余量」算，
   * 下限 VISION_MIN_NUM_CTX，对齐到 1024 的整数倍。
   *
   * 为什么不能固定 8192：用户把浏览器窗口拉到 2560x1440 时，图像部分就 5969 tokens，
   * 8192 仍不够；复合指令跑十几步后历史动作也会累积顶上去。
   *
   * 用 `req.dom.vw/vh`（视口像素）而不是去解 JPEG 尺寸 —— 截图就是视口大小，
   * 而 DOM 快照里已经带着这个尺寸，不必额外解析 base64。
   */
  const estimated = estimateVisionTokens({
    width: req.dom.vw,
    height: req.dom.vh,
    domCount: req.dom.els.length,
    historyCount: req.history.length,
    instructionLength: req.instruction.length
  })
  const numCtx = computeVisionNumCtx({ estimatedTokens: estimated })
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 不传 format:'json'：structured output 与 vision/images 在多个 Ollama/llama.cpp 构建里
        // 会冲突，产生不透明的内部错误（如 UnknownVizError）。已用 extractJson 容错解析，
        // 由 system prompt 强制「只输出 JSON」即可，避免触发该问题。
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          /**
           * 必须显式带上 num_ctx：Ollama 的 llama.cpp runner 默认只给 4096 tokens
           * 上下文窗口（**与模型自身支持的上下文长度无关**）。
           *
           * 实测本机 qwen2.5vl:7b：/api/show 里 context_length = 128000，
           * 但 /api/ps 里运行时 context_length = 4096。而视觉请求要带
           * 「截图 + DOM 列表 + system prompt」—— 1920x1080 截图的图像部分
           * 就占 2715 tokens，合计约 5290 tokens → 直接撞墙：
           *   request (5290 tokens) exceeds the available context size (4096 tokens)
           *
           * 请求级 `options.num_ctx` 实测可覆盖运行时默认值（无需改 Ollama 启动参数）。
           *
           * 注意：**不能靠缩小截图来省 token** —— DOM 坐标是视口像素，
           * system prompt 要求坐标与截图 1:1 对齐，缩放会导致点击坐标错位。
           * 所以走「加大窗口」而不是「压缩输入」。
           */
          options: { num_ctx: numCtx }
        })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        lastErr = `视觉模型调用失败 (${res.status})${text ? ': ' + text : ''}`
        // 上下文超限是**确定性**错误：同样的请求重试结果必然相同。
        // 换成有针对性的提示直接上抛，别让用户看到「连续失败 3 次」这种无信息量的重试。
        const overflow = parseContextOverflow(text)
        if (overflow) {
          throw new Error(
            describeContextOverflow({
              model,
              error: text,
              suggestedNumCtx: numCtx
            })
          )
        }
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
      // 上下文超限同样是**确定性**错误：同样的请求重试必然同样失败。
      // 不上抛的话会被重试两次再套上「① Ollama 未启动；② 未 pull 模型」的通用提示，
      // 反而把真正的原因（窗口不够）盖掉了。
      if (e instanceof Error && parseContextOverflow(e.message)) throw e
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(
    `${lastErr}\n（请确认：① Ollama 已启动；② 已执行 ollama pull ${model}；③ 该模型支持视觉/多模态，且「设置→AI Agent→视觉模型」名称正确）`
  )
}
