/**
 * Ollama 模型名的匹配规则 —— 纯函数（无 Electron 依赖，可离线单测）。
 *
 * ## 要解决什么
 *
 * 探活逻辑原先用「去掉 :tag 只比 base 名」来判断模型是否已安装：
 *
 * ```ts
 * const baseOf = (m: string) => m.split(':')[0]
 * models.some((m) => baseOf(m) === baseOf(model))
 * ```
 *
 * 这个比较太宽松，会把**根本没装**的模型误判成已装。本机装的是 `qwen2.5:3b`，
 * 配置写的是 `qwen2.5:7b` → base 名都是 `qwen2.5` → 判定「已安装」→
 * 设置页「检测连接」显示正常，但真正对话时 Ollama 按**完整名**找模型 →
 * `404 {"error":"model \"qwen2.5:7b\" not found"}`。
 *
 * 用户看到的观感是「检测连接明明成功，一用就报错」。
 *
 * ## Ollama 的真实语义
 *
 * 1. 模型名是 `base:tag`，`tag` 省略时等价于 `latest`。
 * 2. `qwen2.5` 与 `qwen2.5:latest` 是同一个模型。
 * 3. `qwen2.5:7b` 与 `qwen2.5:3b` 是**不同**模型 —— 同 base 不同 tag 不能互认。
 * 4. 已安装列表里出现的是带完整 tag 的名字（`qwen2.5:3b`、`nomic-embed-text:latest`）。
 *
 * 所以判定规则是：**归一化后按完整名精确匹配**，仅允许「省略 tag ≡ latest」这一种等价。
 */

/** 去掉前后的空白 */
function trim(v: string): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 归一化模型名：把省略 tag 的写法补成 `:latest`。
 *
 * - `qwen2.5`      → `qwen2.5:latest`
 * - `qwen2.5:7b`   → `qwen2.5:7b`（原样）
 * - `  qwen2.5:7b ` → `qwen2.5:7b`
 *
 * 注意：不能把 `:` 之后的内容当作 tag 一律丢掉 —— `qwen2.5:7b` 与 `qwen2.5:3b`
 * 是两个不同模型，正是这个 bug 的根源。
 *
 * ## 「省略 tag ≡ :latest」这条规则的精确边界（实测 Ollama 0.40.14）
 *
 * 省略 tag **不会**回退到任意 tag，只在 `:latest` 那个模型**确实装了**时才等价：
 * - 本机装了 `nomic-embed-text:latest` → 查 `nomic-embed-text` **能**命中（HTTP 200）
 * - 本机装了 `qwen2.5vl:7b`（无 `:latest`） → 查 `qwen2.5vl` **命中不了**（HTTP 404
 *   `model 'qwen2.5vl' not found`），真正对话同样 404
 *
 * 所以「省略 tag ≡ latest」是**归一化层面的等价**，而非「Ollama 会帮我找回任意 tag」。
 * 用户填 `qwen2.5vl` 而本机只有 `qwen2.5vl:7b` 时，判定为「未安装」是**正确**的
 * （Ollama 本身也调不通），此时应提示用户改填精确名 —— `findSameBaseModel` 正是干这个的。
 */
export function normalizeModelName(name: string): string {
  const s = trim(name)
  if (!s) return ''
  // 已经是 `base:tag` 的形态
  if (s.includes(':')) return s
  return `${s}:latest`
}

/**
 * 判断「配置里的模型名」是否命中「本机已安装的模型列表」。
 *
 * @param model    用户配置的模型名（可能是 `qwen2.5:7b` / `qwen2.5`）
 * @param installed 本机已安装的模型名列表（来自 Ollama `/api/tags`）
 *
 * 例：
 * - `isModelInstalled('qwen2.5:7b', ['qwen2.5:3b'])` → `false`（同 base 不同 tag，不是同一个模型）
 * - `isModelInstalled('qwen2.5', ['qwen2.5:latest'])` → `true`（省略 tag ≡ latest）
 * - `isModelInstalled('qwen2.5:3b', ['qwen2.5:3b'])` → `true`
 */
export function isModelInstalled(model: string, installed: readonly string[]): boolean {
  const target = normalizeModelName(model)
  if (!target) return false
  return installed.some((m) => normalizeModelName(m) === target)
}

/**
 * 在已安装列表里找与配置名**同 base** 的模型（用于给出「你是不是想用这个」的提示）。
 *
 * 与 `isModelInstalled` 的区别：这里**忽略 tag**，所以 `qwen2.5:7b` 能找到
 * 已装的 `qwen2.5:3b`。仅用于提示，不用于「是否已安装」的判定。
 */
