// 指纹基线对比语义 —— **单测**
//
// ## 为什么需要这个测试
//
// 指纹基线对比（scripts/diff-fingerprint-baseline.cjs）是「内核升级是否改变了
// 伪装输出」的唯一裁判。而它的分类语义有一个**极危险的失败模式**：
//
// 无 GPU 的机器采集时，webgl / webgpu / webgpuSubgroup 三项只会报「不可用」。
// 若把它们当普通实测值参与比较，两份基线都是「不可用」时对比会输出
// 「变化 0 项」——读起来像「WebGL 维度也没变」，实际是**这一维根本没被覆盖**。
// 内核恰好改了 WebGL 输出规则时，回归会被完全漏掉，而且报告看起来是绿的。
//
// 这是「虚假安心」：比漏报更糟的是它伪装成结论。这类判定必须由单测锁死，
// 不能靠人肉读 diff 输出。
//
// 用法：node tests/fingerprintBaseline.test.cjs
const assert = require('assert')
const path = require('path')

const { compareBaselines, inferUncovered } = require('../scripts/diff-fingerprint-baseline.cjs')
const { detectUncovered } = require('../scripts/capture-fingerprint-baseline.cjs')

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

/** 造一份基线快照 */
function snap(actuals, extra) {
  return Object.assign({
    capturedAt: '2026-10-22T11:34:05.071Z',
    profileName: '测试',
    score: 100,
    actuals,
    consistency: {}
  }, extra || {})
}

// ===== 覆盖缺口的判定 =====

t('detectUncovered：WebGL / WebGPU「不可用」判为未覆盖', () => {
  const un = detectUncovered({
    webgl: 'WebGL 不可用',
    webgpu: 'WebGPU 不可用',
    webgpuSubgroup: 'WebGPU 不可用',
    userAgent: 'Mozilla/5.0 ...'
  })
  assert.deepStrictEqual(un.sort(), ['webgl', 'webgpu', 'webgpuSubgroup'])
})

t('detectUncovered：webcryptoVersion「均不可用」不算缺口（那是门控生效的正确结果）', () => {
  const un = detectUncovered({
    webcryptoVersion: '均不可用',
    audioProfile: '48000 / 0.010667 / 2'
  })
  assert.deepStrictEqual(un, [], 'webcryptoVersion 是「探到了、结论是不可见」，不是「没测到」')
})

t('detectUncovered：正常实测值不算缺口', () => {
  const un = detectUncovered({ webgl: 'NVIDIA / GeForce RTX 4070' })
  assert.deepStrictEqual(un, [])
})

t('inferUncovered：旧快照（无 uncovered 字段）能从实测值模式反推', () => {
  const old = snap({ webgl: 'WebGL 不可用', userAgent: 'x' })
  assert.deepStrictEqual(inferUncovered(old), ['webgl'])
})

t('inferUncovered：新快照优先读结构化 uncovered 字段', () => {
  const s = snap({ webgl: 'WebGL 不可用' }, { uncovered: ['webgl', 'customItem'] })
  assert.deepStrictEqual(inferUncovered(s), ['webgl', 'customItem'])
})

// ===== 对比分类语义 =====

