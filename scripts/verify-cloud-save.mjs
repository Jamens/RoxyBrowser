#!/usr/bin/env node
/**
 * 云端后端设置保存 —— **行为级复现**（CDP 驱动真实 UI）
 *
 * ## 要复现什么
 *
 * 用户报障：「设置了线上模型，参数也填写了，回到 AI Agent 页面还是显示本地模型，
 * 再回去设置又变回去本地模型」。
 *
 * 截图显示云端字段（服务商 / API 地址 / 模型名 / 视觉模型 / API Key）都填好了，
 * 但落库后 `aiAgent.backend` 仍是 `local`、云端字段全空。
 *
 * ## 验证什么
 *
 * 1. 把「模型后端」切到「云端 BYOK」后，**点保存**真的发出 PUT /api/settings
 * 2. 载荷里 `aiAgent.backend === 'cloud'`，且云端各字段都在
 * 3. 服务端落库后 `aiAgent.backend === 'cloud'`
 * 4. 切到 AI Agent 页面，顶部标签显示「云端」而不是「本地」
 * 5. 回到设置页，后端下拉仍显示「云端」且参数没丢
 *
 * ## ⚠️ 数据安全
 *
 * 本脚本会写数据库的 settings（不改其它表）。**运行前完整备份 settings，结束时无条件还原。**
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeKeyWithTag } from './lib/fake-credentials.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.CLOUD_SAVE_CDP_PORT || 9377)
const API_PORT = Number(process.env.CLOUD_SAVE_API_PORT || 39180)
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

/** 找到 label 含指定文案的 Form.Item */
const FIND_ITEM = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  return it ? 'found' : 'not-found';
})()`

/** 读某个 Select 当前显示的文本 */
const READ_SELECT = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const sel = it.querySelector('.ant-select-selection-item');
  return sel ? (sel.textContent||'').trim() : 'NO-SELECTION';
})()`

