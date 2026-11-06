#!/usr/bin/env node
/**
 * 设置页「保存」链路 —— **行为级验证**（CDP 驱动真实 UI）
 *
 * ## 这个脚本解决什么问题
 *
 * 用户报障：「在设置里把 AI Agent 打开、把视觉模型换成 qwen2.5vl:7b，保存后
 * 去 AI Agent 页面显示未启用，再回设置页发现视觉模型又变回之前的了」。
 *
 * 根因（已由 A/B 对照实验确证）：SMTP 三件套（host/user/pass）挂着**无条件**
 * `required`，而默认值是空串。antd 的 `validateFields()` 校验**整张表**，
 * 任一字段不过整次保存就被拒 —— 连 `api.put` 都不会发出。用户改的
 * AI Agent 开关与视觉模型被静默丢弃，重新进页面时 `load()` 又拉回服务端的旧值，
 * 于是观感就是「自己之前改的又被恢复了」。
 *
 * 本脚本把这条链路变成可复现的断言：
 *
 *   A. **SMTP 未配置**时改 AI Agent 开关 + 视觉模型 → 保存 → 服务端确实落库
 *      （用户报障场景本身；此前必失败）
 *   B. 切到「云端 BYOK」后端（本地模型字段被条件渲染卸载）→ 保存 → 本地视觉模型
 *      **不被服务端默认值覆盖**（否则用户切走再回来会发现"模型名被恢复"）
 *   C. SMTP 填一半 → 保存 → **必须有可见提示**（toast + 字段红字），且服务端未被改动
 *      （失败绝不能静默吞掉用户的改动）
 *   D. 改完保存 → 跳到别的页面再回来 → 字段仍是用户设的值
 *
 * ## 与 tests/settingsSaveGuard.test.cjs 的分工
 *
 *   tests/settingsSaveGuard.test.cjs  源码级 + 纯函数级断言，进 pnpm test，快
 *   本脚本                            行为级验证，证明"跑起来对"
 *
 * ## ⚠️ 数据安全
 *
 * 本脚本会写数据库的 settings（不改其它表）。**运行前会完整备份 settings，
 * 结束时无条件还原**——上一版临时脚本没做还原，把占位符写进了用户的配置里，
 * 这次不允许再发生。
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认 127.0.0.1:3306，root/1234560）
 *   - 默认账号 admin / 123456 存在
 *   - **不需要**预先 build：脚本跑 `out/main/index.js`（electron-vite dev 会持续
 *     构建主进程），渲染进程连 Vite dev server（需 dev 正在运行）
 *
 * ## 用法
 *
 *   node scripts/verify-settings-save-guard.mjs
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SETTINGS_VERIFY_CDP_PORT || 9344)
const API_PORT = Number(process.env.SETTINGS_VERIFY_API_PORT || 39150)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===== CDP 小客户端 =====
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

// ===== 断言收集 =====
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ===== 页面操作原语（注入到渲染进程执行）=====

/** 按 label 文本定位 .ant-form-item */
const FIND_ITEM = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  return it ? 'found' : 'not-found';
})()`

/**
 * 给受控输入框赋值。
 * 直接 `inp.value = x` 不会触发 React 的 onChange —— 必须走原生 setter 再派发 input 事件。
 */
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

/** 读受控输入框当前值 */
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

/** 读某个 Form.Item 下 Switch 的选中态 */
const READ_SWITCH = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const sw = it.querySelector('.ant-switch');
  return sw ? !!sw.classList.contains('ant-switch-checked') : 'SWITCH-NOT-FOUND';
})()`

/** 点击某个 Form.Item 下的 Switch */
const TOGGLE_SWITCH = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const sw = it.querySelector('.ant-switch');
  if (!sw) return 'SWITCH-NOT-FOUND';
  sw.click();
  return 'toggled';
})()`

/** 打开某个 Form.Item 下的 antd Select 并选中指定选项 */
const SELECT_OPTION = (label, option) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes(${JSON.stringify(label)});
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const sel = it.querySelector('.ant-select');
  if (!sel) return 'SELECT-NOT-FOUND';
  sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  sel.click();
  return 'opened';
})()`

const PICK_OPTION = (option) => `(() => {
  const opts = [...document.querySelectorAll('.ant-select-item-option')];
  const o = opts.find(x => (x.textContent||'').includes(${JSON.stringify(option)}));
  if (!o) return 'OPT-NOT-FOUND:' + opts.map(x => (x.textContent||'').trim()).join('|');
  o.click();
  return 'picked';
})()`

