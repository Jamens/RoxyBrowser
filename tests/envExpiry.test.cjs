// 离线单测：envExpiry.ts（环境生命周期 / 到期管理，候选③）
// 运行：先编译共享模块到临时目录（tsc 会自动把 fingerprint/types/trackers 依赖一起 emit）
//   tsc src/shared/envExpiry.ts src/shared/fingerprint.ts --module commonjs --target es2020 \
//       --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_env
//   再 node tests/envExpiry.test.cjs
const { getEnvExpiresAt, withEnvExpiresAt } = require('../.tmp_env/envExpiry.js')
const { normalizeFingerprint } = require('../.tmp_env/fingerprint.js')

let failed = 0
function check(name, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

const ISO = '2026-10-01T08:30:00.000Z'

// ===== getEnvExpiresAt =====
check('读取合法 ISO', getEnvExpiresAt({ expiresAt: ISO }) === ISO)
check('缺键返回 null', getEnvExpiresAt({ os: 'windows' }) === null)
check('空串返回 null', getEnvExpiresAt({ expiresAt: '' }) === null)
check('非字符串返回 null', getEnvExpiresAt({ expiresAt: 123 }) === null)
check('null 入参返回 null', getEnvExpiresAt(null) === null)
check('undefined 入参返回 null', getEnvExpiresAt(undefined) === null)

// ===== withEnvExpiresAt =====
const setOut = withEnvExpiresAt({ os: 'windows' }, ISO)
check('写入后读回一致', setOut.expiresAt === ISO)
check('写入不改原对象', getEnvExpiresAt({ os: 'windows' }) === null)
const clearOut = withEnvExpiresAt({ os: 'windows', expiresAt: ISO }, null)
check('清空删除 expiresAt 键', Object.prototype.hasOwnProperty.call(clearOut, 'expiresAt') === false)
const noop = withEnvExpiresAt({ os: 'windows' }, null)
check('空值写入不产生键', Object.prototype.hasOwnProperty.call(noop, 'expiresAt') === false)

// ===== 关键不变量：normalizeFingerprint 不得抹除 expiresAt =====
// 这是「不新增数据库列、到期时间存 fingerprint JSON」方案能成立的前提：
// 编辑 / 导入落库前会跑 normalizeFingerprint，若它丢弃自定义键，到期时间就会静默丢失。
const raw = { os: 'windows', expiresAt: ISO, tzOffset: -480 }
const norm = normalizeFingerprint(raw)
check('normalize 后 expiresAt 仍在', getEnvExpiresAt(norm) === ISO)
check('normalize 后其余字段自洽', norm.os === 'windows' && typeof norm.timezone === 'string')
const normNoExp = normalizeFingerprint({ os: 'mac' })
check('无到期环境 normalize 后不含过期键', getEnvExpiresAt(normNoExp) === null)

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
