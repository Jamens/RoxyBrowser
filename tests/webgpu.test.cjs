/**
 * WebGPU 指纹伪装（webgpu.ts）离线单测。
 *
 * 核心原则：**识别不出就不伪造**。宁可让该项在体检里标「不适用」，
 * 也不要给出与 WebGL 自相矛盾的架构——矛盾信号比不伪装更可疑。
 * 本文件的断言全部围绕这条原则，且先跑真实实现确认过匹配结果。
 */
const assert = require('assert')

const W = require('../.tmp_gpu/shared/webgpu.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const EMPTY = { vendor: '', architecture: '', device: '', description: '' }

// ============ webGpuSupported ============

t('iOS 不支持 WebGPU（必须整体隐藏）', () => {
  assert.strictEqual(W.webGpuSupported('ios'), false)
})

t('其余平台支持', () => {
  for (const os of ['android', 'windows', 'mac', 'linux']) {
    assert.strictEqual(W.webGpuSupported(os), true, os)
  }
})

t('空 os 视为支持（保守：仅 ios 明确不支持）', () => {
  assert.strictEqual(W.webGpuSupported(''), true)
})

// ============ webGpuSpoofAllowed ============

t('硬件适配器允许伪装', () => {
  assert.strictEqual(W.webGpuSpoofAllowed(false), true)
})

t('软件渲染回退（SwiftShader）禁止伪装', () => {
  // 回退时若把 vendor 覆盖成独显，会造出「WebGL 说独显、WebGPU 说软件渲染」的矛盾
  assert.strictEqual(W.webGpuSpoofAllowed(true), false)
})

// ============ NVIDIA 架构族 ============

t('RTX 40 系 → ada-lovelace', () => {
  const r = W.webGpuInfoFor('windows', 'NVIDIA', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)')
  assert.strictEqual(r.vendor, 'nvidia')
  assert.strictEqual(r.architecture, 'ada-lovelace')
})

t('RTX 30 系 → ampere', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'NVIDIA', 'RTX 3070').architecture, 'ampere')
})

t('RTX 20 系 → turing', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'NVIDIA', 'RTX 2060').architecture, 'turing')
})

t('GTX 16 系 → turing（与 RTX 20 同代）', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'NVIDIA', 'GTX 1660 Ti').architecture, 'turing')
})

t('GTX 10 系 → pascal', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'NVIDIA', 'GTX 1050').architecture, 'pascal')
})

t('未收录的新型号（RTX 5090）→ 不伪造', () => {
  // 这是「宁缺毋滥」的体现：型号没被收录时返回 EMPTY，
  // 而不是兜底成某个架构（那会造出「WebGL 说 RTX 5090、WebGPU 说 ampere」的矛盾）
  const r = W.webGpuInfoFor('windows', 'NVIDIA', 'RTX 5090')
  assert.deepStrictEqual(r, EMPTY)
})

// ============ Intel 架构族 ============

t('Intel Arc → xe-lpg', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'Intel', 'Intel Arc A770').architecture, 'xe-lpg')
})

t('Iris Xe → gen-12lp', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'Intel', 'Intel Iris Xe Graphics').architecture, 'gen-12lp')
})

t('UHD Graphics → gen-9', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'Intel', 'Intel UHD Graphics 630').architecture, 'gen-9')
})

t('HD Graphics → gen-9', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'Intel', 'Intel HD Graphics 620').architecture, 'gen-9')
})

t('Iris Plus（既非 Xe 也无 HD 前缀）→ gen-9 兜底', () => {
  // 注释特例：指纹池里的 "Iris(TM) Plus Graphics 655" 需要单独兜底
  assert.strictEqual(W.webGpuInfoFor('windows', 'Intel', 'Intel Iris(TM) Plus Graphics 655').architecture, 'gen-9')
})

t('未收录的 Intel 型号 → 不伪造', () => {
  const r = W.webGpuInfoFor('windows', 'Intel', 'Intel Something New 9000')
  assert.deepStrictEqual(r, EMPTY)
})

// ============ AMD 架构族 ============

t('RX 7000 系 → rdna-3', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'AMD', 'AMD Radeon RX 7900 XTX').architecture, 'rdna-3')
})

