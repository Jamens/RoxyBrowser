// 云端 BYOK 的错误分类与可操作提示（纯函数，可离线单测）。
//
// ## 为什么需要这一层
//
// 云端厂商的报错形态差异极大，同一个「配置错了」在不同厂商长得很不一样：
//
// - DeepSeek  Key 错 → 401 `{"error":{"message":"Invalid API key provided"}}`
// - 智谱 GLM   Key 错 → 401 `{"error":{"code":"401","message":"..."}}`
// - OpenAI     Key 错 → 401 `{"error":{"message":"Incorrect API key provided"}}`
// - 余额不足   → 402 `{"error":{"message":"insufficient balance"}}`
// - 模型名错   → 404 `model_not_found` / `The model `xxx` does not exist`
// - 纯文本模型收图 → 400 `does not support image input`
// - 推理模型不认 max_tokens → 400 `Unsupported parameter: 'max_tokens'`
//
// 若直接把厂商原始 JSON 抛给用户，用户看到的是一坨英文 JSON，既不知道
// 「是我 Key 填错了」还是「余额没了」，也不知道下一步该改哪一栏。
//
// ## 设计原则
//
// 1. **保留原文**：分类只用于**前置**，最终错误里仍附上厂商原文，便于提工单。
// 2. **给出下一步**：每类错误都要指向一个具体动作（改哪一栏 / 执行什么命令）。
// 3. **不编造**：只按报文里**确实出现**的特征分类；识别不出就归 unknown，
//    原样透出厂商信息，绝不猜测原因。

/** 云端错误的分类 */
export type CloudErrorKind =
  /** API Key 无效 / 未授权 / 签名错误 */
  | 'auth'
  /** 余额不足 / 额度耗尽 / 欠费 */
  | 'balance'
  /** 限流 / 触发配额 */
  | 'rate_limit'
  /** 模型名不存在 / 无权访问该模型 */
  | 'model_not_found'
  /** 模型存在但不支持图像输入（填错模态） */
  | 'no_vision'
  /** 请求参数不被支持（如 max_tokens） */
  | 'bad_param'
  /** 上下文超出模型窗口 */
  | 'context_length'
  /** 网络不可达 / DNS 失败 / 超时 */
  | 'network'
  /** 其它（保留厂商原文） */
  | 'unknown'

export interface CloudErrorInfo {
  kind: CloudErrorKind
  /** 一句话说明「出了什么问题」 */
  summary: string
  /** 下一步该做什么（指向具体操作） */
  action: string
  /** 厂商原始报文（截断后），便于排查 */
  raw?: string
  /** HTTP 状态码（若已知） */
  status?: number
}

/**
 * 厂商报文里常见的「不支持图像输入」表述（中英文都覆盖）
 *
 * 注意：**不能只靠 'multimodal' 一个词判定** —— 厂商还会在别的语境里提到它
 * （如「该账号未开通 multimodal 权限」「multimodal model not enabled」），
 * 那种情况是**权限问题**而不是「模型是纯文本模型」，归错类会把用户引向错误方向
 * （让他去换模型名，而实际该做的是去开通权限）。故只收录**明确否定图像能力**的表述。
 */
const NO_VISION_PATTERNS = [
  'does not support image',
  'does not support multimodal',
  'does not support vision',
  'not support image input',
  'image input is not supported',
  'unsupported image',
  'multimodal not supported',
  'invalid image_url',
  'only supports text',
  'text-only model',
  '不支持图像',
  '不支持图片',
  '不支持多模态'
]

/** 「余额 / 额度」类表述 */
const BALANCE_PATTERNS = [
  'insufficient balance',
  'insufficient_quota',
  'insufficient quota',
  'exceeded your current quota',
  'quota exceeded',
  'billing_hard_limit_reached',
  'arrearage',
  '余额不足',
  '额度不足'
]

/** 「Key 无效」类表述 */
const AUTH_PATTERNS = [
  'invalid api key',
  'incorrect api key',
  'invalid_api_key',
  'invalid authentication',
  'unauthorized',
  'authentication_error',
  'permission denied',
  'access denied',
  'no api key',
  'missing api key',
  'api key not valid'
]

/** 「模型不存在」类表述 */
const MODEL_NOT_FOUND_PATTERNS = [
  'model_not_found',
  'model not found',
  'does not exist',
  'model not exist',
  'no such model',
  'the model does not exist',
  'model_not_exist',
  '模型不存在'
]

/**
 * 「限流」类表述
 *
 * 注意：**不能只靠裸 '429' 判定** —— 厂商常把业务码塞进报文（如
 * `{"code":"429","message":"..."}` 表示余额/配额），裸匹配会把「余额不足」
 * 误报成「限流」，把用户引向「等一会儿再试」的错误方向。限流由 HTTP 状态码兜底，
 * 这里只匹配**明确的限流措辞**。
 */
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'qps limit',
  '并发超限',
  '限流',
  '请求过于频繁'
]

/** 「参数不被支持」类表述 */
const BAD_PARAM_PATTERNS = [
  'unsupported parameter',
  'unsupported_parameter',
  'unrecognized request argument',
  'invalid parameter',
  'unknown parameter',
  'not supported with this model'
]

/** 「上下文超限」类表述 */
const CONTEXT_PATTERNS = [
  'context length',
  'context_length',
  'maximum context',
  'exceeds the context',
  'context window',
  'too many tokens',
  'reduce the length',
  '上下文'
]

/** 网络类表述（fetch 抛出的 TypeError 文本） */
const NETWORK_PATTERNS = [
  'fetch failed',
  'econnrefused',
  'enotfound',
  'econnreset',
  'etimedout',
  'socket hang up',
  'network',
  'getaddrinfo'
]

