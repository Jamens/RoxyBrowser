// 候选④ 体检逻辑仿真：在「无显卡本机」上直接验证 buildHealthReport 对四个新检查项的判定是否正确。
// 不依赖 GPU / 窗口——只验证「给定探针数据后，体检项怎么算」这一纯逻辑层。
// 编译：node node_modules/typescript/bin/tsc src/shared/healthcheck.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --lib es2020,dom --outDir .tmp_hc
// 运行：node tests/healthcheck_sim.cjs

const { buildHealthReport } = require('../.tmp_hc/healthcheck.js')

// 一个完整的探针基线（所有必填字段给中性默认值），按场景覆盖
function baseProbe() {
  return {
    userAgent: 'Mozilla/5.0', platform: 'Win32', language: 'en-US', languages: ['en-US'],
    hardwareConcurrency: 8, deviceMemory: 8, doNotTrack: 'unspecified', maxTouchPoints: 0,
    ontouchstart: false, devicePixelRatio: 1, uaDataPresent: true, uaDataPlatform: 'Windows',
    uaDataMobile: false, screenWidth: 1920, screenHeight: 1080, tzOffset: -480, timezone: 'Asia/Shanghai',
    webglVendor: 'NVIDIA Corporation', webglRenderer: 'NVIDIA GeForce RTX 4070', webglAvailable: true,
    canvasPatched: true, audioPatched: true, webrtcDisabled: false, fontsGuarded: true,
    webGpuPresent: true, webGpuAdapterAvailable: true, webGpuVendor: 'nvidia', webGpuArchitecture: 'ada-lovelace',
    webGpuIsFallback: false, webGpuSubgroupMinSize: 16, webGpuSubgroupMaxSize: 64,
    canvasStable: true,
    audioSampleRate: 48000, audioBaseLatency: 0.002666, audioMaxChannelCount: 2, audioReduction: -1.2345, audioAvailable: true,
    audioCanIamf: '', audioCanOpus: 'probably', audioCanAac: 'probably',
    emeApiPresent: true, emeWidevine: true, emeClearKey: true, emePlayReady: false, emeInitDataTypes: ['cenc', 'cbcs'], emeVideoCaps: 10, emeAudioCaps: 3,
    webdriver: false, automationTraces: false,
    apiBluetooth: false, apiUsb: false, apiSerial: false, apiHid: false, apiNfc: false,
    prefersColorScheme: 'light', prefersReducedMotion: false
  }
}

function run(name, fp, probeOverride, audioSeed) {
  const probe = Object.assign(baseProbe(), probeOverride)
  const report = buildHealthReport(fp, probe, { audioSeed: audioSeed ?? 12345 })
  const items = Object.fromEntries(report.items.map((i) => [i.key, i]))
  console.log('\n=== ' + name + ' ===')
  for (const k of ['webgpu', 'webgpuSubgroup', 'canvasNoise', 'audioCodecs']) {
    const it = items[k]
    if (!it) { console.log('  [' + k + '] 缺失'); continue }
    console.log(`  [${k}] ok=${it.ok} weight=${it.weight} expected="${it.expected}" actual="${it.actual}"`)
  }
  return items
}

let fail = 0
function assert(cond, msg) { if (!cond) { fail++; console.error('  ✗ ' + msg) } else { console.log('  ✓ ' + msg) } }

// A. 正常独显桌面（NVIDIA）：四项都应正确通过
{
  const fp = { os: 'windows', webglVendor: 'NVIDIA Corporation', webglRenderer: 'NVIDIA GeForce RTX 4070', canvasNoise: true, audioNoise: true }
  const it = run('A. NVIDIA 独显桌面（应全部通过）', fp, {})
  assert(it.webgpu.ok && it.webgpu.weight === 8, 'webgpu 通过且权重 8')
  assert(it.webgpuSubgroup.ok && it.webgpuSubgroup.weight === 0, 'webgpuSubgroup 通过且权重 0')
  assert(it.canvasNoise.ok && it.canvasNoise.weight === 6, 'canvasNoise 稳定通过且权重 6')
  assert(it.audioCodecs.ok && it.audioCodecs.weight === 0, 'audioCodecs 通过且权重 0')
}

// B. 软件渲染回退（isFallbackAdapter=true）：webgpu 必须标记不适用、不伪装
{
  const fp = { os: 'windows', webglVendor: 'NVIDIA Corporation', webglRenderer: 'NVIDIA GeForce RTX 4070', canvasNoise: true, audioNoise: true }
  const it = run('B. 软件渲染回退（isFallbackAdapter）', fp, {
    webGpuIsFallback: true, webGpuVendor: 'Google Inc. (Google)', webGpuArchitecture: 'SwiftShader'
  })
  assert(it.webgpu.weight === 0 && it.webgpu.ok, 'webgpu 回退时权重 0 且不判红')
  assert(/软件渲染回退/.test(it.webgpu.expected), 'webgpu 期望文案标注「软件渲染回退：不伪装」')
  assert(it.webgpuSubgroup.ok, 'webgpuSubgroup 回退下仍自洽（原生透传）')
}

// C. Canvas 噪声不一致（canvasStable=false）：必须判红，暴露注入缺陷
{
  const fp = { os: 'windows', webglVendor: 'NVIDIA Corporation', webglRenderer: 'NVIDIA GeForce RTX 4070', canvasNoise: true, audioNoise: true }
  const it = run('C. Canvas 噪声不一致（应判红）', fp, { canvasStable: false })
  assert(it.canvasNoise.ok === false && it.canvasNoise.weight === 6, 'canvasNoise 不一致判红且权重 6（真实注入缺陷被捕获）')
}

// D. iOS：WebGPU 必须整体不存在（webGpuPresent=false → 通过）
{
  const fp = { os: 'ios', webglVendor: 'Apple', webglRenderer: 'Apple M2', canvasNoise: true, audioNoise: true }
  const it = run('D. iOS 伪装（WebGPU 应不存在）', fp, {
    webGpuPresent: false, webGpuAdapterAvailable: false, webGpuVendor: '', webGpuArchitecture: ''
  })
  assert(it.webgpu.ok && it.webgpu.weight === 8, 'iOS 无 WebGPU 判定通过且权重 8')
}

console.log('\n' + (fail === 0 ? '全部仿真断言通过 ✅' : `有 ${fail} 项断言失败 ❌`))
process.exitCode = fail === 0 ? 0 : 1
