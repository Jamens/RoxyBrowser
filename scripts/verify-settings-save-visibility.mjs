#!/usr/bin/env node
/**
 * 设置页「云端后端存不进去」四道防线 —— **行为级验证**（CDP 驱动真实 UI）
 *
 * ## 背景：用户实测报障
 *
 * 「我设置了线上模型，参数也填写了，回到 AI Agent 页面还是显示本地模型，
 *   再回去设置又变回去本地模型。」
 *
 * binlog 取证还原出的真相（见 VERIFY.md）：
 *
 * | 时刻 | binlog 里的行镜像 | 说明 |
 * | ---- | ------------------ | ---- |
 * | 20:38 | **无任何写入** | 用户填好云端参数后点的那次保存，**一个字节都没落库** |
 * | 20:49 | `local` → `cloud` | 后来保存成功了（说明链路本身没问题） |
 * | 20:51 | `cloud` → `local` | 又切回本地保存 |
 *
 * 且整个 binlog 里 `api.deepseek.com` 出现 **0 次** —— 用户截图里那个
 * 被误填进「API 地址」栏的 `sk-...` 串**从未落过库**。
 *
 * ## 根因（本轮修的四处）
 *
 * 1. **CDP 卡片的按钮与主保存按钮同名**（都叫「保存设置」）
 *    → 用户点的是 CDP 那个，它只写 `cdpEnabled`/`cdpPort`，**不提交表单**。
 * 2. **主保存按钮在整张表单的最末尾**，AI Agent 配置在表单中部
 *    → 改完参数时「保存设置」根本不在视野内。
 * 3. **API 地址栏没有形状校验** → 用户把 API Key 填进去，拼出非法 URL。
 * 4. **离开页面不拦截未保存改动** → 改完直接切走，回来看见旧值像「被系统恢复」。
 *
 * ## 本脚本验证什么
 *
 * - V1  CDP 卡片的按钮文案**不再是**「保存设置」（不再与主按钮同名）
 * - V2  AI Agent 区块内有**就近的保存按钮**，点它能真的落库（backend=cloud）
 * - V3  API 地址栏填 API Key → **被拦下**，并给出「这看起来是 API Key」的提示
 * - V4  云端模式下不填 API Key → **被拦下**（不静默存成空 Key）
 * - V5  保存成功后回到设置页，参数没丢；AI Agent 页显示「云端」
 *
 * ## ⚠️ 数据安全
 *
 * 本脚本会写数据库的 settings。**启动时完整备份 settings，退出时无条件还原。**
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.SAVE_GUARD_CDP_PORT || 9379)
const API_PORT = Number(process.env.SAVE_GUARD_API_PORT || 39182)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 运行时拼装「像密钥的字符串」。
 *
 * ## 为什么不在源码里写字面量
 *
 * 本项目的硬约束：**仓库里不得出现任何真实或形似真实的密钥**。
 * 本脚本需要往「API Key」栏填入一个**能被前端识别成 Key** 的值才能触发校验，
 * 但把它写死成 `sk-` + 32 位十六进制会带来两个实际风险：
 * 1. **密钥扫描器误报** —— CI / 提交钩子里的 secret scanner 会当真实凭据拦截，
 *    久了大家就学会「忽略告警」，告警随即失去意义。
 * 2. **真实凭据的滑坡入口** —— 源码里已经躺着一个「格式完全正确的 key」时，
 *    下一个人顺手把测试值换成自己真实 Key 去「验证一下」几乎零阻力，
 *    这正是凭据泄漏最常见的路径。
 *
 * 故改为运行时拼装：源码里只有前缀片段与占位字符，
 * 任何静态扫描（正则 / grep / secret scanner）都扫不出完整密钥形态。
 *
 * 语义等价性：前端的判定是**前缀匹配**
 * （src/shared/cloudConfigValidation.ts 的 `/^(sk-|sk_ant-|AIza|gsk_|xai-|...)/i`），
 * 判定只看前缀，故拼装值与手写字面量在**被测行为上完全一致**。
 */
const FAKE_KEY = 'sk-' + 'x'.repeat(32)

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
  // 顶层异常（Runtime.evaluate 自身失败）也要暴露出来，否则调用方只看到 undefined
  if (!res?.result?.result) {
    return { __error: 'EVAL_FAILED:' + JSON.stringify(res).slice(0, 300) }
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
  console.log(`  ${ok ? '✅' : '❌'}${name}${detail ? ' — ' + detail : ''}`)
}

