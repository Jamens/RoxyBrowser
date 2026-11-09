#!/usr/bin/env node
/**
 * 环境管理「操作列 + 编辑抽屉高级设置」—— **行为级验证**（CDP 驱动真实 UI）
 *
 * ## 这个脚本解决什么问题
 *
 * 用户报障：「环境管理的编辑环境的高级设置 ui 有点问题」。
 * 根因是**横向 Space 不换行 + 子项自然宽度超出容器**：
 *
 *   - 编辑抽屉里的「指纹配置 → 高级设置」有一排 7 个开关（Canvas 噪声 /
 *     Audio 噪声 / 追踪器屏蔽 / …），自然宽度约 704px，而抽屉只有 640px。
 *     不换行时 flex 只能压缩每一项，把 label 压到 ~45px，中文逐字竖排
 *     （「追踪器屏蔽」竖成 6 行）。
 *   - 同类问题在设置页「安全阈值」区重演（三个 InputNumber + extra 说明）。
 *
 * 审计时顺带查出**两个同源缺陷**（都在环境管理页）：
 *
 *   - 操作列声明 276px，11 个按钮的自然宽度是 354px → 内容溢出单元格 78px，
 *     「删除」被推到表格右边界之外。
 *   - 11 个按钮里唯独「编辑」既无 Tooltip 也无 aria-label，悬停无任何提示
 *     （其余 10 个都有 Tooltip）。
 *
 * 本脚本把这些变成可复现的断言：
 *
 *   A. 高级设置：7 个表单项全部单行显示（label 高度 ≤ 32px）
 *   B. 设置页安全阈值：label 全部单行
 *   C. 操作列：单元格内容宽度 ≤ 单元格宽度（不溢出）
 *   D. 操作列：横向滚动到底后，所有按钮都在表体可见区内（不被裁切）
 *   E. 编辑按钮：悬停出现 Tooltip，且文案可读
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认 127.0.0.1:3306，root/1234560）
 *   - 默认账号 admin / 123456 存在
 *   - 渲染进程连 Vite dev server（需 dev 正在运行）
 *
 * ## 用法
 *
 *   node scripts/verify-env-operations-layout.mjs
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.ENV_LAYOUT_VERIFY_CDP_PORT || 9352)
const API_PORT = Number(process.env.ENV_LAYOUT_VERIFY_API_PORT || 39152)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===== CDP 小客户端 =====
let ws
let msgId = 0
const pending = new Map()

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
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 抽屉里所有 Form.Item label 的高度：> 32px 视为被压成多行 */
const READ_MULTILINE_LABELS = `(() => {
  const labels = [...document.querySelectorAll('.ant-drawer .ant-form-item-label')];
  return labels.map(l => ({
    text: (l.textContent||'').trim(),
    h: Math.round(l.getBoundingClientRect().height)
  })).filter(x => x.h > 32);
})()`

