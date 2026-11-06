// 云端 BYOK 适配器（OpenAI 兼容 chat/completions）。
//
// 所有国内/主流厂商（DeepSeek / 通义千问 / 智谱 GLM / OpenAI）的对话接口都是
// OpenAI 兼容的 /v1/chat/completions，仅 base URL 与鉴权头不同——统一用 Bearer 即可。
// 这是「云端 BYOK 兜底」路径：用户自带 Key，会产生 token 费用，非默认；默认仍是本地 Ollama（零费）。
import type { AIAgentCloudProvider } from '@shared/types'
import type { OllamaMessage } from './ollama'
import {
  classifyCloudError,
  classifyCloudNetworkError,
  formatCloudError,
  type CloudErrorInfo,
  type CloudErrorKind
} from '../../shared/cloudErrors'

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

/**
 * 1x1 透明 PNG（base64），用于**视觉模型探活**。
 *
 * 探活必须发一张**真实图片**才能验证「该模型支持图像输入」——
 * 只发纯文本的话，纯文本模型也会通过探活（本地 Ollama 有 `/api/show` 的
 * capabilities 可查，云端没有等价接口，只能靠实际发图来验证）。
 * 1x1 是最小合法图像，token 成本可忽略。
 */
const PROBE_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 探活图片的真实 MIME —— **必须与字节内容一致**，否则厂商会拒收 */
const PROBE_IMAGE_MIME = 'image/png'


/** 把 HTTP 层失败转成带分类信息的 Error */
function toCloudError(
  status: number | undefined,
  body: string,
  label: string,
  model: string
): Error {
  const info: CloudErrorInfo = classifyCloudError(status, body)
  const err = new Error(`${label}「${model}」调用失败：${formatCloudError(info)}`)
  ;(err as Error & { cloudError?: CloudErrorInfo }).cloudError = info
  return err
}

/** 把网络层异常（fetch 抛错）转成带分类信息的 Error */
function toCloudNetworkError(err: unknown, label: string, model: string): Error {
  const info = classifyCloudNetworkError(err)
  const e = new Error(`${label}「${model}」调用失败：${formatCloudError(info)}`)
  ;(e as Error & { cloudError?: CloudErrorInfo }).cloudError = info
  return e
}

/**
 * 厂商报文是否在说「这个模型不认 max_tokens，只认 max_completion_tokens」。
 *
 * 推理模型（OpenAI o-series / gpt-5 等）已经全面弃用 `max_tokens`，
 * 传了会直接 400：`Unsupported parameter: 'max_tokens' is not supported with
 * this model. Use 'max_completion_tokens' instead.`
 *
 * 这类错误是**确定性的参数名不兼容**，不是配置错误：用户的 Key 是好的、模型名也是对的，
 * 只是我们发了一个它不认识的字段。此时换字段名重试一次即可，不必让用户去改配置。
 */
function needsMaxCompletionTokens(body: string): boolean {
  const t = (body || '').toLowerCase()
  return (
    (t.includes('max_tokens') || t.includes('max tokens')) &&
    (t.includes('max_completion_tokens') || t.includes('max completion tokens'))
  )
}

/**
 * 发起一次云端对话，返回模型文本回复。
 *
 * 失败时抛出的 Error 带 `cloudError` 字段（分类信息），
 * 调用方可据此决定展示口径（如探活 vs 正式调用）。
 *
 * ## 为什么文本探活要能自动降级参数名
 *
 * 探活会带 `max_tokens: 16` 以省 token，但推理模型（OpenAI o-series / gpt-5 等）
 * 已经弃用该字段，传了直接 400。若不处理，用户会看到「Key 无效」式的报错，
 * 而实际上 Key 是好的、模型名也是对的 —— 只是我们发了一个它不认识的字段。
 * 故命中该特征时**自动改用 `max_completion_tokens` 重试一次**。
 */