/**
 * 把页面原语里的占位符换成实际值。
 *
 * 原语一律写成**字符串常量**（不是函数）：写成函数时若调用处漏了括号，
 * 传给 CDP 的就是函数源码，CDP 会以「模板字面量」去解析它，报一个完全看不懂的错：
 * `Invalid parameters - Failed to deserialize params.expression`。
 * 用占位符 + 运行时替换，既保留了这个安全性，又避免了拼错引号。
 */
function fill(tpl, values) {
  let out = tpl
  for (const [k, v] of Object.entries(values)) {
    out = out.replace(`'${k}'`, JSON.stringify(v))
  }
  return out
}

// ===== 页面原语 =====
/** 按按钮显示文本找按钮 */
const FIND_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '__TEXT__');
  return b ? 'found' : 'not-found';
})()`

/** 按按钮显示文本点按钮 */
const CLICK_BUTTON = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '__TEXT__');
  if (!b) return 'BUTTON-NOT-FOUND';
  b.scrollIntoView({block:'center'});
  b.click();
  return 'clicked';
})()`

/** 列出页面上所有按钮的显示文本（去重） */
const LIST_BUTTONS = `JSON.stringify((() => {
  const s = new Set();
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent||'').replace(/\\s/g,'').trim();
    if (t) s.add(t);
  }
  return [...s];
})())`

/** 找到 label 含指定文案的 Form.Item */
const FIND_ITEM = (label) => `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes('__LABEL__');
  });
  return it ? 'found' : 'not-found';
})()`

/** 读某 Form.Item 里输入框的当前值 */
const READ_INPUT = `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes('__LABEL__');
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const inp = it.querySelector('input');
  return inp ? inp.value : 'INPUT-NOT-FOUND';
})()`

/** 往某 Form.Item 的输入框写值（触发 React 的 onChange） */
const TYPE_INTO = `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes('__LABEL__');
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const inp = it.querySelector('input');
  if (!inp) return 'INPUT-NOT-FOUND';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '__VALUE__');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed';
})()`

/**
 * 读某 Form.Item 里 antd 6 Select 当前显示的文本。
 *
 * ⚠️ antd 6 的 Select **没有** `.ant-select-selection-item`（那是 antd 4/5 的结构），
 * 现在的结构是 `.ant-select-content`，其文本同时放在 textContent 与 title 属性里。
 * 用旧选择器会一律取到 NO-SELECTION —— 表现为「脚本说没切成功」，实际是脚本瞎了。
 */
const READ_SELECT = `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes('__LABEL__');
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const c = it.querySelector('.ant-select-content');
  return c ? (c.getAttribute('title') || c.textContent || '').trim() : 'NO-SELECTION';
})()`

/**
 * 打开「模型后端」下拉。
 *
 * antd 6 的 Select 用 `.ant-select-content` 承载显示值，`readonly` 的 input 才是交互点。
 * 展开靠 mousedown（antd 内部用 onMouseDown 切换 open）。
 *
 * ⚠️ 这里写成**字符串常量**而不是函数：写成函数时若调用处漏了括号，
 * 传给 CDP 的就是函数源码（含模板字面量），CDP 会以「模板字面量」去解析它，
 * 报一个完全看不懂的错：`Invalid parameters - Failed to deserialize params.expression`。
 */
