// 本地 Ollama 适配器（零 token，纯 Node fetch，无额外依赖）
// 所有调用默认打 http://127.0.0.1:11434（Ollama 默认端口）。
// 这是 P0「本地 Ollama 默认」的核心：模型权重在用户机器上推理，不调任何按量计费云端 API。

import { isModelInstalled, resolveInstalledModelName } from '../../shared/ollamaModels'

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
 * 查询一个模型的**能力标签**（POST /api/show 的 `capabilities` 字段）。
 *
 * ## 为什么要查这个
 *
 * 「模型已安装」不等于「模型能干这活」。实测：
 * - `qwen2.5-coder:7b` 装了，但 capabilities 是 `['completion','tools','insert']`，
 *   **没有 vision** → 让它看屏，Ollama 直接 400：
 *   `{"error":"Multimodal data provided, but model does not support multimodal requests."}`
 * - `nomic-embed-text:latest` 装了，但只有 `['embedding']` → 当文本模型用，
 *   Ollama 报 `"nomic-embed-text:latest" does not support chat`。
 *
 * 这两类错误在「只查是否安装」的探活里**查不出来**，只能等真正跑 Agent 时才炸。
 *
 * ## 名字必须精确
 *
 * `POST /api/show` 只认已安装的精确名：查 `qwen2.5vl:7b` 返回 200，
 * 查 `qwen2.5vl:latest` 返回 404（尽管后者按「省略 tag ≡ latest」语义上等价）。
 * 所以调用方需先用已装列表反查精确名（`resolveInstalledModelName`）再传进来。
 *
 * @returns 能力标签数组；**查不到时返回 undefined**（模型没装 / 老版本 Ollama
 *          无此字段 / 网络异常）。undefined ≠ 不支持，调用方需按「未知」处理。
 */
export async function getModelCapabilities(
  model: string,
  baseUrl = DEFAULT_BASE
): Promise<string[] | undefined> {
  if (!model) return undefined
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/show`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      },
      5000
    )
    if (!res.ok) return undefined
    const data = (await res.json()) as { capabilities?: string[] }
    // 老版本 Ollama 不返回 capabilities 字段 —— 视为「查不到」，不是「不支持」
    return Array.isArray(data.capabilities) ? data.capabilities : undefined
  } catch {
    return undefined
  }
}

/**
 * 查一个已安装模型的能力标签（自动处理「省略 tag」的写法）。
 *
 * 流程：先用已装列表反查精确名 → 再查能力。
 * 查不到能力时返回 undefined（能力未知，交由上层决定是否拦截）。
 */
export async function getCapabilitiesOfInstalled(
  model: string,
  installed: readonly string[],
  baseUrl = DEFAULT_BASE
): Promise<string[] | undefined> {
  const exact = resolveInstalledModelName(model, installed)
  if (!exact) return undefined
  return getModelCapabilities(exact, baseUrl)
}

/**
 * 列出本机装了的、支持指定能力的模型（用于给用户「换个模型用」的替代建议）。
 *
 * 逐个查 `/api/show`，模型多时略慢 —— 但只在**用户已经配错了**时才会走到，
 * 不影响正常探活的耗时。
 *
 * @param capability 目标能力，如 'vision'
 */
export async function listModelsWithCapability(
  capability: string,
  installed: readonly string[],
  baseUrl = DEFAULT_BASE
): Promise<string[]> {
  const out: string[] = []
  for (const name of installed) {
    const caps = await getModelCapabilities(name, baseUrl)
    if (caps?.includes(capability)) out.push(name)
  }
  return out
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
    // 按**完整模型名**判定是否已安装（仅「省略 tag ≡ :latest」这一种等价）。
    // 原先只比 base 名，会把本机没装的 `qwen2.5:7b` 误判成已装（本机只有 `qwen2.5:3b`），
    // 于是「检测连接」显示正常，真正对话时 Ollama 按完整名找模型 → 404 model not found。
    const pulled = model ? isModelInstalled(model, models) : false
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
