#!/usr/bin/env node
/**
 * 视觉模型上下文超限 —— **端到端验证**（CDP 驱动真实 UI 跑一次 Agent 执行）
 *
 * ## 验证什么
 *
 * 用户报障截图里的错误：
 * ```
 * 视觉模型连续失败 3 次：视觉模型调用失败 (400):
 * {"error":"request (5290 tokens) exceeds the available context size (4096 tokens), try increasing it"}
 * ```
 *
 * 本脚本在**真实运行的应用**里触发一次 Agent 执行，验证：
 *
 * 1. Agent 能真正跑起来（不再因上下文超限失败）
 * 2. 视觉模型调用**不再出现** context size 超限错误
 * 3. 若仍失败，错误信息里**不含** `exceeds the available context size`
 * 4. 主进程日志里能看到 `[agent] step N perceive` —— 说明真的走了感知循环
 *
 * ## 与 verify-ollama-context.mjs 的分工
 *
 *   verify-ollama-context.mjs  直连 Ollama，验证「带 num_ctx 就不超限」这个机制
 *   本脚本                      在真实应用里验证「Agent 真的能跑起来」
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认账号 admin / 123456）
 *   - **Ollama 已启动**且装了视觉模型
 *   - 至少有一个浏览器环境（默认用 #1）
 *   - dev server 在跑（脚本连 dev server 取最新源码）
 *
 * ## ⚠️ 不要与 `npm run build` 并行
 *
 * `npm run dev` 与 `npm run build` **都写 `out/` 目录**，并行跑会互相覆写：
 * dev 的主进程产物被 build 产物替换掉 → dev 直接崩掉（Vite 返回 502）。
 * 验证脚本本身读 `out/main/index.js`，所以正确顺序是：
 * 先 `npm run build`（若需要），再起 dev，最后跑本脚本。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CTX_VERIFY_CDP_PORT || 9377)
const API_PORT = Number(process.env.CTX_VERIFY_API_PORT || 39191)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws
let msgId = 0
const pending = new Map()

async function cdpEval(expression) {
  const id = ++msgId
  const p = new Promise((resolve) => pending.set(id, resolve))
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  )
  const res = await p
  if (res?.result?.exceptionDetails) {
    return {
      __error:
        res.result.exceptionDetails.text +
        ' ' +
        (res.result.exceptionDetails.exception?.description || '')
    }
  }
  return res?.result?.result?.value
}

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e.message
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${label}（最后一次结果：${JSON.stringify(last)}）`)
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ===== 1. 启动带 CDP 的 Electron =====
console.log('\n[1] 启动应用（带 CDP 调试端口）')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

/**
 * 独立的 userData 目录 —— 用来绕开**单实例锁**。
 *
 * `app.requestSingleInstanceLock()` 的锁是按 userData 路径算的：
 * 若 dev 实例正在跑，验证实例再起一个会被锁挡住 → 直接 `app.quit()` 秒退
 * （`src/main/index.ts:284-286`），表现为「脚本连不上 CDP」。
 *
 * 换 userData 目录即可与 dev 实例共存，不互相踢。
 */
const USER_DATA = path.join(root, '.tmp_ctx_userdata')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.API_PORT = String(API_PORT)
env.ROXY_API_BASE = API_BASE

// 渲染进程优先连 dev server（拿到最新源码）；没有就用 out/ 构建产物
let devServer = null
for (const port of [5173, 5174, 5175]) {
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' }).catch(() => null)
  if (res && res.ok) {
    devServer = `http://localhost:${port}`
    break
  }
}
if (devServer) {
  env.ELECTRON_RENDERER_URL = devServer
  console.log('  ℹ️  渲染进程来源：dev server', devServer)
} else {
  console.log('  ℹ️  渲染进程来源：out/ 构建产物')
}

const child = spawn(
  electronBin,
  [
    path.join(root, 'out', 'main', 'index.js'),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`
  ],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
)
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

// 连 CDP
const http = await import('node:http')
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

let targetWsUrl = ''
await waitFor(
  'CDP 端口就绪',
  async () => {
    const raw = await httpGet(`http://127.0.0.1:${PORT}/json/list`)
    const list = JSON.parse(raw)
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!page) return null
    targetWsUrl = page.webSocketDebuggerUrl
    return true
  },
  60000
)

