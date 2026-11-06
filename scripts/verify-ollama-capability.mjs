#!/usr/bin/env node
/**
 * Ollama 模型**模态能力校验** —— 行为级验证（直接打真实 Ollama）
 *
 * ## 验证什么
 *
 * 1. **查得到能力**：已安装模型的 capabilities 能被读出来
 *    （视觉模型有 `vision`，纯文本模型没有，embedding 模型只有 `embedding`）。
 * 2. **探活能拦住模态错配**：视觉模型位填纯文本模型（`qwen2.5-coder:7b`）时，
 *    探活**不能**显示「已连接」，必须报出「不支持看屏」并给出可用的替代模型。
 * 3. **反向错配也要拦**：文本模型位填 embedding 模型（`nomic-embed-text:latest`）时，
 *    探活必须报「不支持对话」。
 * 4. **能力未知不误伤**：查不到能力时（如模型名省略 tag 且本机无对应 latest），
 *    不应误报「不支持」—— 老版本 Ollama 没有 capabilities 字段，误伤比漏报更糟。
 * 5. **正确配置不受影响**：视觉模型位填真正的视觉模型时，探活必须**通过**。
 *
 * ## 与 tests/ollamaModels.test.cjs 的分工
 *
 *   tests/ollamaModels.test.cjs  纯函数级断言，进 pnpm test，快
 *   本脚本                        行为级验证，对真实 Ollama 证明"跑起来对"
 *
 * ## 前置条件
 *
 *   - **Ollama 已启动**（默认 127.0.0.1:11434）
 *   - 本机至少装了一个文本模型；若装了 embedding / 视觉模型，相关断言会自动跳过
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434'

/**
 * 自编译 ollamaModels.ts → .tmp_cap/shared/ollamaModels.js。
 *
 * 不能依赖 scripts/run-tests.mjs 的产物：那个脚本跑完会**清掉** .tmp_* 目录，
 * 且它编到 .tmp_om（与别的条目共用约定）。这里独立编一份，用完即删。
 */
const OUT_DIR = path.join(root, '.tmp_cap')
function buildShared() {
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const args = [
    tscBin,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--skipLibCheck',
    '--rootDir', path.join(root, 'src'),
    '--outDir', OUT_DIR,
    path.join(root, 'src', 'shared', 'ollamaModels.ts')
  ]
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error('❌ 编译 src/shared/ollamaModels.ts 失败：')
    console.error(r.stdout || '')
    console.error(r.stderr || '')
    process.exit(1)
  }
}

buildShared()
process.on('exit', () => {
  try {
    fs.rmSync(OUT_DIR, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响验证结果 */
  }
})

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}
function skip(name, why) {
  console.log(`  ⏭  ${name} — 跳过：${why}`)
  results.push({ name, ok: true, skipped: true, detail: why })
}

/** 1x1 透明 PNG（base64），用于验证「带图调用纯文本模型会被 Ollama 拒绝」 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 取本机已安装模型名列表 */
async function listModels() {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`)
  if (!res.ok) throw new Error(`/api/tags 返回 ${res.status}`)
  const data = await res.json()
  return (data.models || []).map((m) => m.name)
}

/** 查单个模型的能力标签；查不到返回 undefined */
async function capabilities(model) {
  const res = await fetch(`${OLLAMA_BASE}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model })
  })
  if (!res.ok) return undefined
  const data = await res.json()
  return Array.isArray(data.capabilities) ? data.capabilities : undefined
}

/** 复刻 src/main/agent/ollama.ts 的探活判定逻辑 */
async function probe(textModel, visionModel) {
  const installed = await listModels()
  const { isModelInstalled, resolveInstalledModelName, supportsVision, supportsChat, describeModalityMismatch } =
    require(path.join(OUT_DIR, 'shared', 'ollamaModels.js'))

  const textPulled = isModelInstalled(textModel, installed)
  const visionPulled = isModelInstalled(visionModel, installed)

  // 查能力（自动处理省略 tag 的写法）
  const capsOf = async (m) => {
    const exact = resolveInstalledModelName(m, installed)
    if (!exact) return undefined
    return capabilities(exact)
  }
  const textCaps = textPulled ? await capsOf(textModel) : undefined
  const visionCaps = visionPulled ? await capsOf(visionModel) : undefined
  const textOk = supportsChat(textCaps)
  const visionOk = supportsVision(visionCaps)

  // 替代建议
  const alternatives = async (cap) => {
    const out = []
    for (const name of installed) {
      const c = await capabilities(name)
      if (c?.includes(cap)) out.push(name)
    }
    return out
  }

  let error
  if (!textPulled) error = `文本模型「${textModel}」未安装`
  else if (textOk === false)
    error = describeModalityMismatch({
      label: '文本模型',
      model: textModel,
      capabilities: textCaps,
      alternatives: await alternatives('completion')
    })
  else if (!visionPulled) error = `视觉模型「${visionModel}」未安装`
  else if (visionOk === false)
    error = describeModalityMismatch({
      label: '视觉模型',
      model: visionModel,
      capabilities: visionCaps,
      alternatives: (await alternatives('vision')).filter((n) => n !== visionModel)
    })

  return { error, installed, textCaps, visionCaps, textOk, visionOk, alternativesVision: await alternatives('vision') }
}