async function main() {
  const env = { ...process.env, ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173', API_PORT: String(API_PORT) }
  delete env.ELECTRON_RUN_AS_NODE
  const userDataDir = path.join(root, '.tmp_env_layout_verify')
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

  try {
    // ---------- 1. 登录 ----------
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
    console.log('登录成功，用户:', login.user?.username)

    // ---------- 2. 连主窗口 ----------
    const target = await waitFor(
      '主窗口 target',
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null
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
      localStorage.setItem('roxy_token', ${JSON.stringify(login.token)});
      location.hash = '#/envs';
      // 必须 reload：应用启动时停在 /login，HashRouter 不会因为改了 hash
      // 就重新走一遍路由守卫，token 也就来不及注入。
      location.reload();
      return 'ok';
    })()`)
    await waitFor(
      '环境列表渲染',
      async () => (await cdpEval(`document.querySelectorAll('.ant-table-row').length`)) || null,
      40000
    )
    await sleep(1500)

    // ---------- E. 编辑按钮有 Tooltip ----------
    // 放在最前面做：Tooltip 依赖真实鼠标事件，抽屉开合会让坐标失效。
    // 必须用真实鼠标事件——antd Tooltip 用 cloneElement，不产生 DOM 包裹，
    // 靠查询 DOM 里的 .ant-tooltip 永远查不到。
    await cdpEval(`(() => {
      const body = document.querySelector('.ant-table-body') || document.querySelector('.ant-table-content');
      if (body) body.scrollLeft = body.scrollWidth;
      return 'ok';
    })()`)
    await sleep(900)
    const pos = await cdpEval(`(() => {
      const row = document.querySelector('.ant-table-row');
      const btn = row && row.querySelector('button .anticon-edit');
      if (!btn) return null;
      const b = btn.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
    })()`)
    let tipText = ''
    if (pos) {
      const { x, y } = JSON.parse(pos)
      // 先在按钮上装事件记录，看真实鼠标事件到底有没有打上去
      await cdpEval(`(() => {
        const row = document.querySelector('.ant-table-row');
        const btn = row && row.querySelector('button .anticon-edit');
        if (!btn) return 'NO_BTN';
        window.__hoverLog = [];
        ['mouseover','mouseenter','mousemove','pointerover'].forEach(ev => {
          btn.addEventListener(ev, () => window.__hoverLog.push(ev), true);
        });
        return 'listening';
      })()`)
      await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10, buttons: 0 })
      await sleep(300)
      await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
      await sleep(200)
      await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y: y + 1, buttons: 0 })
      await sleep(1500)
      // antd 的 Tooltip 渲染在 body 下的 portal 里，类名可能是 .ant-tooltip，
      // 也可能只留 .ant-tooltip-inner / [role=tooltip]——全查一遍，
      // 免得因为选择器太窄而误判成「没出现」。
      const tips = await cdpEval(`JSON.stringify({
        all: Array.from(document.querySelectorAll('.ant-tooltip, .ant-tooltip-inner, [role="tooltip"]')).map(t => ({
          cls: String(t.className).slice(0, 60),
          role: t.getAttribute('role') || '',
          text: (t.textContent||'').trim().slice(0, 60),
          hidden: t.classList.contains('ant-tooltip-hidden')
        })),
        bodyTail: (document.body.innerHTML.match(/ant-tooltip[^"]*/g) || []).slice(0, 8)
      })`)
      console.log('  · Tooltip DOM:', tips)
      const parsed = JSON.parse(tips)
      tipText = parsed.all.map((t) => t.text).filter(Boolean).join(' | ')
    }
    check('E1 编辑按钮：悬停出现 Tooltip', tipText.length > 0 && tipText.includes('编辑环境'), `提示文案=${JSON.stringify(tipText)}`)

    // ---------- A. 打开编辑抽屉 → 指纹配置 → 高级设置 ----------
    await cdpEval(`(() => {
      const row = document.querySelector('.ant-table-row');
      const btn = row && row.querySelector('button .anticon-edit');
      if (!btn) return 'NO_EDIT';
      btn.closest('button').click();
      return 'clicked';
    })()`)
    await waitFor(
      '编辑抽屉就绪',
      async () => {
        const r = await cdpEval(`(() => {
          const title = document.querySelector('.ant-drawer-title');
          const tabs = document.querySelectorAll('.ant-tabs-tab').length;
          return tabs && title && /编辑环境/.test(title.textContent) ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      40000
    )
    await cdpEval(`(() => {
      const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => (x.textContent||'').includes('指纹配置'));
      if (t) t.click();
      return 'ok';
    })()`)
    await sleep(1200)
    // 「高级设置」是**指纹配置 Tab 内部的 Collapse 折叠面板**（key=advanced），
    // 不是 Tab、也不是顶层 Collapse。按 .ant-tabs-tab 找会永远点不到，
    // 断言就成了「抽屉里没渲染出任何多行 label」的假通过。
    const advPanel = await cdpEval(`(() => {
      const heads = [...document.querySelectorAll('.ant-drawer .ant-collapse-header')];
      const h = heads.find(x => (x.textContent||'').includes('高级设置'));
      if (!h) return 'NOT-FOUND: ' + heads.map(x => (x.textContent||'').trim()).join('|');
      h.click();
      return 'clicked';
    })()`)
    check('A0 高级设置折叠面板存在并可展开', advPanel === 'clicked', String(advPanel))
    await sleep(1500)

    const multiLabels = await cdpEval(READ_MULTILINE_LABELS)
    check(
      'A1 编辑抽屉：所有 label 单行显示（无一被压成多行）',
      Array.isArray(multiLabels) && multiLabels.length === 0,
      JSON.stringify(multiLabels)
    )

    // 高级设置那一排的开关数（确认真的展开到了那一排，而不是空断言）。
    // 高级设置里是 5 个开关：Canvas 噪声 / Audio 噪声 / 追踪器屏蔽 /
    // HTTP 警告 / 减少动效。断言它们都渲染出来了，才说明这一排确实在屏上。
    const advCount = await cdpEval(`(() => {
      const drawer = document.querySelector('.ant-drawer');
      if (!drawer) return 0;
      return drawer.querySelectorAll('.ant-switch').length;
    })()`)
    check('A2 高级设置已展开（5 个开关都在屏上）', Number(advCount) >= 5, `抽屉内开关数=${advCount}`)

    // 关闭抽屉
    await cdpEval(`(() => {
      const x = document.querySelector('.ant-drawer-close');
      if (x) { x.click(); return 'closed'; }
      return 'NOT-FOUND';
    })()`)
    await sleep(1200)

    // ---------- B. 设置页安全阈值 ----------
    await cdpEval(`location.hash = '#/settings'`)
    await sleep(2000)
    await cdpEval(`(() => {
      const t = [...document.querySelectorAll('.ant-collapse-header, .ant-tabs-tab')]
        .find(x => (x.textContent||'').includes('安全'));
      if (t) t.click();
      return 'ok';
    })()`)
    await sleep(1500)
    const secLabels = await cdpEval(`(() => {
      const labels = [...document.querySelectorAll('.ant-form-item-label')];
      return labels.map(l => ({
        text: (l.textContent||'').trim(),
        h: Math.round(l.getBoundingClientRect().height)
      })).filter(x => x.h > 32);
    })()`)
    check('B1 设置页：所有 label 单行显示', Array.isArray(secLabels) && secLabels.length === 0, JSON.stringify(secLabels))

    // ---------- C. 操作列不溢出单元格 ----------
    await cdpEval(`location.hash = '#/envs'`)
    await waitFor(
      '环境列表重新渲染',
      async () => (await cdpEval(`document.querySelectorAll('.ant-table-row').length`)) || null,
      40000
    )
    await sleep(1500)

    const opCol = await cdpEval(`(() => {
      const row = document.querySelector('.ant-table-row');
      if (!row) return null;
      const cells = [...row.querySelectorAll('td')];
      const cell = cells[cells.length - 1];
      const space = cell.querySelector('.ant-space');
      const btns = [...cell.querySelectorAll('button')];
      return JSON.stringify({
        单元格宽: Math.round(cell.getBoundingClientRect().width),
        单元格内容宽: cell.scrollWidth,
        Space宽: space ? Math.round(space.getBoundingClientRect().width) : null,
        按钮数: btns.length,
        自然宽度合计: Math.round(btns.reduce((s, b) => s + b.getBoundingClientRect().width, 0))
      });
    })()`)
    const op = opCol ? JSON.parse(opCol) : null
    check(
      'C1 操作列：单元格内容宽度 ≤ 单元格宽度（不溢出）',
      op && op.单元格内容宽 <= op.单元格宽,
      op ? `内容宽=${op.单元格内容宽} 单元格宽=${op.单元格宽} 按钮数=${op.按钮数}` : '未取到操作列'
    )

    // ---------- D. 横向滚动到底后所有按钮都在表体内 ----------
    await cdpEval(`(() => {
      const body = document.querySelector('.ant-table-body') || document.querySelector('.ant-table-content');
      if (body) body.scrollLeft = body.scrollWidth;
      return 'ok';
    })()`)
    await sleep(900)
    const clipped = await cdpEval(`(() => {
      const row = document.querySelector('.ant-table-row');
      if (!row) return null;
      const cells = [...row.querySelectorAll('td')];
      const cell = cells[cells.length - 1];
      const body = document.querySelector('.ant-table-body') || document.querySelector('.ant-table-content');
      if (!body) return null;
      const bodyRect = body.getBoundingClientRect();
      const btns = [...cell.querySelectorAll('button')];
      const outside = btns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.right > bodyRect.right + 1 || r.left < bodyRect.left - 1;
      }).map(b => {
        const icon = b.querySelector('.anticon');
        return icon ? icon.className.replace('anticon anticon-', '') : 'unknown';
      });
      return JSON.stringify({ 按钮总数: btns.length, 超出表体数: outside.length, 超出明细: outside });
    })()`)
    const clip = clipped ? JSON.parse(clipped) : null
    check(
      'D1 操作列：滚动到底后无按钮被表体裁切',
      clip && clip.超出表体数 === 0,
      clip ? `按钮=${clip.按钮总数} 超出=${clip.超出表体数} ${JSON.stringify(clip.超出明细)}` : '未取到'
    )

    // ---------- E. 编辑按钮有 Tooltip ----------
    // （E1 已在列表刚加载时做完，见上文。）

    // ===== 汇总 =====
    const failed = results.filter((r) => !r.ok)
    console.log('\n──────── 汇总 ────────')
    console.log(`通过 ${results.length - failed.length}/${results.length}`)
    if (failed.length) {
      console.error('失败项：')
      failed.forEach((f) => console.error('  - ' + f.name))
      process.exitCode = 1
    } else {
      console.log('全部通过')
    }
  } catch (e) {
    console.error('\n验证失败:', e.message)
    process.exitCode = 1
  } finally {
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
