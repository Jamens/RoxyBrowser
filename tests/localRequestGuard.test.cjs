// 本地 API 请求守卫（src/shared/localRequestGuard.ts）的离线单测。
//
// ## 要锁住什么
//
// 这层守卫一旦被改松，攻击面会**静默**变大——不会报错、不会有测试失败，
// 只是某天发现本地 API 被网页调走了。所以每条判定都要钉死：
//
// 1. **Host 必须是回环且精确匹配** —— 挡 DNS rebinding。
//    `127.0.0.1.evil.com` 这种后缀混淆最容易漏判。
// 2. **Origin 必须在白名单** —— 挡网页侧跨源请求。
//    关键前提：CORS 只阻止**读响应**、不阻止**请求发出**，
//    所以必须由服务端主动 403 才算数。
// 3. **`Origin: null` 必须带正确 nonce** —— file:// 页面与不透明源都是 null，
//    只有 nonce 能区分二者。
// 4. **拒绝时绝不能回 CORS 允许头** —— 回了头等于放行。
//    这条最容易被后人「顺手优化」掉（有人会觉得「拒绝也回个头更规范」），
//    所以单独锁。
//
// 用法：node tests/localRequestGuard.test.cjs
// （编译产物由 scripts/run-tests.mjs 负责，见 COMPILES 里的 localGuard 条目）
const assert = require('assert')
const {
  evaluateLocalRequest,
  parseHostHostname,
  isLoopbackHost,
  isLoopbackOrigin,
  buildCorsHeaders
} = require('../.tmp_lg/shared/localRequestGuard.js')

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

/** 判定请求的便捷包装 */
function decide(overrides = {}, options = {}) {
  return evaluateLocalRequest(
    {
      method: 'GET',
      host: '127.0.0.1:39100',
      origin: undefined,
      nonce: undefined,
      ...overrides
    },
    options
  )
}

// ===== 1. Host 解析 =====
t('Host 带端口 → 取出主机名', () => {
  assert.strictEqual(parseHostHostname('127.0.0.1:39100'), '127.0.0.1')
})

t('Host 无端口 → 原样取出', () => {
  assert.strictEqual(parseHostHostname('localhost'), 'localhost')
})

t('Host 是 IPv6 带端口 → 去掉方括号', () => {
  assert.strictEqual(parseHostHostname('[::1]:39100'), '::1')
})

t('Host 缺失 → null', () => {
  assert.strictEqual(parseHostHostname(undefined), null)
})

t('Host 为空白 → null', () => {
  assert.strictEqual(parseHostHostname('   '), null)
})

// ===== 2. 回环判定（必须精确匹配，不能后缀匹配）=====
t('127.0.0.1:39100 是回环', () => {
  assert.ok(isLoopbackHost('127.0.0.1:39100'))
})

t('evil.com 不是回环', () => {
  assert.ok(!isLoopbackHost('evil.com'))
})

t('127.0.0.1.evil.com 不是回环（后缀混淆）', () => {
  assert.ok(!isLoopbackHost('127.0.0.1.evil.com'))
})

t('localhost.evil.com 不是回环', () => {
  assert.ok(!isLoopbackHost('localhost.evil.com'))
})

t('evil.com:39100 不是回环', () => {
  assert.ok(!isLoopbackHost('evil.com:39100'))
})

// ===== 3. Origin 判定 =====
t('http://localhost:5173 是本机来源（dev server）', () => {
  assert.ok(isLoopbackOrigin('http://localhost:5173'))
})

t('http://127.0.0.1:39100 是本机来源', () => {
  assert.ok(isLoopbackOrigin('http://127.0.0.1:39100'))
})

t('https://evil.com 不是本机来源', () => {
  assert.ok(!isLoopbackOrigin('https://evil.com'))
})

t('file:// 不是本机来源（按 URL 解析会被拒）', () => {
  assert.ok(!isLoopbackOrigin('file:///C:/app/index.html'))
})

t('非法 origin 字符串被拒', () => {
  assert.ok(!isLoopbackOrigin('not-a-url'))
})

// ===== 4. Host 不合法 → 一律拒绝 =====
t('Host 为 evil.com → 403 bad-host', () => {
  const d = decide({ host: 'evil.com', origin: 'https://evil.com' })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.status, 403)
  assert.strictEqual(d.reason, 'bad-host')
})

t('Host 缺失 → 403 bad-host', () => {
  const d = decide({ host: undefined })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-host')
})

// ===== 5. 无 Origin = 非浏览器客户端 → 放行但不发 CORS 头 =====
t('无 Origin（curl / 第三方脚本）→ 放行', () => {
  const d = decide({ origin: undefined })
  assert.strictEqual(d.allowed, true)
  assert.strictEqual(d.reason, 'ok')
})