// ===== 0. 前置检查 =====
console.log('\n[0] 前置检查')
let installed = []
try {
  installed = await listModels()
  check('Ollama 可访问', true, `已装 ${installed.length} 个模型：${installed.join('、')}`)
} catch (e) {
  check('Ollama 可访问', false, e.message)
  console.error('\n❌ Ollama 未启动，无法验证。请先启动 Ollama 后重试。\n')
  process.exit(1)
}

// 按能力给模型分类
const capMap = new Map()
for (const name of installed) capMap.set(name, await capabilities(name))
const visionModels = installed.filter((n) => capMap.get(n)?.includes('vision'))
const textModels = installed.filter((n) => capMap.get(n)?.includes('completion'))
const embedModels = installed.filter((n) => capMap.get(n)?.includes('embedding'))
const plainModels = installed.filter(
  (n) => !capMap.get(n)?.includes('vision') && capMap.get(n)?.includes('completion')
)

// ===== 1. 能力可读 =====
console.log('\n[1] 能力读取')
for (const name of installed) {
  const caps = capMap.get(name)
  check(`能读出 ${name} 的能力`, Array.isArray(caps), caps ? caps.join('、') : 'undefined')
}
if (visionModels.length) {
  check('至少有一个视觉模型', true, visionModels.join('、'))
} else {
  skip('至少有一个视觉模型', '本机未装视觉模型，相关断言无法进行')
}
if (plainModels.length) {
  check('至少有一个纯文本模型（用于错配验证）', true, plainModels.join('、'))
} else {
  skip('至少有一个纯文本模型（用于错配验证）', '本机未装纯文本模型')
}
if (embedModels.length) {
  check('至少有一个 embedding 模型', true, embedModels.join('、'))
} else {
  skip('至少有一个 embedding 模型', '本机未装 embedding 模型')
}

// ===== 2. 视觉模型位填纯文本模型 → 必须被拦 =====
console.log('\n[2] 错配一：视觉模型位填纯文本模型')
if (plainModels.length && textModels.length) {
  const wrongVision = plainModels[0]
  const goodText = textModels[0]
  const r = await probe(goodText, wrongVision)
  check('探活报出模态错配（不是「已连接」）', !!r.error, r.error || '未报错 ← 这是 bug')
  check('错误信息点明是视觉模型', (r.error || '').includes('视觉模型'), r.error)
  check('错误信息含该模型的真实能力', (r.error || '').includes('completion'), r.error)
  if (visionModels.length) {
    check('错误信息给出可用的视觉模型建议', visionModels.some((v) => (r.error || '').includes(v)), r.error)
  }
} else {
  skip('错配一：视觉模型位填纯文本模型', '缺少纯文本模型或视觉模型')
}

// ===== 3. 文本模型位填 embedding 模型 → 必须被拦 =====
console.log('\n[3] 错配二：文本模型位填 embedding 模型')
if (embedModels.length && visionModels.length) {
  const wrongText = embedModels[0]
  const r = await probe(wrongText, visionModels[0])
  check('探活报出模态错配', !!r.error, r.error || '未报错 ← 这是 bug')
  check('错误信息点明是文本模型', (r.error || '').includes('文本模型'), r.error)
} else {
  skip('错配二：文本模型位填 embedding 模型', '缺少 embedding 模型或视觉模型')
}

// ===== 4. 能力未知 → 不误伤 =====
console.log('\n[4] 能力未知时不误伤')
{
  // 一个「语义上等价但本机没有该 tag」的名字 → 查不到能力 → 应判未知而非不支持
  const r = await probe(textModels[0] || installed[0], 'definitely-not-installed:9b')
  check('未安装的模型报「未安装」而非「不支持」', (r.error || '').includes('未安装'), r.error)
  check('能力未知时 visionOk 为 undefined', r.visionOk === undefined, `visionOk=${r.visionOk}`)
}

// ===== 5. 正确配置 → 探活通过 =====
console.log('\n[5] 正确配置不受影响')
if (textModels.length && visionModels.length) {
  const r = await probe(textModels[0], visionModels[0])
  check('正确配置时探活无错误', !r.error, r.error || '通过')
} else {
  skip('正确配置不受影响', '缺少可用的文本模型或视觉模型')
}

// ===== 6. 端到端：确认错配确实会导致 Ollama 报错 =====
console.log('\n[6] 端到端：错配在 Ollama 侧的真实后果')
if (plainModels.length) {
  const wrong = plainModels[0]
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: wrong,
      messages: [{ role: 'user', content: '描述这张图', images: [TINY_PNG] }],
      stream: false
    })
  })
  const body = await res.text()
  check(
    '让纯文本模型看屏，Ollama 确实报错',
    !res.ok,
    `HTTP ${res.status} ${body.slice(0, 120)}`
  )
}

console.log(`\n  模态能力校验：${results.filter((r) => r.ok).length}/${results.length} 项通过`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error('\n❌ 失败项：')
  for (const f of failed) console.error(`   - ${f.name} ${f.detail || ''}`)
  process.exit(1)
}
console.log('✅ 全部通过\n')
