/**
 * 一键跑完全量离线测试：先 tsc 把需要的模块编成 CJS，再逐个用 node 跑。
 *
 * 背景：项目没有引入 vitest/jest 等运行器，测试分两类——
 *   1) 无跨模块 import 的 .ts 可用 `node --experimental-strip-types` 直跑；
 *   2) 有 extensionless import 的模块（如 fingerprint.ts → './trackers'）Node ESM
 *      解析不了，必须先 tsc→CJS 再 require（见 tests/ 下各 .cjs 头部注释）。
 * 此前这套流程靠手工敲 7 条编译 + 8 条运行命令，极易漏跑，故固化为脚本。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

/** 编译清单：把 shared/main 模块编到对应临时目录（.tmp_* 已被 .gitignore 忽略） */
const COMPILES = [
  { name: 'webglOsMatch', files: ['src/shared/webglOsMatch.ts'], out: '.tmp_hc' },
  // countries / locales 是 healthcheck 的传递依赖，显式列出确保一并编进 .tmp_hc
  { name: 'healthcheck', files: ['src/shared/healthcheck.ts', 'src/shared/countries.ts', 'src/shared/locales.ts'], out: '.tmp_hc', extra: ['--lib', 'es2020,dom'] },
  { name: 'trackers', files: ['src/shared/trackers.ts'], out: '.tmp_tr' },
  { name: 'envExpiry', files: ['src/shared/envExpiry.ts', 'src/shared/fingerprint.ts'], out: '.tmp_env' },
  { name: 'candidate4', files: ['src/shared/webgpu.ts', 'src/shared/canvasNoise.ts'], out: '.tmp_c4' },
  { name: 'fingerprint', files: ['src/shared/fingerprint.ts'], out: '.tmp_nf' },
  { name: 'jwtSecret', files: ['src/main/jwtSecret.ts'], out: '.tmp_jwt' },
  // secretKey 依赖 shared/secretCrypto，tsc 会自动一并编进同一临时目录
  { name: 'secretCrypto', files: ['src/shared/secretCrypto.ts', 'src/main/secretKey.ts'], out: '.tmp_sc' },
  { name: 'cdp', files: ['src/shared/cdp.ts'], out: '.tmp_cdp' },
  { name: 'proxyHeal', files: ['src/shared/proxyHeal.ts'], out: '.tmp_ph' },
  { name: 'sessionRevoke', files: ['src/shared/sessionRevoke.ts'], out: '.tmp_sr' },
  { name: 'rateLimit', files: ['src/shared/rateLimit.ts'], out: '.tmp_rl' },
  { name: 'logArchive', files: ['src/shared/logArchive.ts'], out: '.tmp_la' },
  { name: 'crashReason', files: ['src/shared/crashReason.ts'], out: '.tmp_cr' },
  { name: 'pollBackoff', files: ['src/shared/pollBackoff.ts'], out: '.tmp_pb' },
  { name: 'windowLimit', files: ['src/shared/windowLimit.ts'], out: '.tmp_wl' },
  { name: 'trashBatch', files: ['src/shared/trashBatch.ts'], out: '.tmp_tb' },
  { name: 'envPartition', files: ['src/shared/envPartition.ts'], out: '.tmp_ep' },
  { name: 'assistantPlan', files: ['src/shared/assistantPlan.ts'], out: '.tmp_ap' },
  { name: 'expiryAlert', files: ['src/shared/expiryAlert.ts'], out: '.tmp_xa' },
  // healthBaseline 曾经漏配这一条：测试 require 的 .tmp_hb 目录只靠早期手工编译的
  // 残留产物存在，全新 clone 跑 pnpm test 会直接 MODULE_NOT_FOUND。编译清单必须
  // 覆盖 tests/ 下所有 `require('../.tmp_*')` 的目标目录，新增模块时同步补这里。
  { name: 'healthBaseline', files: ['src/shared/healthBaseline.ts'], out: '.tmp_hb' },
  // healthFix 依赖 healthcheck（uaOs）与 countries（时区/语言表）
  { name: 'healthFix', files: ['src/shared/healthFix.ts', 'src/shared/healthcheck.ts', 'src/shared/countries.ts', 'src/shared/locales.ts'], out: '.tmp_hf', extra: ['--lib', 'es2020,dom'] },
  // 快照：零 import 但含接口与类型断言，仍按约定先编再 require
  { name: 'snapshot', files: ['src/shared/snapshot.ts'], out: '.tmp_snap' },
  // webhook 匹配引擎：零外部依赖（仅 node:crypto），文件头本就标注「便于离线单测」却一直零测试
  { name: 'webhook', files: ['src/main/webhook.ts'], out: '.tmp_wh' },
  // cookieText 通过 `import type` 引用 CookieEntity，tsc 仍会把 entities.ts 拉进类型检查
  // 程序，而实体带装饰器 —— 故需显式开启 experimentalDecorators（否则报 TS1240）
  { name: 'cookieText', files: ['src/main/cookieText.ts'], out: '.tmp_ck', extra: ['--experimentalDecorators', '--emitDecoratorMetadata'] }
]

