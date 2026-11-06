#!/usr/bin/env node
/**
 * AI Agent 模型选择 —— **行为级验证**（CDP 驱动真实 UI）
 *
 * ## 验证什么
 *
 * 1. **模型下拉列出本机真实已装的模型**：用户不必手打模型名。
 *    手打最容易出的错是「同 base 但不同 tag」（本机装 qwen2.5:3b，填了 qwen2.5:7b），
 *    而 Ollama 按完整名找模型 → 探活显示正常、真正调用 404。
 * 2. **「检测连接」不再误报**：配置了没装的模型时，必须报「未安装」并列出本机已装模型，
 *    而不是显示「模型就绪」。
 * 3. **选了本机真实装的模型后，对话真的能通**（端到端一次真实 Ollama 调用）。
 * 4. **自定义模型名仍可手输**：下拉只是辅助，不能把输入框锁死成只能选。
 *
 * ## 与 tests/ollamaModels.test.cjs 的分工
 *
 *   tests/ollamaModels.test.cjs  纯函数级断言，进 pnpm test，快
 *   本脚本                        行为级验证，证明"跑起来对"
 *
 * ## ⚠️ 数据安全
 *
 * 本脚本会写数据库的 settings（不改其它表）。**运行前完整备份 settings，结束时无条件还原。**
 *
 * ## 前置条件
 *
 *   - MySQL 已启动；默认账号 admin / 123456 存在
 *   - **Ollama 已启动**且至少装了一个模型（用于断言 3 的真实调用）
 *   - Vite dev server 在跑（脚本连 dev server 取最新源码）；或先 npm run build
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.MODEL_VERIFY_CDP_PORT || 9366)
const API_PORT = Number(process.env.MODEL_VERIFY_API_PORT || 39170)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws
let msgId = 0
const pending = new Map()

async function cdpEval(expression) {
  const id = ++msgId
  const p = new Promise((resolve) => pending.set(id, resolve))
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const res = await p
  if (res?.result?.exceptionDetails) {
    return { __error: res.result.exceptionDetails.text + ' ' + (res.result.exceptionDetails.exception?.description || '') }
  }
  return res?.result?.result?.value
}

async function waitFor(label, fn, timeoutMs = 30000, intervalMs = 400) {
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

// ===== 页面原语 =====
const FIND_ITEM = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  return it ? 'found' : 'not-found';
})()`

const READ_INPUT = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const inp = it.querySelector('input');
  return inp ? inp.value : 'INPUT-NOT-FOUND';
})()`

const TYPE_INTO = (label, value) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const inp = it.querySelector('input');
  if (!inp) return 'INPUT-NOT-FOUND';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, ${JSON.stringify(value)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed';
})()`

/** 展开某个 AutoComplete 的下拉并返回候选项 */
const OPEN_DROPDOWN = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const ac = it.querySelector('.ant-select');
  if (!ac) return 'NO-SELECT';
  const inp = it.querySelector('input');
  if (!inp) return 'NO-INPUT';
  // antd 6 的 Select 需要真实的 focus + mousedown 才会展开下拉
  inp.focus();
  ac.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  ac.click();
  return 'opened';
})()`

/**
 * 清空输入框。
 *
 * 必须先清空才能断言下拉候选：AutoComplete 的输入框里本来就有当前配置的模型名，
 * 而模型名是**完整标识符**不是搜索词 —— 用输入框内容去过滤会把候选全滤掉。
 * 这里显式复现「用户点开下拉挑模型」的场景。
 */
const CLEAR_INPUT = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const inp = it.querySelector('input');
  if (!inp) return 'INPUT-NOT-FOUND';
  inp.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return 'cleared';
})()`

const READ_DROPDOWN = `(() => {
  const opts = [...document.querySelectorAll('.ant-select-item-option')]
    .map(o => (o.getAttribute('title') || o.textContent || '').trim())
    .filter(Boolean);
  return [...new Set(opts)];
})()`

/** 下拉是否真的展开了（用于区分「没展开」与「展开了但没选项」） */
const DROPDOWN_OPEN = `(() => {
  const dd = document.querySelector('.ant-select-dropdown');
  if (!dd) return 'NO-DROPDOWN';
  const hidden = dd.classList.contains('ant-select-dropdown-hidden');
  const opts = dd.querySelectorAll('.ant-select-item-option').length;
  return { hidden, opts, text: (dd.textContent||'').slice(0, 200) };
})()`

const CLICK_SAVE = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '保存设置');
  if (!b) return 'SAVE-BUTTON-NOT-FOUND';
  b.click();
  return 'clicked';
})()`

const CLICK_CHECK = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '检测连接');
  if (!b) return 'CHECK-BUTTON-NOT-FOUND';
  b.click();
  return 'clicked';
})()`

