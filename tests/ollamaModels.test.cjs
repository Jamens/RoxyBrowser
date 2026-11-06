// Ollama 模型名匹配规则（src/shared/ollamaModels.ts）的离线单测。
//
// ## 要锁住什么
//
// 1. **同 base 不同 tag 不是同一个模型**：`qwen2.5:7b` 与 `qwen2.5:3b` 是两个模型。
//    原先的探活只比 base 名（`m.split(':')[0]`），会把没装的模型误判成已装 ——
//    本机装的是 `qwen2.5:3b`，配置写的是 `qwen2.5:7b` → 探活显示「已就绪」，
//    真正对话时 Ollama 按**完整名**找模型 → `404 model not found`。
//    这是「检测连接成功，一用就报错」的根因。
// 2. **省略 tag ≡ :latest**：`qwen2.5` 与 `qwen2.5:latest` 是同一个模型，
//    这一种等价必须保留（用户写 `qwen2.5` 就该匹配上已装的 `qwen2.5:latest`）。
// 3. **同 base 查找只用于提示**：`findSameBaseModel` 忽略 tag 找候选，
//    用来在报错里提示「本机已安装同系列的 xxx」。
// 4. **模态能力判定**：装了 ≠ 支持视觉。视觉模型位误填纯文本模型时，
//    「已安装」这关过得去，但真正看屏时 Ollama 报 400
//    `model does not support multimodal requests` —— 必须在探活阶段拦下。
// 5. **三态语义**：能力判定区分「支持 / 明确不支持 / 能力未知」。
//    老版本 Ollama 的 `/api/show` 不返回 capabilities 字段，
//    此时必须判为「未知」而非「不支持」，否则会误伤本机明明装了视觉模型的用户。
//
// 用法：node tests/ollamaModels.test.cjs
// （编译产物由 scripts/run-tests.mjs 负责，见 COMPILES 里的 ollamaModels 条目）
const assert = require('assert')
const {
  normalizeModelName,
  isModelInstalled,
  findSameBaseModel,
  resolveInstalledModelName,
  supportsVision,
  supportsChat,
  hasCapability,
  describeModalityMismatch,
  estimateImageTokens,
  estimateVisionTokens,
  computeVisionNumCtx,
  parseContextOverflow,
  describeContextOverflow,
  OLLAMA_DEFAULT_NUM_CTX,
  VISION_MIN_NUM_CTX
} = require('../.tmp_om/shared/ollamaModels.js')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✅', name)
  } catch (e) {
    console.error('  ❌', name)
    console.error('     ', e.message)
    process.exitCode = 1
  }
}

// ===== 1. 归一化 =====
t('归一化：省略 tag 补成 :latest', () => {
  assert.strictEqual(normalizeModelName('qwen2.5'), 'qwen2.5:latest')
  assert.strictEqual(normalizeModelName('minicpm-v'), 'minicpm-v:latest')
})

t('归一化：省略 tag 只在 :latest 确实装了时才等价（实测 Ollama 0.40.14）', () => {
  // 本机装了 nomic-embed-text:latest → 查 nomic-embed-text 能命中（Ollama 返回 200）
  assert.strictEqual(isModelInstalled('nomic-embed-text', ['nomic-embed-text:latest']), true)
  // 本机只有 qwen2.5vl:7b（无 :latest）→ 查 qwen2.5vl 命中不了（Ollama 返回 404）
  // 判定「未安装」是正确的：Ollama 本身也调不通这个名字
  assert.strictEqual(isModelInstalled('qwen2.5vl', ['qwen2.5vl:7b']), false)
})

t('归一化：带 tag 原样保留（不同 tag 不能被抹平）', () => {
  assert.strictEqual(normalizeModelName('qwen2.5:7b'), 'qwen2.5:7b')
  assert.strictEqual(normalizeModelName('qwen2.5:3b'), 'qwen2.5:3b')
})

t('归一化：去掉首尾空白', () => {
  assert.strictEqual(normalizeModelName('  qwen2.5:7b  '), 'qwen2.5:7b')
})

t('归一化：空值返回空串', () => {
  assert.strictEqual(normalizeModelName(''), '')
  assert.strictEqual(normalizeModelName('   '), '')
})

// ===== 2. 是否已安装 =====
t('已安装：完整名精确命中', () => {
  assert.strictEqual(isModelInstalled('qwen2.5:3b', ['qwen2.5:3b']), true)
  assert.strictEqual(isModelInstalled('qwen2.5vl:7b', ['qwen2.5vl:7b']), true)
})