t('无 Origin 时不下发 CORS 允许头（非浏览器不需要）', () => {
  const d = decide({ origin: undefined })
  assert.deepStrictEqual(d.corsHeaders, {})
})

// ===== 6. Origin 白名单 =====
t('Origin 为本机 dev server → 放行且回显该 Origin', () => {
  const d = decide({ origin: 'http://localhost:5173' })
  assert.strictEqual(d.allowed, true)
  assert.strictEqual(d.corsHeaders['Access-Control-Allow-Origin'], 'http://localhost:5173')
})

t('Origin 为 https://evil.com → 403 bad-origin', () => {
  const d = decide({ origin: 'https://evil.com' })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.status, 403)
  assert.strictEqual(d.reason, 'bad-origin')
})

t('**拒绝时绝不回 CORS 允许头**（回了头等于放行）', () => {
  const d = decide({ origin: 'https://evil.com' })
  assert.deepStrictEqual(d.corsHeaders, {}, '拒绝响应里出现了 CORS 允许头')
})

t('Origin 为 http://evil.com（明文）同样拒绝', () => {
  const d = decide({ origin: 'http://evil.com' })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-origin')
})

t('Origin 为 http://localhost.evil.com 拒绝（后缀混淆）', () => {
  const d = decide({ origin: 'http://localhost.evil.com' })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-origin')
})

// ===== 7. Origin: null + nonce =====
const NONCE = 'a'.repeat(64)

t('Origin=null 且 nonce 正确 → 放行', () => {
  const d = decide({ origin: 'null', nonce: NONCE }, { nonce: NONCE })
  assert.strictEqual(d.allowed, true)
  assert.strictEqual(d.corsHeaders['Access-Control-Allow-Origin'], 'null')
})

t('Origin=null 且 nonce 错误 → 403 bad-nonce', () => {
  const d = decide({ origin: 'null', nonce: 'b'.repeat(64) }, { nonce: NONCE })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-nonce')
})

t('Origin=null 且缺 nonce → 403 bad-nonce', () => {
  const d = decide({ origin: 'null', nonce: undefined }, { nonce: NONCE })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-nonce')
})

t('服务端未配置 nonce 时，Origin=null 仍然拒绝（宁可拒绝不能放行）', () => {
  const d = decide({ origin: 'null', nonce: NONCE }, {})
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-nonce')
})

t('nonce 长度不同 → 拒绝', () => {
  const d = decide({ origin: 'null', nonce: 'a'.repeat(32) }, { nonce: NONCE })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-nonce')
})

t('Origin=null 被拒时同样不回 CORS 头', () => {
  const d = decide({ origin: 'null', nonce: 'wrong' }, { nonce: NONCE })
  assert.deepStrictEqual(d.corsHeaders, {})
})

// ===== 8. 额外 Origin 白名单（精确匹配）=====
t('命中额外白名单 → 放行', () => {
  const d = decide({ origin: 'https://ops.internal' }, { extraOrigins: ['https://ops.internal'] })
  assert.strictEqual(d.allowed, true)
})

t('额外白名单差一个字符 → 拒绝', () => {
  const d = decide({ origin: 'https://ops.internalx' }, { extraOrigins: ['https://ops.internal'] })
  assert.strictEqual(d.allowed, false)
  assert.strictEqual(d.reason, 'bad-origin')
})

// ===== 9. CORS 头内容 =====
t('CORS 头含 LNA 配套头 Access-Control-Allow-Private-Network', () => {
  const h = buildCorsHeaders('http://localhost:5173')
  assert.strictEqual(h['Access-Control-Allow-Private-Network'], 'true')
})

t('CORS 头含 Vary: Origin（避免代理缓存串味）', () => {
  const h = buildCorsHeaders('http://localhost:5173')
  assert.strictEqual(h.Vary, 'Origin')
})

t('CORS 头允许 X-Roxy-Nonce（自定义头必须被预检放行）', () => {
  const h = buildCorsHeaders('http://localhost:5173')
  assert.ok(/X-Roxy-Nonce/i.test(h['Access-Control-Allow-Headers']))
})

t('CORS 头不含通配符 *（回显具体 Origin）', () => {
  const h = buildCorsHeaders('http://localhost:5173')
  assert.notStrictEqual(h['Access-Control-Allow-Origin'], '*')
})

console.log(`\n${passed} 项断言通过`)
if (passed < 30) {
  console.error('断言数异常偏少，检查测试是否被意外跳过')
  process.exitCode = 1
}