function hit(text: string, patterns: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return patterns.some((p) => lower.includes(p))
}

/**
 * 从 HTTP 状态码 + 厂商报文里分类出错误类型。
 *
 * @param status HTTP 状态码（网络层失败时传 undefined）
 * @param body   厂商响应体原文（可为空）
 */
export function classifyCloudError(status: number | undefined, body: string): CloudErrorInfo {
  const raw = (body || '').trim()
  const text = raw.toLowerCase()

  // 厂商常把原因放在 error.message 里，也可能是裸字符串
  let detail = raw
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; code?: string | number; type?: string } | string
      message?: string
      code?: string | number
    }
    const e = parsed.error
    if (typeof e === 'string') detail = e
    else if (e && typeof e === 'object') {
      detail = [e.message, e.code, e.type].filter(Boolean).map(String).join(' ')
    } else if (parsed.message) {
      detail = String(parsed.message)
    }
  } catch {
    /* 非 JSON（网关 HTML 报错等），保持原文 */
  }

  const combined = `${text} ${detail.toLowerCase()}`

  const mk = (kind: CloudErrorKind, summary: string, action: string): CloudErrorInfo => ({
    kind,
    summary,
    action,
    raw: raw ? raw.slice(0, 600) : undefined,
    status
  })

  // 顺序有讲究：先判语义特征，再看状态码兜底。
  // 因为厂商常「用 400 报鉴权问题」（如 GLM 的 code:401 也可能裹在 400 里）。

  if (hit(combined, AUTH_PATTERNS) || status === 401 || status === 403) {
    return mk(
      'auth',
      'API Key 无效或无权访问该模型',
      '请检查「设置 → AI Agent → API Key」是否填错、是否已过期或被撤销；Key 前后若有空格/换行会被自动去除，若仍失败请到对应厂商控制台确认该 Key 的权限范围'
    )
  }

  if (hit(combined, BALANCE_PATTERNS) || status === 402) {
    return mk(
      'balance',
      '账户余额或额度不足',
      '请到对应厂商控制台充值或提升额度后重试；若已充值请确认生效的账号与当前 API Key 属于同一主体'
    )
  }

  if (hit(combined, NO_VISION_PATTERNS)) {
    return mk(
      'no_vision',
      '该模型不支持图像输入（它是纯文本模型）',
      '请把「设置 → AI Agent → 视觉模型（云端）」改为支持图像输入的多模态模型（如 gpt-4o / qwen-vl-max / glm-4v），具体可用模型名请到厂商官网确认'
    )
  }

  if (hit(combined, MODEL_NOT_FOUND_PATTERNS) || status === 404) {
    return mk(
      'model_not_found',
      '模型名不存在或该账号无权访问',
      '请核对「设置 → AI Agent → 模型名」拼写是否与厂商控制台完全一致（含版本后缀）；不同厂商的模型名差异很大，请勿照抄示例'
    )
  }

  if (hit(combined, BAD_PARAM_PATTERNS)) {
    return mk(
      'bad_param',
      '请求参数不被该模型支持',
      '请更换为该厂商的常规对话模型；若使用的是推理/思考类模型，请确认其支持的参数形式'
    )
  }

  if (hit(combined, CONTEXT_PATTERNS)) {
    return mk(
      'context_length',
      '请求内容超出模型上下文窗口',
      '请缩短历史消息长度或减少单次输入的内容量后重试'
    )
  }

  if (hit(combined, RATE_LIMIT_PATTERNS) || status === 429) {
    return mk(
      'rate_limit',
      '触发厂商限流或并发配额',
      '请稍后重试；若持续出现请到厂商控制台提升 QPS / 并发配额'
    )
  }

  if (status === 404) {
    return mk(
      'model_not_found',
      '接口地址或模型名不存在',
      '请检查「设置 → AI Agent → API 地址」是否填对（应包含 /v1 等版本段，且不要带 /chat/completions）'
    )
  }

  if (status !== undefined && status >= 500) {
    return mk(
      'unknown',
      `厂商服务异常（HTTP ${status}）`,
      '这通常是厂商侧临时故障，请稍后重试；若持续出现请查看厂商服务状态页'
    )
  }

  if (status !== undefined && status >= 400) {
    return mk(
      'unknown',
      `厂商拒绝了该请求（HTTP ${status}）`,
      '请查看下方厂商原始信息定位具体参数问题'
    )
  }

  return mk(
    'unknown',
    '调用云端模型失败',
    '请查看下方厂商原始信息'
  )
}

/**
 * 网络层失败（fetch 抛异常）的分类。
 *
 * 与 HTTP 层分开：fetch 连 TCP 都没建立，压根没有厂商报文可读。
 */
export function classifyCloudNetworkError(err: unknown): CloudErrorInfo {
  const msg = err instanceof Error ? err.message : String(err)
  const isNetwork = hit(msg.toLowerCase(), NETWORK_PATTERNS)
  return {
    kind: isNetwork ? 'network' : 'unknown',
    summary: isNetwork ? '无法连接到厂商接口' : '调用云端模型失败',
    action: isNetwork
      ? '请确认「设置 → AI Agent → API 地址」填写正确、网络可达；若走了代理请检查系统代理设置'
      : '请查看下方原始信息',
    raw: msg.slice(0, 600)
  }
}

/**
 * 把分类结果拼成最终给用户看的错误文案。
 *
 * 格式：`问题 —— 下一步怎么做` + （有原文时）`厂商返回：<原文>`
 */
export function formatCloudError(info: CloudErrorInfo): string {
  const head = `${info.summary} —— ${info.action}`
  return info.raw ? `${head}\n厂商返回：${info.raw}` : head
}
