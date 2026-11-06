#!/usr/bin/env node
/**
 * 视觉模型**上下文超限** —— 行为级验证（直连真实 Ollama）
 *
 * ## 验证什么
 *
 * 1. **复现原始 bug**：不带 `num_ctx` 时，用 1920x1080 截图 + DOM + system prompt
 *    的典型请求会撞上 Ollama 默认的 4096 窗口，报
 *    `request (5290 tokens) exceeds the available context size (4096 tokens)`。
 * 2. **修复有效**：带上 `options.num_ctx` 后同一请求**不再超限**，且能正常返回。
 * 3. **超限错误可识别**：`parseContextOverflow` 能从 Ollama 原始报错里解析出
 *    请求 token 数与窗口大小。
 * 4. **提示可操作**：错误文案点明「瓶颈是 Ollama 的 num_ctx，不是模型能力不足」，
 *    并给出模型的真实上下文长度。
 *
 * ## 为什么要单独验证
 *
 * 这个 bug 的隐蔽之处在于**模型明明支持 128K 上下文**（`/api/show` 里
 * `context_length = 128000`），但 Ollama 的 llama.cpp runner 默认只给 4096。
 * 不查 `/api/ps` 就发现不了这个落差 —— 而用户看到的报错（"exceeds the available
 * context size"）完全看不出是配置问题，只会觉得「这模型太小了」，于是去换模型 ——
 * 换了也白换，因为任何模型在默认 num_ctx 下都会撞同一堵墙。
 *
 * ## 前置条件
 *
 *   - **Ollama 已启动**（默认 127.0.0.1:11434）
 *   - 至少装了一个支持视觉的模型
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434'

/** 自编译 ollamaModels.ts（run-tests.mjs 的 .tmp_* 跑完即删，不能依赖） */
const OUT_DIR = path.join(root, '.tmp_ctx')
function buildShared() {
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const r = spawnSync(
    process.execPath,
    [
      tscBin,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--esModuleInterop',
      '--skipLibCheck',
      '--rootDir', path.join(root, 'src'),
      '--outDir', OUT_DIR,
      path.join(root, 'src', 'shared', 'ollamaModels.ts')
    ],
    { cwd: root, encoding: 'utf8' }
  )
  if (r.status !== 0) {
    console.error('❌ 编译失败：\n' + (r.stdout || '') + (r.stderr || ''))
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

const { parseContextOverflow, describeContextOverflow, estimateImageTokens, VISION_MIN_NUM_CTX } =
  require(path.join(OUT_DIR, 'shared', 'ollamaModels.js'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}
function skip(name, why) {
  console.log(`  ⏭  ${name} — 跳过：${why}`)
  results.push({ name, ok: true, skipped: true, detail: why })
}

// ===== 0. 前置检查 =====
console.log('\n[0] 前置检查')
async function api(path_, init) {
  const res = await fetch(`${OLLAMA_BASE}${path_}`, init)
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json, text }
}

const tags = await api('/api/tags')
if (!tags.ok) {
  console.error(`❌ Ollama 未启动（${OLLAMA_BASE} 返回 ${tags.status}），无法验证。\n`)
  process.exit(1)
}
const installed = (tags.json?.models || []).map((m) => m.name)
console.log(`  ✅ Ollama 可访问 — 已装 ${installed.length} 个模型：${installed.join('、')}`)

// 找视觉模型
let visionModel = null
for (const name of installed) {
  const show = await api('/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name })
  })
  if (show.json?.capabilities?.includes('vision')) {
    visionModel = name
    break
  }
}
if (!visionModel) {
  console.error('\n❌ 本机未装支持视觉的模型，无法验证。请先 ollama pull qwen2.5vl:7b。\n')
  process.exit(1)
}
console.log(`  ✅ 找到视觉模型：${visionModel}`)

// ===== 1. 运行时 num_ctx 的落差 =====
console.log('\n[1] 运行时上下文窗口的落差')
const show = await api('/api/show', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: visionModel })
})
const modelMaxContext = show.json?.model_info?.['qwen25vl.context_length'] || 0
console.log(`  ℹ️  /api/show 的 context_length = ${modelMaxContext || '(未暴露)'}`)

const ps = await api('/api/ps')
const running = (ps.json?.models || []).find((m) => m.name === visionModel)
const runtimeCtx = running?.context_length
console.log(`  ℹ️  /api/ps 的运行时 context_length = ${runtimeCtx ?? '(模型未加载)'}`)
check(
  '模型能力与运行时窗口存在落差（num_ctx 默认 4096）',
  modelMaxContext === 0 || !runtimeCtx || modelMaxContext > runtimeCtx,
  `模型 ${modelMaxContext} vs 运行时 ${runtimeCtx ?? '未加载'}`
)

// ===== 2. 构造真实请求 =====
console.log('\n[2] 构造真实请求（1920x1080 截图 + DOM + system prompt）')