t('已安装：省略 tag ≡ :latest', () => {
  assert.strictEqual(isModelInstalled('qwen2.5', ['qwen2.5:latest']), true)
  assert.strictEqual(isModelInstalled('qwen2.5:latest', ['qwen2.5:latest']), true)
})

t('未安装：同 base 不同 tag 不能互认（核心回归）', () => {
  // 本机装的是 qwen2.5:3b，配置写的是 qwen2.5:7b → 必须判为「未安装」
  assert.strictEqual(isModelInstalled('qwen2.5:7b', ['qwen2.5:3b']), false)
  assert.strictEqual(isModelInstalled('qwen2.5:3b', ['qwen2.5:7b']), false)
})

t('未安装：完全不同的模型', () => {
  assert.strictEqual(isModelInstalled('qwen2.5:7b', ['llama3.2-vision:latest']), false)
  assert.strictEqual(isModelInstalled('qwen2.5:7b', []), false)
})

t('未安装：省略 tag 也不能匹配同 base 的其它 tag', () => {
  // `qwen2.5` 在 Ollama 里解析为 `qwen2.5:latest`，
  // 本机只有 `qwen2.5:3b` 时不该被误判为已安装
  assert.strictEqual(isModelInstalled('qwen2.5', ['qwen2.5:3b']), false)
})

t('未安装：配置为空', () => {
  assert.strictEqual(isModelInstalled('', ['qwen2.5:3b']), false)
})

t('已安装：在多个模型里能找到目标那个', () => {
  const installed = ['qwen2.5vl:7b', 'qwen2.5-coder:7b', 'nomic-embed-text:latest', 'qwen2.5:3b']
  assert.strictEqual(isModelInstalled('qwen2.5-coder:7b', installed), true)
  assert.strictEqual(isModelInstalled('nomic-embed-text:latest', installed), true)
  assert.strictEqual(isModelInstalled('qwen2.5:7b', installed), false)
})

// ===== 3. 同 base 候选（仅用于提示） =====
t('同 base 候选：忽略 tag 找到已装的那个', () => {
  const installed = ['qwen2.5vl:7b', 'qwen2.5:3b']
  assert.strictEqual(findSameBaseModel('qwen2.5:7b', installed), 'qwen2.5:3b')
  assert.strictEqual(findSameBaseModel('qwen2.5vl:7b', installed), 'qwen2.5vl:7b')
})

t('同 base 候选：没有同 base 时返回 undefined', () => {
  assert.strictEqual(findSameBaseModel('llama3:8b', ['qwen2.5:3b']), undefined)
  assert.strictEqual(findSameBaseModel('', ['qwen2.5:3b']), undefined)
})

t('同 base 候选：空列表返回 undefined', () => {
  assert.strictEqual(findSameBaseModel('qwen2.5:7b', []), undefined)
})

// ===== 4. 精确名反查（查 capabilities 的前置） =====
// POST /api/show 只认已安装的精确名：查 `qwen2.5vl:7b` 返回 200，
// 查 `qwen2.5vl:latest` 返回 404。所以查能力前必须先反查精确名，
// 否则用户填省略 tag 的写法（`qwen2.5vl`）会查不到能力，退化成「能力未知」。
t('精确名反查：命中时返回已装的那个精确名', () => {
  const installed = ['qwen2.5vl:7b', 'qwen2.5-coder:7b', 'nomic-embed-text:latest', 'qwen2.5:3b']
  assert.strictEqual(resolveInstalledModelName('qwen2.5vl:7b', installed), 'qwen2.5vl:7b')
  assert.strictEqual(resolveInstalledModelName('nomic-embed-text:latest', installed), 'nomic-embed-text:latest')
})

t('精确名反查：省略 tag 的写法能命中（归一化后比较）', () => {
  assert.strictEqual(resolveInstalledModelName('nomic-embed-text', ['nomic-embed-text:latest']), 'nomic-embed-text:latest')
  assert.strictEqual(resolveInstalledModelName('qwen2.5', ['qwen2.5:latest']), 'qwen2.5:latest')
})

t('精确名反查：不同 tag 不互认', () => {
  assert.strictEqual(resolveInstalledModelName('qwen2.5:7b', ['qwen2.5:3b']), undefined)
})