export function findSameBaseModel(model: string, installed: readonly string[]): string | undefined {
  const s = trim(model)
  if (!s) return undefined
  const base = s.split(':')[0]
  return installed.find((m) => m.split(':')[0] === base)
}

/**
 * 在已安装列表里找出与配置名**等价**的那一个，并返回它的**精确名字**。
 *
 * ## 为什么需要这个
 *
 * Ollama 的 `POST /api/show` 只认**已安装的精确名**：查 `qwen2.5vl:7b` 返回 200，
 * 查 `qwen2.5vl:latest` 返回 404（尽管 `qwen2.5vl` 按「省略 tag ≡ latest」的规则
 * 在**归一化层面**与它等价）。
 *
 * 所以查能力前必须先拿已装列表反查精确名，否则用户填 `qwen2.5vl` 这种省略
 * tag 的写法就会查不到能力，退化成「能力未知」而非「明确不支持视觉」。
 *
 * @returns 命中的已装模型精确名；未命中返回 undefined
 */
export function resolveInstalledModelName(
  model: string,
  installed: readonly string[]
): string | undefined {
  const target = normalizeModelName(model)
  if (!target) return undefined
  return installed.find((m) => normalizeModelName(m) === target)
}

/**
 * Ollama 模型的能力标签（来自 `POST /api/show` 的 `capabilities` 字段）。
 *
 * 实测（本机 Ollama 0.40.14）：
 * - `qwen2.5vl:7b`          → `['completion', 'vision']`
 * - `qwen2.5-coder:7b`      → `['completion', 'tools', 'insert']`
 * - `qwen2.5:3b`            → `['completion', 'tools']`
 * - `nomic-embed-text:latest` → `['embedding']`
 *
 * 关键区别：**装了 ≠ 支持视觉**。只有带 `vision` 标签的模型才能接收
 * `images` 字段，否则 Ollama 直接返回 400：
 * `{"error":"Multimodal data provided, but model does not support multimodal requests."}`
 */
export type OllamaCapability = 'completion' | 'vision' | 'embedding' | 'tools' | 'insert'

/** 判断模型能力列表里是否含指定能力 */
export function hasCapability(
  capabilities: readonly string[] | undefined,
  capability: OllamaCapability
): boolean {
  if (!capabilities) return false
  return capabilities.includes(capability)
}
/**
 * 判定一个模型能否充当**视觉模型**（Agent 看屏用）。
 *
 * @param capabilities `POST /api/show` 返回的 capabilities；undefined 表示**查不到**
 *        （模型没装 / Ollama 版本太老没有该字段 / 网络异常）。
 *
 * ## 三态语义（重要）
 *
 * - `true`  —— 明确带 `vision` 标签，可以看屏。
 * - `false` —— **明确**不支持（查到了能力列表但没有 vision）。必须拦截并告知用户。
 * - `undefined` —— **能力未知**，无法判定。此时**不能**拦截：
 *        老版本 Ollama 的 `/api/show` 不返回 capabilities 字段，若一律判为 false，
 *        会把「本机明明装了视觉模型」的用户挡在门外（误伤比漏报更糟）。
 */
export function supportsVision(
  capabilities: readonly string[] | undefined
): boolean | undefined {
  // undefined → 能力未知（老版本 Ollama 无 capabilities 字段）→ 不拦截
  // 空数组 → 查到了但确实无任何能力 → false
  if (capabilities === undefined) return undefined
  return capabilities.includes('vision')
}

/**
 * 判定一个模型能否充当**文本模型**（对话用）。
 *
 * - `true`  —— 带 `completion` 能力，可以对话。
 * - `false` —— 明确不支持（如 `nomic-embed-text` 只有 `embedding`，
 *        实测调用 `/api/chat` 返回 `{"error":"\"nomic-embed-text:latest\" does not support chat"}`）。
 * - `undefined` —— 能力未知，不拦截。
 */
export function supportsChat(
  capabilities: readonly string[] | undefined
): boolean | undefined {
  if (capabilities === undefined) return undefined
  return capabilities.includes('completion')
}

/**
 * 描述一个模型的模态错配，给出可操作的提示。
 *
 * 场景：视觉模型位填了纯文本模型（如 `qwen2.5-coder:7b`）。
 * 这类模型**装了**，所以「是否已安装」这一关过得去；但它没有 `vision` 能力，
 * 真正让 Agent 看屏时 Ollama 会返回 400 `model does not support multimodal requests`。
 *
 * 探活阶段就拦下来，用户看到的是「这个模型不支持看屏」，而不是跑到一半才崩。
 */
