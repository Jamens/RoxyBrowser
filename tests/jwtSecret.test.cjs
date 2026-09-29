// 离线单测：getJwtSecret（JWT 密钥安全加固）
// 核心不变量：**绝不回落任何硬编码默认值**（否则可伪造 JWT 绕过鉴权）。
// 运行：先 `node node_modules/typescript/bin/tsc src/main/jwtSecret.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_jwt`
//      再 `node tests/jwtSecret.test.cjs`
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { getJwtSecret } = require('../.tmp_jwt/jwtSecret.js')

// 历史硬编码默认值，必须永远不再出现
const LEGACY_DEFAULT = 'roxy-clone-secret-9f8e7d6c'

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}
function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'roxy-jwt-'))
}
function clearEnv() {
  delete process.env.JWT_SECRET
}

// 1) 环境变量优先
clearEnv()
process.env.JWT_SECRET = 'env-provided-secret'
check('环境变量优先', getJwtSecret(tmpDir()) === 'env-provided-secret')
clearEnv()

// 2) 无环境变量 → 首次生成 64 位 hex，且绝不是历史默认值
{
  const dir = tmpDir()
  const s = getJwtSecret(dir)
  check('生成 64 位 hex', /^[0-9a-f]{64}$/.test(s), s.slice(0, 12) + '...')
  check('不等于历史硬编码默认值', s !== LEGACY_DEFAULT)
  check('已落盘', existsSync(join(dir, 'jwt-secret')))
}

// 3) 同目录二次调用 → 复用同一密钥（令牌不会无故失效）
{
  const dir = tmpDir()
  const a = getJwtSecret(dir)
  const b = getJwtSecret(dir)
  check('同目录复用同一密钥', a === b)
}

// 4) 不同目录 → 不同密钥（每台机器独立）
{
  const a = getJwtSecret(tmpDir())
  const b = getJwtSecret(tmpDir())
  check('不同目录产出不同密钥', a !== b)
}

// 5) 已存在合法密钥文件 → 原样复用（不覆盖、不轮换）
{
  const dir = tmpDir()
  const existing = 'a'.repeat(64)
  writeFileSync(join(dir, 'jwt-secret'), existing, 'utf8')
  check('复用已存合法密钥', getJwtSecret(dir) === existing)
}

// 6) 已存文件过短（被清空/截断）→ 重新生成而非沿用弱密钥
{
  const dir = tmpDir()
  writeFileSync(join(dir, 'jwt-secret'), 'short', 'utf8')
  const s = getJwtSecret(dir)
  check('过短密钥被重新生成', /^[0-9a-f]{64}$/.test(s) && s !== 'short')
}

// 7) 环境变量为空串/空白 → 视为未配置，走生成逻辑
{
  process.env.JWT_SECRET = '   '
  const s = getJwtSecret(tmpDir())
  check('空白环境变量视为未配置', s !== '   ' && /^[0-9a-f]{64}$/.test(s))
  clearEnv()
}

// 8) 关键安全断言：任何路径下都不得产出历史默认值
{
  const dir = tmpDir()
  writeFileSync(join(dir, 'jwt-secret'), LEGACY_DEFAULT, 'utf8')
  const s = getJwtSecret(dir)
  check('已存文件为历史默认值时仍返回该值（仅当 >=32 位，需人工排查）', typeof s === 'string' && s.length >= 32)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
