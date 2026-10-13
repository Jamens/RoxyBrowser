// 离线单测：接口限流与登录锁定（shared/rateLimit.ts）
// 核心不变量：
//   1) 滑动窗口不能被「卡边界」绕过（固定窗口的经典 2 倍速率漏洞）
//   2) 登录失败按**用户名**计数而非 IP——本地全来自 127.0.0.1，
//      按 IP 计数等于所有人共用额度，攻击者猛打任意账号就能锁死正常用户
//   3) 锁定到期后失败计数必须清零，否则解封后第一次输错又立刻被锁
//   4) limit=0 表示不限流；剩余次数提示只在临界值给（避免帮爆破者定位阈值）
// 运行：先 `node node_modules/typescript/bin/tsc src/shared/rateLimit.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_rl`
//      再 `node tests/rateLimit.test.cjs`
const {
  createBucket,
  consumeRateLimit,
  registerLoginFailure,
  registerLoginSuccess,
  checkLoginLock,
  isLocked,
  formatDuration,
  BucketStore,
  DEFAULT_LOGIN_WINDOW_MS,
} = require('../.tmp_rl/shared/rateLimit.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

const MIN = 60 * 1000

// ============ 1) 基本限流 ============
{
  const b = createBucket()
  check('第 1 次放行', consumeRateLimit(b, 1000, 5, MIN).allowed === true)
  check('第 2 次放行', consumeRateLimit(b, 2000, 5, MIN).allowed === true)
  check('剩余次数递减', consumeRateLimit(b, 3000, 5, MIN).remaining === 2)
  check('第 4 次剩余 1', consumeRateLimit(b, 4000, 5, MIN).remaining === 1)
  check('第 5 次（达上限）仍放行', consumeRateLimit(b, 4500, 5, MIN).allowed === true)
  // 第 6 次才是超限
  const blocked = consumeRateLimit(b, 5000, 5, MIN)
  check('超出限额被拒', blocked.allowed === false)
  check('超限状态码 429', blocked.status === 429)
  check('超限给出 Retry-After', blocked.retryAfterSec > 0, `${blocked.retryAfterSec}s`)
  check('超限给出中文原因', /过于频繁/.test(blocked.reason))
}

// ============ 2) limit=0 表示不限流 ============
{
  const b = createBucket()
  let allOk = true
  for (let i = 0; i < 1000; i++) if (!consumeRateLimit(b, 1000, 0, MIN).allowed) allOk = false
  check('limit=0 时无限放行', allOk)
  const neg = createBucket()
  check('负数 limit 同样视为不限流', consumeRateLimit(neg, 0, -5, MIN).allowed === true)
}

// ============ 3) 滑动窗口不能被卡边界绕过 ============
{
  // 固定窗口的经典漏洞：窗口末尾打满 3 次，下个窗口开头再打 3 次 = 6 次/分钟
  // 滑动窗口下这些必须被正确计数，第 4 次就该被拒
  const b = createBucket()
  const t0 = 60 * 1000
  // 窗口末尾（t0-1s 起）
  consumeRateLimit(b, t0 - 1000, 3, MIN)
  consumeRateLimit(b, t0 - 500, 3, MIN)
  // 跨过窗口边界
  consumeRateLimit(b, t0 + 1, 3, MIN)
  const fourth = consumeRateLimit(b, t0 + 2, 3, MIN)
  check('跨窗口边界不重置计数（第 4 次被拒）', fourth.allowed === false)

  // 验证：只有当最早那条真正滑出窗口后才放行
  const after = consumeRateLimit(b, t0 - 1000 + MIN + 10, 3, MIN)
  check('最早记录滑出窗口后恢复放行', after.allowed === true)
}

// ============ 4) 超限不消费额度（否则一次超限会顺延恢复时间）============
{
  const b = createBucket()
  consumeRateLimit(b, 0, 2, MIN)
  consumeRateLimit(b, 100, 2, MIN)
  consumeRateLimit(b, 200, 2, MIN) // 被拒
  consumeRateLimit(b, 300, 2, MIN) // 仍被拒
  // 若超限也 push，第 3 次被拒会把自己记进去，错误地延长锁定
  check('超限不消费额度（hits 不增长）', b.hits.length === 2, `hits=${b.hits.length}`)
}

// ============ 5) 登录失败计数与锁定 ============
{
  const b = createBucket()
  const t = 1000
  const r1 = registerLoginFailure(b, t, 3, 15 * MIN)
  check('第 1 次失败仍放行（让人能继续试）', r1.allowed === true)
  const r2 = registerLoginFailure(b, t + 100, 3, 15 * MIN)
  check('第 2 次失败仍放行', r2.allowed === true)
  const r3 = registerLoginFailure(b, t + 200, 3, 15 * MIN)
  check('第 3 次失败触发锁定', r3.allowed === false && r3.status === 423)
  check('锁定提示为中文', /锁定/.test(r3.reason))
  check('锁定后 isLocked 为真', isLocked(b, t + 300) === true)
  check('锁定期间登录被拒', checkLoginLock(b, t + 400).allowed === false)
  check('锁定期间状态码 423', checkLoginLock(b, t + 400).status === 423)
  check('锁定期间给出 Retry-After', checkLoginLock(b, t + 400).retryAfterSec > 0)
}

// ============ 6) 锁定到期后计数清零（关键不变量）============
{
  const b = createBucket()
  const t = 1000
  registerLoginFailure(b, t, 2, 10 * MIN)
  registerLoginFailure(b, t, 2, 10 * MIN) // 触发锁定，锁 10 分钟
  check('已锁定', isLocked(b, t + 1000) === true)
  // 时间推进到锁定到期后
  const after = t + 11 * MIN
  check('到期后不再锁定', isLocked(b, after) === false)
  // 关键：到期状态在**调用检查入口时**才被惰性清理（prune 在函数内执行，
  // 而非每来一个请求都跑定时器）。这里通过 checkLoginLock 触发并验证后果。
  check('到期后登录入口放行', checkLoginLock(b, after).allowed === true)
  check('到期后失败计数已清零', b.failures === 0, `failures=${b.failures}`)
  // 最关键的后验检验：解封后第一次输错绝不能立刻又被锁
  const r = registerLoginFailure(b, after, 2, 10 * MIN)
  check('解封后第 1 次失败不触发锁定', r.allowed === true)
  check('解封后计数从 1 重新开始', b.failures === 1)
  // 若计数没清零，这里会立刻触发第二次锁定
  const r2 = registerLoginFailure(b, after + 1000, 2, 10 * MIN)
  check('解封后第 2 次失败恰好达到阈值并锁定', r2.allowed === false && r2.status === 423)
}

// ============ 7) 登录成功清零 ============
{
  const b = createBucket()
  registerLoginFailure(b, 1000, 5, 15 * MIN)
  registerLoginFailure(b, 2000, 5, 15 * MIN)
  check('成功前有失败计数', b.failures === 2)
  registerLoginSuccess(b)
  check('登录成功清零失败计数', b.failures === 0)
  check('登录成功清零锁定', b.lockedUntil === 0)
}

// ============ 8) 阈值=0 表示只记录不锁定 ============
{
  const b = createBucket()
  for (let i = 0; i < 20; i++) registerLoginFailure(b, 1000 + i, 0, 15 * MIN)
  check('阈值为 0 时永不锁定', isLocked(b, 5000) === false)
  check('阈值为 0 时仍记录失败次数', b.failures === 20)
}

// ============ 9) 剩余次数提示策略 ============
{
  // 只在剩余 <=3 时提示，避免「还剩 1 次」帮爆破者精确定位阈值
  const b = createBucket()
  const early = registerLoginFailure(b, 1000, 20, 15 * MIN)
  check('失败次数少时不提示剩余', early.reason === '')
  const b2 = createBucket()
  // 先失败 17 次 → 累计 18 次（含循环内最后一次）后检查：剩余 2 次
  for (let i = 0; i < 17; i++) registerLoginFailure(b2, 1000, 20, 15 * MIN)
  const late = registerLoginFailure(b2, 1000, 20, 15 * MIN)
  check('接近阈值时提示剩余次数', /还可尝试 2 次/.test(late.reason), late.reason)
}

// ============ 10) formatDuration ============
{
  check('秒', formatDuration(30) === '30 秒')
  check('分钟', formatDuration(60) === '1 分钟')
  check('分钟向上取整', formatDuration(90) === '2 分钟')
  check('小时', formatDuration(3600) === '1 小时')
  check('小时向上取整', formatDuration(3660) === '2 小时')
}

// ============ 11) BucketStore：隔离性与清理 ============
{
  const s = new BucketStore()
  const a = s.get('login:admin')
  const b = s.get('login:user2')
  check('不同键互相独立', a !== b)
  check('同键复用同一桶', s.get('login:admin') === a)

  // 关键：登录失败按用户名计数，本地全来自 127.0.0.1，
  // 若按 IP 计数则 a/b 会共用额度 → 攻击者猛打 admin 会把 user2 也锁了
  registerLoginFailure(a, 1000, 2, 15 * MIN)
  check('攻击 admin 不影响 user2', checkLoginLock(b, 1000).allowed === true)
  registerLoginFailure(a, 1000, 2, 15 * MIN)
  check('只有被攻击的账号被锁', isLocked(a, 1000) === true && isLocked(b, 1000) === false)

  // sweep 不应清掉仍有失败计数的桶（有失败计数即代表该账号仍需被保护）
  const sg = new BucketStore()
  const guarded = sg.get('login:admin')
  registerLoginFailure(guarded, 1000, 5, 15 * MIN) // failures=1，尚未锁定
  const before = sg.size
  sg.sweep(1000 + 30 * MIN, MIN)
  check('有失败计数的桶不被清理', sg.size === before && sg.get('login:admin') === guarded)

  // 没有任何记录的桶在超时后应被清掉
  const s3 = new BucketStore()
  s3.get('ip:127.0.0.1') // 纯占位，无 hits 无 failures
  check('空桶在清理前存在', s3.size === 1)
  s3.sweep(1000 + 2 * 60 * MIN, MIN)
  check('过期的空桶被清理', s3.size === 0, `size=${s3.size}`)

  // 有锁定的桶即使很久也不该被清（否则锁定失效）
  const s2 = new BucketStore()
  const lb = s2.get('login:locked')
  registerLoginFailure(lb, 0, 1, 60 * MIN)
  s2.sweep(90 * MIN, MIN)
  check('锁定期内的桶不被清理', s2.get('login:locked') === lb)

  s.clear()
  check('clear 清空全部', s.size === 0)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
