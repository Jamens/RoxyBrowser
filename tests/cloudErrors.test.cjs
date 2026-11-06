// 云端 BYOK 错误分类（src/shared/cloudErrors.ts）的离线单测。
//
// ## 要锁住什么
//
// 云端厂商的报错形态差异极大，同一个「配置错了」在不同厂商长得很不一样。
// 若直接把厂商原始 JSON 抛给用户，用户看到的是一坨英文 JSON，既不知道
// 「是我 Key 填错了」还是「余额没了」，也不知道下一步该改哪一栏。
//
// 本单测锁住的核心不变量：
//
// 1. **分类必须准确**：401 → auth、402 → balance、404 → model_not_found、
//    429 → rate_limit、「不支持图像」→ no_vision。
// 2. **不能被报文里的数字误导**：
//    - 裸 `'429'` 不能判成限流 —— 厂商常把业务码塞进报文
//      （`{"code":"429"}` 表示余额/配额），误判会把用户引向「等一会再试」。
//    - 裸 `'multimodal'` 不能判成「模型是纯文本模型」—— 厂商在
//      「该账号未开通 multimodal 权限」这类**权限**语境里也会提到它，
//      误判会让用户去换模型名，而实际该做的是去开通权限。
// 3. **原始信息必须保留**：分类只用于「前置」，最终文案仍要附上厂商原文，
//    否则用户无法提工单、我们也无法排查。
// 4. **每类错误都要给出下一步**：只说「失败」等于没说。
const assert = require('assert')
const {
  classifyCloudError,
  classifyCloudNetworkError,
  formatCloudError
} = require('../.tmp_ce/shared/cloudErrors')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    console.error(`  ❌ ${name}`)
    console.error(`     ${e.message}`)
    process.exitCode = 1
  }
}

console.log('\n──── 云端错误分类 ────')

// ===== 1. 状态码兜底 =====
t('401 → auth', () => {
  const r = classifyCloudError(401, '{"error":{"message":"Invalid API key provided"}}')
  assert.strictEqual(r.kind, 'auth')
  assert.ok(r.action.includes('API Key'))
})

t('402 → balance', () => {
  const r = classifyCloudError(402, '{"error":{"message":"insufficient balance"}}')
  assert.strictEqual(r.kind, 'balance')
  assert.ok(r.action.includes('充值'))
})

t('404 → model_not_found', () => {
  const r = classifyCloudError(404, '{"error":{"message":"model not found"}}')
  assert.strictEqual(r.kind, 'model_not_found')
  assert.ok(r.action.includes('模型名'))
})

t('429 → rate_limit', () => {
  const r = classifyCloudError(429, '{"error":{"message":"Too many requests"}}')
  assert.strictEqual(r.kind, 'rate_limit')
})

t('500 → unknown（厂商侧故障，不该让用户改配置）', () => {
  const r = classifyCloudError(500, 'internal server error')
  assert.strictEqual(r.kind, 'unknown')
  assert.ok(r.summary.includes('500'))
})

t('400 且无特征 → unknown', () => {
  const r = classifyCloudError(400, '{"error":{"message":"something odd"}}')
  assert.strictEqual(r.kind, 'unknown')
})

// ===== 2. 语义特征优先于状态码 =====
t('厂商用 400 报鉴权问题也归 auth（GLM 风格）', () => {
  const r = classifyCloudError(400, '{"error":{"code":"401","message":"invalid api key"}}')
  assert.strictEqual(r.kind, 'auth')
})

t('厂商用 400 报「不支持图像」也归 no_vision', () => {
  const r = classifyCloudError(400, '{"error":{"message":"does not support image input"}}')
  assert.strictEqual(r.kind, 'no_vision')
})

t('裸字符串 error 体也能解析', () => {
  const r = classifyCloudError(400, '"model_not_found"')
  assert.strictEqual(r.kind, 'model_not_found')
})

t('裸 message 字段也能解析', () => {
  const r = classifyCloudError(400, '{"message":"insufficient quota"}')
  assert.strictEqual(r.kind, 'balance')
})

