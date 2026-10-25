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

// ============ mulberry32 ============

t('同一 a 值产生同一条序列（确定性）', () => {
  const r1 = C.mulberry32(42), r2 = C.mulberry32(42)
  for (let i = 0; i < 100; i++) assert.strictEqual(r1(), r2())
})

t('不同 a 值产生不同序列', () => {
  const r1 = C.mulberry32(1), r2 = C.mulberry32(2)
  let diff = 0
  for (let i = 0; i < 100; i++) if (r1() !== r2()) diff++
  assert.ok(diff > 90, '前 100 个输出应几乎全都不同')
})

t('输出落在 [0,1)', () => {
  const r = C.mulberry32(7)
  for (let i = 0; i < 1000; i++) {
    const v = r()
    assert.ok(v >= 0 && v < 1, `得到 ${v}`)
  }
})

// ============ noisePixelCount ============

t('约每 1000 像素 1 个，至少 2 个', () => {
  assert.strictEqual(C.noisePixelCount(240, 60), 14)
  assert.strictEqual(C.noisePixelCount(300, 150), 45)
  assert.strictEqual(C.noisePixelCount(1920, 1080), 2073)
  assert.strictEqual(C.noisePixelCount(8, 8), 2, '再小也有 2 个')
  assert.strictEqual(C.noisePixelCount(0, 100), 2, '空画布也返回 2（调用方有尺寸守卫）')
})

// ============ applyIdempotentNoise ============

/** 造一块确定内容的 RGBA 画布（alpha=255 的不透明像素 + 全透明背景） */
function makeCanvas(w, h) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = (i * 7) % 256
    d[i * 4 + 1] = (i * 13) % 256
    d[i * 4 + 2] = (i * 29) % 256
    d[i * 4 + 3] = i % 3 === 0 ? 0 : 255 // 三分之一全透明
  }
  return d
}

t('相同 (seed,w,h) 两次施加结果完全一致（跨读取稳定）', () => {
  const a = makeCanvas(120, 80), b = makeCanvas(120, 80)
  C.applyIdempotentNoise(a, 42, 120, 80)
  C.applyIdempotentNoise(b, 42, 120, 80)
  assert.deepStrictEqual(Array.from(a), Array.from(b))
})

t('幂等：施加两次 === 施加一次（图像回环检查的根基）', () => {
  const once = makeCanvas(120, 80), twice = makeCanvas(120, 80)
  C.applyIdempotentNoise(once, 42, 120, 80)
  C.applyIdempotentNoise(twice, 42, 120, 80)
  C.applyIdempotentNoise(twice, 42, 120, 80)
  assert.deepStrictEqual(Array.from(twice), Array.from(once), 'N(N(x)) 必须 === N(x)')
  // 三次也一样
  C.applyIdempotentNoise(twice, 42, 120, 80)
  assert.deepStrictEqual(Array.from(twice), Array.from(once))
})

t('噪声确实改了像素（不是空操作）', () => {
  const d = makeCanvas(300, 150)
  const before = Array.from(d)
  C.applyIdempotentNoise(d, 42, 300, 150)
  let diff = 0
  for (let i = 0; i < d.length; i++) if (d[i] !== before[i]) diff++
  assert.ok(diff > 0, '至少要有像素被改动')
  // 每个被选中的像素至多动 R/G/B 三个通道、每通道差值不超过 1（LSB）
  for (let i = 0; i < d.length; i++) {
    if (d[i] !== before[i]) assert.ok(Math.abs(d[i] - before[i]) <= 1, `位置 ${i} 差值 ${d[i] - before[i]}`)
  }
})

t('常见尺寸下「完全落空」概率可忽略（曾实测 seed 42 @300x150 单通道全落空）', () => {
  // 扫一批种子：每个种子都应至少改动一个像素。
  // 双保险：位置只从「不透明像素索引表」抽取（100% 落在不透明像素），
  // 且密度 /1000 让最小画布也有 ≥8 个位置，单个位置空操作概率 1/8。
  for (const [w, h] of [[240, 60], [300, 150], [280, 60], [220, 40]]) {
    for (let seed = 1; seed <= 50; seed++) {
      const d = makeCanvas(w, h)
      const before = Array.from(d)
      C.applyIdempotentNoise(d, seed, w, h)
      const diff = d.some((v, i) => v !== before[i])
      assert.ok(diff, `(${w},${h}) seed=${seed} 完全落空`)
    }
  }
})

t('全透明像素（alpha=0）完全不动', () => {
  const d = makeCanvas(120, 80)
  const before = Array.from(d)
  C.applyIdempotentNoise(d, 42, 120, 80)
  for (let p = 0; p < d.length; p += 4) {
    if (before[p + 3] === 0) {
      assert.strictEqual(d[p], before[p], `透明像素 R @${p}`)
      assert.strictEqual(d[p + 1], before[p + 1], `透明像素 G @${p}`)
      assert.strictEqual(d[p + 2], before[p + 2], `透明像素 B @${p}`)
    }
  }
})

t('Alpha 通道永不被修改（只动 RGB）', () => {
  const d = makeCanvas(120, 80)
  const beforeAlpha = []
  for (let p = 3; p < d.length; p += 4) beforeAlpha.push(d[p])
  C.applyIdempotentNoise(d, 42, 120, 80)
  for (let p = 3, i = 0; p < d.length; p += 4, i++) {
    assert.strictEqual(d[p], beforeAlpha[i], `alpha @${p}`)
  }
})

t('不同环境种子施加结果不同（跨环境可区分）', () => {
  const a = makeCanvas(300, 150), b = makeCanvas(300, 150)
  C.applyIdempotentNoise(a, 1, 300, 150)
  C.applyIdempotentNoise(b, 2, 300, 150)
  assert.notDeepStrictEqual(Array.from(a), Array.from(b))
})

t('同种子不同尺寸结果不同（按画布维度派生）', () => {
  const a = makeCanvas(300, 150), b = makeCanvas(150, 300)
  C.applyIdempotentNoise(a, 42, 300, 150)
  C.applyIdempotentNoise(b, 42, 150, 300)
  assert.notDeepStrictEqual(Array.from(a), Array.from(b))
})

t('两块同尺寸同内容的画布得到相同噪声（x0 双绘一致性）', () => {
  // 两块都填纯白不透明：模拟 browserscan x0 的「两块纯色画布输出必须一致」
  const mk = () => { const d = new Uint8ClampedArray(240 * 60 * 4); for (let p = 0; p < d.length; p += 4) { d[p] = 255; d[p+1] = 255; d[p+2] = 255; d[p+3] = 255 } return d }
  const a = mk(), b = mk()
  C.applyIdempotentNoise(a, 42, 240, 60)
  C.applyIdempotentNoise(b, 42, 240, 60)
  assert.deepStrictEqual(Array.from(a), Array.from(b))
})

t('非正尺寸直接返回不修改', () => {
  const d = makeCanvas(4, 4)
  const before = Array.from(d)
  C.applyIdempotentNoise(d, 42, 0, 100)
  C.applyIdempotentNoise(d, 42, 100, 0)
  assert.deepStrictEqual(Array.from(d), before)
})

console.log(`\ncanvasNoise: ${pass} passed, ${fail} failed`)