t('精确名反查：未命中 / 空输入返回 undefined', () => {
  assert.strictEqual(resolveInstalledModelName('llama3:8b', ['qwen2.5:3b']), undefined)
  assert.strictEqual(resolveInstalledModelName('', ['qwen2.5:3b']), undefined)
  assert.strictEqual(resolveInstalledModelName('qwen2.5:3b', []), undefined)
})

// ===== 5. 能力判定（三态） =====
t('supportsVision：带 vision 标签 → true', () => {
  assert.strictEqual(supportsVision(['completion', 'vision']), true)
})

t('supportsVision：只有 completion → false（明确不支持看屏）', () => {
  assert.strictEqual(supportsVision(['completion', 'tools', 'insert']), false)
  assert.strictEqual(supportsVision(['completion']), false)
})

t('supportsVision：能力未知 → undefined（不能判为不支持）', () => {
  // 老版本 Ollama 不返回 capabilities 字段 → 判 false 会误伤本机装了视觉模型的用户
  assert.strictEqual(supportsVision(undefined), undefined)
})

t('supportsVision：空能力列表 → false（查到了，但确实没有任何能力）', () => {
  // 空数组 ≠ 未知：说明 Ollama 明确返回了 capabilities 且其中没有任何能力
  assert.strictEqual(supportsVision([]), false)
})

t('supportsChat：带 completion → true', () => {
  assert.strictEqual(supportsChat(['completion', 'tools']), true)
  assert.strictEqual(supportsChat(['completion', 'vision']), true)
})

t('supportsChat：只有 embedding → false（不能当文本模型）', () => {
  assert.strictEqual(supportsChat(['embedding']), false)
})

t('supportsChat：能力未知 → undefined', () => {
  assert.strictEqual(supportsChat(undefined), undefined)
})

t('hasCapability：按标签匹配', () => {
  assert.strictEqual(hasCapability(['completion', 'vision'], 'vision'), true)
  assert.strictEqual(hasCapability(['completion'], 'vision'), false)
  assert.strictEqual(hasCapability(undefined, 'vision'), false)
})

// ===== 6. 模态错配提示 =====
t('模态错配提示：含模型名、能力列表与替代建议', () => {
  const msg = describeModalityMismatch({
    label: '视觉模型',
    model: 'qwen2.5-coder:7b',
    capabilities: ['completion', 'tools', 'insert'],
    alternatives: ['qwen2.5vl:7b']
  })
  assert.ok(msg.includes('视觉模型'))
  assert.ok(msg.includes('qwen2.5-coder:7b'))
  assert.ok(msg.includes('completion'))
  assert.ok(msg.includes('qwen2.5vl:7b'))
})

t('模态错配提示：无替代模型时也能给出可操作提示', () => {
  const msg = describeModalityMismatch({
    label: '视觉模型',
    model: 'qwen2.5-coder:7b',
    capabilities: ['completion']
  })
  assert.ok(msg.includes('qwen2.5-coder:7b'))
  assert.ok(msg.includes('请改用'))
})

t('模态错配提示：能力未知时显示「未知」而非空', () => {
  const msg = describeModalityMismatch({ label: '视觉模型', model: 'x:1b' })
  assert.ok(msg.includes('未知'))
})

// ===== 7. 上下文容量（num_ctx）=====
t('上下文：默认窗口是 4096（Ollama runner 默认，与模型能力无关）', () => {
  assert.strictEqual(OLLAMA_DEFAULT_NUM_CTX, 4096)
})

t('上下文：视觉请求的 num_ctx 下限为 8192（够装 1080p 截图 + 满额 DOM）', () => {
  assert.strictEqual(VISION_MIN_NUM_CTX, 8192)
  assert.ok(VISION_MIN_NUM_CTX > OLLAMA_DEFAULT_NUM_CTX)
})

t('图像 token 估算：1920x1080 约 2691（实测 2715，公式略低估）', () => {
  const t = estimateImageTokens(1920, 1080)
  // ceil(1920/28)=69, ceil(1080/28)=39 → 69*39=2691
  assert.strictEqual(t, 69 * 39)
  assert.ok(t > 2000, `实际 ${t}`)
})

t('图像 token 估算：分辨率减半，token 显著下降', () => {
  const full = estimateImageTokens(1920, 1080)
  const half = estimateImageTokens(1280, 720)
  assert.ok(half < full * 0.6, `1920→${half}, 1080→${full}`)
})

t('图像 token 估算：非法输入返回 0', () => {
  assert.strictEqual(estimateImageTokens(0, 0), 0)
  assert.strictEqual(estimateImageTokens(-1, 100), 0)
  assert.strictEqual(estimateImageTokens(NaN, 100), 0)
})