// ===== 3. 防误判（本次修复的重点） =====
t('报文里的 "429" 业务码不判成限流（余额问题）', () => {
  // 厂商把业务码塞进报文：{"code":"429","message":"insufficient balance"}
  // 若按裸 '429' 判限流，用户会被引向「等一会儿再试」，而实际该充值。
  const r = classifyCloudError(400, '{"code":"429","message":"insufficient balance"}')
  assert.strictEqual(r.kind, 'balance', `实际分类：${r.kind}`)
})

t('报文里的 "multimodal" 不判成 no_vision（权限问题）', () => {
  // 「该账号未开通 multimodal 权限」是权限问题，不是「模型是纯文本模型」。
  // 误判会让用户去换模型名，而实际该做的是去开通权限。
  const r = classifyCloudError(403, '{"error":{"message":"multimodal not enabled for this account"}}')
  assert.notStrictEqual(r.kind, 'no_vision', `实际分类：${r.kind}`)
})

t('明确的「不支持图像」措辞仍归 no_vision', () => {
  const cases = [
    'The model `deepseek-chat` does not support image input.',
    'This model does not support multimodal requests',
    'image input is not supported',
    'Invalid image_url: unsupported format',
    '该模型不支持图像输入'
  ]
  for (const msg of cases) {
    const r = classifyCloudError(400, JSON.stringify({ error: { message: msg } }))
    assert.strictEqual(r.kind, 'no_vision', `「${msg}」被判成 ${r.kind}`)
  }
})

t('参数不被支持 → bad_param', () => {
  const r = classifyCloudError(400, "Unsupported parameter: 'max_tokens' is not supported with this model.")
  assert.strictEqual(r.kind, 'bad_param')
})

t('上下文超限 → context_length', () => {
  const r = classifyCloudError(400, '{"error":{"message":"maximum context length is 8192 tokens"}}')
  assert.strictEqual(r.kind, 'context_length')
})

// ===== 4. 原始信息必须保留 =====
t('保留厂商原文（截断到 600 字）', () => {
  const raw = JSON.stringify({ error: { message: 'Invalid API key provided: sk-ab***cd' } })
  const r = classifyCloudError(401, raw)
  assert.ok(r.raw.includes('Invalid API key provided'), `raw=${r.raw}`)
  assert.ok(r.raw.length <= 600)
})

t('原文很长时被截断而非无限增长', () => {
  const raw = 'x'.repeat(5000)
  const r = classifyCloudError(400, raw)
  assert.strictEqual(r.raw.length, 600)
})

t('空响应体不炸（raw 为 undefined）', () => {
  const r = classifyCloudError(400, '')
  assert.strictEqual(r.kind, 'unknown')
  assert.strictEqual(r.raw, undefined)
})

t('非 JSON 响应体（网关 HTML）原样保留', () => {
  const r = classifyCloudError(502, '<html>502 Bad Gateway</html>')
  assert.strictEqual(r.kind, 'unknown')
  assert.ok(r.raw.includes('502 Bad Gateway'))
})

// ===== 5. 格式化成用户可读的文案 =====
t('文案含「问题 + 下一步」两部分', () => {
  const r = classifyCloudError(401, '{"error":{"message":"Invalid API key provided"}}')
  const text = formatCloudError(r)
  assert.ok(text.includes(r.summary), text)
  assert.ok(text.includes(r.action), text)
})

t('有原文时附上「厂商返回：」', () => {
  const r = classifyCloudError(401, '{"error":{"message":"Invalid API key provided"}}')
  assert.ok(formatCloudError(r).includes('厂商返回：'))
})

t('无原文时不出现空白的「厂商返回：」', () => {
  const r = classifyCloudError(400, '')
  assert.ok(!formatCloudError(r).includes('厂商返回：'))
})

// ===== 6. 网络层错误 =====
t('fetch failed → network', () => {
  const r = classifyCloudNetworkError(new TypeError('fetch failed'))
  assert.strictEqual(r.kind, 'network')
  assert.ok(r.action.includes('API 地址'))
})

t('DNS 失败 → network', () => {
  const r = classifyCloudNetworkError(new Error('getaddrinfo ENOTFOUND api.deepseek.com'))
  assert.strictEqual(r.kind, 'network')
})

t('网络错误保留原文', () => {
  const r = classifyCloudNetworkError(new TypeError('fetch failed'))
  assert.ok(r.raw.includes('fetch failed'))
})

console.log(`\n云端错误分类：${passed} 项通过`)
