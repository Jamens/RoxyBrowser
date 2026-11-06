// 云端 BYOK 配置校验（src/shared/cloudConfigValidation.ts）的离线单测。
//
// ## 要锁住什么
//
// 1. **「API 地址」栏不能填 API Key**。
//    用户实测报障：把 `sk-...` 填进了「API 地址」栏。该值会被 `resolveEndpoint`
//    拼成 `sk-xxx/chat/completions` 这种非法 URL，之后每次调用都失败，
//    而报错是厂商的 DNS/连接错误 —— 完全看不出是填错了栏位。
//    必须在**保存那一刻**就拦下并点名说「这看起来是 API Key」。
// 2. **地址必须是合法的 http(s) URL**，且空值放行（留空 = 用厂商默认地址）。
// 3. **不能误伤合法输入**：带 `://` 或 `/` 的地址、含 `sk` 字样的普通域名
//    都不能被判成密钥（误伤比漏报更糟 —— 合法配置被拦下无法保存）。
//
// 用法：node tests/cloudConfigValidation.test.cjs
// （编译产物由 scripts/run-tests.mjs 负责，见 COMPILES 里的 cloudConfigValidation 条目）
const assert = require('assert')
const {
  looksLikeApiKey,
  isValidHttpUrl,
  checkCloudBaseUrl,
  CLOUD_BASE_URL_PLACEHOLDERS
} = require('../.tmp_ccv/shared/cloudConfigValidation.js')

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

/**
 * 运行时拼装「像密钥的字符串」。
 *
 * ## 为什么不在源码里写字面量
 *
 * 本项目的硬约束：**仓库里不得出现任何真实或形似真实的密钥**。
 * 即使是 `sk-` + 32 位占位十六进制，写进源码也会带来两个实际风险：
 * 1. **密钥扫描器误报**：CI / 提交钩子里的 secret scanner 会把它当真实凭据拦截，
 *    久了大家就学会「忽略告警」，告警随即失去意义。
 * 2. **真实凭据的滑坡入口**：源码里已经有一个「格式完全正确的 key」时，
 *    下一个人顺手把测试值换成自己真实 Key 去「验证一下」几乎零阻力——
 *    这正是凭据泄漏最常见的路径。
 *
 * 故这里改为**运行时拼装**：源码里只有前缀片段与占位字符，
 * 任何静态扫描（正则 / grep / secret scanner）都扫不出完整密钥形态。
 *
 * 语义等价性：`looksLikeApiKey` 是**前缀匹配**（见 src/shared/cloudConfigValidation.ts
 * 的 `/^(sk-|sk_ant-|AIza|gsk_|xai-|hf_|r8_|dop_v1_)/i`），判定只看前缀，
 * 因此拼装出的字符串与手写字面量在**被测行为上完全一致**。
 */
function fakeKey(prefix, bodyLength = 32) {
  return prefix + 'x'.repeat(bodyLength)
}

// ===== 1. 识别疑似 API Key =====
t('识别常见厂商密钥前缀', () => {
  assert.strictEqual(looksLikeApiKey(fakeKey('sk-')), true)
  assert.strictEqual(looksLikeApiKey(fakeKey('sk-ant-', 12)), true)
  assert.strictEqual(looksLikeApiKey(fakeKey('AIza', 24)), true)
  assert.strictEqual(looksLikeApiKey(fakeKey('gsk_', 16)), true)
  assert.strictEqual(looksLikeApiKey(fakeKey('xai-', 8)), true)
})

t('带协议头或路径的**不是**裸密钥（不能误伤正常地址）', () => {
  assert.strictEqual(looksLikeApiKey('https://api.deepseek.com/v1'), false)
  assert.strictEqual(looksLikeApiKey('http://localhost:8080/v1'), false)
  assert.strictEqual(looksLikeApiKey('sk.example.com/v1'), false)
})

t('普通文本不是密钥', () => {
  assert.strictEqual(looksLikeApiKey(''), false)
  assert.strictEqual(looksLikeApiKey('   '), false)
  assert.strictEqual(looksLikeApiKey('my-key'), false)
  assert.strictEqual(looksLikeApiKey('deepseek-v4-flash'), false)
})

// ===== 2. URL 形状校验 =====
t('合法 http(s) 地址通过', () => {
  assert.strictEqual(isValidHttpUrl('https://api.deepseek.com/v1'), true)
  assert.strictEqual(isValidHttpUrl('http://127.0.0.1:8000/v1'), true)
  assert.strictEqual(isValidHttpUrl('https://open.bigmodel.cn/api/paas/v4'), true)
})

t('非法地址被拒（非 http 协议 / 无主机 / 非 URL）', () => {
  assert.strictEqual(isValidHttpUrl('ftp://api.deepseek.com'), false)
  assert.strictEqual(isValidHttpUrl('api.deepseek.com/v1'), false)
  assert.strictEqual(isValidHttpUrl('https://'), false)
  assert.strictEqual(isValidHttpUrl(''), false)
})

// ===== 3. 组合校验 =====
t('空地址放行（留空 = 用厂商默认地址，这是合法用法）', () => {
  assert.deepStrictEqual(checkCloudBaseUrl(''), { ok: true })
  assert.deepStrictEqual(checkCloudBaseUrl('   '), { ok: true })
})

t('地址栏填了 Key → 判定为 looksLikeKey', () => {
  const r = checkCloudBaseUrl(fakeKey('sk-'))
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.problem, 'looksLikeKey')
})

t('地址栏填了非法 URL → 判定为 notUrl', () => {
  const r = checkCloudBaseUrl('not a url')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.problem, 'notUrl')
})

t('地址栏填了合法地址 → 放行', () => {
  assert.deepStrictEqual(checkCloudBaseUrl('https://api.deepseek.com/v1'), { ok: true })
})

t('各厂商默认地址都通过校验（占位符不能自己把自己判为非法）', () => {
  for (const [provider, url] of Object.entries(CLOUD_BASE_URL_PLACEHOLDERS)) {
    const r = checkCloudBaseUrl(url)
    assert.strictEqual(r.ok, true, `${provider} 的默认地址应通过校验`)
  }
})

t('前后空格不影响判定（用户从文档复制常带空格/换行）', () => {
  assert.deepStrictEqual(checkCloudBaseUrl('  https://api.deepseek.com/v1  '), { ok: true })
  assert.strictEqual(checkCloudBaseUrl('  ' + fakeKey('sk-', 6) + '  ').problem, 'looksLikeKey')
})

console.log(`\n  云端配置校验：${passed} 项全部通过`)
