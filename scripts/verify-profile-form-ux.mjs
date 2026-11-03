#!/usr/bin/env node
/**
 * 创建环境流程 UX —— **行为级验证**（CDP 驱动真实 UI）
 *
 * ## 这个脚本解决什么问题
 *
 * 「创建窗口流程焕新 / 窗口创建体验简化」（对标官方 4.0.3 / 4.0.8）在
 * FEATURE-GAP.md 里被记为「无量化标准，需自查」。自查不能只靠读代码——
 * 本脚本把它变成可复现的断言：
 *
 *   A. 新建态：基本信息低频项默认收起、指纹细项默认全收起
 *   B. 状态重置：手动展开 → 关闭 → 再打开，必须回到收起（受控逻辑的价值所在）
 *   C. 编辑态：指纹区默认展开「基础设置」（用户就是冲着改参数来的）
 *   D. **数据不丢**：带备注的环境「什么都没改 → 保存」后备注仍在
 *      （这条最关键：低频项收进了折叠区，若面板不预渲染，字段就不在
 *        onFinish 的 values 里，而后端 PUT 是全量覆盖——一次无操作的编辑
 *        就会把用户的备注悄悄抹掉）
 *
 * ## 与 tests/profileFormUx.test.cjs 的分工
 *
 *   tests/profileFormUx.test.cjs  源码级断言，进 pnpm test，快，但只能证明"写对了"
 *   本脚本                        行为级验证，证明"跑起来对"
 *
 * 两者互补：源码级能进 CI，行为级能抓出 antd 版本差异这类运行时问题。
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认 127.0.0.1:3306，root/1234560）
 *   - 已执行 pnpm build（脚本跑的是 out/ 产物，不是 dev 源码）
 *   - 默认账号 admin / 123456 存在（首次启动会自动创建）
 *
 * ## 用法
 *
 *   node scripts/verify-profile-form-ux.mjs
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.UX_VERIFY_PORT || 9333)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const apiBaseFile = path.join(os.homedir(), '.roxy-clone', 'api-base.json')

// ===== CDP 小客户端 =====
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

/** 读当前激活 Tab 面板内的折叠区 */
const READ_COLLAPSES = `(() => {
  // antd 6 的激活 pane 类名是 .ant-tabs-content-active（v5 是 .ant-tabs-tabpane-active，
  // 两者不通用——写错会永远读到空数组，断言全挂）
  const heads = [...document.querySelectorAll('.ant-tabs-content-active .ant-collapse-header')];
  return heads.map(h => ({ text: (h.textContent||'').trim(), expanded: h.getAttribute('aria-expanded') }));
})()`

