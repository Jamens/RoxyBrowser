/**
 * WebAudio 指纹派生（webaudio.ts）离线单测。
 *
 * 核心约束：**同环境稳定、异环境不同**，且各字段之间自洽
 * （baseLatency 必须是 sampleRate 的整数分之一）。本模块此前零测试。
 * 断言全部先跑真实实现确认过，而非凭直觉推断。
 */
const assert = require('assert')

const A = require('../.tmp_wa/shared/webaudio.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const SEEDS = [1, 42, 12345, 99999, 2654435761, 2 ** 31 - 1]

// ============ 确定性 ============

t('同一 (seed, os) 多次调用结果完全一致', () => {
  for (const s of SEEDS) {
    const a = A.audioProfileFor(s, 'windows')
    const b = A.audioProfileFor(s, 'windows')
    assert.deepStrictEqual(a, b, `seed=${s} 应稳定`)
  }
})

t('不同 seed 的结果不同（异环境可区分）', () => {
  const a = A.audioProfileFor(12345, 'windows')
  const b = A.audioProfileFor(99999, 'windows')
  assert.notDeepStrictEqual(a, b)
})

t('seed=0 与 seed=NaN 结果相同（都被 Number(seed)||0 归一）', () => {
  // 这是**已知等价关系**：`const s = Number(seed) || 0` 把 NaN 与 0 视为同一输入。
  // 固定下来以免将来有人误以为两者会产生不同档案。
  assert.deepStrictEqual(A.audioProfileFor(0, 'windows'), A.audioProfileFor(NaN, 'windows'))
})

t('seed=0 本身能产出合法档案（不是全零/空）', () => {
  const p = A.audioProfileFor(0, 'windows')
  assert.ok([44100, 48000].includes(p.sampleRate))
  assert.ok([2, 6, 8].includes(p.maxChannelCount))
})

// ============ 字段取值域 ============

t('sampleRate 只取 44100 或 48000', () => {
  for (const s of SEEDS) {
    for (const os of ['windows', 'mac', 'android', 'ios']) {
      const r = A.audioProfileFor(s, os).sampleRate
      assert.ok(r === 44100 || r === 48000, `seed=${s} os=${os} 得到 ${r}`)
    }
  }
})

t('maxChannelCount 只取 2 / 6 / 8', () => {
  for (const s of SEEDS) {
    const c = A.audioProfileFor(s, 'windows').maxChannelCount
    assert.ok([2, 6, 8].includes(c), `得到 ${c}`)
  }
})

t('绝大多数环境是 2 声道（贴合真实人群分布）', () => {
  let two = 0
  const N = 200
  for (let i = 1; i <= N; i++) if (A.audioProfileFor(i, 'windows').maxChannelCount === 2) two++
  // 代码里 chRoll < 0.9 → 2，即期望约 90%
  assert.ok(two / N > 0.8, `2 声道占比 ${(two / N * 100).toFixed(0)}% 过低`)
  assert.ok(two / N < 1.0, '应存在少量多声道，不应全部为 2')
})

t('compressorReduction 为小幅负值（贴近真实量级，不是常量）', () => {
  const vals = SEEDS.map((s) => A.audioProfileFor(s, 'windows').compressorReduction)
  for (const v of vals) {
    assert.ok(v < 0, `应为负值，实际 ${v}`)
    assert.ok(v > -3, `幅度应 ≤3dB，实际 ${v}`)
  }
  // 不能是同一个常量——否则所有环境在该维度上完全相同，等于互相撞车
  assert.strictEqual(new Set(vals).size > 1, true, '不同 seed 的 reduction 应不同')
})

t('compressorReduction 不为 0（无信号流过时真实值为 0，常量 0 会自我标记）', () => {
  for (const s of SEEDS) {
    assert.notStrictEqual(A.audioProfileFor(s, 'windows').compressorReduction, 0)
  }
})

// ============ baseLatency 与 sampleRate 自洽 ============

t('baseLatency 由 bufferSize/sampleRate 推导（128/256/512）', () => {
  for (const s of SEEDS) {
    const p = A.audioProfileFor(s, 'windows')
    const buffer = p.baseLatency * p.sampleRate
    // 注意：因 toFixed(6) 舍入，baseLatency 与 bufferSize/sampleRate 只是**近似**相等，
    // 反推误差最大约 0.5e-6 × 48000 ≈ 0.024。故容差取 0.05。
    // 这是已知的微小不精确（真实浏览器同样上报浮点值，影响可忽略），此处固定该事实。
    assert.ok(
      [128, 256, 512].some((b) => Math.abs(buffer - b) < 0.05),
      `seed=${s} 反推 bufferSize=${buffer.toFixed(4)} 不在 128/256/512 之列`
    )
  }
})

t('baseLatency 为正值且量级合理（毫秒级）', () => {
  for (const s of SEEDS) {
    const l = A.audioProfileFor(s, 'windows').baseLatency
    assert.ok(l > 0 && l < 0.05, `baseLatency=${l} 超出合理区间`)
  }
})

t('48000Hz 的 baseLatency 小于 44100Hz 的（同 bufferSize 下）', () => {
  // 同一 bufferSize 时采样率越高延迟越低——这是物理关系，派生结果应符合
  let checked = 0
  for (let i = 1; i <= 100 && checked < 5; i++) {
    const p = A.audioProfileFor(i, 'windows')
    const buf = Math.round(p.baseLatency * p.sampleRate)
    if (buf === 512 && p.sampleRate === 48000) {
      // 找到 48000 的样本，再找一个 44100 且 buffer 相同的
      for (let j = 1; j <= 100; j++) {
        const q = A.audioProfileFor(j, 'windows')
        if (q.sampleRate === 44100 && Math.abs(q.baseLatency * q.sampleRate - 512) < 0.05) {
          assert.ok(p.baseLatency < q.baseLatency, '同 bufferSize 下 48k 延迟应更低')
          checked++
          break
        }
      }
    }
  }
  assert.ok(checked > 0, '应至少比到一对同 bufferSize 的不同采样率')
})

// ============ 移动端分布 ============

t('移动端 48k 占比高于桌面（贴近真实设备分布）', () => {
  const N = 300
  let mob = 0, desk = 0
  for (let i = 1; i <= N; i++) {
    if (A.audioProfileFor(i, 'android').sampleRate === 48000) mob++
    if (A.audioProfileFor(i, 'windows').sampleRate === 48000) desk++
  }
  assert.ok(mob > desk, `移动端 ${mob} 应高于桌面 ${desk}`)
  // 代码常量：移动 0.85、桌面 0.72
  assert.ok(mob / N > 0.7, `移动端 48k 占比 ${(mob / N * 100).toFixed(0)}% 偏离预期`)
  assert.ok(desk / N > 0.6, `桌面 48k 占比 ${(desk / N * 100).toFixed(0)}% 偏离预期`)
})

t('os 只区分移动/桌面两类（android 与 ios 同分布口径）', () => {
  // 代码里 mobile = os==='android' || os==='ios'，两者用同一阈值
  assert.strictEqual(
    A.audioProfileFor(777, 'android').sampleRate,
    A.audioProfileFor(777, 'ios').sampleRate
  )
})

// ============ 无副作用 ============

t('连续调用不累积状态（纯函数）', () => {
  const first = A.audioProfileFor(4242, 'windows')
  for (let i = 0; i < 50; i++) A.audioProfileFor(i, 'android')
  assert.deepStrictEqual(A.audioProfileFor(4242, 'windows'), first)
})

console.log(`\nwebaudio: ${pass} passed, ${fail} failed`)