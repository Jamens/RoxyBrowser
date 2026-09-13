// 本地 Ollama 适配器（零 token，纯 Node fetch，无额外依赖）
// 所有调用默认打 http://127.0.0.1:11434（Ollama 默认端口）。
// 这是 P0「本地 Ollama 默认」的核心：模型权重在用户机器上推理，不调任何按量计费云端 API。

export interface OllamaStatus {
  reachable: boolean
  baseUrl: string
  /** 用户配置的模型名（仅 local 时有意义） */
  model?: string
  /** 该模型是否已 `ollama pull` 到本机 */
  modelPulled: boolean
  /** 本机已安装的全部模型名 */
  models: string[]
  error?: string
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const DEFAULT_BASE = 'http://127.0.0.1:11434'

/** 带超时控制的 fetch（默认 5s，避免 Ollama 未启动时卡死 UI） */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 5000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 列出本机已拉取的模型名（GET /api/tags） */
export async function listOllamaModels(baseUrl = DEFAULT_BASE): Promise<string[]> {
  const res = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, 5000)
  if (!res.ok) throw new Error(`Ollama 返回 ${res.status}`)
  const data = (await res.json()) as { models?: Array<{ name: string }> }
  return (data.models || []).map((m) => m.name)
}

/**
 * 连通性探针：Ollama 是否可达 + 配置模型是否已拉取。
 * 用于设置页「检测连接」按钮，给出明确的可操作反馈。
 */
export async function checkOllamaStatus(opts: { baseUrl?: string; model?: string } = {}): Promise<OllamaStatus> {
  const baseUrl = opts.baseUrl || DEFAULT_BASE
  const model = opts.model
  try {
    const models = await listOllamaModels(baseUrl)
    // 配置名可能是 "qwen2.5:7b"，已安装名可能是 "qwen2.5:latest" 或省略 tag 的 "qwen2.5"：
    // 按 base 名（去掉 :tag）归一化比较，只要 base 一致即视为已拉取。
    const baseOf = (m: string) => m.split(':')[0]
    const pulled = model
      ? models.some((m) => baseOf(m) === baseOf(model))
      : false
    return { reachable: true, baseUrl, model, modelPulled: pulled, models }
  } catch (e) {
    return {
      reachable: false,
      baseUrl,
      model,
      modelPulled: false,
      models: [],
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * 文本对话（Chat / Support 模式复用）。messages 形同 OpenAI chat 格式。
 * stream:false 直接拿完整回复；长对话可后续改流式。
 */
export async function ollamaChat(opts: {
  baseUrl?: string
  model: string
  messages: OllamaMessage[]
  signal?: AbortSignal
}): Promise<string> {
  const baseUrl = opts.baseUrl || DEFAULT_BASE
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: false }),
    signal: opts.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama chat 返回 ${res.status}${text ? `: ${text}` : ''}`)
  }
  const data = (await res.json()) as { message?: { content?: string }; error?: string }
  if (data.error) throw new Error(data.error)
  return data.message?.content || ''
}