/** 点「保存设置」 */
const CLICK_SAVE = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '保存设置');
  if (!b) return 'SAVE-BUTTON-NOT-FOUND';
  b.click();
  return 'clicked';
})()`

/** 抓当前页面的校验错误文案 + toast */
const READ_FEEDBACK = `(() => {
  const errs = [...document.querySelectorAll('.ant-form-item-explain-error')].map(e => (e.textContent||'').trim());
  // toast 的类名在 antd 各版本间变过（.ant-message-notice-content / .ant-message-custom-content），
  // 用属性包含匹配兜住，避免"功能正常但断言抓不到"
  const toasts = [...document.querySelectorAll('[class*="ant-message"]')]
    .map(e => (e.textContent||'').trim())
    .filter(t => t && t.length < 300);
  return { errs, toasts: [...new Set(toasts)] };
})()`

/** 抓最近的 PUT /api/settings 请求体（验证前端实际发了什么） */
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

  // 渲染进程加载哪份代码，决定了验证的是不是最新源码：
  //   - dev server 可达 → 走 ELECTRON_RENDERER_URL 加载 dev 源码（改完即生效）
  //   - 否则 → 用 out/ 里的构建产物（需先 npm run build，否则验的是旧代码）
  // 踩过的坑：早期版本没设这个变量，脚本跑的是上一次的 build 产物，
  // 于是"修复没生效"的假象 —— 断言全红而代码其实是对的。
  // SETTINGS_VERIFY_USE_BUILD=1 可强制走构建产物路径（验证打包形态）。
  let devServer = null
  if (process.env.SETTINGS_VERIFY_USE_BUILD !== '1') {
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
    // ---------- 1. 独立端口的 API 就绪 ----------
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

    // ---------- 2. 登录 ----------
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
    console.log('登录成功，用户:', login.user?.username)

    // ---------- 3. 备份 settings（结束必还原） ----------
    backup = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    console.log('已备份 settings：aiAgent.localVisionModel =', backup.aiAgent?.localVisionModel)

    // ---------- 4. 连主窗口 ----------
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

    // ---------- 5. 注入 token + 进设置页 + 装 fetch 探针 ----------
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
    // 等 load() 把服务端值灌进表单（否则会在默认值上做断言）
    await sleep(1200)
    await cdpEval(INSTALL_FETCH_PROBE)

    // ===== A. SMTP 未配置时，AI Agent 开关 + 视觉模型能否存进去 =====
    console.log('\n───── A. SMTP 未配置时的保存 ─────')
    await cdpEval(TYPE_INTO('视觉模型', 'qwen2.5vl:7b'))
    await sleep(400)
    // 开关按需打开：读当前态，没开才点
    const swBefore = await cdpEval(READ_SWITCH('启用 AI Agent'))
    if (swBefore !== true) {
      await cdpEval(TOGGLE_SWITCH('启用 AI Agent'))
      await sleep(400)
    }
    const domVision = await cdpEval(READ_INPUT('视觉模型'))
    const domSwitch = await cdpEval(READ_SWITCH('启用 AI Agent'))
    check('A0 前端表单已改到位（视觉模型 + 开关）', domVision === 'qwen2.5vl:7b' && domSwitch === true, `vision=${domVision} switch=${domSwitch}`)

    await cdpEval(CLEAR_PUT_PROBE)
    await cdpEval(CLICK_SAVE)
    await sleep(1200)

    const fbA = await cdpEval(READ_FEEDBACK)
    const putA = await cdpEval(READ_PUT_PROBE)
    check('A1 保存请求确实发出（PUT /api/settings）', !!putA, putA ? 'body 已捕获' : '未捕获到 PUT 请求')
    check('A2 无校验错误阻断', fbA.errs.length === 0, JSON.stringify(fbA.errs))
    check('A3 有成功提示', fbA.toasts.some((x) => x.includes('已保存')), JSON.stringify(fbA.toasts))

    const serverA = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    check('A4 服务端：AI Agent 开关已落库', serverA.aiAgent?.enabled === true, `enabled=${serverA.aiAgent?.enabled}`)
    check('A5 服务端：视觉模型已落库', serverA.aiAgent?.localVisionModel === 'qwen2.5vl:7b', `localVisionModel=${serverA.aiAgent?.localVisionModel}`)
    check('A6 服务端：SMTP 仍是未配置（没被偷偷写值）', !serverA.smtp?.host, `smtp.host=${JSON.stringify(serverA.smtp?.host)}`)

    // ===== B. 条件渲染卸载的字段不被默认值覆盖 =====
    console.log('\n───── B. 切到云端后端后本地模型不被默认值覆盖 ─────')
    await cdpEval(SELECT_OPTION('模型后端', '云端'))
    await sleep(900)
    const picked = await cdpEval(PICK_OPTION('云端'))
    await sleep(900)
    const backendNow = await cdpEval(`(() => {
      const items = [...document.querySelectorAll('.ant-form-item')];
      const it = items.find(i => {
        const l = i.querySelector('.ant-form-item-label');
        return l && (l.textContent||'').includes('模型后端');
      });
      if (!it) return 'NOT-FOUND';
      const sel = it.querySelector('.ant-select');
      if (!sel) return 'NO-SELECT';
      return (sel.textContent||'').trim() || 'EMPTY';
    })()`)
    check('B1 模型后端已切到云端（本地模型字段被卸载）', /云端/.test(String(backendNow)), `picked=${picked} backend=${backendNow}`)

    await cdpEval(CLEAR_PUT_PROBE)
    await cdpEval(CLICK_SAVE)
    await sleep(1200)
    const serverB = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    check(
      'B2 本地视觉模型未被服务端默认值覆盖',
      serverB.aiAgent?.localVisionModel === 'qwen2.5vl:7b',
      `localVisionModel=${serverB.aiAgent?.localVisionModel}`
    )

    // ===== C. SMTP 填一半 → 必须有可见提示，且服务端不被改动 =====
    console.log('\n───── C. 校验失败必须可见 ─────')
    await cdpEval(TYPE_INTO('SMTP 服务器', 'smtp.partial.example'))
    await sleep(400)
    await cdpEval(CLEAR_PUT_PROBE)
    await cdpEval(CLICK_SAVE)
    await sleep(1200)
    const fbC = await cdpEval(READ_FEEDBACK)
    const putC = await cdpEval(READ_PUT_PROBE)
    check('C1 校验失败有可见提示（toast）', fbC.toasts.some((x) => x.includes('未通过校验')), JSON.stringify(fbC.toasts))
    check('C2 出错字段有红字提示', fbC.errs.length > 0, JSON.stringify(fbC.errs))
    check('C3 校验失败时未发出 PUT（不应提交半份配置）', !putC, putC ? '竟发出了 PUT' : '未发出 PUT')

    // 清掉 SMTP 半份输入，避免影响后续场景
    await cdpEval(TYPE_INTO('SMTP 服务器', ''))
    await sleep(300)

    // ===== D. 改完保存 → 跳走再回来，值仍在 =====
    console.log('\n───── D. 跳转页面再回来，值仍在 ─────')
    await cdpEval(TYPE_INTO('视觉模型', 'qwen2.5vl:7b'))
    await sleep(400)
    // 切回本地后端，让视觉模型字段重新挂载
    await cdpEval(SELECT_OPTION('模型后端', '本地'))
    await sleep(900)
    await cdpEval(PICK_OPTION('本地'))
    await sleep(900)
    await cdpEval(CLICK_SAVE)
    await sleep(1200)

    // 跳到 AI Agent 页，再回设置页
    await cdpEval(`(() => { location.hash = '#/ai-agent'; return 'nav'; })()`)
    await sleep(1500)
    const aiPageText = await cdpEval(`(() => (document.body.innerText || '').slice(0, 400))()`)
    await cdpEval(`(() => { location.hash = '#/settings'; return 'nav'; })()`)
    await sleep(1200)

    const visionAfter = await cdpEval(READ_INPUT('视觉模型'))
    check('D1 跳走再回来，视觉模型输入框仍是 qwen2.5vl:7b', visionAfter === 'qwen2.5vl:7b', `value=${visionAfter}`)

    const serverD = await (await fetch(`${apiBase}/api/settings`, { headers: auth })).json()
    check('D2 服务端仍是 qwen2.5vl:7b', serverD.aiAgent?.localVisionModel === 'qwen2.5vl:7b', `localVisionModel=${serverD.aiAgent?.localVisionModel}`)
    check('D3 AI Agent 页已识别为「已启用」（不再显示未启用提示）', !/AI Agent 未启用/.test(String(aiPageText)), String(aiPageText).slice(0, 120).replace(/\n/g, ' '))

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
    // ===== 还原 settings（绝不能把测试数据留在用户数据库里）=====
    if (backup && token) {
      try {
        await fetch(`${API_BASE}/api/settings`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(backup)
        })
        const restored = await (await fetch(`${API_BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } })).json()
        console.log(
          '\n已还原 settings：localVisionModel =',
          restored.aiAgent?.localVisionModel,
          '| smtp.host =',
          JSON.stringify(restored.smtp?.host)
        )
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