/** 下拉选择某一项（按显示文本匹配） */
const SELECT_OPTION = (label, optionText) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const sel = it.querySelector('.ant-select');
  if (!sel) return 'NO-SELECT';
  const inp = sel.querySelector('input');
  if (inp) { inp.focus(); }
  sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  sel.click();
  return 'opened';
})()`

const CLICK_OPTION = (optionText) => `(() => {
  const opts = [...document.querySelectorAll('.ant-select-item-option')];
  const o = opts.find(x => (x.getAttribute('title') || x.textContent || '').trim() === ${JSON.stringify(optionText)});
  if (!o) return 'OPTION-NOT-FOUND:' + opts.map(x => (x.getAttribute('title')||x.textContent||'').trim()).join('|');
  o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  o.click();
  return 'clicked';
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

const CLICK_SAVE = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '保存设置');
  if (!b) return 'SAVE-BUTTON-NOT-FOUND';
  b.click();
  return 'clicked';
})()`

const READ_FEEDBACK = `(() => {
  const errs = [...document.querySelectorAll('.ant-form-item-explain-error')].map(e => (e.textContent||'').trim());
  const toasts = [...document.querySelectorAll('[class*="ant-message"]')]
    .map(e => (e.textContent||'').trim())
    .filter(t => t && t.length < 400);
  return { errs, toasts: [...new Set(toasts)] };
})()`

/** 拦截 PUT /api/settings，记录每次发出的载荷 */
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
const PUT_COUNT = `(() => (window.__roxyPutProbe || []).length)`

/** 读 AI Agent 页顶部的后端标签 */
const READ_AGENT_TAGS = `(() => {
  const tags = [...document.querySelectorAll('.ant-tag')].map(t => (t.textContent||'').trim()).filter(Boolean);
  return tags;
})()`

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.API_PORT = String(API_PORT)
  env.ROXY_API_BASE = API_BASE

  let devServer = null
  if (process.env.CLOUD_SAVE_USE_BUILD !== '1') {
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

    backup = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    console.log('已备份 settings')

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
    await sleep(2000)
    await cdpEval(INSTALL_FETCH_PROBE)

    // ===== A. 切到云端后端 =====
    console.log('\n───── A. 切换到云端后端 ─────')
    const backendBefore = await cdpEval(READ_SELECT('模型后端'))
    console.log('  切换前:', backendBefore)

    await cdpEval(SELECT_OPTION('模型后端', '云端 BYOK（需 Key）'))
    await sleep(1200)
    // antd 6 的下拉选项在弹层里渲染，需再点一次具体项
    const clickRes = await cdpEval(CLICK_OPTION('云端 BYOK（需 Key）'))
    if (clickRes !== 'clicked') {
      // 文案可能带空格差异，退化成包含匹配
      await cdpEval(`(() => {
        const opts = [...document.querySelectorAll('.ant-select-item-option')];
        const o = opts.find(x => /云端/.test(x.getAttribute('title') || x.textContent || ''));
        if (!o) return 'not-found';
        o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        o.click();
        return 'clicked-fuzzy';
      })()`)
    }
    await sleep(1200)
    const backendAfter = await cdpEval(READ_SELECT('模型后端'))
    console.log('  切换后:', backendAfter)
    check('A1 后端已切到云端', /云端/.test(String(backendAfter)), `after=${backendAfter}`)

    // ===== B. 填云端参数 =====
    console.log('\n───── B. 填写云端参数 ─────')
    await cdpEval(TYPE_INTO('模型名', 'deepseek-flash'))
    await sleep(300)
    await cdpEval(TYPE_INTO('视觉模型（云端）', 'deepseek-flash'))
    await sleep(300)
    await cdpEval(TYPE_INTO('API Key', fakeKeyWithTag('save-test')))
    await sleep(300)

    const modelVal = await cdpEval(READ_INPUT('模型名'))
    const visionVal = await cdpEval(READ_INPUT('视觉模型（云端）'))
    console.log('  模型名 =', modelVal, '| 视觉模型 =', visionVal)
    check('B1 云端模型名已填入表单', modelVal === 'deepseek-flash', `value=${modelVal}`)
    check('B2 云端视觉模型名已填入表单', visionVal === 'deepseek-flash', `value=${visionVal}`)

    // ===== C. 点保存 =====
    console.log('\n───── C. 点「保存设置」 ─────')
    const before = await cdpEval(PUT_COUNT)
    console.log('  保存前已发出 PUT 次数:', before)
    await cdpEval(CLICK_SAVE)
    await sleep(2500)

    const fb = await cdpEval(READ_FEEDBACK)
    console.log('  校验错误:', JSON.stringify(fb.errs))
    console.log('  toast   :', JSON.stringify(fb.toasts))
    check('C1 没有表单校验错误', fb.errs.length === 0, `errs=${JSON.stringify(fb.errs)}`)

    const after = await cdpEval(PUT_COUNT)
    console.log('  保存后已发出 PUT 次数:', after)
    check('C2 点保存确实发出了 PUT /api/settings', after > before, `before=${before} after=${after}`)

    const put = await cdpEval(READ_PUT_PROBE)
    console.log('  载荷 aiAgent =', JSON.stringify(put?.aiAgent))
    check('C3 载荷里 backend === cloud', put?.aiAgent?.backend === 'cloud', `backend=${put?.aiAgent?.backend}`)
    check('C4 载荷里云端模型名在', put?.aiAgent?.cloudModel === 'deepseek-flash', `cloudModel=${put?.aiAgent?.cloudModel}`)
    check(
      'C5 载荷里云端视觉模型名在',
      put?.aiAgent?.cloudVisionModel === 'deepseek-flash',
      `cloudVisionModel=${put?.aiAgent?.cloudVisionModel}`
    )
    check('C6 载荷里 API Key 在', !!put?.aiAgent?.cloudApiKey, `cloudApiKey=${put?.aiAgent?.cloudApiKey ? '(有值)' : '(空)'}`)

    // ===== D. 服务端落库 =====
    console.log('\n───── D. 服务端落库 ─────')
    const server = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    console.log('  服务端 aiAgent =', JSON.stringify(server.aiAgent))
    check('D1 服务端 backend 已落库为 cloud', server.aiAgent?.backend === 'cloud', `backend=${server.aiAgent?.backend}`)
    check('D2 服务端 cloudModel 已落库', server.aiAgent?.cloudModel === 'deepseek-flash', `cloudModel=${server.aiAgent?.cloudModel}`)

    // ===== E. AI Agent 页面显示 =====
    console.log('\n───── E. AI Agent 页面 ─────')
    await cdpEval(`(() => { location.hash = '#/ai-agent'; return 'ok'; })()`)
    await sleep(3000)
    const tags = await cdpEval(READ_AGENT_TAGS)
    console.log('  页面标签:', JSON.stringify(tags))
    const tagText = (tags || []).join(' | ')
    check('E1 AI Agent 页显示云端而非本地', /云端/.test(tagText) && !/本地/.test(tagText), tagText)

    // ===== F. 回到设置页参数未丢 =====
    console.log('\n───── F. 回到设置页 ─────')
    await cdpEval(`(() => { location.hash = '#/settings'; return 'ok'; })()`)
    await sleep(3000)
    const backendBack = await cdpEval(READ_SELECT('模型后端'))
    const modelBack = await cdpEval(READ_INPUT('模型名'))
    console.log('  后端 =', backendBack, '| 模型名 =', modelBack)
    check('F1 回到设置页后端仍是云端', /云端/.test(String(backendBack)), `backend=${backendBack}`)
    check('F2 回到设置页云端模型名没丢', modelBack === 'deepseek-flash', `cloudModel=${modelBack}`)

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
        console.log('\n已还原 settings：backend =', restored.aiAgent?.backend)
      } catch (e) {
        console.error('还原 settings 失败:', e.message)
      }
    }
    try { child.kill() } catch { /* ignore */ }
    if (ws) { try { ws.close() } catch { /* ignore */ } }
  }
}

main()
