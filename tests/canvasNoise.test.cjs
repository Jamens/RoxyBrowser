/**
 * Canvas 噪声派生（canvasNoise.ts）离线单测。
 *
 * 核心约束：**相同 (环境种子, 宽, 高) 必须得到完全相同的噪声种子**。
 * 检测站判定「Canvas 被注入」的首要检查点就是「同一画布两次读取是否一致」——
 * 若噪声随调用推进，两个相同画布会拿到不同噪声，等于主动承认被改过。
 * 本模块此前零测试。
 */
const assert = require('assert')

const C = require('../.tmp_cn/shared/canvasNoise.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

// ============ hashString（FNV-1a）============

t('空串返回 FNV offset basis 2166136261', () => {
  assert.strictEqual(C.hashString(''), 2166136261)
})

t('空串与 null/undefined 等价（内部统一转空串）', () => {
  assert.strictEqual(C.hashString(''), C.hashString(null))
  assert.strictEqual(C.hashString(''), C.hashString(undefined))
})

t('同一字符串多次哈希结果一致', () => {
  assert.strictEqual(C.hashString('abc'), C.hashString('abc'))
  assert.strictEqual(C.hashString('Google Inc. (Intel)'), C.hashString('Google Inc. (Intel)'))
})

t('不同字符串哈希不同', () => {
  assert.notStrictEqual(C.hashString('abc'), C.hashString('abd'))
  assert.notStrictEqual(C.hashString('abc'), C.hashString('abcc'))
})

t('返回值恒为 uint32（非负整数）', () => {
  for (const s of ['', 'a', 'abc', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090)', 'x'.repeat(1000)]) {
    const h = C.hashString(s)
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 4294967295, `${s.slice(0, 20)} 得到 ${h}`)
  }
})

t('大小写敏感（FNV 逐字节，不做归一）', () => {
  assert.notStrictEqual(C.hashString('NVIDIA'), C.hashString('nvidia'))
})

// ============ canvasNoiseSeed ============

t('相同 (seed, w, h) 必返回相同值（防篡改检测的根基）', () => {
  for (const [s, w, h] of [[100, 300, 150], [0, 8, 8], [42, 1920, 1080], [2 ** 31 - 1, 1, 1]]) {
    assert.strictEqual(
      C.canvasNoiseSeed(s, w, h),
      C.canvasNoiseSeed(s, w, h),
      `(${s},${w},${h}) 应稳定`
    )
  }
})

t('宽变化大概率改变种子', () => {
  const base = C.canvasNoiseSeed(100, 300, 150)
  const changed = C.canvasNoiseSeed(100, 301, 150)
  assert.notStrictEqual(base, changed)
})

t('高变化大概率改变种子', () => {
  assert.notStrictEqual(C.canvasNoiseSeed(100, 300, 150), C.canvasNoiseSeed(100, 300, 151))
})

t('环境种子变化改变结果', () => {
  assert.notStrictEqual(C.canvasNoiseSeed(100, 300, 150), C.canvasNoiseSeed(101, 300, 150))
})

t('返回值恒为 uint32', () => {
  for (const [s, w, h] of [[0, 0, 0], [1, 1, 1], [2 ** 31, 9999, 9999], [-5, 100, 100]]) {
    const v = C.canvasNoiseSeed(s, w, h)
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 4294967295, `(${s},${w},${h}) 得到 ${v}`)
  }
})

t('宽高不对称：(300,150) 与 (150,300) 不同（交换维度不应撞车）', () => {
  assert.notStrictEqual(C.canvasNoiseSeed(100, 300, 150), C.canvasNoiseSeed(100, 150, 300))
})

t('非整数宽高被截断为整数（|0）', () => {
  assert.strictEqual(C.canvasNoiseSeed(100, 300.7, 150.2), C.canvasNoiseSeed(100, 300, 150))
})

t('NaN seed 归一为 0', () => {
  assert.strictEqual(C.canvasNoiseSeed(NaN, 300, 150), C.canvasNoiseSeed(0, 300, 150))
})

t('大量样本无重复碰撞（在合理范围内唯一）', () => {
  const seen = new Set()
  for (let w = 1; w <= 40; w++) {
    for (let h = 1; h <= 40; h++) seen.add(C.canvasNoiseSeed(7, w, h))
  }
  assert.strictEqual(seen.size, 1600, '1600 个不同尺寸应产生 1600 个不同种子')
})

// ============ isTinyCanvas ============

t('默认阈值 8px：小于 8 即极小', () => {
  assert.strictEqual(C.isTinyCanvas(1, 1), true)
  assert.strictEqual(C.isTinyCanvas(7, 100), true, '宽 < 8 即极小')
  assert.strictEqual(C.isTinyCanvas(100, 1), true, '高 < 8 即极小')
})

t('恰好等于阈值不算极小（严格小于）', () => {
  assert.strictEqual(C.isTinyCanvas(8, 8), false)
  assert.strictEqual(C.isTinyCanvas(8, 100), false)
  assert.strictEqual(C.isTinyCanvas(100, 8), false)
})

t('大于阈值不算极小', () => {
  assert.strictEqual(C.isTinyCanvas(9, 9), false)
  assert.strictEqual(C.isTinyCanvas(1920, 1080), false)
})

t('自定义阈值生效', () => {
  assert.strictEqual(C.isTinyCanvas(10, 10, 16), true)
  assert.strictEqual(C.isTinyCanvas(16, 16, 16), false)
  assert.strictEqual(C.isTinyCanvas(20, 20, 16), false)
})

t('非整数尺寸被截断后判定', () => {
  assert.strictEqual(C.isTinyCanvas(7.9, 100), true, '7.9 截断为 7 → 极小')
  assert.strictEqual(C.isTinyCanvas(8.1, 100), false, '8.1 截断为 8 → 非极小')
})

// ============ effectiveCanvasSeed ============

t('有种子时原样返回', () => {
  assert.strictEqual(C.effectiveCanvasSeed(42, 'abc'), 42)
  assert.strictEqual(C.effectiveCanvasSeed(1, 'abc'), 1)
})

t('种子为 0 时回退文本哈希（避免所有无种子环境撞同一套噪声）', () => {
  assert.strictEqual(C.effectiveCanvasSeed(0, 'abc'), C.hashString('abc'))
})

t('种子为 null/undefined 时同样回退', () => {
  assert.strictEqual(C.effectiveCanvasSeed(null, 'abc'), C.hashString('abc'))
  assert.strictEqual(C.effectiveCanvasSeed(undefined, 'abc'), C.hashString('abc'))
})

t('回退文本为空时用默认值 roxy', () => {
  assert.strictEqual(C.effectiveCanvasSeed(0, ''), C.hashString('roxy'))
  assert.strictEqual(C.effectiveCanvasSeed(0, null), C.hashString('roxy'))
})

t('不同回退文本得到不同种子（无种子环境之间仍可区分）', () => {
  assert.notStrictEqual(C.effectiveCanvasSeed(0, 'envA'), C.effectiveCanvasSeed(0, 'envB'))
})

t('负种子不被当作缺失（仅 0/null/undefined 回退）', () => {
  // `profileSeed && profileSeed !== 0` —— 负数 truthy 且非 0，故原样返回
  assert.strictEqual(C.effectiveCanvasSeed(-5, 'abc'), -5)
})

console.log(`\ncanvasNoise: ${pass} passed, ${fail} failed`)