export async function cloudChat(opts: CloudChatOptions): Promise<string> {
  // 去掉复制粘贴时常带的头尾空白 / 换行，否则 Bearer 里带 \n 或空格会被厂商判为「无效 Key」
  const apiKey = (opts.apiKey || '').trim()
  const model = (opts.model || '').trim()
  if (!apiKey) throw new Error('未配置云端 API Key（请在「设置 → AI Agent」填写）')
  if (!model) throw new Error('未配置云端模型名（请在「设置 → AI Agent」填写）')
  const url = resolveEndpoint(opts.provider, opts.baseUrl)
  const messages = opts.messages

  /**
   * 发一次请求。
   * @param maxTokensParam 长度参数名：'max_tokens'（通用）| 'max_completion_tokens'（推理模型）
   */
  const send = async (maxTokensParam: 'max_tokens' | 'max_completion_tokens'): Promise<string> => {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false
    }
    if (typeof opts.maxTokens === 'number') body[maxTokensParam] = opts.maxTokens
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: opts.signal
      })
    } catch (e) {
      throw toCloudNetworkError(e, '文本模型', model)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // 推理模型不认 max_tokens → 换参数名重试一次（这是参数名不兼容，不是配置错误）
      if (maxTokensParam === 'max_tokens' && needsMaxCompletionTokens(text)) {
        return send('max_completion_tokens')
      }
      throw toCloudError(res.status, text, '文本模型', model)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      error?: { message?: string } | string
    }
    if (data.error) {
      const msg = typeof data.error === 'string' ? data.error : data.error.message || 'unknown error'
      throw toCloudError(undefined, msg, '文本模型', model)
    }
    return data.choices?.[0]?.message?.content || ''
  }

  return send('max_tokens')
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
  /** 图片 base64（不含 data: 前缀），按视口分辨率、与坐标 1:1 对齐 */
  imageBase64: string
  /**
   * 图片 MIME。
   *
   * **必须与字节内容一致** —— 厂商（尤其 OpenAI 系）会按 data URL 声明的 MIME
   * 去解码，声明与实际不符时直接 400「Invalid image」/「unsupported format」。
   * 真实看屏传的是 Electron 截的 JPEG；探活传的是 1x1 PNG，两者不能混用同一个前缀。
   */
  imageMime?: string
  signal?: AbortSignal
}

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
  // MIME 必须与字节一致：真实看屏是 JPEG，探活是 PNG
  const mime = opts.imageMime || 'image/jpeg'
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.userText },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${opts.imageBase64}` } }
        ]
      }
    ],
    stream: false
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal
    })
  } catch (e) {
    throw toCloudNetworkError(e, '云端视觉模型', model)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw toCloudError(res.status, text, '云端视觉模型', model)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string } | string
  }
  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error.message || 'unknown error'
    throw toCloudError(undefined, msg, '云端视觉模型', model)
  }
  return data.choices?.[0]?.message?.content || ''
}

export interface CloudStatus {
  reachable: boolean
  baseUrl: string
  model?: string
  modelConfigured: boolean
  error?: string
  /** 该模型是否确认支持图像输入（仅视觉探活时有意义） */
  supportsVision?: boolean
  /** 错误分类（若有） */
  errorKind?: CloudErrorKind
}

/**
 * 连通性自检：校验 Key/模型是否已填，再发起一次极小调用确认鉴权与服务可达。
 *
 * ## 为什么视觉模型要单独发图
 *
 * 本地 Ollama 可以查 `/api/show` 的 `capabilities` 直接知道模型支不支持视觉，
 * **云端没有等价接口** —— 唯一的判定办法就是**发一张真实图片过去看厂商收不收**。
 *
 * 若视觉探活也发纯文本（历史实现就是这样），会出现「检测连接显示已连接、
 * 真正看屏时厂商返回 `does not support image input`」的错位 —— 用户最常见
 * 的踩坑是把文本模型名（deepseek-flash 之外的纯文本模型）复制到视觉模型栏。
 *
 * 用 1x1 PNG 探活，token 成本可忽略。
 */
export async function checkCloudStatus(opts: {
  provider: AIAgentCloudProvider
  baseUrl?: string
  apiKey?: string
  model?: string
  /** 该模型是否用于看屏（视觉探活）—— 为 true 时探活请求会带一张 1x1 图片 */
  vision?: boolean
}): Promise<CloudStatus> {
  const baseUrl = resolveEndpoint(opts.provider, opts.baseUrl)
  const model = opts.model
  const isVision = opts.vision === true
  if (!opts.apiKey?.trim()) {
    return { reachable: false, baseUrl, model, modelConfigured: false, error: '未配置云端 API Key' }
  }
  if (!model?.trim()) {
    return {
      reachable: false,
      baseUrl,
      model,
      modelConfigured: false,
      error: isVision
        ? '未配置云端视觉模型名（Agent 看屏需要多模态模型，如 gpt-4o / qwen-vl-max / glm-4v）'
        : '未配置云端模型名'
    }
  }
  try {
    let probe: string
    if (isVision) {
      // 视觉探活：带一张 1x1 图片，验证模型确实接受图像输入。
      // MIME 必须是 image/png —— 探活图就是 PNG 字节，标成 jpeg 会被厂商拒收。
      probe = await cloudVisionChat({
        provider: opts.provider,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model,
        systemPrompt: 'reply ok',
        userText: 'hi',
        imageBase64: PROBE_IMAGE,
        imageMime: PROBE_IMAGE_MIME
      })
    } else {
      probe = await cloudChat({
        provider: opts.provider,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16
      })
    }
    // 严格判定：不仅要求「未抛错」，还要求确有非空内容返回。
    // 部分网关 / 中继对无效 Key 仍返回 HTTP 200，但 choices 为空或 content 为空串，
    // 若不校验会被误判为「连通」。这里把空响应当作不可达，避免错误 Key 检测通过。
    if (!probe || !probe.trim()) {
      return {
        reachable: false,
        baseUrl,
        model,
        modelConfigured: true,
        supportsVision: isVision ? false : undefined,
        error: '云端返回内容为空（可能是 API Key 无效或模型无响应），请检查 Key 与模型名'
      }
    }
    return {
      reachable: true,
      baseUrl,
      model,
      modelConfigured: true,
      supportsVision: isVision ? true : undefined
    }
  } catch (e) {
    const info = (e as Error & { cloudError?: CloudErrorInfo }).cloudError
    return {
      reachable: false,
      baseUrl,
      model,
      modelConfigured: true,
      // 视觉探活失败且原因正是「不支持图像」→ 明确标记能力缺失
      supportsVision: isVision ? info?.kind !== 'no_vision' : undefined,
      errorKind: info?.kind,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