const SELECT_BACKEND = `(() => {
  const items = [...document.querySelectorAll('.ant-form-item')];
  const it = items.find(i => {
    const l = i.querySelector('.ant-form-item-label');
    return l && (l.textContent||'').includes('模型后端');
  });
  if (!it) return 'ITEM-NOT-FOUND';
  const sel = it.querySelector('.ant-select');
  if (!sel) return 'NO-SELECT';
  const inp = sel.querySelector('input');
  if (inp) inp.focus();
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

/** 读校验错误文案 + toast */
const READ_FEEDBACK = `JSON.stringify((() => {
  const errs = [...document.querySelectorAll('.ant-form-item-explain-error')].map(e => (e.textContent||'').trim());
  const toasts = [...document.querySelectorAll('[class*="ant-message"]')]
    .map(e => (e.textContent||'').trim())
    .filter(t => t && t.length < 400);
  return { errs, toasts: [...new Set(toasts)] };
})())`

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

const READ_PUT_PROBE = `JSON.stringify((window.__roxyPutProbe || []).slice(-1)[0] || null)`
const PUT_COUNT = `String((window.__roxyPutProbe || []).length)`
/** 读 AI Agent 页顶部的标签 */
const READ_AGENT_TAGS = `JSON.stringify((() => {
  const tags = [...document.querySelectorAll('.ant-tag')].map(t => (t.textContent||'').trim()).filter(Boolean);
  return tags;
})())`

/** 读「有未保存的改动」提示是否出现 */
const READ_DIRTY_TAG = `String((() => {
  const tags = [...document.querySelectorAll('.ant-tag')].map(t => (t.textContent||'').trim());
  return tags.find(t => t.includes('未保存')) || '';
})())`

// ===== 数据库（备份 / 还原 / 校验）=====
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '1234560',
  database: process.env.DB_NAME || 'roxy_browser'
}

async function dbRead() {
  const mysql = require('mysql2/promise')
  const conn = await mysql.createConnection(DB_CONFIG)
  const [rows] = await conn.query('SELECT `settings` FROM app_settings WHERE `key`=?', ['global'])
  await conn.end()
  const raw = rows?.[0]?.settings
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

async function dbWrite(settings) {
  const mysql = require('mysql2/promise')
  const conn = await mysql.createConnection(DB_CONFIG)
  await conn.query('UPDATE app_settings SET `settings`=? WHERE `key`=?', [JSON.stringify(settings), 'global'])
  await conn.end()
}

// ===== 主流程 =====
async function main() {
  const backup = await dbRead()
  if (!backup) throw new Error('读不到 app_settings，无法备份')
  console.log('  ℹ️ 已备份原设置（退出时无条件还原）')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.API_PORT = String(API_PORT)
  env.ROXY_API_BASE = API_BASE

  let devServer = null
  if (process.env.SAVE_GUARD_USE_BUILD !== '1') {
    for (const port of [5173, 5174, 5175, 5176]) {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' }).catch(() => null)
      if (res && res.ok) {
        devServer = `http://localhost:${port}`
        console.log(`  ℹ️ 使用 dev server：${devServer}`)
        break
      }
    }
  }
  if (!devServer) {
    console.log('  ℹ️ 未发现 dev server，使用构建产物 out/')
  }

  const userDataDir = path.join(root, '.tmp_save_guard_profile')
  fs.rmSync(userDataDir, { recursive: true, force: true })

  const args = [
    path.join(root, 'out', 'main', 'index.js'),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox'
  ]
  const child = spawn(electronBin, args, {
    cwd: root,
    env: devServer ? { ...env, ELECTRON_RENDERER_URL: devServer } : env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let outLog = ''
  child.stdout.on('data', (d) => { outLog += d.toString() })
  child.stderr.on('data', (d) => { outLog += d.toString() })

  try {
    // 连 CDP
    let target = null
    await waitFor('CDP 目标就绪', async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
      if (!res || !res.ok) return null
      const list = await res.json()
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      return target
    }, 40000)

    const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }))
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m)
          pending.delete(m.id)
        }
      } catch { /* ignore */ }
    })

    // 登录：直接调 API 拿 token 写进 localStorage。
    // 比点 UI 按钮可靠 —— 登录按钮文案是「登 录」（中间带空格），
    // 且它是 antd Tabs 的页签，误点不会触发提交。
    await waitFor('登录页出现', async () => (await cdpEval(`document.body.innerText.includes('登录')`)) ? true : null, 40000)
    const loginRes = await cdpEval(`(async () => {
      const r = await fetch('http://127.0.0.1:${API_PORT}/api/auth/login', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ username: 'admin', password: '123456' })
      });
      const j = await r.json();
      const t = j.token || j.data?.token || '';
      if (t) localStorage.setItem('roxy_token', t);
      return t ? 'ok' : ('fail:' + r.status + ':' + JSON.stringify(j).slice(0,200));
    })()`)
    if (loginRes !== 'ok') throw new Error('登录失败：' + loginRes)
    await cdpEval(`location.hash = '#/settings'`)
    await waitFor('设置页加载', async () => (await cdpEval(`document.body.innerText.includes('AI Agent')`)) ? true : null, 40000)
    await sleep(3000)

    // ===== V1：CDP 卡片按钮不再与主按钮同名 =====
    const buttons = JSON.parse((await cdpEval(LIST_BUTTONS)) || '[]')
    const saveLabelCount = buttons.filter((b) => b === '保存设置').length
    check(
      'V1 CDP 卡片按钮文案不再与主保存按钮同名',
      saveLabelCount === 1 && buttons.includes('保存调试端口'),
      `页面上「保存设置」出现 ${saveLabelCount} 次；含「保存」的按钮：${buttons.filter((b) => b.includes('保存')).join(' / ')}`
    )

    // ===== V3：API 地址栏填 Key 被拦下（先测这个，因为它不写库）=====
    // 预热：先做一次读取（诊断发现 antd 的下拉在页面刚渲染完时可能还没绑好事件）
    await cdpEval(fill(READ_SELECT, { __LABEL__: '模型后端' }))
    await sleep(500)

    // 打开下拉（最多试 3 次：antd 6 的展开依赖 mousedown，首帧可能丢事件）
    let opened = false
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      const r = await cdpEval(SELECT_BACKEND)
      await sleep(800)
      const n = await cdpEval(`document.querySelectorAll('.ant-select-item-option').length`)
      if (Number(n) >= 2) opened = true
      else {
        console.log(`    ℹ️ 第 ${attempt + 1} 次打开下拉失败：${JSON.stringify(r)}，option 数=${n}`)
        console.log('       下拉相关 DOM：' + JSON.stringify(await cdpEval(`(() => {
          const items=[...document.querySelectorAll('.ant-form-item')];
          const it=items.find(i=>{const l=i.querySelector('.ant-form-item-label');return l&&(l.textContent||'').includes('模型后端');});
          return {
            itemFound: !!it,
            hasSelect: !!(it&&it.querySelector('.ant-select')),
            dropdowns: document.querySelectorAll('.ant-select-dropdown').length,
            popups: document.querySelectorAll('.ant-select-dropdown-hidden').length,
            listboxes: document.querySelectorAll('[role="listbox"]').length
          };
        })()`)))
      }
    }
    check('下拉已展开', opened, '模型后端下拉未打开')
    if (!opened) throw new Error('模型后端下拉打不开，后续用例无法进行')

    await cdpEval(CLICK_OPTION('云端 BYOK（需 Key）'))
    // 等选中生效
    await waitFor('后端切到云端', async () => {
      const v = await cdpEval(fill(READ_SELECT, { __LABEL__: '模型后端' }))
      return String(v).includes('云端') ? v : null
    }, 10000)
    const backendSwitched = await cdpEval(fill(READ_SELECT, { __LABEL__: '模型后端' }))
    check('V0 已切到「云端 BYOK」', String(backendSwitched).includes('云端'), `当前：${backendSwitched}`)

    await cdpEval(fill(TYPE_INTO, { __LABEL__: 'API 地址', __VALUE__: FAKE_KEY }))
    await cdpEval(fill(TYPE_INTO, { __LABEL__: '模型名', __VALUE__: 'deepseek-v4-flash' }))
    await cdpEval(fill(TYPE_INTO, { __LABEL__: '视觉模型（云端）', __VALUE__: 'deepseek-v4-flash-vision-exp' }))
    await cdpEval(fill(TYPE_INTO, { __LABEL__: 'API Key', __VALUE__: FAKE_KEY }))
    await sleep(400)

    await cdpEval(fill(CLICK_BUTTON, { __TEXT__: '保存AIAgent设置' }))
    await sleep(1200)
    const fb1 = JSON.parse((await cdpEval(READ_FEEDBACK)) || '{}')
    const keyMisplaced = (fb1?.errs || []).some((e) => e.includes('API Key') && e.includes('地址'))
    check(
      'V3 API 地址栏误填 API Key → 被拦下并点名说明',
      keyMisplaced,
      `校验错误：${JSON.stringify(fb1?.errs || [])}`
    )

    // ===== V4：不填 API Key 也被拦下 =====
    await cdpEval(fill(TYPE_INTO, { __LABEL__: 'API 地址', __VALUE__: 'https://api.deepseek.com/v1' }))
    await sleep(300)
    // 把 API Key 清空
    await cdpEval(`(() => {
      const items = [...document.querySelectorAll('.ant-form-item')];
      const it = items.find(i => {
        const l = i.querySelector('.ant-form-item-label');
        return l && (l.textContent||'').includes('API Key');
      });
      const inp = it && it.querySelector('input');
      if (!inp) return 'NOT-FOUND';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(inp, '');
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      inp.dispatchEvent(new Event('change', {bubbles:true}));
      return 'cleared';
    })()`)
    await sleep(400)
    await cdpEval(fill(CLICK_BUTTON, { __TEXT__: '保存AIAgent设置' }))
    await sleep(1200)
    const fb2 = JSON.parse((await cdpEval(READ_FEEDBACK)) || '{}')
    const keyRequired = (fb2?.errs || []).some((e) => e.includes('API Key'))
    check('V4 云端模式下不填 API Key → 被拦下', keyRequired, `校验错误：${JSON.stringify(fb2?.errs || [])}`)

    // ===== V2：填对后点就近保存按钮 → 真的落库 =====
    await cdpEval(fill(TYPE_INTO, { __LABEL__: 'API Key', __VALUE__: FAKE_KEY }))
    await sleep(500)
    await cdpEval(INSTALL_FETCH_PROBE)
    const before = await cdpEval(PUT_COUNT)
    const clicked = await cdpEval(fill(CLICK_BUTTON, { __TEXT__: '保存AIAgent设置' }))
    if (clicked === 'BUTTON-NOT-FOUND') {
      console.log('    ℹ️ 页面上所有按钮：' + JSON.stringify(JSON.parse((await cdpEval(LIST_BUTTONS)) || '[]')))
    }
    await sleep(2500)
    const after = await cdpEval(PUT_COUNT)
    const probeRaw = await cdpEval(READ_PUT_PROBE)
    let probe = null
    try { probe = probeRaw ? JSON.parse(probeRaw) : null } catch { probe = null }
    console.log(`    ℹ️ 点击结果=${JSON.stringify(clicked)} | PUT before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    console.log(`    ℹ️ 载荷=${JSON.stringify(probe)?.slice(0, 300)}`)
    check(
      'V2 点就近保存按钮 → 真的发出 PUT /api/settings',
      Number(after) > Number(before),
      `PUT 次数 ${JSON.stringify(before)} → ${JSON.stringify(after)}`
    )
    check(
      'V2b 载荷里 backend === "cloud" 且云端字段齐全',
      probe?.aiAgent?.backend === 'cloud' &&
        probe?.aiAgent?.cloudModel === 'deepseek-v4-flash' &&
        probe?.aiAgent?.cloudVisionModel === 'deepseek-v4-flash-vision-exp' &&
        probe?.aiAgent?.cloudBaseUrl === 'https://api.deepseek.com/v1' &&
        !!probe?.aiAgent?.cloudApiKey,
      `aiAgent=${JSON.stringify(probe?.aiAgent || null)}`
    )

    const dbNow = await dbRead()
    check(
      'V2c 服务端落库 backend === "cloud"',
      dbNow?.aiAgent?.backend === 'cloud',
      `落库 backend=${dbNow?.aiAgent?.backend}，cloudModel=${dbNow?.aiAgent?.cloudModel}`
    )
    check(
      'V2d 落库的 API 地址是合法 URL（没被 Key 覆盖）',
      dbNow?.aiAgent?.cloudBaseUrl === 'https://api.deepseek.com/v1',
      `cloudBaseUrl=${dbNow?.aiAgent?.cloudBaseUrl}`
    )

    // ===== V5：AI Agent 页显示云端 =====
    await cdpEval(`location.hash = '#/ai-agent'`)
    await sleep(2500)
    const tags = JSON.parse((await cdpEval(READ_AGENT_TAGS)) || '[]')
    check(
      'V5 AI Agent 页显示「云端 BYOK」而不是「本地」',
      (tags || []).some((t) => t.includes('云端')),
      `标签：${(tags || []).join(' / ')}`
    )

    // ===== V5b：回设置页参数没丢 =====
    await cdpEval(`location.hash = '#/settings'`)
    await sleep(2500)
    const modelAfter = await cdpEval(fill(READ_INPUT, { __LABEL__: '模型名' }))
    check('V5b 回到设置页云端模型名没丢', modelAfter === 'deepseek-v4-flash', `模型名=${modelAfter}`)

    // ===== V4b：保存成功后「未保存改动」提示消失 =====
    const dirty = await cdpEval(READ_DIRTY_TAG)
    check('V4b 保存成功后不再提示「有未保存的改动」', !dirty, `提示=${dirty || '（无）'}`)

    // ===== 额外：未保存提示在改动后出现 =====
    await cdpEval(fill(TYPE_INTO, { __LABEL__: '模型名', __VALUE__: 'deepseek-v4-pro' }))
    await sleep(800)
    const dirty2 = await cdpEval(READ_DIRTY_TAG)
    check('V4c 改动后出现「有未保存的改动」提示', !!dirty2, `提示=${dirty2 || '（无）'}`)
  } finally {
    // 还原数据库
    try {
      await dbWrite(backup)
      console.log('  ℹ️ 已还原数据库设置')
    } catch (e) {
      console.error('  ❌ 还原数据库失败：', e.message)
      process.exitCode = 1
    }
    try { child.kill() } catch { /* ignore */ }
    await sleep(600)
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('\n  失败项：')
    for (const f of failed) console.log(`   ❌ ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
    process.exitCode = 1
  } else {
    console.log('  ✅ 全部通过')
  }
}

main().catch((e) => {
  console.error('  ❌ 脚本异常：', e.message)
  console.error(e.stack)
  process.exitCode = 1
})
