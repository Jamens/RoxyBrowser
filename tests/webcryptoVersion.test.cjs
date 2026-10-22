// WebCrypto 版本一致性体检项 —— 离线单测
// 编译命令（在本仓库根目录执行）：
//   node node_modules/typescript/bin/tsc src/shared/healthcheck.ts src/shared/countries.ts \
//     src/shared/locales.ts src/shared/webglOsMatch.ts --module commonjs --target es2020 \
//     --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_hc --lib es2020,dom
// 然后：node tests/webcryptoVersion.test.cjs
//
// 背景：Chromium 154 起默认提供 ML-KEM / ML-DSA / X-Wing / ChaCha20-Poly1305。
// 升级到 Electron 45（Chromium 156）后，若环境伪装成 Chrome 151/152/153 却能用它们，
// 就是「特性超前」的矛盾信号——平台一行 generateKey 即可识破。
// 本测试锁住体检项对该矛盾的判定。
const assert = require('assert')
const { buildHealthReport } = require('../.tmp_hc/shared/healthcheck.js')

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

/** 取体检报告里的 webcryptoVersion 项 */
function cryptoItem(expectedFp, probeAlgos) {
  const report = buildHealthReport(
    expectedFp,
    Object.assign(
      {
        userAgent: '', platform: '', language: '', languages: [],
        hardwareConcurrency: 0, deviceMemory: 0, doNotTrack: '', maxTouchPoints: 0,
        ontouchstart: false, devicePixelRatio: 1, uaDataPresent: false
      },
      { cryptoNewAlgos: probeAlgos }
    ),
    {}
  )
  return report.items.find((x) => x.key === 'webcryptoVersion')
}

const fp151 = { os: 'windows', uaFullVersion: '151.0.7325.30' }
const fp154 = { os: 'windows', uaFullVersion: '154.0.7521.60' }

t('伪装 151 且新算法不可见 → 通过', () => {
  const it = cryptoItem(fp151, [])
  assert.ok(it, '体检报告里应有 webcryptoVersion 项')
  assert.strictEqual(it.ok, true)
  assert.ok(it.expected.includes('151'), `expected 应写明伪装版本，实际：${it.expected}`)
  assert.ok(it.expected.includes('不应支持'), `expected 应说明不应支持，实际：${it.expected}`)
  assert.strictEqual(it.actual, '均不可用')
})

t('伪装 151 但新算法可见 → 判为矛盾（转红）', () => {
  const it = cryptoItem(fp151, ['ML-KEM-768', 'ML-DSA-65'])
  assert.strictEqual(it.ok, false, '特性超前必须被发现')
  assert.ok(it.actual.includes('ML-KEM-768'), `actual 应列出泄漏的算法，实际：${it.actual}`)
  assert.ok(it.actual.includes('ML-DSA-65'))
})

t('伪装 153 同样受门控（< 154 一律不可见）', () => {
  const fp153 = { os: 'windows', uaFullVersion: '153.0.7458.40' }
  assert.strictEqual(cryptoItem(fp153, []).ok, true)
  assert.strictEqual(cryptoItem(fp153, ['X-Wing']).ok, false, '153 伪装 + X-Wing 可用 = 矛盾')
})

t('伪装 154 且新算法可见 → 通过（不应误报）', () => {
  const it = cryptoItem(fp154, ['ML-KEM-768', 'ML-DSA-65', 'X-Wing', 'ChaCha20-Poly1305'])
  assert.strictEqual(it.ok, true, '伪装 154 就该支持，不该误报')
  assert.ok(it.actual.includes('ML-KEM-768'))
})

t('伪装 154 但新算法不可见 → 不判为矛盾（反向不算破绽）', () => {
  // 真实用户也可能遇到功能被禁用（策略开关 / 平台差异），
  // 「伪装新版却用不了」不是可识别的破绽，只判「超前」这一侧。
  const it = cryptoItem(fp154, [])
  assert.strictEqual(it.ok, true, '只判超前，不判滞后')
})

t('探针未采集该字段（老数据 / 采集失败）时按「不可见」处理，不误报', () => {
  const report = buildHealthReport(fp151, {
    userAgent: '', platform: '', language: '', languages: [],
    hardwareConcurrency: 0, deviceMemory: 0, doNotTrack: '', maxTouchPoints: 0,
    ontouchstart: false, devicePixelRatio: 1, uaDataPresent: false
  }, {})
  const it = report.items.find((x) => x.key === 'webcryptoVersion')
  assert.ok(it)
  assert.strictEqual(it.ok, true, '字段缺失时应保守判通过，而不是误报矛盾')
})

t('uaFullVersion 缺失时按 0 处理，不抛异常', () => {
  const it = cryptoItem({ os: 'windows' }, ['ML-KEM-768'])
  assert.ok(it, '不应因缺 uaFullVersion 而崩')
  assert.strictEqual(it.ok, false, '版本视为 0 → 新算法可见即矛盾')
})

console.log(`\nwebcryptoVersion: ${passed} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
