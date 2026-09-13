// 云端 BYOK 适配器（OpenAI 兼容 chat/completions）。
//
// 所有国内/主流厂商（DeepSeek / 通义千问 / 智谱 GLM / OpenAI）的对话接口都是
// OpenAI 兼容的 /v1/chat/completions，仅 base URL 与鉴权头不同——统一用 Bearer 即可。
// 这是「云端 BYOK 兜底」路径：用户自带 Key，会产生 token 费用，非默认；默认仍是本地 Ollama（零费）。
import type { AIAgentCloudProvider } from '@shared/types'
import type { OllamaMessage } from './ollama'

export interface CloudChatOptions {
  provider: AIAgentCloudProvider
  /** 用户自定义 base（代理 / 私有部署）；留空则用厂商默认地址 */
  baseUrl?: string
  apiKey: string
  model: string
  messages: OllamaMessage[]
  /** 限制输出长度（状态自检时用很小的数，避免白耗 token） */
  maxTokens?: number
  signal?: AbortSignal
}

// 各厂商 OpenAI 兼容 chat/completions 的默认 base（已含 /v1 或 /v4 段）
const DEFAULT_BASE: Record<AIAgentCloudProvider, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4'
}

/** 把 provider + 自定义 baseUrl 解析成完整的 chat/completions 端点，避免重复/缺段斜杠 */
function resolveEndpoint(provider: AIAgentCloudProvider, baseUrl?: string): string {
  let base = (baseUrl && baseUrl.trim()) || DEFAULT_BASE[provider]
  if (base.endsWith('/')) base = base.slice(0, -1)
  if (base.endsWith('/chat/completions')) return base
  return `${base}/chat/completions`
}

/** 发起一次云端对话，返回模型文本回复 */
export async function cloudChat(opts: CloudChatOptions): Promise<string> {
  // 去掉复制粘贴时常带的头尾空白 / 换行，否则 Bearer 里带 \n 或空格会被厂商判为「无效 Key」
  const apiKey = (opts.apiKey || '').trim()
  const model = (opts.model || '').trim()
  if (!apiKey) throw new Error('未配置云端 API Key（请在「设置 → AI Agent」填写）')
  if (!model) throw new Error('未配置云端模型名（请在「设置 → AI Agent」填写）')
  const url = resolveEndpoint(opts.provider, opts.baseUrl)
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false
  }
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`云端模型返回 ${res.status}${text ? `: ${text}` : ''}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string } | string
  }
  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error.message || 'unknown error'
    throw new Error(msg)
  }
  return data.choices?.[0]?.message?.content || ''
}

export interface CloudVisionOptions {
  provider: AIAgentCloudProvider
  /** 用户自定义 base（代理 / 私有部署）；留空则用厂商默认地址 */
  baseUrl?: string
  apiKey: string
  /** 多模态视觉模型名（需支持图像输入，如 gpt-4o / qwen-vl-max / glm-4v） */
  model: string
  systemPrompt: string
  userText: string
  /** 截图 JPEG base64（不含 data: 前缀），按视口分辨率、与坐标 1:1 对齐 */
  imageBase64: string
  signal?: AbortSignal
}

const IMG_DATA_PREFIX = 'data:image/jpeg;base64,'

/**
 * 发起一次云端多模态（视觉）对话：把「文本指令 + 截图」作为多模态消息发给 OpenAI 兼容的
 * /v1/chat/completions，返回模型文本（预期为动作 JSON，由调用方解析）。
 * 与 cloudChat 共用 resolveEndpoint / Bearer 鉴权 / 错误处理；仅消息体改为多模态 content 数组。
 */
export async function cloudVisionChat(opts: CloudVisionOptions): Promise<string> {
  const apiKey = (opts.apiKey || '').trim()
  const model = (opts.model || '').trim()
  if (!apiKey) throw new Error('未配置云端 API Key（请在「设置 → AI Agent」填写）')
  if (!model) {
    throw new Error('未配置云端视觉模型名：Agent 执行闭环需要多模态模型，请在「设置 → AI Agent」填写（如 gpt-4o / qwen-vl-max / glm-4v）')
  }
  const url = resolveEndpoint(opts.provider, opts.baseUrl)
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.userText },
          { type: 'image_url', image_url: { url: `${IMG_DATA_PREFIX}${opts.imageBase64}` } }
        ]
      }
    ],
    stream: false
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`云端视觉模型返回 ${res.status}${text ? `: ${text}` : ''}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string } | string
  }
  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error.message || 'unknown error'
    throw new Error(msg)
  }
  return data.choices?.[0]?.message?.content || ''
}

export interface CloudStatus {
  reachable: boolean
  baseUrl: string
  model?: string
  modelConfigured: boolean
  error?: string
}

/** 连通性自检：校验 Key/模型是否已填，再发起一次极小调用确认鉴权与服务可达 */
export async function checkCloudStatus(opts: {
  provider: AIAgentCloudProvider
  baseUrl?: string
  apiKey?: string
  model?: string
}): Promise<CloudStatus> {
  const baseUrl = resolveEndpoint(opts.provider, opts.baseUrl)
  const model = opts.model
  if (!opts.apiKey?.trim()) {
    return { reachable: false, baseUrl, model, modelConfigured: false, error: '未配置云端 API Key' }
  }
  if (!model?.trim()) {
    return { reachable: false, baseUrl, model, modelConfigured: false, error: '未配置云端模型名' }
  }
  try {
    const probe = await cloudChat({
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1
    })
    // 严格判定：不仅要求「未抛错」，还要求确有非空内容返回。
    // 部分网关 / 中继对无效 Key 仍返回 HTTP 200，但 choices 为空或 content 为空串，
    // 若不校验会被误判为「连通」。这里把空响应当作不可达，避免错误 Key 检测通过。
    if (!probe || !probe.trim()) {
      return { reachable: false, baseUrl, model, modelConfigured: true, error: '云端返回内容为空（可能是 API Key 无效或模型无响应），请检查 Key 与模型名' }
    }
    return { reachable: true, baseUrl, model, modelConfigured: true }
  } catch (e) {
    return {
      reachable: false,
      baseUrl,
      model,
      modelConfigured: true,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