// 1x1 起步，逐步放大到能触发超限的规模
function makePng(w, h) {
  const zlib = require('node:zlib')
  const raw = Buffer.alloc(h * (w * 3 + 1))
  let p = 0
  for (let y = 0; y < h; y++) {
    raw[p++] = 0
    for (let x = 0; x < w * 3; x++) raw[p++] = (x * 7 + y * 3) % 256
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : require('node:zlib').crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const W = 1920
const H = 1080
const png = makePng(W, H)
const b64 = png.toString('base64')
console.log(`  ℹ️  截图 ${W}x${H}，base64 长度 ${b64.length}，估算图像 tokens ≈ ${estimateImageTokens(W, H)}`)

// 模拟 DOM 列表（80 个元素，接近真实上限）+ system prompt 规模
const domLines = Array.from({ length: 80 }, (_, i) =>
  `#${i} a "点击链接 ${i} 这里是一些可交互元素的文本内容" @(${100 + i * 15},${200 + (i % 20) * 30}) 120x36`
).join('\n')
const userText = `当前页面标题: 测试页面
URL: https://example.com/
视口: ${W}x${H}

用户指令: 帮我打开百度，然后搜索electron，进入官网

可交互元素（中心坐标，与截图对齐）:
${domLines}

已执行动作:
(none)

请输出下一个动作（仅 JSON）。`

const messages = [
  { role: 'system', content: 'You are a precise browser-automation agent. '.repeat(60) },
  { role: 'user', content: userText, images: [b64] }
]

// ===== 3. 不带 num_ctx → 应复现超限 =====
console.log('\n[3] 不带 num_ctx（复现原始 bug）')
const noCtx = await api('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: visionModel, messages, stream: false })
})
const noCtxErr = noCtx.json?.error || ''
if (noCtxErr) {
  console.log(`  ℹ️  报错：${noCtxErr.slice(0, 140)}`)
  const parsed = parseContextOverflow(noCtxErr)
  check('默认配置下复现上下文超限', !!parsed, parsed ? `${parsed.requestTokens} > ${parsed.contextSize}` : noCtxErr.slice(0, 80))
  if (parsed) {
    check('解析出请求 token 数', parsed.requestTokens > 0, String(parsed.requestTokens))
    check('解析出窗口大小', parsed.contextSize > 0, String(parsed.contextSize))
  }
} else {
  check(
    '默认配置下复现上下文超限',
    false,
    `未复现（prompt_tokens=${noCtx.json?.prompt_eval_count}）—— 若本机 Ollama 已全局配置 num_ctx 则不适用`
  )
}

// ===== 4. 带 num_ctx → 应成功 =====
console.log('\n[4] 带 options.num_ctx（验证修复）')
const withCtx = await api('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: visionModel,
    messages,
    stream: false,
    options: { num_ctx: VISION_MIN_NUM_CTX }
  })
})
if (withCtx.json?.error) {
  check('带 num_ctx 后不再超限', false, withCtx.json.error.slice(0, 140))
} else {
  check('带 num_ctx 后不再超限', true, `prompt_tokens=${withCtx.json?.prompt_eval_count}`)
  check(
    '带 num_ctx 后正常返回内容',
    typeof withCtx.json?.message?.content === 'string' && withCtx.json.message.content.length > 0,
    (withCtx.json?.message?.content || '').slice(0, 60)
  )
}

// ===== 5. 超限提示的可操作性 =====
console.log('\n[5] 超限提示的可操作性')
const overflowErr =
  'request (5290 tokens) exceeds the available context size (4096 tokens), try increasing it'
const msg = describeContextOverflow({
  model: visionModel,
  error: overflowErr,
  modelMaxContext: modelMaxContext || undefined,
  suggestedNumCtx: VISION_MIN_NUM_CTX
})
console.log(`  ℹ️  ${msg}`)
check('提示含请求 token 数', msg.includes('5290'))
check('提示含窗口大小', msg.includes('4096'))
check('提示点明 num_ctx 是瓶颈', msg.includes('num_ctx'))
check('提示给出模型的真实上下文长度', !modelMaxContext || msg.includes(String(modelMaxContext)))
check('提示不含 undefined 之类的脏字符', !msg.includes('undefined') && !msg.includes('NaN'))

// ===== 6. 源码守卫：视觉请求必须带 num_ctx =====
console.log('\n[6] 源码守卫')
const visionSrc = fs.readFileSync(path.join(root, 'src', 'main', 'agent', 'vision.ts'), 'utf8')
check('vision.ts 的请求体带 options.num_ctx', /options\s*:\s*\{\s*num_ctx/.test(visionSrc))
// 窗口大小是**动态**算的（computeVisionNumCtx），不是写死 8192 ——
// 写死的话，用户把窗口拉到 2560x1440 就会再次超限
check(
  'vision.ts 用动态计算决定 num_ctx（不写死）',
  visionSrc.includes('computeVisionNumCtx') && /num_ctx:\s*numCtx/.test(visionSrc)
)
check('vision.ts 引用了 estimateVisionTokens 做需求估算', visionSrc.includes('estimateVisionTokens'))
const sessionSrc = fs.readFileSync(path.join(root, 'src', 'main', 'agent', 'session.ts'), 'utf8')
check('session.ts 对上下文超限不再重试', sessionSrc.includes('parseContextOverflow'))

console.log(`\n  上下文超限校验：${results.filter((r) => r.ok).length}/${results.length} 项通过`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error('\n❌ 失败项：')
  for (const f of failed) console.error(`   - ${f.name} ${f.detail || ''}`)
  process.exit(1)
}
console.log('✅ 全部通过\n')