/** 点击文本匹配的 Tab */
const CLICK_TAB = (label) => `(() => {
  const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => (x.textContent||'').includes(${JSON.stringify(label)}));
  if (!t) return 'TAB-NOT-FOUND';
  t.click(); return 'clicked';
})()`

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const launchedAt = Date.now()
  const child = spawn(
    electronBin,
    [path.join(root, 'out', 'main', 'index.js'), `--remote-debugging-port=${PORT}`],
    { env, stdio: 'ignore' }
  )

  let profileId = null
  const remark = `UX验证备注-${Date.now()}`
  const profileName = `UX验证环境-${Date.now()}`

  try {
    // ---------- 1. 等 API 服务起来 ----------
    const apiBase = await waitFor(
      'API 服务就绪',
      async () => {
        if (!fs.existsSync(apiBaseFile)) return null
        const info = JSON.parse(fs.readFileSync(apiBaseFile, 'utf8'))
        // 端口可能被占用而自动递增，api-base.json 里是真实值。
        // 用 startedAt 判断这是不是本次启动的实例（避免读到上次遗留的旧文件）。
        if (!info.startedAt || new Date(info.startedAt).getTime() < launchedAt - 2000) return null
        const res = await fetch(`${info.apiBase}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: '__probe__', password: '__probe__' })
        })
        return res.status ? info.apiBase : null
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
    const auth = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }
    console.log('登录成功，用户:', login.user?.username)

    // ---------- 3. 造一个带备注的环境（供 D 项保值验证用） ----------
    const created = await (
      await fetch(`${apiBase}/api/profiles`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: profileName,
          remark,
          platform: '',
          startUrl: '',
          groupId: null,
          proxyId: null,
          extensions: []
        })
      })
    ).json()
    profileId = created.id || created.profile?.id
    if (!profileId) throw new Error('创建测试环境失败：' + JSON.stringify(created).slice(0, 200))

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

    // ---------- 5. 注入 token 并进入环境列表 ----------
    // 不这么做的话应用停在 /login，页面里根本没有「新建环境」按钮——
    // 这是本脚本第一版探针失败的原因之一。
    await cdpEval(`(() => {
      localStorage.setItem('roxy_token', ${JSON.stringify(login.token)});
      location.hash = '#/envs';
      location.reload();
      return 'ok';
    })()`)
    await waitFor(
      '「新建环境」按钮出现',
      async () => {
        const r = await cdpEval(`(() => {
          const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('新建环境'));
          return b ? 'found' : null;
        })()`)
        return r === 'found'
      },
      30000
    )

    // ---------- A. 新建态默认收起 ----------
    await cdpEval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('新建环境'));
      if (b) b.click();
      return 'clicked';
    })()`)
    // 必须等指纹生成完：fp 为 null 时抽屉里只有一个 Spin，Tabs 都不存在
    await waitFor(
      '抽屉 Tab 渲染',
      async () => {
        const r = await cdpEval(`(() => {
          const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
          return tabs.length ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      30000
    )

    const base = await cdpEval(READ_COLLAPSES)
    check(
      'A1 新建态：基本信息低频项默认收起',
      Array.isArray(base) && base.length > 0 && base.every((h) => h.expanded === 'false'),
      JSON.stringify(base)
    )

    await cdpEval(CLICK_TAB('指纹配置'))
    await sleep(1200)
    const fp = await cdpEval(READ_COLLAPSES)
    check(
      'A2 新建态：指纹细项默认全收起',
      Array.isArray(fp) && fp.length > 0 && fp.every((h) => h.expanded === 'false'),
      JSON.stringify(fp)
    )

    // ---------- B. 状态重置 ----------
    // 手动展开「基础设置」→ 关闭 → 再打开，必须回到收起。
    // 若用 defaultActiveKey（非常受控），antd 只在首次挂载生效，
    // 第二次打开会沿用上次状态——用户明明只想建个环境，却先看到一屏指纹细项。
    await cdpEval(`(() => {
      const h = [...document.querySelectorAll('.ant-tabs-content-active .ant-collapse-header')]
        .find(x => (x.textContent||'').includes('基础设置'));
      if (h) h.click();
      return 'expanded';
    })()`)
    await sleep(700)
    const expandedState = await cdpEval(`(() => {
      const h = [...document.querySelectorAll('.ant-tabs-content-active .ant-collapse-header')]
        .find(x => (x.textContent||'').includes('基础设置'));
      return h ? h.getAttribute('aria-expanded') : 'NOT-FOUND';
    })()`)
    check('B1 手动展开「基础设置」生效', expandedState === 'true', `aria-expanded=${expandedState}`)

    await cdpEval(`(() => {
      const b = [...document.querySelectorAll('.ant-drawer button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '取消');
      if (b) { b.click(); return 'closed'; }
      const x = document.querySelector('.ant-drawer-close');
      if (x) { x.click(); return 'closed-via-x'; }
      return 'CLOSE-NOT-FOUND';
    })()`)
    await sleep(1200)
    await cdpEval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('新建环境'));
      if (b) b.click();
      return 'clicked';
    })()`)
    await waitFor(
      '重开后 Tab 渲染',
      async () => {
        const r = await cdpEval(`(() => {
          const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
          return tabs.length ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      30000
    )
    await cdpEval(CLICK_TAB('指纹配置'))
    await sleep(1200)
    const fpReopen = await cdpEval(READ_COLLAPSES)
    check(
      'B2 重开抽屉后展开状态已重置',
      Array.isArray(fpReopen) && fpReopen.length > 0 && fpReopen.every((h) => h.expanded === 'false'),
      JSON.stringify(fpReopen)
    )

    // ---------- C. 编辑态默认展开「基础设置」 ----------
    // 定位行要用**名称**：环境列表表格没有「备注」列，用备注找行会永远找不到。
    await cdpEval(`(() => {
      const rows = [...document.querySelectorAll('tr')];
      const row = rows.find(tr => (tr.textContent||'').includes(${JSON.stringify(profileName)}));
      if (!row) return 'ROW-NOT-FOUND';
      const btn = [...row.querySelectorAll('button')].find(b => b.querySelector('.anticon-edit'));
      if (!btn) return 'EDIT-BTN-NOT-FOUND';
      btn.click(); return 'clicked';
    })()`)
    await waitFor(
      '编辑抽屉就绪',
      async () => {
        const r = await cdpEval(`(() => {
          const tabs = [...document.querySelectorAll('.ant-tabs-tab')];
          const title = document.querySelector('.ant-drawer-title');
          return tabs.length && /编辑环境/.test(title ? title.textContent : '') ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      30000
    )
    await cdpEval(CLICK_TAB('指纹配置'))
    await sleep(1200)
    const editFp = await cdpEval(READ_COLLAPSES)
    check(
      'C1 编辑态：指纹区默认展开「基础设置」',
      Array.isArray(editFp) && editFp.some((h) => h.text.includes('基础设置') && h.expanded === 'true'),
      JSON.stringify(editFp)
    )

    // ---------- D. 数据不丢：什么都没改的编辑不能清空备注 ----------
    await cdpEval(CLICK_TAB('基本信息'))
    await sleep(800)
    const domValue = await cdpEval(`(() => {
      const ta = [...document.querySelectorAll('.ant-tabs-content-active textarea')];
      return ta.map(t => t.value);
    })()`)
    check(
      'D1 收起状态下备注字段仍已挂载（forceRender 生效）',
      Array.isArray(domValue) && domValue.includes(remark),
      JSON.stringify(domValue)
    )

    await cdpEval(`(() => {
      const b = [...document.querySelectorAll('.ant-drawer button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '保存');
      if (!b) return 'SAVE-NOT-FOUND';
      b.click(); return 'clicked';
    })()`)
    await sleep(2500)

    const after = await (await fetch(`${apiBase}/api/profiles/${profileId}`, { headers: auth })).json()
    const p = after.profile || after
    check('D2 什么都没改的编辑后备注仍在', p.remark === remark, `remark=${JSON.stringify(p.remark)}`)

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
    // 清理测试环境
    try {
      if (profileId) {
        const login2 = await (
          await fetch(`${apiBase || 'http://127.0.0.1:39100'}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: '123456' })
          })
        ).json()
        await fetch(`${apiBase || 'http://127.0.0.1:39100'}/api/profiles/${profileId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${login2.token}` }
        })
        console.log('已清理测试环境 id =', profileId)
      }
    } catch {
      /* 清理失败不掩盖主结果 */
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
