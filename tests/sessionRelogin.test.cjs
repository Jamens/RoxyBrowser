// 源码级守卫：「登出后无法再登录」这条回归不许再回来。
//
// 纯读源码，无需编译，进 pnpm test。
//
// 要锁住的是一整条链路，缺任何一环都会静默退化成原来的 bug：
//   signSessionToken 注入毫秒级 iatMs
//     → 令牌带上签发时刻
//     → checkSession 把签发时刻传给 isDeviceRevoked
//     → 判定只让「晚于签发时刻」的撤销记录生效
//
// 这条链最阴险的地方是：**漏掉任何一环都不会有编译错误、不会有报错**，
// 用户只会看到「登出后再也登不回来」，而单测若只测「撤销能生效」反而全绿。
// 行为级验证见 scripts/verify-session-relogin.mjs。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

const shared = read('src/shared/sessionRevoke.ts')
const server = read('src/main/server.ts')
const auth = read('src/main/routes/auth.ts')

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

/** 取函数体（到下一个顶层 export / function 之前），避免断言被文件其它部分"凑巧"满足 */
function bodyOf(src, signature, span = 2200) {
  const i = src.indexOf(signature)
  assert.ok(i >= 0, `源码里找不到 ${signature}（函数被改名或挪走了？）`)
  return src.slice(i, i + span)
}

console.log('\n  登出后可重新登录（源码级守卫）')

t('SessionClaims 声明了毫秒级签发时刻 iatMs', () => {
  assert.ok(/iatMs\?:\s*number/.test(shared), 'SessionClaims 缺少 iatMs 字段')
  assert.ok(/iat\?:\s*number/.test(shared), 'SessionClaims 缺少秒级 iat 兜底字段')
})

t('signSessionToken 必须注入 iatMs: Date.now()', () => {
  const body = bodyOf(server, 'function signSessionToken')
  assert.ok(/iatMs:\s*Date\.now\(\)/.test(body), '签发时没写入毫秒级签发时刻，撤销判定无法区分新旧令牌')
  assert.ok(/dev:\s*args\.dev\s*\|\|\s*''/.test(body), '签发时漏了 dev，设备级撤销会整体失效')
  assert.ok(/ver:\s*args\.tokenVersion\s*\?\?\s*0/.test(body), '签发时漏了 ver，全设备撤销会整体失效')
})

t('为什么不能用秒级 iat 这件事写在注释里（防后人"简化"掉）', () => {
  const body = bodyOf(server, 'function signSessionToken')
  assert.ok(/同一秒|秒级/.test(body), '毫秒精度的设计理由必须留在签发处')
})

t('checkSession 把签发时刻传给设备撤销判定', () => {
  assert.ok(
    /isDeviceRevoked\(dev,\s*revokedDevices,\s*sessionIssuedAtMs\(claims\)\)/.test(shared),
    '设备撤销判定没收到签发时刻 —— 会退回「只按 dev 匹配」，登出后永远登不回来'
  )
})

t('isDeviceRevoked 按「撤销时间 > 签发时间」判定', () => {
  const body = bodyOf(shared, 'export function isDeviceRevoked')
  assert.ok(/issuedAtMs/.test(body), '判定函数没有签发时刻参数')
  assert.ok(
    /\(Number\(d\.at\)\s*\|\|\s*0\)\s*>\s*issued/.test(body),
    '没有做时间比较（必须是严格大于，同毫秒边界才不会误杀新令牌）'
  )
  assert.ok(
    /issuedAtMs\s*===\s*undefined/.test(body),
    '缺少「无签发时刻时保守拒绝」的兼容分支'
  )
})

t('sessionIssuedAtMs 有毫秒优先 / 秒级兜底 / 全缺为 0 三级语义', () => {
  const body = bodyOf(shared, 'export function sessionIssuedAtMs', 900)
  assert.ok(/claims\.iatMs/.test(body) && /claims\.iat/.test(body) && /\*\s*1000/.test(body))
  assert.ok(/return\s+0/.test(body), '全缺时必须保守返回 0')
})

t('所有会话令牌都走唯一签发入口 signSessionToken', () => {
  const calls = (auth.match(/signSessionToken\(/g) || []).length
  assert.ok(calls >= 4, `auth.ts 里只找到 ${calls} 处签发调用，预期至少 4 处（注册/登录/切换团队/2FA 验证）`)
  // 唯一允许绕过统一入口的是 2FA 挑战令牌，且它必须带 purpose（checkSession 会先拒掉它）
  const jwtSigns = (auth.match(/jwt\.sign\(/g) || []).length
  assert.strictEqual(jwtSigns, 1, `auth.ts 里出现了 ${jwtSigns} 处裸 jwt.sign —— 绕开统一入口会漏掉 iatMs`)
  const challenge = bodyOf(auth, "purpose: '2fa'", 400)
  assert.ok(/purpose:\s*'2fa'/.test(challenge), '2FA 挑战令牌缺少 purpose 标记')
})

t('撤销记录里的 at 是判定的一部分（不只是过期回收用）', () => {
  const iface = bodyOf(shared, 'export interface RevokedDevice', 700)
  assert.ok(/at:\s*number/.test(iface), 'RevokedDevice 缺少 at 字段')
  assert.ok(/判定|命中/.test(iface), 'at 的时间判定语义应有注释说明，避免被当成纯清理字段删掉')
})

console.log(`\n  登出后可重新登录（源码级守卫）：${passed} 项全部通过`)
