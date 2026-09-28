// 离线单测：webglMatchesOs（WebGL 显卡品牌 ↔ 操作系统 一致性守卫）
// 运行：先 `tsc src/shared/webglOsMatch.ts --module commonjs --target es2020 --esModuleInterop --skipLibCheck --outDir .tmp_hc`
//      再 `node tests/webglOsMatch.test.cjs`
const { webglMatchesOs } = require('../.tmp_hc/webglOsMatch.js')

let failed = 0
function check(name, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

// ---- iOS：必须 Apple，且不得出现任何桌面 / 移动非 Apple GPU ----
check('ios Apple 合规', webglMatchesOs('ios', 'Apple Inc.', 'Apple GPU').ok === true)
check('ios Apple ANGLE 合规', webglMatchesOs('ios', 'Apple Inc.', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)').ok === true)
check('ios 泄露 NVIDIA 判红', webglMatchesOs('ios', 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)').ok === false)
check('ios 泄露 Intel 判红', webglMatchesOs('ios', 'Intel', 'Intel Iris Graphics').ok === false)
check('ios 误填 Adreno 判红', webglMatchesOs('ios', 'Qualcomm', 'Adreno (TM) 730').ok === false)
check('ios 非 Apple 显卡判红', webglMatchesOs('ios', 'Samsung', 'Mali-G78').ok === false)
check('ios 无 Apple 标识判红', webglMatchesOs('ios', 'Unknown', 'GPU').ok === false)

// ---- Android：不得出现桌面 GPU（NVIDIA/AMD/Intel），移动 GPU 合规 ----
check('android Adreno 合规', webglMatchesOs('android', 'Qualcomm', 'Adreno (TM) 730').ok === true)
check('android Mali 合规', webglMatchesOs('android', 'ARM', 'Mali-T860').ok === true)
check('android PowerVR 合规', webglMatchesOs('android', 'Imagination', 'PowerVR Rogue').ok === true)
check('android 泄露 NVIDIA 判红', webglMatchesOs('android', 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)').ok === false)
check('android 泄露 AMD 判红', webglMatchesOs('android', 'AMD', 'AMD Radeon RX 6600').ok === false)

// ---- Windows / Linux：不得出现移动 GPU（Adreno/Mali/PowerVR），不强制具体桌面品牌 ----
check('windows NVIDIA 合规', webglMatchesOs('windows', 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)').ok === true)
check('windows Intel 合规', webglMatchesOs('windows', 'Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)').ok === true)
check('windows 泄露 Adreno 判红', webglMatchesOs('windows', 'Qualcomm', 'Adreno (TM) 730').ok === false)
check('windows 泄露 Mali 判红', webglMatchesOs('windows', 'ARM', 'Mali-T860').ok === false)
check('linux NVIDIA 合规', webglMatchesOs('linux', 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, ...)').ok === true)
check('linux 泄露 PowerVR 判红', webglMatchesOs('linux', 'Imagination', 'PowerVR').ok === false)

// ---- macOS：必须 Apple（ANGLE 始终报 Apple）----
check('mac Apple 合规', webglMatchesOs('mac', 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)').ok === true)
check('mac 泄露 NVIDIA 判红', webglMatchesOs('mac', 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)').ok === false)
check('mac 非 Apple 判红', webglMatchesOs('mac', 'Unknown', 'GPU').ok === false)

// ---- 边界：字段为空（老数据）应标记不适用（ok=true，由 weight=0 处理）----
check('空字段不误报', webglMatchesOs('windows', '', '').ok === true)

// ---- 错误信息非空（便于体检回显）----
const bad = webglMatchesOs('ios', 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, ...)')
check('错误信息非空', bad.ok === false && typeof bad.reason === 'string' && bad.reason.length > 0)

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
