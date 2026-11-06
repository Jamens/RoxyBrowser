// 云端 BYOK 链路行为级验证。
//
// ## 为什么需要这个脚本
//
// 本地链路补了「模态能力校验」（探活阶段拦截文本模型当视觉模型），
// 但**云端链路没有等价机制** —— 而云端的坑更多，因为：
//
// 1. **厂商之间差异大**：DeepSeek 无视觉模型、GLM/OpenAI 视觉模型名各不相同、
//    部分模型不认 `max_tokens`（推理模型要求 `max_completion_tokens`）。
// 2. **探活与真实调用的请求形态不同**：
//    - 文本探活发的是纯文本 "hi"
//    - 视觉探活必须发**真实图片**（云端没有 /api/show 那样的 capabilities 接口，
//      只能实际发图来验证模型是否接受图像输入）
//    - 真实看屏发的是**视口 JPEG 截图**，探活发的是 1x1 **PNG**
//    若视觉探活也发纯文本，则「纯文本模型当视觉模型」会探活通过、执行时报 400。
// 3. **MIME 必须与字节一致**：data URL 声明 image/jpeg 但字节是 PNG 时，
//    厂商（OpenAI 系）直接 400 拒收。
// 4. **Key 错误时的报错可操作性**：厂商返回体形态各异，
//    需要确认应用把「401 / 余额不足 / 模型名错」翻译成用户能懂的中文。
//
// 用法：
//   node scripts/verify-cloud-agent.mjs            # 自动起 mock + 跑全部用例
//   MOCK_PORT=4600 node scripts/verify-cloud-agent.mjs
//
// 依赖：mock OpenAI 兼容服务（scripts/mock-openai-server.mjs），
//       本脚本会自己拉起它，不需要真实 API Key、不产生任何费用。

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { fakeKeyWithTag, INVALID_KEY } from './lib/fake-credentials.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const PORT = Number(process.env.MOCK_PORT || 4599)
const BASE = `http://127.0.0.1:${PORT}/v1`

/**
 * 本脚本用到的假凭据：全部来自 scripts/lib/fake-credentials.mjs（运行时拼装）。
 *
 * 为什么不写死成字符串字面量：仓库里一旦出现「格式完全正确的 key」，
 * secret scanner 会误报（久了就学会忽略，告警失去意义），
 * 且下一个人顺手换成真实 Key 去验证几乎零阻力 —— 这是凭据泄漏最常见的路径。
 * 详见该模块的头部注释。
 */
const TEST_KEY = fakeKeyWithTag('test')
const PING_KEY = fakeKeyWithTag('ping')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'}${name}${detail ? ' — ' + detail : ''}`)
}

// ===== 1. 自编译 src/main/agent/cloud.ts → .tmp_cloud/ =====
const OUT_DIR = path.join(root, '.tmp_cloud')

/**
 * 用临时 tsconfig 编译，而不是命令行直传 tsc 参数。
 *
 * 原因：`--paths` **只能**在 tsconfig 里配（命令行传会报 TS6064），
 * 而 cloud.ts 依赖 `@shared/types` 这个项目路径别名，必须给映射。
 */
function buildCloud() {
  const tsconfigPath = path.join(OUT_DIR, 'tsconfig.cloud.json')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tsconfig = {
    compilerOptions: {
      module: 'commonjs',
      target: 'es2020',
      esModuleInterop: true,
      skipLibCheck: true,
      rootDir: path.join(root, 'src'),
      outDir: OUT_DIR,
      // paths 的 baseUrl 相对 tsconfig 所在目录解析 —— 这里 tsconfig 在 .tmp_cloud/ 下，
      // 故必须用绝对路径指向 src，否则映射不到 @shared/*
      baseUrl: path.join(root, 'src'),
      paths: { '@shared/*': ['shared/*'] }
    },
    files: [path.join(root, 'src', 'main', 'agent', 'cloud.ts')]
  }
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8')
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tscBin, '-p', tsconfigPath], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error('❌ 编译 src/main/agent/cloud.ts 失败：')
    console.error(r.stdout || '')
    console.error(r.stderr || '')
    process.exit(1)
  }
}

