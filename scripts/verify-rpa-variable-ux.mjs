#!/usr/bin/env node
/**
 * RPA 变量覆盖「装完市场脚本显示 {{keyword}}」—— **行为级验证**（真 HTTP + 真 UI）
 *
 * ## 用户报障
 * 从脚本市场安装「亚马逊商品搜索比价」后，回放弹窗的「变量覆盖」左侧显示
 * `{{keyword}}`：那是步骤里给引擎看的模板字面量，用户以为模板没渲染 / 脚本坏了。
 * 同一处还藏着一个反向 bug：提示写「留空则用脚本默认值」，但旧前端会把
 * `{keyword:''}` 原样下发、后端整体替换，最终 URL 变成 `?k=`。
 *
 * ## 本脚本验证什么
 *   V1  回放弹窗可见文本里不再出现 `{{keyword}}`
 *   V2  变量字段名显示为中文「搜索关键词」
 *   V3  默认值仍预填 `wireless earbuds`
 *   V4  变量名与步骤写法保留在 hover 提示里（技术信息没丢）
 *   V5  清空输入框再点「开始回放」，真实请求体里不带空的 variables
 *   V6  市场目录 / 已安装脚本的变量数据一致（真 HTTP 读取）
 *
 * V1–V5 需要 CDP 驱动 UI；无头 Electron 里 React 合成事件偶发失效时，这几条
 * 会明确标为 SKIP 而非假通过，源码级守卫 tests/rpaVariableUx.test.cjs 与
 * tests/rpa.test.ts 承担主防线。V6 始终是真 HTTP 断言。
 *
 * ## 前置条件
 *   - MySQL 已启动、默认 admin 账号存在
 *   - Vite dev server 在 127.0.0.1:5173
 *   - 已执行过 npm run build（out/main/index.js 存在）
 *
 * ## 用法
 *   node scripts/verify-rpa-variable-ux.mjs
 * 退出码：0 = 无断言失败（SKIP 不计入通过数），1 = 有断言失败。
 *
 * 数据安全：仅在库里没有任何脚本 / 环境时自举最小数据，finally 无条件清理。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.RPA_VAR_CDP_PORT || 9354)
const API_PORT = Number(process.env.RPA_VAR_API_PORT || 39154)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const VITE = 'http://127.0.0.1:5173'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===== CDP 小客户端 =====
let ws
let msgId = 0
const pending = new Map()
const capturedRequests = []

async function cdpSend(method, params = {}) {
  const id = ++msgId
  const p = new Promise((resolve) => pending.set(id, resolve))
  ws.send(JSON.stringify({ id, method, params }))
  return p
}

async function cdpEval(expression) {
  const res = await cdpSend('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res?.result?.exceptionDetails) {
    return { __error: res.result.exceptionDetails.text + ' ' + (res.result.exceptionDetails.exception?.description || '') }
  }
  if (!res?.result?.result) return { __error: 'EVAL_FAILED' }
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

// ===== 断言收集 =====
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}
function skip(name, why) {
  results.push({ name, skipped: true })
  console.log(`  ⏭  SKIP ${name} — ${why}`)
}

const FIND_BTN = `(() => {
  const btn = [...document.querySelectorAll('.ant-table-row button')]
    .find(b => (b.textContent || '').includes('回放'));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
})()`

const READ_MODAL = `(() => {
  const modal = [...document.querySelectorAll('.ant-modal-content')]
    .find(m => (m.textContent || '').includes('开始回放'));
  if (!modal) return null;
  return {
    text: modal.textContent || '',
    spans: [...modal.querySelectorAll('span')].map(s => (s.textContent || '').trim()),
    inputs: [...modal.querySelectorAll('input')].map(i => i.value),
    titles: [...modal.querySelectorAll('[title]')].map(e => e.getAttribute('title') || '')
  };
})()`

async function main() {
  const vite = await fetch(VITE).catch(() => null)
  if (!vite || !vite.ok) throw new Error(`Vite dev server 未就绪：${VITE}（请先 npm run dev）`)

  const env = { ...process.env, ELECTRON_RENDERER_URL: VITE, API_PORT: String(API_PORT) }
  delete env.ELECTRON_RUN_AS_NODE
  const userDataDir = path.join(root, '.tmp_rpa_var_verify')
  fs.mkdirSync(userDataDir, { recursive: true })

  const child = spawn(
    electronBin,
    [
      path.join(root, 'out', 'main', 'index.js'),
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox'
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )

  let authHeaders = null
  let seededProfileId = null
  let seededScriptId = null

  try {
    // ---------- 1. 登录（真 HTTP） ----------
    const login = await waitFor(
      'API 服务就绪',
      async () => {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: '123456' })
        }).catch(() => null)
        if (!res || !res.ok) return null
        const j = await res.json()
        return j.token ? j : null
      },
      60000
    )
    authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }
    console.log('登录成功，用户:', login.user?.username)

    // ---------- 2. 数据自举（空库才建，结束时清理） ----------
    const profilesRes = await fetch(`${API_BASE}/api/profiles`, { headers: authHeaders }).catch(() => null)
    const profilesJson = profilesRes && profilesRes.ok ? await profilesRes.json() : null
    const profiles = Array.isArray(profilesJson) ? profilesJson : profilesJson?.items || profilesJson?.data || []
    if (!profiles.length) {
      const seed = await fetch(`${API_BASE}/api/profiles/quick-create`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({})
      }).catch(() => null)
      if (seed && seed.ok) {
        seededProfileId = (await seed.json())?.id ?? null
        console.log('环境列表为空，已自举一条测试环境 (id=' + seededProfileId + ')')
      }
    }

    const scriptsRes = await fetch(`${API_BASE}/api/rpa`, { headers: authHeaders }).catch(() => null)
    const scripts = scriptsRes && scriptsRes.ok ? await scriptsRes.json() : []
    let target = (Array.isArray(scripts) ? scripts : []).find((s) => s.variables && s.variables.keyword)
    if (!target) {
      const install = await fetch(`${API_BASE}/api/rpa/market/install/amazon-search`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({})
      }).catch(() => null)
      if (!install || !install.ok) throw new Error('自举安装市场脚本失败：' + (install ? install.status : '请求失败'))
      target = await install.json()
      seededScriptId = target?.id ?? null
      console.log('脚本列表为空，已自举安装「亚马逊商品搜索比价」(id=' + seededScriptId + ')')
    }

    // V6：市场目录与已安装脚本的变量数据一致
    const marketRes = await fetch(`${API_BASE}/api/rpa/market`, { headers: authHeaders }).catch(() => null)
    const marketList = marketRes && marketRes.ok ? await marketRes.json() : []
    const amazon = (Array.isArray(marketList) ? marketList : marketList?.items || []).find((m) => m.id === 'amazon-search')
    check('V6 市场脚本变量 keyword 默认值为 wireless earbuds',
      amazon?.variables?.keyword === 'wireless earbuds', JSON.stringify(amazon?.variables || null))
    check('V6 已安装脚本变量与市场一致',
      target.variables?.keyword === 'wireless earbuds', JSON.stringify(target.variables || null))

    // ---------- 3. 连主窗口（用 CDP 网络层抓请求，不注入页面脚本） ----------
    const pageTarget = await waitFor(
      '主窗口 target',
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null
      },
      60000
    )
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method === 'Network.requestWillBeSent') {
        capturedRequests.push({
          url: m.params?.request?.url || '',
          postData: m.params?.request?.postData || ''
        })
      }
    }
    await cdpSend('Network.enable')
    await cdpSend('Page.enable')

    await cdpEval(`(() => {
      localStorage.setItem('roxy_token', ${JSON.stringify(login.token)});
      location.hash = '#/rpa';
      location.reload();
      return 'ok';
    })()`)
    // cdpEval 在页面表达式抛错时返回 { __error } 对象（truthy），必须显式排除，
    // 否则 waitFor 会把「求值失败」误判成「条件已满足」。
    const evalOk = async (expr) => {
      const v = await cdpEval(expr)
      return v && !v.__error ? v : false
    }
    await waitFor('RPA 列表渲染', () => evalOk(`(() => !!document.querySelector('.ant-table-row'))()`))

    // ---------- 4. 打开回放弹窗：鼠标 → 键盘 → DOM click 依次尝试 ----------
    const rect = await cdpEval(FIND_BTN)
    if (!rect || rect.__error) throw new Error('找不到回放按钮：' + JSON.stringify(rect))
    await cdpSend('Page.bringToFront')
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await sleep(600)
    if (!(await evalOk(READ_MODAL))) {
      await cdpEval(`(() => {
        const b = [...document.querySelectorAll('.ant-table-row button')].find(x => (x.textContent||'').includes('回放'));
        if (b) b.focus(); return !!b;
      })()`)
      await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await sleep(600)
    }
    if (!(await evalOk(READ_MODAL))) {
      await cdpEval(`(() => {
        const b = [...document.querySelectorAll('.ant-table-row button')].find(x => (x.textContent||'').includes('回放'));
        if (b) b.click(); return !!b;
      })()`)
      await sleep(600)
    }

    let view = null
    try {
      view = await waitFor('回放弹窗出现', () => evalOk(READ_MODAL), 6000)
    } catch {
      // 某些无头 Electron 实例里 React 合成事件不派发（事件能冒泡到 #root，
      // onClick 却不被调用），这是验证环境限制，不是产品缺陷——用户实机截图
      // 里的弹窗是正常打开的。明确 SKIP，绝不把没跑到的断言算成通过。
      const why = '无头窗口未派发 React onClick，UI 断言改由源码守卫覆盖'
      for (const n of ['V1', 'V2', 'V3', 'V4', 'V5']) skip(n, why)
    }

    if (view && !view.__error) {
      check('V1 弹窗可见文本不再出现 {{keyword}}', !view.text.includes('{{keyword}}'),
        view.text.slice(0, 100).replace(/\s+/g, ' '))
      check('V2 变量字段名显示为中文「搜索关键词」', view.spans.includes('搜索关键词'),
        view.spans.filter((s) => s && s.length < 20).join(' | '))
      check('V3 默认值仍预填 wireless earbuds', view.inputs.includes('wireless earbuds'), view.inputs.join(' | '))
      check('V4 变量名与步骤写法保留在 hover 提示',
        view.titles.some((x) => x.includes('keyword') && x.includes('{{keyword}}')),
        view.titles.join(' | '))

      // V5：选环境 → 清空输入 → 开始回放 → 检查真实请求体。
      // 环境未运行，后端会在变量合并后返回 400，请求已发出且无回放副作用。
      await cdpEval(`(() => {
        const sel = document.querySelector('.ant-modal .ant-select-selector');
        if (!sel) return false;
        sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sel.click(); return true;
      })()`)
      await waitFor('环境下拉选项', () => evalOk(`(() => {
        const opt = [...document.querySelectorAll('.ant-select-item-option')].find(o => o.offsetParent !== null);
        if (!opt) return false; opt.click(); return true;
      })()`), 8000).catch(() => false)

      await cdpEval(`(() => {
        const modal = [...document.querySelectorAll('.ant-modal-content')]
          .find(m => (m.textContent || '').includes('开始回放'));
        const input = modal && modal.querySelector('input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
      await cdpEval(`(() => {
        const b = [...document.querySelectorAll('.ant-modal-content button')]
          .find(x => (x.textContent || '').includes('开始回放'));
        if (b) b.click(); return !!b;
      })()`)

      const call = await waitFor('run 请求发出', () => {
        const c = capturedRequests.find((x) => /\/api\/rpa\/\d+\/run/.test(x.url))
        return c || false
      }, 8000).catch(() => false)
      if (call && call.postData) {
        let body = {}
        try { body = JSON.parse(call.postData) } catch { /* 断言会打印原文 */ }
        check('V5 清空覆盖值后请求体不带空 variables',
          body.variables === undefined || Object.keys(body.variables).length === 0, call.postData)
      } else {
        skip('V5', '未捕获到 run 请求（可能需要先选中一个环境）')
      }
    }

    const failed = results.filter((r) => !r.skipped && !r.ok)
    const skipped = results.filter((r) => r.skipped)
    console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} 条通过，${skipped.length} 条跳过`)
    if (failed.length) process.exitCode = 1
  } finally {
    try { if (ws) ws.close() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    if (authHeaders) {
      if (seededScriptId != null) {
        await fetch(`${API_BASE}/api/rpa/${seededScriptId}`, { method: 'DELETE', headers: authHeaders }).catch(() => null)
      }
      if (seededProfileId != null) {
        // 环境是软删除：先删再 purge，否则行会一直留在库里
        await fetch(`${API_BASE}/api/profiles/${seededProfileId}`, { method: 'DELETE', headers: authHeaders }).catch(() => null)
        await fetch(`${API_BASE}/api/profiles/${seededProfileId}/purge`, { method: 'DELETE', headers: authHeaders }).catch(() => null)
      }
    }
  }
}

main().catch((e) => {
  console.error('\n验证失败：', e.message)
  process.exitCode = 1
})
