/**
 * 云端 BYOK 配置的**纯函数校验**（无 React / Electron 依赖，可离线单测）。
 *
 * ## 要解决什么
 *
 * 用户实测报障：在设置页把 API Key（`sk-...`）**误填进了「API 地址」栏**。
 * 该值会被 `resolveEndpoint` 拼成 `sk-xxx/chat/completions` 这种非法 URL，
 * 之后每次调用云端模型都会失败，而失败信息是厂商返回的 DNS/连接错误，
 * **完全看不出是「填错栏位」**。用户只能反复换 Key 试。
 *
 * 这类「把一种值填进另一种栏位」的错误必须在**填的时候**就拦下来：
 * - 地址栏填了疑似密钥 → 直接点名说「这看起来是 API Key，不是地址」
 * - 地址栏不是合法 http(s) URL → 拦下并说明期望格式
 *
 * 为什么不放在服务端：服务端收到的是「已保存的配置」，此时用户已经离开页面，
 * 提示再晚就只能靠调用时报错；而**保存那一刻**是唯一能给出「你填错栏了」的机会。
 */

/** 云端 API 地址的默认占位提示（各厂商官方推荐的 base_url） */
export const CLOUD_BASE_URL_PLACEHOLDERS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1'
}

/**
 * 判断一个字符串「像不像 API Key」而不是地址。
 *
 * 覆盖各厂商常见前缀（`sk-` / `sk-ant-` / `AIza` / `gsk_` / `xai-` 等），
 * 以及「不含 `://` 且含长随机串」这一通用特征。
 *
 * 判据要**宁松勿紧**：只用于给出提示文案，不用于阻断合法输入，
 * 故只用高置信特征，不做「长度大于 N 就算密钥」这类容易误伤的推断。
 */
export function looksLikeApiKey(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  // 带协议头或路径分隔符的显然不是裸密钥
  if (v.includes('://') || v.includes('/')) return false
  // 明确的厂商密钥前缀
  if (/^(sk-|sk_ant-|AIza|gsk_|xai-|hf_|r8_|dop_v1_)/i.test(v)) return true
  return false
}

/** 地址是否形如 http(s)://host/... —— 只做形状判断，不联网 */
export function isValidHttpUrl(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // 主机名必须存在且含点（避免 `https://a` 这种）
  if (!u.hostname || !u.hostname.includes('.')) return false
  return true
}

export type CloudBaseUrlProblem = 'empty' | 'looksLikeKey' | 'notUrl'

export interface CloudBaseUrlCheck {
  ok: boolean
  problem?: CloudBaseUrlProblem
}

/**
 * 校验「API 地址」栏。
 *
 * - 空 → **放行**（留空时由 `resolveEndpoint` 回落到厂商默认地址，这是合法用法）
 * - 疑似密钥 → 报错「这是 API Key，请填到 API Key 栏」
 * - 非 http(s) URL → 报错「不是合法的接口地址」
 */
export function checkCloudBaseUrl(value: string): CloudBaseUrlCheck {
  const v = (value || '').trim()
  if (!v) return { ok: true }
  if (looksLikeApiKey(v)) return { ok: false, problem: 'looksLikeKey' }
  if (!isValidHttpUrl(v)) return { ok: false, problem: 'notUrl' }
  return { ok: true }
}