// ===== 2. 拉起 mock 服务 =====
let mock = null
async function startMock() {
  mock = spawn(process.execPath, [path.join(root, 'scripts', 'mock-openai-server.mjs'), String(PORT)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // 等端口就绪
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PING_KEY}` },
        body: JSON.stringify({ model: 'ping', messages: [{ role: 'user', content: 'hi' }] })
      })
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('mock 服务启动超时')
}

buildCloud()
const { cloudChat, cloudVisionChat, checkCloudStatus } = require(path.join(OUT_DIR, 'main', 'agent', 'cloud.js'))

process.on('exit', () => {
  try {
    mock?.kill()
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(OUT_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

await startMock()
console.log(`\n[1] 云端适配层基础能力（mock: ${BASE}）`)

// ===== 3. 基础调用 =====
const TXT = '描述这张图'
/** 1x1 透明 PNG（与云端探活用的是同一张） */
const IMG_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 1x1 JPEG（与真实看屏截图同格式） */
const IMG_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

{
  const reply = await cloudChat({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }]
  })
  check('cloudChat 正常返回文本', reply === 'ok', `reply=${JSON.stringify(reply)}`)
}

{
  // 真实看屏路径：JPEG 字节 + image/jpeg 声明
  const reply = await cloudVisionChat({
    provider: 'openai',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'gpt-4o-vision',
    systemPrompt: 'sys',
    userText: TXT,
    imageBase64: IMG_JPEG,
    imageMime: 'image/jpeg'
  })
  check('cloudVisionChat 对多模态模型正常返回（JPEG）', reply.includes('navigate'), reply.slice(0, 60))
}

{
  // 探活路径：PNG 字节 + image/png 声明（修复前这里会被标成 jpeg → 厂商拒收）
  const reply = await cloudVisionChat({
    provider: 'openai',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'gpt-4o-vision',
    systemPrompt: 'reply ok',
    userText: 'hi',
    imageBase64: IMG_PNG,
    imageMime: 'image/png'
  })
  check('cloudVisionChat 对多模态模型正常返回（探活 PNG）', reply.includes('navigate'), reply.slice(0, 60))
}

console.log('\n[2] MIME 与字节一致性')

{
  // 反例：PNG 字节却声明 jpeg —— 真实厂商会拒。应用不应发出这种请求。
  let err = ''
  try {
    await cloudVisionChat({
      provider: 'openai',
      baseUrl: BASE,
      apiKey: TEST_KEY,
      model: 'gpt-4o-vision',
      systemPrompt: 'sys',
      userText: TXT,
      imageBase64: IMG_PNG,
      imageMime: 'image/jpeg' // ← 故意错配
    })
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check(
    'MIME 与字节错配会被厂商拒（mock 复现真实行为）',
    /Invalid image format/i.test(err),
    err.slice(0, 120) || '未报错'
  )
}

console.log('\n[3] 探活口径（视觉探活必须带图）')

// 关键用例：**纯文本模型当视觉模型**。
// 修复前：视觉探活也发纯文本 → 探活报「已连接」，真正看屏才报 400。
// 修复后：视觉探活发真图 → 探活阶段就应判为不可达并指明「不支持图像」。
{
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'deepseek-chat',
    vision: true
  })
  check('纯文本模型当视觉模型 → 视觉探活判为不可达', st.reachable === false, st.error || '无错误')
  check('错误分类为 no_vision（提示换多模态模型）', st.errorKind === 'no_vision', `errorKind=${st.errorKind}`)
  check(
    '错误文案指向「视觉模型」这一栏',
    /视觉模型/.test(st.error || ''),
    (st.error || '').slice(0, 140)
  )
}

{
  // 文本探活对纯文本模型仍应通过（不能因为修了视觉就把文本也判死）
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'deepseek-chat'
  })
  check('纯文本模型文本探活仍可达', st.reachable === true, st.error || '无错误')
}

{
  // 视觉探活对多模态模型应可达（不能因为带图就判不通）
  const st = await checkCloudStatus({
    provider: 'openai',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'gpt-4o-vision',
    vision: true
  })
  check('多模态模型视觉探活可达', st.reachable === true, st.error || '无错误')
  check('多模态模型确认支持图像（supportsVision=true）', st.supportsVision === true, `supportsVision=${st.supportsVision}`)
}

console.log('\n[4] 错误信息可操作性')

{
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: INVALID_KEY,
    model: 'deepseek-chat'
  })
  check('Key 无效 → 不可达', st.reachable === false)
  check('错误分类为 auth', st.errorKind === 'auth', `errorKind=${st.errorKind}`)
  check(
    'Key 无效的报错里含厂商原始信息（便于定位 401）',
    /401|Invalid API key/i.test(st.error || ''),
    (st.error || '').slice(0, 120)
  )
  check(
    '报错给出「下一步」而非只丢一句失败',
    /请检查|请到|请确认/.test(st.error || ''),
    (st.error || '').slice(0, 160)
  )
}

{
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'nofund-model'
  })
  check('余额不足 → 不可达', st.reachable === false)
  check('错误分类为 balance', st.errorKind === 'balance', `errorKind=${st.errorKind}`)
  check(
    '余额不足的报错含关键信息',
    /402|balance/i.test(st.error || ''),
    (st.error || '').slice(0, 120)
  )
}

{
  // 推理模型只认 max_completion_tokens：应用应自动换参数名重试，
  // 而不是甩给用户一个「参数不支持」的错误（Key 和模型名其实都是对的）。
  const st = await checkCloudStatus({
    provider: 'openai',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: 'reasoner-model'
  })
  check('推理模型（只认 max_completion_tokens）→ 自动降级后可达', st.reachable === true, st.error || '无错误')
}

{
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: '   ',
    model: 'deepseek-chat'
  })
  check('未填 Key → 不可达且提示去设置填', !st.reachable && /API Key/.test(st.error || ''), st.error)
}

{
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: '  '
  })
  check('未填模型名 → 不可达且提示去设置填', !st.reachable && /模型名/.test(st.error || ''), st.error)
}

{
  const st = await checkCloudStatus({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: TEST_KEY,
    model: '   ',
    vision: true
  })
  check(
    '未填视觉模型名 → 提示里点名「视觉模型」',
    !st.reachable && /视觉模型/.test(st.error || ''),
    st.error
  )
}

console.log('\n[5] 端点拼接（厂商 base 各不相同，容易拼错）')
{
  // 自定义 base 带尾斜杠
  const reply = await cloudChat({
    provider: 'deepseek',
    baseUrl: `${BASE}/`,
    apiKey: TEST_KEY,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }]
  })
  check('base 带尾斜杠也能拼对', reply === 'ok', reply)
}

{
  // 用户直接粘了完整的 chat/completions 地址 —— 不该再拼一次
  let ok = false
  try {
    const reply = await cloudChat({
      provider: 'deepseek',
      baseUrl: `${BASE}/chat/completions`,
      apiKey: TEST_KEY,
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }]
    })
    ok = reply === 'ok'
  } catch (e) {
    ok = false
  }
  check('base 已是完整 chat/completions 地址时不重复拼接', ok)
}

{
  // Key 里带空白（复制粘贴常见）—— 应被 trim 后仍可用
  const reply = await cloudChat({
    provider: 'deepseek',
    baseUrl: BASE,
    apiKey: `  ${TEST_KEY}\n`,
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }]
  })
  check('Key 带空白时自动 trim', reply === 'ok', reply)
}

{
  // 网络不可达：base 指向一个没人监听的端口
  let err = ''
  try {
    await cloudChat({
      provider: 'deepseek',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: TEST_KEY,
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }]
    })
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check(
    '网络不可达 → 提示检查 API 地址 / 网络',
    /API 地址|网络/.test(err),
    err.slice(0, 160)
  )
}

// ===== 汇总 =====
const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(56)}`)
console.log(`云端链路验证：${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('\n未通过：')
  for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
}
console.log('='.repeat(56))
process.exit(failed.length ? 1 : 0)