t('上下文超限解析：识别 Ollama 的原始报错', () => {
  const raw =
    'request (5290 tokens) exceeds the available context size (4096 tokens), try increasing it'
  const r = parseContextOverflow(raw)
  assert.ok(r)
  assert.strictEqual(r.requestTokens, 5290)
  assert.strictEqual(r.contextSize, 4096)
})

t('上下文超限解析：非超限错误返回 null', () => {
  assert.strictEqual(parseContextOverflow('model not found'), null)
  assert.strictEqual(parseContextOverflow('Multimodal data provided, but model does not support'), null)
  assert.strictEqual(parseContextOverflow(undefined), null)
  assert.strictEqual(parseContextOverflow(''), null)
})

t('上下文超限提示：点明「瓶颈是 num_ctx 不是模型能力不足」', () => {
  const raw =
    'request (5290 tokens) exceeds the available context size (4096 tokens), try increasing it'
  const msg = describeContextOverflow({
    model: 'qwen2.5vl:7b',
    error: raw,
    modelMaxContext: 128000,
    suggestedNumCtx: 8192
  })
  assert.ok(msg.includes('5290'))
  assert.ok(msg.includes('4096'))
  assert.ok(msg.includes('128000'))
  assert.ok(msg.includes('num_ctx'))
  assert.ok(msg.includes('8192'))
})

t('上下文超限提示：模型能力未知时不编造数字', () => {
  const raw = 'request (5290 tokens) exceeds the available context size (4096 tokens)'
  const msg = describeContextOverflow({ model: 'x:1b', error: raw })
  assert.ok(msg.includes('5290'))
  assert.ok(!msg.includes('undefined'))
})

// ===== 8. 动态 num_ctx =====
t('视觉 token 估算：1920x1080 + 80 个 DOM 元素 ≈ 4900+', () => {
  const t = estimateVisionTokens({
    width: 1920,
    height: 1080,
    domCount: 80,
    historyCount: 0,
    instructionLength: 40
  })
  // 图像 2691 + system 554 + DOM 1600 + 指令 10 = 4855
  assert.ok(t > 4500, `实际 ${t}`)
  assert.ok(t < 6000, `实际 ${t}`)
})

t('视觉 token 估算：历史动作与指令都会推高需求', () => {
  const base = estimateVisionTokens({ width: 1920, height: 1080, domCount: 80 })
  const more = estimateVisionTokens({
    width: 1920,
    height: 1080,
    domCount: 80,
    historyCount: 10,
    instructionLength: 400
  })
  assert.ok(more > base, `${more} > ${base}`)
})

t('动态 num_ctx：1920x1080 场景给出 ≥ 8192', () => {
  const est = estimateVisionTokens({ width: 1920, height: 1080, domCount: 80 })
  const ctx = computeVisionNumCtx({ estimatedTokens: est })
  assert.ok(ctx >= 8192, `实际 ${ctx}`)
})

t('动态 num_ctx：小窗口也至少是下限值', () => {
  const est = estimateVisionTokens({ width: 640, height: 480, domCount: 5 })
  const ctx = computeVisionNumCtx({ estimatedTokens: est })
  assert.strictEqual(ctx, VISION_MIN_NUM_CTX)
})

t('动态 num_ctx：大窗口自动放大（2560x1440）', () => {
  const est = estimateVisionTokens({ width: 2560, height: 1440, domCount: 80 })
  const ctx = computeVisionNumCtx({ estimatedTokens: est })
  assert.ok(ctx > VISION_MIN_NUM_CTX, `实际 ${ctx}`)
  // 2560x1440 的图像部分约 5969 tokens，×1.5 后应明显超过 8192
  assert.ok(ctx >= 10240, `实际 ${ctx}`)
})

t('动态 num_ctx：对齐到 1024 的整数倍', () => {
  for (const est of [3000, 5000, 6000, 12000]) {
    const ctx = computeVisionNumCtx({ estimatedTokens: est })
    assert.strictEqual(ctx % 1024, 0, `${est} → ${ctx}`)
  }
})

t('动态 num_ctx：不超过模型自身能力上限', () => {
  const est = estimateVisionTokens({ width: 4000, height: 3000, domCount: 80 })
  const ctx = computeVisionNumCtx({ estimatedTokens: est, modelMaxContext: 8192 })
  assert.strictEqual(ctx, 8192)
})

console.log(`\n  ollamaModels: ${passed} 项通过`)
