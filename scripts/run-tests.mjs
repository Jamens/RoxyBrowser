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
  { name: 'jwtSecret', files: ['src/main/jwtSecret.ts'], out: '.tmp_jwt' },
  // secretKey 依赖 shared/secretCrypto，tsc 会自动一并编进同一临时目录
  { name: 'secretCrypto', files: ['src/shared/secretCrypto.ts', 'src/main/secretKey.ts'], out: '.tmp_sc' },
  { name: 'cdp', files: ['src/shared/cdp.ts'], out: '.tmp_cdp' },
  { name: 'proxyHeal', files: ['src/shared/proxyHeal.ts'], out: '.tmp_ph' },
  { name: 'sessionRevoke', files: ['src/shared/sessionRevoke.ts'], out: '.tmp_sr' },
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
  { name: 'cookieText', file: 'tests/cookieText.test.cjs' }
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