export function describeModalityMismatch(opts: {
  /** 字段标签，如「视觉模型」 */
  label: string
  /** 用户填的模型名 */
  model: string
  /** 该模型的能力标签 */
  capabilities?: readonly string[]
  /** 本机装的其他模型里，支持该模态的有哪些（用于给出替代建议） */
  alternatives?: readonly string[]
}): string {
  const { label, model, capabilities, alternatives = [] } = opts
  // undefined = 查不到能力（老版本 Ollama / 网络异常）→ 说「未知」；
  // 空数组 = 查到了但确实没有任何能力 → 说「空」。两者含义不同，别混。
  const caps =
    capabilities === undefined
      ? '未知'
      : capabilities.length
        ? capabilities.join('、')
        : '空'
  const alt = alternatives.length
    ? `。本机支持该能力的模型有：${alternatives.join('、')}，请改用其中之一`
    : '。请改用支持该能力的模型'
  return `${label}「${model}」的能力为 ${caps}，不支持所需的模态${alt}`
}

/**
 * Ollama 的**默认上下文窗口**（`num_ctx` 未显式指定时生效）。
 *
 * ## 为什么需要这个
 *
 * Ollama 的 llama.cpp runner 默认只给 **4096** tokens 的上下文窗口 ——
 * **与模型本身支持的上下文长度无关**。实测本机 `qwen2.5vl:7b`：
 *
 * - `POST /api/show` 的 `model_info` 里 `qwen25vl.context_length = 128000`
 * - 但 `POST /api/ps` 显示运行时 `context_length = 4096`
 *
 * 后果：视觉模型每次请求要带「截图 + DOM 元素列表 + system prompt」，
 * 实测 1920x1080 截图的图像部分就占 **2715** tokens，加上 DOM 与 system prompt
 * 总计约 **5290** tokens → 直接撞上 4096 的墙：
 *
 * ```
 * {"error":"request (5290 tokens) exceeds the available context size (4096 tokens), try increasing it"}
 * ```
 *
 * 报错里那句 `try increasing it` 说的就是 `num_ctx`。本项目在请求里显式带上
 * `options.num_ctx` 即可覆盖运行时默认值（实测请求级覆盖生效，无需改 Ollama 启动参数）。
 */
export const OLLAMA_DEFAULT_NUM_CTX = 4096

/**
 * 视觉模型请求所需的上下文窗口下限。
 *
 * 构成（实测 1920x1080 视口）：
 * - 图像部分：约 2715 tokens（qwen2.5vl，patch 14 + 2x2 spatial merge）
 * - system prompt：约 554 tokens
 * - DOM 元素列表（最多 80 个）：约 1500-2000 tokens
 * - 用户指令 + 历史动作：数百 tokens
 *
 * 合计约 5000+ tokens，故 4096 必然不够。取 **8192** 留出余量：
 * 能容纳 1920x1080 全分辨率截图 + 满额 DOM；更大分辨率或更长指令仍可能不够，
 * 那时错误信息会明确告知需要更大的窗口。
 */
export const VISION_MIN_NUM_CTX = 8192

/**
 * 估算图像部分的 token 数（qwen2.5-vl 系的计算方式）。
 *
 * 图像 token ≈ (H / 28) × (W / 28) —— `patch_size=14` × `spatial_merge_size=2`。
 *
 * 实测校验（本机 qwen2.5vl:7b）：
 * - 1920x1080 → 理论 2691，实测 **2715**（含 chat template 的少量额外 token）
 * - 1280x720  → 理论 1196，实测 **1220**
 * - 1024x576  → 理论  777，实测 **1099**（含固定开销）
 *
 * 故公式会**低估**，只适合做量级估算与下限判断，不能当作精确值。
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0
  }
  const MERGED_PATCH = 28 // patch_size 14 × spatial_merge 2
  return Math.ceil(width / MERGED_PATCH) * Math.ceil(height / MERGED_PATCH)
}

/**
 * 解析 Ollama 的上下文超限错误，提取可操作信息。
 *
 * Ollama 的报错形如：
 * ```
 * request (5290 tokens) exceeds the available context size (4096 tokens), try increasing it
 * ```
 *
 * @returns `{ requestTokens, contextSize }`；不是超限错误时返回 null
 */
export function parseContextOverflow(
  error: string | undefined | null
): { requestTokens: number; contextSize: number } | null {
  if (!error) return null
  const m = error.match(
    /request\s*\((\d+)\s*tokens?\)\s*exceeds the available context size\s*\((\d+)\s*tokens?\)/i
  )
  if (!m) return null
  return { requestTokens: Number(m[1]), contextSize: Number(m[2]) }
}

