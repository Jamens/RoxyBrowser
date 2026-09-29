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
  { name: 'healthcheck', files: ['src/shared/healthcheck.ts'], out: '.tmp_hc', extra: ['--lib', 'es2020,dom'] },
  { name: 'trackers', files: ['src/shared/trackers.ts'], out: '.tmp_tr' },
  { name: 'envExpiry', files: ['src/shared/envExpiry.ts', 'src/shared/fingerprint.ts'], out: '.tmp_env' },
  { name: 'candidate4', files: ['src/shared/webgpu.ts', 'src/shared/canvasNoise.ts'], out: '.tmp_c4' },
  { name: 'fingerprint', files: ['src/shared/fingerprint.ts'], out: '.tmp_nf' },
  { name: 'jwtSecret', files: ['src/main/jwtSecret.ts'], out: '.tmp_jwt' }
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
  { name: 'jwtSecret', file: 'tests/jwtSecret.test.cjs' }
]

function run(bin, args, label) {
  const r = spawnSync(bin, args, { cwd: root, stdio: 'inherit' })
  if (r.error) throw r.error
  return { ok: r.status === 0, status: r.status, label }
}

console.log('──────── 编译共享模块 ────────')
for (const c of COMPILES) {
  // 先清空再编，避免残留旧产物导致测试读到过期实现
  fs.rmSync(path.join(root, c.out), { recursive: true, force: true })
  const args = [
    tscBin,
    ...c.files,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    ...(c.extra || []),
    '--outDir', c.out
  ]
  const { ok } = run(process.execPath, args, `compile:${c.name}`)
  if (!ok) {
    console.error(`\n编译失败：${c.name}（${c.files.join(', ')}）`)
    process.exit(1)
  }
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
process.exit(failed.length === 0 ? 0 : 1)