t('真变化：两侧都已覆盖且值不同', () => {
  const a = snap({ userAgent: 'UA-151', webgl: 'A / B' })
  const b = snap({ userAgent: 'UA-154', webgl: 'A / B' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.changed.length, 1)
  assert.strictEqual(r.changed[0].key, 'userAgent')
  assert.strictEqual(r.bothUncovered.length, 0)
})

// ===== 身份字段 vs 行为字段：归因不能混 =====

t('★ 身份字段变化 → 归入 identityChanged，不可归因于内核', () => {
  const a = snap({ platform: 'MacIntel', languages: 'ja-JP,ja', canvasNoise: 'on / 一致性OK' })
  const b = snap({ platform: 'Win32', languages: 'en-SG,en', canvasNoise: 'on / 一致性OK' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.identityChanged.length, 2, 'platform / languages 属身份字段')
  assert.strictEqual(r.behaviorChanged.length, 0, '行为字段没变，不该报内核回归')
  assert.strictEqual(r.sameEnvironment, false, '两份不是同一套环境指纹')
})

t('★ 行为字段变化 → 归入 behaviorChanged，这才是内核回归信号', () => {
  const a = snap({ platform: 'Win32', languages: 'zh-CN', canvasNoise: 'on / 一致性OK' })
  const b = snap({ platform: 'Win32', languages: 'zh-CN', canvasNoise: 'off / 不一致' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.behaviorChanged.length, 1)
  assert.strictEqual(r.behaviorChanged[0].key, 'canvasNoise')
  assert.strictEqual(r.identityChanged.length, 0)
  assert.strictEqual(r.sameEnvironment, true, '身份字段一致 → 同一环境')
})

t('同一环境：身份字段全同 → sameEnvironment 为真', () => {
  const base = { userAgent: 'UA-154', platform: 'Win32', languages: 'zh-CN', screen: '1920×1080' }
  const r = compareBaselines(snap(base), snap(Object.assign({}, base)))
  assert.strictEqual(r.sameEnvironment, true)
  assert.strictEqual(r.changed.length, 0)
})

t('★ 双方都未覆盖 → 归入 bothUncovered，不算「无变化」（虚假安心的堵截）', () => {
  const a = snap({ userAgent: 'UA-151', webgl: 'WebGL 不可用' })
  const b = snap({ userAgent: 'UA-151', webgl: 'WebGL 不可用' })
  const r = compareBaselines(a, b)
  // 值确实相同 → changed 为空，这一点本身没错
  assert.strictEqual(r.changed.length, 0)
  // 但必须明确记为「未覆盖」，让报告能提示补采——不能让人读成「这一维没变」
  assert.strictEqual(r.bothUncovered.length, 1)
  assert.strictEqual(r.bothUncovered[0].key, 'webgl')
  assert.strictEqual(r.coverage.a.uncovered.length, 1)
  assert.strictEqual(r.coverage.b.uncovered.length, 1)
})

t('覆盖补齐：A 未覆盖 → B 已覆盖，不算回归', () => {
  const a = snap({ userAgent: 'UA-154', webgl: 'WebGL 不可用' })
  const b = snap({ userAgent: 'UA-154', webgl: 'NVIDIA / GeForce RTX 4070' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.changed.length, 0, '覆盖补齐不得被误判为内核引起的变化')
  assert.strictEqual(r.coverageFilled.length, 1)
  assert.strictEqual(r.coverageFilled[0].key, 'webgl')
  assert.strictEqual(r.bothUncovered.length, 0)
})

t('覆盖丢失：A 已覆盖 → B 未覆盖（换机器采集的典型情况）', () => {
  const a = snap({ userAgent: 'UA-154', webgl: 'NVIDIA / GeForce RTX 4070' })
  const b = snap({ userAgent: 'UA-154', webgl: 'WebGL 不可用' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.coverageLost.length, 1)
  assert.strictEqual(r.coverageLost[0].key, 'webgl')
  assert.strictEqual(r.changed.length, 0)
})

t('新增体检项：B 有 A 无 → added，不算变化', () => {
  const a = snap({ userAgent: 'UA-154' })
  const b = snap({ userAgent: 'UA-154', webcryptoVersion: '均不可用' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.added.length, 1)
  assert.strictEqual(r.added[0].key, 'webcryptoVersion')
  assert.strictEqual(r.changed.length, 0)
})

t('一致性项变化被单独列出', () => {
  const a = snap({ userAgent: 'x' }, { consistency: { tzVsProxy: { ok: true, skipped: true } } })
  const b = snap({ userAgent: 'x' }, { consistency: { tzVsProxy: { ok: false, skipped: false } } })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.consistencyChanged.length, 1)
  assert.strictEqual(r.consistencyChanged[0].key, 'tzVsProxy')
  assert.strictEqual(r.consistencyChanged[0].a, 'skip')
  assert.strictEqual(r.consistencyChanged[0].b, 'fail')
})

t('有效覆盖计数只统计两侧都覆盖的项', () => {
  const a = snap({ ua: 'x', webgl: 'WebGL 不可用', webgpu: 'WebGPU 不可用' })
  const b = snap({ ua: 'x', webgl: 'WebGL 不可用', webgpu: 'WebGPU 不可用' })
  const r = compareBaselines(a, b)
  assert.strictEqual(r.coverage.a.total, 3)
  assert.strictEqual(r.coverage.a.covered, 1)
  assert.strictEqual(r.coverage.coveredKeys, 1, '只有 ua 一项真正参与了对比')
})

console.log(`\nfingerprintBaseline: ${passed} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