/** 测试清单：strip=true 的走 --experimental-strip-types 直跑 */
const TESTS = [
  { name: 'rpa', file: 'tests/rpa.test.ts', strip: true },
  { name: 'webglOsMatch', file: 'tests/webglOsMatch.test.cjs' },
  { name: 'trackers', file: 'tests/trackers.test.cjs' },
  { name: 'envExpiry', file: 'tests/envExpiry.test.cjs' },
  { name: 'candidate4', file: 'tests/candidate4.test.cjs' },
  { name: 'healthcheck_sim', file: 'tests/healthcheck_sim.cjs' },
  { name: 'normalize_fingerprint', file: 'tests/normalize_fingerprint.test.cjs' },
  { name: 'jwtSecret', file: 'tests/jwtSecret.test.cjs' },
  { name: 'secretCrypto', file: 'tests/secretCrypto.test.cjs' },
  { name: 'cdp', file: 'tests/cdp.test.cjs' },
  { name: 'proxyHeal', file: 'tests/proxyHeal.test.cjs' },
  { name: 'sessionRevoke', file: 'tests/sessionRevoke.test.cjs' },
  { name: 'rateLimit', file: 'tests/rateLimit.test.cjs' },
  { name: 'logArchive', file: 'tests/logArchive.test.cjs' },
  { name: 'crashReason', file: 'tests/crashReason.test.cjs' },
  { name: 'pollBackoff', file: 'tests/pollBackoff.test.cjs' },
  { name: 'windowLimit', file: 'tests/windowLimit.test.cjs' },
  { name: 'trashBatch', file: 'tests/trashBatch.test.cjs' },
  { name: 'envPartition', file: 'tests/envPartition.test.cjs' },
  { name: 'assistantPlan', file: 'tests/assistantPlan.test.cjs' },
  { name: 'expiryAlert', file: 'tests/expiryAlert.test.cjs' },
  { name: 'consistency', file: 'tests/consistency.test.cjs' },
  { name: 'healthBaseline', file: 'tests/healthBaseline.test.cjs' },
  { name: 'healthFix', file: 'tests/healthFix.test.cjs' },
  { name: 'snapshot', file: 'tests/snapshot.test.cjs' },
  { name: 'webhook', file: 'tests/webhook.test.cjs' },
  { name: 'cookieText', file: 'tests/cookieText.test.cjs' }
]

function run(bin, args, label) {
  const r = spawnSync(bin, args, { cwd: root, stdio: 'inherit' })
  if (r.error) throw r.error
  return { ok: r.status === 0, status: r.status, label }
}

console.log('──────── 编译共享模块 ────────')
for (const c of COMPILES) {
  // 先清空再编，避免残留旧产物导致测试读到过期实现。
  // best-effort：受限于沙箱/权限删不掉时降级为「覆盖编译」，不能让清理失败中断测试。
  try { fs.rmSync(path.join(root, c.out), { recursive: true, force: true }) } catch { /* 忽略 */ }
  const args = [
    tscBin,
    ...c.files,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    ...(c.extra || []),
    // 显式钉死 rootDir=src：否则 tsc 会按「当前编译文件集的公共祖先目录」推算，
    // 导致同一份代码在不同编译批次下产物层级不一致（有时扁平、有时带 main/ shared/ 前缀），
    // 测试里的 require 路径就会时灵时不灵。钉死后层级恒定为 src 的子目录结构。
    '--rootDir', 'src',
    '--outDir', c.out
  ]
  const { ok } = run(process.execPath, args, `compile:${c.name}`)
  if (!ok) {
    console.error(`\n编译失败：${c.name}（${c.files.join(', ')}）`)
    process.exit(1)
  }
}

// 前置自检：tests/ 里 require 到的每个 .tmp_* 目录，都必须有对应的 tsc 产出条目。
// 漏配时测试仍能"通过"——因为本地可能残留着上一次手工编译的产物，但全新 clone
// 跑 pnpm test 会直接 MODULE_NOT_FOUND。healthBaseline 就踩过这个坑。
const compiledOuts = new Set(COMPILES.map((c) => c.out))
const requiredOuts = new Set()
for (const t of TESTS) {
  let src = ''
  try { src = fs.readFileSync(path.join(root, t.file), 'utf8') } catch { /* 文件缺失交由运行阶段报错 */ }
  for (const m of src.matchAll(/require\(\s*['"]\.\.\/(\.tmp_[A-Za-z0-9_]+)/g)) requiredOuts.add(m[1])
}
const missingOuts = [...requiredOuts].filter((d) => !compiledOuts.has(d))
if (missingOuts.length) {
  console.error(`\n编译清单缺项：${missingOuts.join(', ')}`)
  console.error('tests/ 引用了这些目录，但 COMPILES 里没有产出它们的条目。')
  process.exit(1)
}

console.log('\n──────── 运行测试 ────────')
const results = []
for (const t of TESTS) {
  const args = t.strip ? ['--experimental-strip-types', t.file] : [t.file]
  const { ok } = run(process.execPath, args, t.name)
  results.push({ name: t.name, ok })
}

console.log('\n════════ 汇总 ════════')
for (const r of results) console.log(`  ${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`)
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)

// 清理编译产物。.tmp_* 只是 tsc 的中间输出，测试跑完即无用。
// 教训：此前没有这一步，每加一个 shared 模块就多一个目录，根目录一度堆到
// 61 个 .tmp_* / 7.1M，被当成"垃圾文件"。全绿时自动回收，失败时保留便于复现。
const outDirs = [...new Set(COMPILES.map((c) => c.out))]
if (failed.length === 0) {
  let cleaned = 0
  for (const d of outDirs) {
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); cleaned++ } catch { /* best-effort */ }
  }
  console.log(cleaned === outDirs.length
    ? `已清理 ${cleaned} 个编译临时目录`
    : `已清理 ${cleaned}/${outDirs.length} 个编译临时目录（其余删除失败，可手工 rm -rf .tmp_*）`)
} else {
  console.log(`有失败用例，保留编译产物便于调试：${outDirs.join(', ')}`)
}
process.exit(failed.length === 0 ? 0 : 1)
