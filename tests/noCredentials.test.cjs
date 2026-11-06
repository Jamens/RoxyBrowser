// 凭据泄漏守卫：**仓库里不得出现任何真实或形似真实的密钥**。
//
// ## 要锁住什么
//
// 1. **真实凭据** —— 用户在设置页填的 API Key 属于凭据，一旦写进源码就等于公开。
//    本项目踩过：用户实测把 `sk-...` 填进了「API 地址」栏，
//    那串值被原样写进了 `tests/cloudConfigValidation.test.cjs` 与验证脚本。
//    （真实密钥从未进入 git 历史，但**差点**随下一次提交一起入库。）
// 2. **形似真实的占位串** —— `sk-` + 32 位十六进制这种「格式完全正确」的占位值，
//    同样不该入库：
//    - secret scanner 会误报 → 告警多了就学会忽略 → 告警失去意义；
//    - 源码里已经躺着一个「真 key 形状」时，下一个人顺手换成自己的真实 Key
//      去「验证一下」几乎零阻力 —— 这正是凭据泄漏最常见的路径。
//
// ## 怎么判定「像密钥」
//
// 只匹配**高置信形态**：厂商密钥前缀 + 足够长的随机体。
// 宁松勿紧 —— 误报比漏报更糟，一个老喊狼来了的规则很快就会被忽略。
// 故：
// - 前缀后至少 8 位随机体（真实凭据的随机体远长于此）；
// - 排除明显的占位形态（`xxx` / `XXXX` / `test` / `dummy` / `example` / `fake` / `placeholder`）；
// - 排除**代码里拼接出来的前缀片段**（如 `'sk-' + 'x'.repeat(32)`）——
//   那不是凭据，是拼装源；真正的风险是「拼完之后落进仓库」，故只扫**字面量**。
//
// ## 用法：node tests/noCredentials.test.cjs
// （无需编译，纯读源码）
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

/** 需要扫描的源码目录（排除构建产物与依赖） */
const SCAN_DIRS = ['src', 'tests', 'scripts']

/** 单文件大小上限：超过 1MB 的不扫（构建产物 / 二进制） */
const MAX_FILE_SIZE = 1024 * 1024

/** 跳过的目录与文件 */
const SKIP_DIRS = new Set(['node_modules', 'out', 'out-tsc', 'dist', 'release', '.git', '.tmp_ccv'])

/**
 * 高置信密钥形态：厂商前缀 + 至少 8 位随机体。
 *
 * 前缀清单覆盖主流厂商的公开格式（见 src/shared/cloudConfigValidation.ts 的
 * `looksLikeApiKey` —— 两处必须保持一致：一边是运行时判定，一边是仓库自查）。
 */
const KEY_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk_ant-[A-Za-z0-9_-]{8,}/g,
  /AIza[A-Za-z0-9_-]{8,}/g,
  /gsk_[A-Za-z0-9]{8,}/g,
  /xai-[A-Za-z0-9]{8,}/g,
  /hf_[A-Za-z0-9]{8,}/g,
  /r8_[A-Za-z0-9]{8,}/g,
  /dop_v1_[A-Za-z0-9]{8,}/g
]

/**
 * 明显的占位形态 —— 命中即放行。
 *
 * 这些是**有意的**示意值（如文档里的 `sk-xxx/chat/completions`、
 * 前缀片段 `'sk-'`），不是凭据。放行它们是为了让规则保持高置信：
 * 只抓「看着像真 key」的，不抓「明确写着是示例的」。
 */
const PLACEHOLDER_PATTERNS = [
  /x{4,}/i, // xxx / xxxxx
  /placeholder/i,
  /example/i,
  /dummy/i,
  /\bfake\b/i,
  /your[-_]/i,
  /\*{3,}/
]

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value))
}

/** 递归收集待扫描的文本文件 */
function collectFiles(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collectFiles(path.join(dir, e.name), out)
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✅', name)
  } catch (e) {
    console.error('  ❌', name)
    console.error('     ', e.message)
    process.exitCode = 1
  }
}

console.log('\n  凭据泄漏守卫')

const files = []
for (const d of SCAN_DIRS) files.push(...collectFiles(path.join(root, d)))

t('扫描到足够多的源码文件（守卫本身没跑空）', () => {
  assert.ok(files.length > 20, `只扫到 ${files.length} 个文件，扫描范围可能配错了`)
})

const violations = []
for (const file of files) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    continue
  }
  if (stat.size > MAX_FILE_SIZE) continue
  // 只扫文本文件：二进制（图片等）读了也没意义，且可能乱码误报
  const ext = path.extname(file).toLowerCase()
  if (!['.ts', '.tsx', '.js', '.cjs', '.mjs', '.md', '.json', '.yml', '.yaml', '.env'].includes(ext)) continue

  let content
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const rel = path.relative(root, file)
  const lines = content.split(/\r?\n/)
  lines.forEach((line, idx) => {
    for (const pattern of KEY_PATTERNS) {
      pattern.lastIndex = 0
      let m
      while ((m = pattern.exec(line)) !== null) {
        const hit = m[0]
        if (isPlaceholder(hit)) continue
        violations.push({ rel, line: idx + 1, hit, text: line.trim().slice(0, 120) })
      }
    }
  })
}

t('源码中没有任何形似真实凭据的字符串', () => {
  if (violations.length === 0) return
  const detail = violations
    .map((v) => `  ${v.rel}:${v.line}  ${v.hit}  |  ${v.text}`)
    .join('\n')
  assert.fail(
    `发现 ${violations.length} 处疑似凭据字面量。\n` +
    `仓库里不得出现真实或形似真实的密钥（即使是真 key 的占位形态也不允许）：\n` +
    `  - secret scanner 会误报，久了大家就学会忽略，告警随即失去意义\n` +
    `  - 源码里躺着一个「格式完全正确的 key」时，下一个人顺手换成自己的真实 Key 去验证几乎零阻力\n` +
    `修法：改为运行时拼装（见 scripts/lib/fake-credentials.mjs 的做法）。\n${detail}`
  )
})

t('测试凭据来自统一的受控来源（而非各处散落）', () => {
  // 拼装源必须是唯一的：散落各处就等于无法审计，也无从保证都被改掉
  const src = fs.readFileSync(path.join(root, 'scripts/lib/fake-credentials.mjs'), 'utf8')
  assert.ok(src.includes('export function fakeKey'), '缺少统一的假凭据生成器')
  assert.ok(
    fs.existsSync(path.join(root, 'scripts/lib/fake-credentials.mjs')),
    '缺少 scripts/lib/fake-credentials.mjs'
  )
})

t('JWT 密钥无硬编码回落（防伪造令牌）', () => {
  const src = fs.readFileSync(path.join(root, 'src/main/jwtSecret.ts'), 'utf8')
  // 优先级必须是 环境变量 > 本地文件 > 随机生成，任何一处出现固定字符串回落都是硬伤
  assert.ok(
    !/process\.env\.JWT_SECRET\s*\|\|\s*['"]/.test(src),
    'JWT_SECRET 回落到了硬编码字符串 —— 拿到该值的人可直接伪造令牌'
  )
  assert.ok(src.includes('randomBytes'), 'JWT 密钥应有随机生成兜底')
})

console.log(`\n  凭据泄漏守卫：${passed} 项全部通过`)