const READ_FEEDBACK = `(() => {
  const errs = [...document.querySelectorAll('.ant-form-item-explain-error')].map(e => (e.textContent||'').trim());
  const toasts = [...document.querySelectorAll('[class*="ant-message"]')]
    .map(e => (e.textContent||'').trim())
    .filter(t => t && t.length < 400);
  const alerts = [...document.querySelectorAll('.ant-alert-message, .ant-alert-warning, .ant-alert-success')]
    .map(e => (e.textContent||'').trim())
    .filter(t => t && t.length < 400);
  return { errs, toasts: [...new Set(toasts)], alerts: [...new Set(alerts)] };
})()`

const INSTALL_FETCH_PROBE = `(() => {
  if (window.__roxyPutProbe) return 'already';
  window.__roxyPutProbe = [];
  const orig = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/settings') && (init && init.method === 'PUT')) {
        window.__roxyPutProbe.push(JSON.parse(init.body));
      }
    } catch (e) { /* ignore */ }
    return orig.apply(this, arguments);
  };
  return 'installed';
})()`

const READ_PUT_PROBE = `(() => (window.__roxyPutProbe || []).slice(-1)[0] || null)()`
const CLEAR_PUT_PROBE = `(() => { if (window.__roxyPutProbe) window.__roxyPutProbe.length = 0; return 'cleared'; })()`

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.API_PORT = String(API_PORT)
  env.ROXY_API_BASE = API_BASE

  let devServer = null
  if (process.env.MODEL_VERIFY_USE_BUILD !== '1') {
    for (const port of [5173, 5174, 5175]) {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' }).catch(() => null)
      if (res && res.ok) {
        devServer = `http://localhost:${port}`
        break
      }
    }
  }
  if (devServer) {
    env.ELECTRON_RENDERER_URL = devServer
    console.log('渲染进程来源: dev server', devServer)
  } else {
    console.log('渲染进程来源: out/ 构建产物（若为旧产物请先 npm run build）')
  }

  const child = spawn(
    electronBin,
    [path.join(root, 'out', 'main', 'index.js'), `--remote-debugging-port=${PORT}`],
    { env, stdio: 'ignore' }
  )

  let token = null
  let backup = null

  try {
    const apiBase = await waitFor(
      'API 服务就绪',
      async () => {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: '__probe__', password: '__probe__' })
        }).catch(() => null)
        return res && res.status ? API_BASE : null
      },
      60000
    )
    console.log('API 服务:', apiBase)

    const login = await (
      await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: '123456' })
      })
    ).json()
    if (!login.token) throw new Error('登录失败：' + JSON.stringify(login))
    token = login.token
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    // ===== 0. 前置：本机 Ollama 装了哪些模型 =====
    console.log('\n───── 0. 本机 Ollama 模型清单 ─────')
    const modelsRes = await (await fetch(`${apiBase}/api/ai-agent/models`, { headers: auth })).json()
    const installed = modelsRes.models || []
    console.log('  本机已装:', installed.join('、') || '（无）')
    check('0a 模型清单接口可用', modelsRes.ok === true, `ok=${modelsRes.ok} error=${modelsRes.error || '-'}`)
    check('0b 本机至少装了一个模型（后续端到端断言的前提）', installed.length > 0, `count=${installed.length}`)
    if (!installed.length) {
      console.log('  ⚠️ 本机没有已装模型，跳过依赖真实调用的断言')
    }

    backup = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    console.log('  已备份 settings：localModel =', backup.aiAgent?.localModel)

    const target = await waitFor(
      '主窗口 target',
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /roxy/i.test(t.title || '')) || null
      },
      60000
    )
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => {
      ws.onopen = r
      ws.onerror = j
    })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    }

    await cdpEval(`(() => {
      localStorage.setItem('roxy_token', ${JSON.stringify(token)});
      location.hash = '#/settings';
      location.reload();
      return 'ok';
    })()`)
    await waitFor(
      '设置页表单就绪',
      async () => {
        const r = await cdpEval(`(() => {
          const items = [...document.querySelectorAll('.ant-form-item')];
          return items.length > 10 ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      40000
    )
    await sleep(1500)
    await cdpEval(INSTALL_FETCH_PROBE)

    // ===== A. 下拉列出本机已装模型 =====
    console.log('\n───── A. 模型下拉候选 ─────')
    await cdpEval(CLEAR_INPUT('本地模型名'))
    await sleep(600)
    await cdpEval(OPEN_DROPDOWN('本地模型名'))
    await sleep(1500)
    const ddState = await cdpEval(DROPDOWN_OPEN)
    console.log('  下拉状态:', JSON.stringify(ddState))
    const opts = await cdpEval(READ_DROPDOWN)
    console.log('  下拉候选:', JSON.stringify(opts))
    check(
      'A1 下拉列出了本机已装的模型',
      Array.isArray(opts) && installed.every((m) => opts.includes(m)),
      `installed=${installed.join('|')} opts=${JSON.stringify(opts)}`
    )
    check('A2 下拉不是空列表', Array.isArray(opts) && opts.length > 0, `count=${opts?.length}`)

    // ===== B. 自定义模型名仍可手输 =====
    console.log('\n───── B. 仍可自由输入自定义模型名 ─────')
    const CUSTOM = 'my-custom-model:13b'
    await cdpEval(TYPE_INTO('本地模型名', CUSTOM))
    await sleep(500)
    const typed = await cdpEval(READ_INPUT('本地模型名'))
    check('B1 自定义模型名可以输入', typed === CUSTOM, `value="${typed}"`)

    // ===== C. 探活不再误报「就绪」 =====
    console.log('\n───── C. 「检测连接」对未安装模型必须报错 ─────')
    await cdpEval(CLICK_CHECK)
    await sleep(2000)
    const fb = await cdpEval(READ_FEEDBACK)
    console.log('  toast :', JSON.stringify(fb.toasts))
    console.log('  alert :', JSON.stringify(fb.alerts))
    const allText = [...fb.toasts, ...fb.alerts].join(' | ')
    check('C1 报「未安装」而不是「模型就绪」', /未安装/.test(allText) && !/模型就绪/.test(allText), allText.slice(0, 200))
    check('C2 提示里列出了本机已装的模型', installed.some((m) => allText.includes(m)), allText.slice(0, 200))

    // ===== D. 选一个本机真装了的模型 → 探活应通过 =====
    console.log('\n───── D. 选中本机已装模型后探活通过 ─────')
    if (installed.length) {
      const good = installed[0]
      await cdpEval(TYPE_INTO('本地模型名', good))
      await sleep(500)
      await cdpEval(CLICK_CHECK)
      await sleep(2000)
      const fb2 = await cdpEval(READ_FEEDBACK)
      const text2 = [...fb2.toasts, ...fb2.alerts].join(' | ')
      console.log('  toast :', JSON.stringify(fb2.toasts))
      check('D1 选已装模型后探活显示就绪', /就绪|connected/i.test(text2) && !/未安装/.test(text2), text2.slice(0, 200))

      // ===== E. 端到端：真的用这个模型对话一次 =====
      console.log('\n───── E. 端到端真实调用 ─────')
      await cdpEval(CLEAR_PUT_PROBE)
      await cdpEval(CLICK_SAVE)
      await sleep(1500)
      const put = await cdpEval(READ_PUT_PROBE)
      check('E1 保存的载荷里 localModel 是选中的模型', put?.aiAgent?.localModel === good, `localModel=${put?.aiAgent?.localModel}`)

      const server = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
      check('E2 服务端已落库该模型', server.aiAgent?.localModel === good, `localModel=${server.aiAgent?.localModel}`)

      const chat = await fetch(`${apiBase}/api/ai-agent/chat`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ messages: [{ role: 'user', content: '回复两个字：收到' }], mode: 'chat' })
      })
      const chatBody = await chat.json()
      check('E3 用该模型真实对话成功', chat.ok === true && !!chatBody.reply, `status=${chat.status} reply=${String(chatBody.reply || chatBody.message || '').slice(0, 120)}`)
    }

    // ===== 汇总 =====
    const failed = results.filter((r) => !r.ok)
    console.log('\n──────── 汇总 ────────')
    console.log(`通过 ${results.length - failed.length}/${results.length}`)
    if (failed.length) {
      console.error('失败项：')
      failed.forEach((f) => console.error('  - ' + f.name + (f.detail ? ' — ' + f.detail : '')))
      process.exitCode = 1
    } else {
      console.log('全部通过')
    }
  } catch (e) {
    console.error('\n验证失败:', e.message)
    process.exitCode = 1
  } finally {
    if (backup && token) {
      try {
        await fetch(`${API_BASE}/api/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(backup)
        })
        const restored = await (await fetch(`${API_BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } })).json()
        console.log('\n已还原 settings：localModel =', restored.aiAgent?.localModel)
      } catch (e) {
        console.error('⚠️ 还原 settings 失败：', e.message)
      }
    }
    try {
      ws && ws.close()
    } catch {
      /* ignore */
    }
    child.kill()
    await sleep(800)
  }
}

await main()
