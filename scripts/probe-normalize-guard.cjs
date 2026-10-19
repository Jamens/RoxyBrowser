// 修复后的行为探测：确认守卫与文案的实际输出（写断言前先跑真实实现）
const { planOne } = require('../.tmp_fb/shared/fixBatch.js')
const { normalizeBlockReason, isNormalizableFingerprint } = require('../.tmp_fb/shared/fingerprint.js')
const { proposeFixes } = require('../.tmp_fb/shared/healthFix.js')
const { checkConsistency } = require('../.tmp_fb/shared/healthcheck.js')

console.log('=== isNormalizableFingerprint ===')
const cases = [
  ['{os:windows}', { os: 'windows' }],
  ['{os:mac}', { os: 'mac' }],
  ['{os:android}', { os: 'android' }],
  ['{os:ios}', { os: 'ios' }],
  ['{os:bogus}', { os: 'bogus' }],
  ['{timezone:x} 无 os', { timezone: 'Asia/Tokyo' }],
  ['{} 空对象', {}],
  ['null', null],
  ['undefined', undefined]
]
for (const [label, v] of cases) {
  console.log('  ' + label.padEnd(18) + ' → ' + isNormalizableFingerprint(v))
}

console.log('\n=== normalizeBlockReason（null 表示可安全归一）===')
for (const [label, v] of cases) {
  const r = normalizeBlockReason(v)
  console.log('  ' + label.padEnd(18) + ' → ' + (r === null ? '(可归一)' : r))
}

console.log('\n=== planOne 对残缺指纹的判定 ===')
const r = planOne(
  { id: 1, name: '残缺指纹', fingerprint: { timezone: 'Australia/Sydney' }, proxyCountry: 'United States' },
  (fp, pc) => checkConsistency(fp, pc)
)
console.log('  status   =', r.status)
console.log('  changes  =', r.changes.length, '(必须为 0)')
console.log('  reason   =', r.reason)
console.log('  summary  =', r.summary)

console.log('\n=== planOne 对合法指纹仍应正常出方案 ===')
const ok = planOne(
  {
    id: 2,
    name: '合法指纹',
    fingerprint: {
      timezone: 'Australia/Sydney',
      languages: ['en-AU'],
      os: 'windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    },
    proxyCountry: 'United States'
  },
  (fp, pc) => checkConsistency(fp, pc)
)
console.log('  status   =', ok.status)
console.log('  changes  =', JSON.stringify(ok.changes))

console.log('\n=== os 为空时的 uaVsOs 文案 ===')
proposeFixes({ timezone: 'Asia/Tokyo' }, '', ['uaVsOs']).forEach((x) => console.log('  ' + x.key + ': ' + x.reason))
console.log('\n=== os 为空且 UA 也为空（fromUa === target 的双空场景）===')
proposeFixes({}, '', ['uaVsOs']).forEach((x) => console.log('  ' + x.key + ': ' + x.reason))
console.log('\n=== 对照：os=android 的正常文案 ===')
proposeFixes({ os: 'android', userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }, '', ['uaVsOs']).forEach((x) => console.log('  ' + x.key + ': ' + x.reason))