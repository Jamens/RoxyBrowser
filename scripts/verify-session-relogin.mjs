/**
 * 行为级验证：「登出 → 重新登录 → 新令牌可用」。
 *
 * 用户报障：「我发现登出后就无法再登陆了」。
 * 现象是登录接口明明返回了 token，但紧接着的任意请求都 401，前端清 token
 * 跳回登录页，再登录又被拒 —— 死循环。纯函数单测测不出这条链路，
 * 必须走真实 HTTP：登录 / 登出 / 鉴权中间件 / 数据库撤销记录全都在场。
 *
 * 用法：后端在 39100 跑着时 `node scripts/verify-session-relogin.mjs`
 * 可用 ROXY_API / ROXY_TEST_USER / ROXY_TEST_PASSWORD 覆盖连接与账号
 * （默认用 bootstrap 创建的本地演示账号；不读取任何外部凭据）。
 *
 * 关于数据：脚本用两个**独立的 User-Agent**，撤销记录只落在这两个指纹下，
 * 不会污染真实浏览器窗口；记录随令牌有效期（7 天）由 pruneRevokedDevices 自动回收。
 * 脚本只写审计日志（operation_logs），不新增/删除任何业务数据。
 */
const API = process.env.ROXY_API || 'http://127.0.0.1:39100'
const USER = process.env.ROXY_TEST_USER || 'admin'
const PASSWORD = process.env.ROXY_TEST_PASSWORD || '123456'
const UA_A = 'RoxySessionReloginVerify/1.0-A'
const UA_B = 'RoxySessionReloginVerify/1.0-B'

let passed = 0
let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  cond ? passed++ : failed++
}

async function call(path, { method = 'GET', token, ua = UA_A, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

const login = (ua) =>
  call('/api/auth/login', { method: 'POST', ua, body: { username: USER, password: PASSWORD } })
const me = (token, ua = UA_A) => call('/api/auth/me', { token, ua })
const logout = (token, ua = UA_A) => call('/api/auth/logout', { method: 'POST', token, ua })

/** 只读 JWT payload（不验签）：确认签发时刻确实被写进了令牌 */
function payloadOf(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

async function main() {
  // ---------- S0. 后端在线 ----------
  const probe = await me('')
  check('S0 后端在线（无令牌请求返回 401 而非连接失败）', probe.status === 401, `status=${probe.status}`)
  if (probe.status !== 401) throw new Error('后端不可用，请先启动 npm run dev')

  // ---------- S1/S2. 首次登录 ----------
  const first = await login(UA_A)
  const token1 = first.json?.token || ''
  check('S1 首次登录成功并拿到令牌', first.status === 200 && !!token1, `status=${first.status}`)
  if (!token1) throw new Error('登录失败：' + JSON.stringify(first.json).slice(0, 200))
  check('S2 首次登录的令牌可用', (await me(token1)).status === 200)

  // 另一个设备也在登出前拿到令牌 —— 用来验证「普通登出只踢本设备」
  const other = await login(UA_B)
  const tokenB = other.json?.token || ''
  check('S2b 另一设备登录成功', other.status === 200 && !!tokenB, `status=${other.status}`)

  // ---------- S3/S4. 登出，旧令牌必须失效 ----------
  const lo1 = await logout(token1)
  check('S3 登出接口返回成功', lo1.status === 200, `status=${lo1.status}`)
  const oldAfter = await me(token1)
  check(
    'S4 登出后旧令牌被拒（撤销确实生效）',
    oldAfter.status === 401,
    `status=${oldAfter.status} code=${oldAfter.json?.code || ''}`
  )
  if (tokenB) {
    check('S4b 其他设备的令牌不受牵连', (await me(tokenB, UA_B)).status === 200)
  }

  // ---------- S5~S8. 核心：同一设备重新登录 ----------
  const second = await login(UA_A)
  const token2 = second.json?.token || ''
  check('S5 同一设备重新登录成功并拿到新令牌', second.status === 200 && !!token2, `status=${second.status}`)
  if (!token2) throw new Error('重新登录失败：' + JSON.stringify(second.json).slice(0, 200))

  const p1 = payloadOf(token1)
  const p2 = payloadOf(token2)
  check('S6 两个令牌都带毫秒级 iatMs，且新令牌严格更晚',
    Number.isFinite(p1.iatMs) && Number.isFinite(p2.iatMs) && p2.iatMs > p1.iatMs,
    `iatMs: ${p1.iatMs} -> ${p2.iatMs}`)
  check('S6b 设备指纹一致（证明确实是「同一设备」重登录）',
    !!p1.dev && p1.dev === p2.dev, `dev=${String(p2.dev).slice(0, 12)}...`)

  const relogged = await me(token2)
  check('★ S7 重新登录后的新令牌可用（核心回归项）', relogged.status === 200,
    `status=${relogged.status} code=${relogged.json?.code || ''} msg=${relogged.json?.message || ''}`)
  check('S8 旧令牌不因重新登录而复活（安全不破防）', (await me(token1)).status === 401)

  // ---------- S9. 二次登出仍然有效 ----------
  // S9b 必须与 S9a 联动：否则 token2 若本来就已被拒（修复前的 bug 态），
  // S9b 会「白捡一个 401」假通过，掩盖 S9a 的失败。
  const lo2 = await logout(token2)
  const lo2Ok = lo2.status === 200
  check('S9a 二次登出返回成功', lo2Ok, `status=${lo2.status}`)
  const afterLo2 = await me(token2)
  check('S9b 二次登出能吊销这一轮的新令牌', lo2Ok && afterLo2.status === 401,
    `status=${afterLo2.status} code=${afterLo2.json?.code || ''}`)

  // ---------- 汇总 ----------
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) {
    console.log('\n提示：若 S7 为 401 session_revoked，说明设备级撤销又退回了「只按 dev 匹配」的老实现。')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
