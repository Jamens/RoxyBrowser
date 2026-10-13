// 离线单测：会话撤销判定（shared/sessionRevoke.ts）
// 核心不变量：
//   1) 升级兼容：ver 缺失的旧令牌必须仍然有效（否则一升级就把在线用户全踢下线）
//   2) 撤销生效：库版本一旦递增，此前签发的令牌立即全部失效
//   3) 反向不一致也不放行：令牌版本「领先」于库（数据回滚 / 跨环境）同样拒绝
//   4) 2FA 挑战令牌绝不能当会话令牌用（防 2FA 降级绕过）
//   5) nextSessionVersion 必须稳定递增
// 运行：先 `node node_modules/typescript/bin/tsc src/shared/sessionRevoke.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_sr`
//      再 `node tests/sessionRevoke.test.cjs`
const { checkSession, nextSessionVersion, shouldClearLocalSession, SESSION_TTL_DAYS } = require('../.tmp_sr/shared/sessionRevoke.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

const claims = (o) => ({ uid: 1, tid: 1, username: 'u', role: 'owner', ...o })

// ============ 1) 版本号一致 → 有效 ============
{
  const v = checkSession(claims({ ver: 3 }), 3)
  check('版本一致 → 有效', v.valid === true)
  check('版本为 0 且库为 0 → 有效', checkSession(claims({ ver: 0 }), 0).valid === true)
}

// ============ 2) 升级兼容：ver 缺失的旧令牌必须仍有效 ============
{
  // 这是最容易写出 bug 的地方：上线本功能前签发的令牌没有 ver 字段。
  // 若把缺失当「不合法」，所有在线用户会在升级瞬间被踢下线。
  const v = checkSession(claims({}), 0)
  check('ver 缺失 + 库版本 0 → 有效（升级不踢人）', v.valid === true)
  // 但库版本已递增（用户曾登出过）时，旧令牌必须失效
  const v2 = checkSession(claims({}), 1)
  check('ver 缺失 + 库版本 1 → 失效', v2.valid === false && v2.code === 'session_revoked')
}

// ============ 3) 撤销生效 ============
{
  const old = claims({ ver: 1 }) // 令牌签发时库版本是 1
  const after = checkSession(old, 2) // 用户登出 → 库版本 +1 变成 2
  check('登出后旧令牌立即失效', after.valid === false)
  check('失效原因指向需重新登录', after.valid === false && /重新登录/.test(after.reason))
  check('失效带 code 供前端处理', after.valid === false && after.code === 'session_revoked')
  // 重新登录拿到 ver=2 的新令牌 → 有效
  check('登出后新签发的令牌有效', checkSession(claims({ ver: 2 }), 2).valid === true)
}

// ============ 4) 反向不一致也不放行 ============
{
  // 令牌版本高于库版本：可能是库被回滚/重置，或令牌来自另一套环境。
  // 放行等于绕过撤销机制，必须拒绝。
  const v = checkSession(claims({ ver: 5 }), 2)
  check('令牌版本领先于库 → 拒绝', v.valid === false && v.code === 'session_revoked')
  check('领先时提示状态异常', v.valid === false && /异常/.test(v.reason))
}

// ============ 5) 2FA 挑战令牌不被当作会话令牌 ============
{
  const v = checkSession(claims({ purpose: '2fa', ver: 0 }), 0)
  check('2FA 挑战令牌被拒（防降级绕过）', v.valid === false && v.code === 'wrong_token_type')
  // 即便版本号匹配也不能放行——类型检查优先于版本检查
  const v2 = checkSession(claims({ purpose: '2fa', ver: 3 }), 3)
  check('挑战令牌即便版本匹配也拒绝', v2.valid === false && v2.code === 'wrong_token_type')
}

// ============ 6) nextSessionVersion ============
{
  check('0 → 1', nextSessionVersion(0) === 1)
  check('1 → 2', nextSessionVersion(1) === 2)
  check('null/NaN 视为 0 → 1', nextSessionVersion(NaN) === 1)
  check('连续递增', nextSessionVersion(nextSessionVersion(3)) === 5)
  // 版本号只要「相等/不等」，绝对值无意义——不能倒退（倒退会让旧令牌复活）
  const seq = [0, 1, 2, 3].map((i) => nextSessionVersion(i))
  check('版本号严格递增不倒退', seq.every((v, i) => i === 0 || v > seq[i - 1]))
}

// ============ 7) 前端联动 ============
{
  check('有效会话不需清本地', shouldClearLocalSession(checkSession(claims({ ver: 1 }), 1)) === false)
  check('撤销后需清本地', shouldClearLocalSession(checkSession(claims({ ver: 1 }), 2)) === true)
}

// ============ 8) 有效期常量 ============
{
  check('会话有效期为 7 天', SESSION_TTL_DAYS === 7)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