/**
 * 为上下文超限生成可操作的提示。
 *
 * 关键是点明**真正的原因**：模型支持 128K 上下文，但 Ollama 运行时窗口只有 4096，
 * 这是 Ollama 的默认 `num_ctx`，不是模型本身的限制。用户若不知道这点，
 * 会误以为是「模型太小了」而去换模型 —— 换了也白换。
 */
export function describeContextOverflow(opts: {
  /** 出错时使用的模型名 */
  model: string
  /** 报错原文 */
  error: string
  /** 模型自身支持的上下文长度（来自 /api/show 的 model_info），查不到时为 undefined */
  modelMaxContext?: number
  /** 本次请求实际建议使用的窗口 */
  suggestedNumCtx?: number
}): string {
  const { model, error, modelMaxContext, suggestedNumCtx } = opts
  const parsed = parseContextOverflow(error)
  const parts: string[] = []

  if (parsed) {
    parts.push(
      `本次请求需要 ${parsed.requestTokens} tokens，超出当前上下文窗口 ${parsed.contextSize} tokens`
    )
  }
  if (modelMaxContext && modelMaxContext > 0) {
    parts.push(
      `模型「${model}」本身支持 ${modelMaxContext} tokens 上下文 —— 瓶颈是 Ollama 运行时的 num_ctx 默认值（4096），不是模型能力不足`
    )
  }
  if (suggestedNumCtx) {
    parts.push(`已自动将本次请求的 num_ctx 提升到 ${suggestedNumCtx}，若仍超限请缩小浏览器窗口或改用更大的视觉模型`)
  }
  return parts.join('；')
}

/**
 * 估算一次视觉请求需要的 token 数（用于动态决定 `num_ctx`）。
 *
 * 构成（实测 1920x1080 视口）：
 * - 图像部分：`estimateImageTokens` 的结果（实测 2715，与估算 2691 很接近）
 * - system prompt：约 554 tokens（英文，约 4 字符/token）
 * - DOM 元素列表：每个元素约 20 tokens（实测 80 个元素约 1500-2000）
 * - 用户指令 + 历史动作：约 200 tokens（历史每步约 30）
 */
export function estimateVisionTokens(opts: {
  /** 截图宽度（视口像素） */
  width: number
  /** 截图高度（视口像素） */
  height: number
  /** DOM 元素个数 */
  domCount: number
  /** 已执行的历史动作个数 */
  historyCount?: number
  /** 用户指令长度（字符） */
  instructionLength?: number
}): number {
  const { width, height, domCount, historyCount = 0, instructionLength = 0 } = opts
  const image = estimateImageTokens(width, height)
  const system = 554
  const dom = domCount * 20
  const history = historyCount * 30
  const instruction = Math.ceil(instructionLength / 4)
  return image + system + dom + history + instruction
}

/**
 * 根据实际请求规模算出该用的 `num_ctx`。
 *
 * ## 为什么要动态算
 *
 * 固定 8192 对 1080p 够用，但：
 * - 用户把浏览器窗口拉到 2560x1440 → 图像部分就 5969 tokens，8192 仍然不够
 * - 复合指令跑十几步后，历史动作累积也会顶上去
 *
 * 所以按「估算需求 × 余量」算，并**对齐到 1024 的整数倍**（llama.cpp 对
 * `num_ctx` 按块分配内存，非整数倍会浪费显存）。
 *
 * @param opts.estimatedTokens 估算的请求 token 数
 * @param opts.modelMaxContext 模型自身支持的上下文长度（查不到时为 undefined）
 * @param opts.minNumCtx 下限（`VISION_MIN_NUM_CTX`）
 * @returns 建议的 num_ctx
 */
export function computeVisionNumCtx(opts: {
  estimatedTokens: number
  modelMaxContext?: number
  minNumCtx?: number
}): number {
  const min = opts.minNumCtx ?? VISION_MIN_NUM_CTX
  // 余量 1.5 倍：token 估算本身有偏差（图像部分实测 2715 vs 估算 2691，
  // 且不同 Ollama / llama.cpp 版本的图像切分粒度略有差异）
  const need = Math.ceil((opts.estimatedTokens || 0) * 1.5)
  let ctx = Math.max(min, need)
  // 对齐到 1024 的整数倍
  ctx = Math.ceil(ctx / 1024) * 1024
  // 不超过模型自身能力（超了也没用，反而浪费显存）
  if (opts.modelMaxContext && opts.modelMaxContext > 0) {
    ctx = Math.min(ctx, opts.modelMaxContext)
  }
  return ctx
}
