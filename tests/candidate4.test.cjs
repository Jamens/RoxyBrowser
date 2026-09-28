// 候选④ 离线单测：WebGPU 回退守卫 + Canvas 噪声确定性派生。
// 纯函数编译为 CJS 后在 Node 直接跑（无需 Electron / DOM）。
// 编译命令（在本仓库根目录执行）：
//   node node_modules/typescript/bin/tsc src/shared/webgpu.ts src/shared/canvasNoise.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_c4
// 然后：node tests/candidate4.test.cjs

const assert = require('assert')
const { webGpuSpoofAllowed } = require('../.tmp_c4/webgpu.js')
const { hashString, canvasNoiseSeed, isTinyCanvas, effectiveCanvasSeed } = require('../.tmp_c4/canvasNoise.js')

// 与 preload 同源的 mulberry32：用于验证「相同 (seed,w,h) 派生出完全相同的噪声序列」
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let pass = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok  -', name)
  } catch (e) {
    console.error('  FAIL -', name, '\n      ', e.message)
    process.exitCode = 1
  }
}

console.log('WebGPU webGpuSpoofAllowed')
check('软件渲染回退 → 不伪装', () => assert.strictEqual(webGpuSpoofAllowed(true), false))
check('正常适配器 → 允许伪装', () => assert.strictEqual(webGpuSpoofAllowed(false), true))
check('undefined 兜底为不伪装（防止误判）', () => assert.strictEqual(webGpuSpoofAllowed(undefined), true))

console.log('canvasNoise.hashString')
check('相同字符串稳定', () => assert.strictEqual(hashString('nvidia'), hashString('nvidia')))
check('空串稳定且为 0 之外的正整数', () => {
  const h = hashString('')
  assert.strictEqual(typeof h, 'number')
  assert.ok(Number.isInteger(h) && h >= 0 && h < 4294967296)
})
check('不同字符串大概率不同', () => assert.notStrictEqual(hashString('nvidia'), hashString('intel')))

console.log('canvasNoise.canvasNoiseSeed')
check('相同 (seed,w,h) 稳定', () =>
  assert.strictEqual(canvasNoiseSeed(123, 240, 60), canvasNoiseSeed(123, 240, 60)))
check('返回 uint32', () => {
  const v = canvasNoiseSeed(99, 100, 100)
  assert.ok(Number.isInteger(v) && v >= 0 && v < 4294967296)
})
check('宽/高/种子任一变化应改变序列种子（区分不同画布）', () => {
  const a = canvasNoiseSeed(123, 240, 60)
  const b = canvasNoiseSeed(123, 240, 61)
  const c = canvasNoiseSeed(124, 240, 60)
  assert.notStrictEqual(a, b)
  assert.notStrictEqual(a, c)
})

console.log('canvasNoise.isTinyCanvas')
check('1×N 细条视为极小', () => assert.strictEqual(isTinyCanvas(1, 100), true))
check('8×8 阈值边界（<8 → 极小）', () => assert.strictEqual(isTinyCanvas(7, 7), true))
check('8×8 非极小', () => assert.strictEqual(isTinyCanvas(8, 8), false))
check('默认 240×60 非极小', () => assert.strictEqual(isTinyCanvas(240, 60), false))

console.log('canvasNoise.effectiveCanvasSeed')
check('非零种子原样返回', () => assert.strictEqual(effectiveCanvasSeed(2654435761, 'nvidia'), 2654435761))
check('种子为 0 → 退回文本哈希', () => {
  const v = effectiveCanvasSeed(0, 'nvidia')
  assert.strictEqual(v, hashString('nvidia'))
  assert.ok(v !== 0)
})
check('种子为 NaN → 退回文本哈希', () => {
  const v = effectiveCanvasSeed(NaN, 'intel')
  assert.strictEqual(v, hashString('intel'))
})
check('回退结果稳定', () => assert.strictEqual(effectiveCanvasSeed(0, 'amd'), effectiveCanvasSeed(0, 'amd')))

console.log('噪声序列一致性（canvasStable 的根因）')
check('相同 (seed,w,h) → 两次噪声序列逐位相等', () => {
  const s = 2654435761
  const r1 = mulberry32(canvasNoiseSeed(s, 240, 60))
  const r2 = mulberry32(canvasNoiseSeed(s, 240, 60))
  for (let i = 0; i < 20; i++) assert.strictEqual(r1(), r2())
})
check('不同尺寸 → 噪声序列不同（环境间/画布间可区分）', () => {
  const s = 2654435761
  const r1 = mulberry32(canvasNoiseSeed(s, 240, 60))
  const r2 = mulberry32(canvasNoiseSeed(s, 241, 60))
  let diff = false
  for (let i = 0; i < 20; i++) if (r1() !== r2()) { diff = true; break }
  assert.ok(diff, '不同尺寸的噪声序列应不同')
})

console.log(`\n通过 ${pass} 项`)