// 建立 WebSocket（Node 22 内置 WebSocket 用 addEventListener，不是 ws 的 on）
ws = new globalThis.WebSocket(targetWsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
ws.addEventListener('message', (ev) => {
  try {
    const msg = JSON.parse(String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  } catch {
    /* ignore */
  }
})
console.log('  ✅ CDP 已连接')

// ===== 2. 登录 =====
console.log('\n[2] 登录')
await waitFor('登录页出现', async () => {
  const r = await cdpEval(`document.querySelectorAll('input').length`)
  return typeof r === 'number' && r > 0
})
const loginResult = await cdpEval(`(async () => {
  const inputs = [...document.querySelectorAll('input')];
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // 找用户名/密码两个输入框
  const user = inputs.find(i => /user|name|账号|用户名/i.test(i.placeholder||i.name||'')) || inputs[0];
  const pwd = inputs.find(i => /pass|密码/i.test(i.placeholder||i.type||'')) || inputs[1];
  if (!user || !pwd) return 'no-inputs';
  setVal(user, 'admin');
  setVal(pwd, '123456');
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('button')].find(b => /登录|登 录|login|sign/i.test(b.textContent||''));
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()`)
console.log(`  ℹ️  登录触发：${loginResult}`)
await waitFor(
  '登录成功（出现侧边栏/环境）',
  async () => {
    const r = await cdpEval(`document.body.innerText.includes('AI Agent') || document.body.innerText.includes('环境')`)
    return r === true
  },
  40000
)
console.log('  ✅ 已登录')

// ===== 3. 确认设置：启用 AI Agent + 视觉模型 =====
console.log('\n[3] 确认设置（AI Agent 已启用、视觉模型已配置）')
const token = await cdpEval(`(async () => {
  const raw = localStorage.getItem('roxy_token') || localStorage.getItem('token') || '';
  return raw;
})()`)
const settingsInfo = await cdpEval(`(async () => {
  const keys = Object.keys(localStorage);
  return keys.join(',');
})()`)
console.log(`  ℹ️  localStorage keys: ${settingsInfo}`)

// 直接调后端确认当前配置
const API = API_BASE
const settings = await (await fetch(`${API}/api/settings`, {
  headers: { Authorization: `Bearer ${token}` }
})).json().catch(() => null)
const ai = settings?.aiAgent || settings?.data?.aiAgent
console.log(
  `  ℹ️  当前配置：enabled=${ai?.enabled} localModel=${ai?.localModel} localVisionModel=${ai?.localVisionModel}`
)
if (!ai?.enabled || !ai?.localVisionModel) {
  console.log('  ⚠️  AI Agent 未启用或未配视觉模型，先在设置页开启')
}

// ===== 4. 启动环境窗口 + 触发一次 Agent 执行 =====
console.log('\n[4] 启动环境窗口并触发 Agent 执行（真实跑一次）')

/**
 * Agent 执行需要**环境窗口正在运行**（`runner.ts` 的 `launchOne` 里
 * `getWindow(envId)` 拿不到就直接判「该环境窗口未运行」）。
 * 故先调 `POST /api/profiles/:id/open` 把环境开起来。
 */
const openRes = await fetch(`${API}/api/profiles/1/open`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
})
  .then((r) => r.text().catch(() => ''))
  .catch((e) => String(e))
console.log(`  ℹ️  启动环境 #1：${String(openRes).slice(0, 120)}`)

// 等环境状态变成 running —— 窗口刚开时 getWindow 还拿不到，
// 太早触发 Agent 会得到「该环境窗口未运行」。
const envReady = await waitFor(
  '环境状态变为 running',
  async () => {
    const list = await fetch(`${API}/api/profiles`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((r) => r.json())
      .catch(() => null)
    const items = Array.isArray(list) ? list : list?.items || []
    const env = items.find((e) => e.id === 1)
    return env?.status === 'running' ? env : null
  },
  60000,
  1500
)
  .then((e) => e || null)
  .catch(() => null)
console.log(`  ℹ️  环境状态：${envReady ? 'running ✅' : '未变为 running ❌'}`)
// 再多等一会儿，让浏览器窗口完成加载、CDP 注入完成
await sleep(8000)

/**
 * 走 **preload 直调**（`window.roxy.agentStart`）而不是点 UI 按钮。
 *
 * 原因：「开始」按钮的文案在 antd 的 `<PlayCircleOutlined/>` 里，textContent 为空，
 * 且它 `disabled={!s.envIds.length}` —— 还得先在 Select 里选中环境。
 * UI 路径对这些结构特征太脆弱，而我们要验的是**主进程的视觉模型调用**，
 * 直调 preload 走的是完全相同的主进程代码路径。
 */
/**
 * 指令用**用户报障时的原话**（复合指令，会跑多步）：
 * 「帮我打开百度，然后搜索electron，进入官网」
 *
 * 复合指令更能压出上下文问题 —— 每步都带「截图 + DOM + 累积历史动作」，
 * 步数越多、历史越长，token 越容易顶到窗口上限。
 */
const INSTRUCTION = process.env.CTX_VERIFY_INSTRUCTION || '帮我打开百度，然后搜索electron，进入官网'

const startRes = await cdpEval(`(async () => {
  if (!window.roxy || !window.roxy.agentStart) return 'no-preload';
  const res = await window.roxy.agentStart({
    envIds: [1],
    instruction: ${JSON.stringify(INSTRUCTION)},
    options: { needApproval: false }
  });
  return JSON.stringify(res);
})()`)
console.log(`  ℹ️  agentStart 返回：${String(startRes).slice(0, 300)}`)

const started = typeof startRes === 'string' && !startRes.includes('no-preload')
if (!started) {
  console.error('\n❌ 无法触发 Agent 执行（preload 未就绪）\n')
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
}

// 等待执行结束。
//
// 观测手段：**读操作日志表**（agent_start / agent_failed 等会落库），
// 而不是 Electron 的 stdout —— 打包后的主进程日志不一定写到 stdout，
// 且 stdout 捕获在 Windows 下不稳定。落库的日志才是可靠证据。
/**
 * 等待执行结束。
 *
 * 观测手段：**读操作日志表**（agent_start / agent_failed 等会落库），
 * 而不是 Electron 的 stdout —— 打包后的主进程日志不一定写到 stdout，
 * 且 stdout 捕获在 Windows 下不稳定。落库的日志才是可靠证据。
 *
 * 只取**本次运行**的日志：操作日志表是持久化的，用户之前报障那次
 * （正是 `exceeds the available context size`）的记录还在里面。
 * 不按时间过滤就会把**旧记录**误判成「修复没生效」—— 第一次跑就踩了这个坑。
 */
const AGENT_ACTIONS = ['agent_start', 'agent_step', 'agent_done', 'agent_failed']
const RUN_START = Date.now()

async function readThisRunLogs() {
  const res = await fetch(`${API}/api/logs`, { headers: { Authorization: `Bearer ${token}` } })
  const json = await res.json().catch(() => null)
  const items = Array.isArray(json) ? json : json?.items || json?.data || []
  return items
    .filter((l) => AGENT_ACTIONS.includes(l.action) || /agent/i.test(l.action || ''))
    .filter((l) => {
      if (!l.createdAt) return false
      const t = new Date(l.createdAt).getTime()
      return Number.isFinite(t) && t >= RUN_START - 2000 // 2s 容差
    })
    .map((l) => `${l.action}: ${l.detail || ''}`)
}

/**
 * 与「上下文超限」无关的**环境窗口类**错误。
 *
 * 这些是环境本身的问题（窗口被销毁 / 浏览器引擎抽风），不是本次要修的东西，
 * 判定失败时要区分开，否则会把环境问题算到修复头上。
 */
const UNRELATED_FAILURES = [
  '该环境窗口未运行',
  'Object has been destroyed',
  'UnknownVizError'
]

/**
 * 复合指令（「打开百度 → 搜索 electron → 进官网」）要跑好几步，
 * 每步都要真调一次视觉模型（本地推理，单步几十秒），总耗时可能十几分钟。
 */
const WAIT_MS = Number(process.env.CTX_VERIFY_WAIT_MS || 900000)

const outcome = await waitFor(
  'Agent 执行出结果',
  async () => {
    const agentLogs = await readThisRunLogs()
    const joined = agentLogs.join('\n')
    if (/exceeds the available context size/.test(joined)) {
      return { kind: 'context-error', txt: joined.slice(0, 500) }
    }
    const failLine = agentLogs.find((l) => l.startsWith('agent_failed'))
    if (failLine) {
      const unrelated = UNRELATED_FAILURES.find((u) => failLine.includes(u))
      return {
        kind: unrelated ? 'unrelated-failure' : 'failed',
        txt: joined.slice(0, 500),
        unrelated
      }
    }
    if (agentLogs.some((l) => l.startsWith('agent_done'))) {
      return { kind: 'done', txt: joined.slice(0, 500) }
    }
    return null
  },
  WAIT_MS,
  3000
).catch((e) => ({ kind: 'timeout', txt: e.message, unrelated: null }))

console.log(`  ℹ️  结果类型：${outcome.kind}`)
console.log(`  ℹ️  本次运行的 Agent 日志：\n${String(outcome.txt).split('\n').map((l) => '      ' + l).join('\n')}`)

// ===== 5. 断言 =====
console.log('\n[5] 断言')
const allLogs = logs.join('')
const agentLogsText = String(outcome.txt || '')
// 两路证据并用：落库的日志（可靠但只有 start/done/failed）+ 主进程 stdout（有逐步明细）
const evidence = allLogs + '\n' + agentLogsText

const hasContextErr = /exceeds the available context size/.test(evidence)
check('不再出现上下文超限错误', !hasContextErr, hasContextErr ? '仍出现 context size 超限' : '未出现')

const sawStart = /agent_start/.test(agentLogsText) || /\[agent\] step \d+ perceive/.test(allLogs)
check('Agent 执行已启动', sawStart, sawStart ? '已看到 agent_start / step N perceive' : '未见启动痕迹')

// 逐步明细：证明视觉模型被反复成功调用（每步一次），而不是一开始就失败
const stepMatches = allLogs.match(/\[agent\] step (\d+) perceive/g) || []
const decideMatches = allLogs.match(/\[agent\] step (\d+) decide/g) || []
console.log(`  ℹ️  perceive 次数：${stepMatches.length}，decide 次数：${decideMatches.length}`)
check(
  '视觉模型被成功调用至少 2 次（多步都过了看屏这一关）',
  decideMatches.length >= 2,
  `decide ${decideMatches.length} 次`
)

// 环境窗口类失败与「上下文超限」无关 —— 单列出来，不混算
const isUnrelated = outcome.kind === 'unrelated-failure'
if (isUnrelated) {
  console.log(`  ℹ️  本次是环境窗口类失败（与上下文超限无关）：${outcome.unrelated}`)
  console.log('      这类问题需要环境侧排查，不在本次修复范围内')
} else {
  const sawDone = /agent_done/.test(agentLogsText) || /执行完成|AI 执行完成/.test(allLogs)
  const sawFailed = /agent_failed/.test(agentLogsText)
  check(
    'Agent 执行有明确结局（成功或失败）',
    sawDone || sawFailed || outcome.kind === 'timeout',
    sawDone ? 'agent_done' : sawFailed ? 'agent_failed' : outcome.kind === 'timeout' ? '超时（但已在跑多步）' : '未见结局日志'
  )

  const failLine = /agent_failed[^\n]*/.exec(agentLogsText)?.[0] || ''
  if (sawFailed) {
    check(
      '失败原因不含上下文超限',
      !failLine.includes('exceeds the available context size'),
      failLine.slice(0, 160)
    )
    check(
      '失败原因不是「视觉模型连续失败」（说明不再无意义重试）',
      !failLine.includes('视觉模型连续失败'),
      failLine.slice(0, 160)
    )
  } else {
    console.log('  ℹ️  未出现失败日志')
  }
}

// ===== 6. 清理 =====
console.log('\n[6] 清理')
// 先停 Agent 再关环境：直接 kill 进程会把环境窗口一起带走，
// 产生「Object has been destroyed」这类**与被测无关**的失败噪音。
try {
  await fetch(`${API}/api/profiles/1/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null)
} catch {
  /* ignore */
}
await sleep(1500)
try {
  child.kill()
} catch {
  /* ignore */
}
await sleep(1500)
try {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
} catch {
  /* 清理失败不影响验证结果 */
}

console.log(`\n  上下文超限端到端验证：${results.filter((r) => r.ok).length}/${results.length} 项通过`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error('\n❌ 失败项：')
  for (const f of failed) console.error(`   - ${f.name} ${f.detail || ''}`)
  console.error('\n--- 主进程日志尾部 ---')
  console.error(allLogs.slice(-2000))
  process.exit(1)
}
console.log('✅ 全部通过\n')