t('RX 6000 系 → rdna-2', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'AMD', 'AMD Radeon RX 6600').architecture, 'rdna-2')
})

t('RX Vega → rdna-1', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'AMD', 'AMD Radeon RX Vega 56').architecture, 'rdna-1')
})

t('RX 500 三位数型号匹配不到（正则要求四位）→ 不伪造', () => {
  // 实测确认：RX 580 是常见卡，但 RX\s*5\d\d\d 要求 RX 后跟 4 位数字，
  // "580" 只有 3 位，故落到 EMPTY。这是**已知缺口**，方向仍是安全的
  // （不伪造而非伪造错），故只固定行为、不在本次测试任务里改正则。
  const r = W.webGpuInfoFor('windows', 'AMD', 'AMD Radeon RX 580')
  assert.deepStrictEqual(r, EMPTY)
})

// ============ 移动端与回退判定 ============

t('Adreno：vendor 为空但型号在 renderer → 仍可识别', () => {
  // 移动端 WebGL vendor 常只写 "Qualcomm"/"ARM"，型号在 renderer 里
  const r = W.webGpuInfoFor('android', '', 'Qualcomm Adreno 740')
  assert.strictEqual(r.vendor, 'qualcomm')
  assert.strictEqual(r.architecture, 'adreno')
})

t('Mali：vendor 为空但型号在 renderer → 仍可识别', () => {
  const r = W.webGpuInfoFor('android', '', 'ARM Mali-G78')
  assert.strictEqual(r.vendor, 'arm')
  assert.strictEqual(r.architecture, 'mali')
})

t('vendor 大小写不敏感', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'nvidia', 'RTX 4090').vendor, 'nvidia')
  assert.strictEqual(W.webGpuInfoFor('windows', 'NVIDIA', 'RTX 4090').vendor, 'nvidia')
  assert.strictEqual(W.webGpuInfoFor('windows', 'nViDiA', 'RTX 4090').vendor, 'nvidia')
})

t('radeon 也归到 amd（品牌名混用）', () => {
  assert.strictEqual(W.webGpuInfoFor('windows', 'Radeon Technologies', 'RX 7900').vendor, 'amd')
})

t('完全识别不出 → EMPTY', () => {
  assert.deepStrictEqual(W.webGpuInfoFor('windows', 'Unknown Vendor', 'Unknown Renderer'), EMPTY)
  assert.deepStrictEqual(W.webGpuInfoFor('windows', '', ''), EMPTY)
})

// ============ 平台短路与字段约束 ============

t('iOS 直接返回 EMPTY，不再看 vendor/renderer', () => {
  const r = W.webGpuInfoFor('ios', 'NVIDIA', 'RTX 4090')
  assert.deepStrictEqual(r, EMPTY)
})

t('device / description 恒为空串（真实 Chrome 默认如此，填值反而穿帮）', () => {
  const r = W.webGpuInfoFor('windows', 'NVIDIA', 'RTX 4090')
  assert.strictEqual(r.device, '')
  assert.strictEqual(r.description, '')
})

t('EMPTY_WEBGPU_INFO 是常量，调用方不得改动', () => {
  // 该常量被多处引用，若被就地修改会污染所有「不伪装」的路径
  assert.deepStrictEqual(W.EMPTY_WEBGPU_INFO, EMPTY)
  W.webGpuInfoFor('ios', 'NVIDIA', 'RTX 4090')
  assert.deepStrictEqual(W.EMPTY_WEBGPU_INFO, EMPTY, '调用后常量应保持不变')
})

t('识别成功与失败返回的是不同对象（不共享可变引用）', () => {
  const ok = W.webGpuInfoFor('windows', 'NVIDIA', 'RTX 4090')
  assert.notStrictEqual(ok, W.EMPTY_WEBGPU_INFO, '成功路径不得返回共享常量')
  ok.vendor = 'mutated'
  assert.strictEqual(W.EMPTY_WEBGPU_INFO.vendor, '', '改成功结果不得影响常量')
})

console.log(`\nwebgpu: ${pass} passed, ${fail} failed`)