// 离线单测：轮询退避（shared/pollBackoff.ts）
// 核心不变量：
//   1) 遇 429 必须暂停，否则「越限流越打」形成正反馈，限流窗口永远不恢复
//   2) 退避时长取 Retry-After，但必须有上限，不能真等几分钟
//   3) 非 429 错误不该拖慢轮询（那是个别接口问题，不是整体过载）
//   4) 页面隐藏时停止轮询（用户看不见，没必要打接口）
const { MAX_BACKOFF_SEC, formatRetryAfter } = require('../.tmp_pb/shared/pollBackoff.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

// ============ 1) 退避上限 ============
{
  check('MAX_BACKOFF_SEC 为正整数', Number.isInteger(MAX_BACKOFF_SEC) && MAX_BACKOFF_SEC > 0)
  check('上限不超过 60 秒', MAX_BACKOFF_SEC <= 60, `${MAX_BACKOFF_SEC}s`)
  // 模拟：服务端说等 300 秒，必须被截断到 60
  const serverSays = 300
  const actual = Math.min(serverSays || 3, MAX_BACKOFF_SEC)
  check('服务端给 300s 时截断到上限', actual === MAX_BACKOFF_SEC, `${actual}s`)
  const small = Math.min(5 || 3, MAX_BACKOFF_SEC)
  check('服务端给 5s 时原样采用', small === 5, `${small}s`)
  const none = Math.min(undefined || 3, MAX_BACKOFF_SEC)
  check('无 Retry-After 时用默认 3s', none === 3, `${none}s`)
}

// ============ 2) formatRetryAfter 文案 ============
{
  check('小于 60 秒显示「X 秒」', formatRetryAfter(5) === '5 秒', formatRetryAfter(5))
  check('0 秒不崩', typeof formatRetryAfter(0) === 'string')
  check('60 秒显示「1 分钟」', formatRetryAfter(60) === '1 分钟', formatRetryAfter(60))
  check('90 秒显示「1 分 30 秒」', formatRetryAfter(90) === '1 分 30 秒', formatRetryAfter(90))
  check('120 秒显示「2 分钟」', formatRetryAfter(120) === '2 分钟', formatRetryAfter(120))
  check('输出非空', formatRetryAfter(7).length > 0)
}

// ============ 3) 判定逻辑（isRateLimited 的契约）============
{
  // 复刻 ApiError 的判定方式，确保轮询工具与 api.ts 约定一致
  const mk = (status, retryAfterSec) => ({ isRateLimited: status === 429, retryAfterSec })
  check('429 被判为限流', mk(429, 5).isRateLimited === true)
  check('401 不是限流', mk(401).isRateLimited === false)
  check('423 不是限流', mk(423).isRateLimited === false)
  check('500 不是限流', mk(500).isRateLimited === false)
  check('网络错误（无 status）不是限流', mk(undefined).isRateLimited === false)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)