#!/usr/bin/env node
/**
 * 出口 IP → 语言 / 时区一键填充 —— **行为级验证**（CDP 驱动真实 UI + 真实 HTTP 端口）
 *
 * ## 这个脚本解决什么问题
 *
 * 离线单测（tests/ipLocaleSuggest.test.cjs）能证明「推导函数写对了」，
 * 但证明不了三件事，而这三件事恰恰是这个功能最容易翻车的地方：
 *
 *   E. **端点真的按代理的出口国家推导**，而不是回落到某个默认值；
 *      推不出来时**必须报错**，绝不能拿宿主 IP 兜底。
 *   U. **预演弹窗真的显示了「当前值 → 新值」**——填前不预演等于静默改掉用户手调过的值。
 *   W. **确认后真的写进了指纹并落库**，且写的是新时区与新语言。
 *
 * ## 为什么需要直连数据库
 *
 * 端点读的是代理的 `country` / `region` / `exitIp`（代理检测时回写）。
 * 真实检测要能连通 ip-api 且代理本身可��——那是外部依赖，本脚本不能假设。
 * 故用 mysql2 直接把两个**测试用代理**的出口信息写成已知值，
 * 让端点走「代理已检测」这条真实分支。生产代码路径完全没被绕过：
 * 读的就是同一张表、同一批字段。
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认 127.0.0.1:3306，root/1234560，库名 roxy_browser）
 *   - 已执行 pnpm build（脚本跑的是 out/ 产物，不是 dev 源码）
 *   - 默认账号 admin / 123456 存在（首次启动会自动创建）
 *
 * ## 用法
 *
 *   node scripts/verify-ip-locale-fill.mjs
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.IPLOCALE_VERIFY_PORT || 9334)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const apiBaseFile = path.join(os.homedir(), '.roxy-clone', 'api-base.json')

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '1234560',
  database: process.env.DB_NAME || 'roxy_browser'
}

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
  let apiBase = null
  let auth = null
  const proxyIds = []
  const stamp = Date.now()
  const profileName = `IPLocale验证环境-${stamp}`
  const UK_PROXY = `IPLocale验证代理-英国-${stamp}`
  const US_PROXY = `IPLocale验证代理-美国-${stamp}`
  const BAD_PROXY = `IPLocale验证代理-未检测-${stamp}`

  try {
    // ---------- 1. 等 API 服务起来 ----------
    apiBase = await waitFor(
      'API 服务就绪',
      async () => {
        if (!fs.existsSync(apiBaseFile)) return null
        const info = JSON.parse(fs.readFileSync(apiBaseFile, 'utf8'))
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
    auth = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }
    console.log('登录成功，用户:', login.user?.username)

    // ---------- 3. 造三个测试代理 ----------
    async function createProxy(name) {
      const r = await (
        await fetch(`${apiBase}/api/proxies`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ name, type: 'http', host: '127.0.0.1', port: 9, username: '', password: '' })
        })
      ).json()
      if (!r.id) throw new Error('创建测试代理失败：' + JSON.stringify(r).slice(0, 200))
      proxyIds.push(r.id)
      return r.id
    }
    const ukId = await createProxy(UK_PROXY)
    const usId = await createProxy(US_PROXY)
    const badId = await createProxy(BAD_PROXY)

    // ---------- 4. 直写出口信息（模拟「代理已检测」） ----------
    // 注意列名是 typeorm 的默认驼峰（exitIp），不是 exit_ip——
    // 写错会静默更新 0 行，表现为「端点说代理没检测过」这种看不懂的失败。
    const conn = await mysql.createConnection(DB)
    try {
      const [ukRows] = await conn.execute(
        'UPDATE proxies SET country = ?, region = ?, city = ?, exitIp = ?, status = ? WHERE id = ?',
        ['United Kingdom', 'England', 'London', '203.0.113.10', 'active', ukId]
      )
      const [usRows] = await conn.execute(
        'UPDATE proxies SET country = ?, region = ?, city = ?, exitIp = ?, status = ? WHERE id = ?',
        ['United States', 'California', 'Los Angeles', '198.51.100.20', 'active', usId]
      )
      if (ukRows.affectedRows !== 1 || usRows.affectedRows !== 1) {
        throw new Error(`写入出口信息失败：uk=${ukRows.affectedRows} us=${usRows.affectedRows} 行（列名写错时会是 0）`)
      }
    } finally {
      await conn.end()
    }
    console.log('已写入测试代理的出口信息')

    async function suggest(body) {
      const res = await fetch(`${apiBase}/api/fingerprint/suggest-from-ip`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body)
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      return { status: res.status, json }
    }

    // ---------- E. 端点层 ----------
    const e1 = await suggest({ country: 'United States', region: 'California' })
    check(
      'E1 显式国家 + 地区 → 精确到州时区',
      e1.status === 200 && e1.json?.timeZone === 'America/Los_Angeles' && e1.json?.ambiguous === false,
      JSON.stringify(e1.json)
    )
    check(
      'E2 推导出的语言地区码等于国码（en-US / 美国）',
      e1.status === 200 && e1.json?.locale === 'en-US' && Array.isArray(e1.json?.languages),
      JSON.stringify(e1.json?.languages)
    )

    const e2 = await suggest({ country: 'United States' })
    check(
      'E3 多时区国家且无地区 → 标需确认并给候选列表',
      e2.status === 200 && e2.json?.ambiguous === true && e2.json?.timeZoneOptions?.length > 1,
      `ambiguous=${e2.json?.ambiguous} options=${e2.json?.timeZoneOptions?.length}`
    )

    const e3 = await suggest({ country: 'Atlantis' })
    check(
      'E4 出口国家不在内置表 → 400，且不返回任何兜底时区',
      e3.status === 400 && !e3.json?.timeZone,
      `status=${e3.status} body=${JSON.stringify(e3.json)}`
    )

    const e4 = await suggest({})
    check(
      'E5 既无代理也无国家 → 400（没有出口信息就拒绝推导）',
      e4.status === 400,
      `status=${e4.status} body=${JSON.stringify(e4.json)}`
    )

    const e5 = await suggest({ country: 'United Kingdom' })
    check(
      'E6 英国 → Europe/London + en-GB（不是 en-US）',
      e5.status === 200 && e5.json?.timeZone === 'Europe/London' && e5.json?.locale === 'en-GB',
      JSON.stringify(e5.json)
    )

    const e6 = await suggest({ proxyId: ukId })
    check(
      'E7 按 proxyId 取代理的出口国家推导（走真实数据库分支）',
      e6.status === 200 && e6.json?.timeZone === 'Europe/London' && e6.json?.country === 'GB',
      JSON.stringify(e6.json)
    )
    check(
      'E8 响应带回出口 IP，供界面回显',
      e6.status === 200 && e6.json?.exitIp === '203.0.113.10',
      `exitIp=${e6.json?.exitIp}`
    )

    const e7 = await suggest({ proxyId: usId })
    check(
      'E9 按 proxyId 推导多时区国家的具体州时区',
      e7.status === 200 && e7.json?.timeZone === 'America/Los_Angeles',
      JSON.stringify(e7.json)
    )

    const e8 = await suggest({ proxyId: badId })
    check(
      'E10 代理未检测且检测失败 → 400，不拿宿主 IP 兜底',
      e8.status === 400 && !e8.json?.timeZone,
      `status=${e8.status} body=${JSON.stringify(e8.json)}`
    )

    const e9 = await suggest({ proxyId: 999999999 })
    check('E11 不存在的 proxyId → 404', e9.status === 404, `status=${e9.status}`)

    // ---------- 5. UI 层 ----------
    const created = await (
      await fetch(`${apiBase}/api/profiles`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: profileName,
          remark: '',
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
      localStorage.setItem('roxy_token', ${JSON.stringify(login.token)});
      location.hash = '#/envs';
      location.reload();
      return 'ok';
    })()`)
    await waitFor(
      '环境列表就绪',
      async () => {
        const r = await cdpEval(`(() => {
          const rows = [...document.querySelectorAll('tr')];
          return rows.some(tr => (tr.textContent||'').includes(${JSON.stringify(profileName)})) ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      30000
    )

    // 打开编辑抽屉
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

    // 切到「代理配置」页签
    await cdpEval(`(() => {
      const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => (x.textContent||'').includes('代理配置'));
      if (!t) return 'TAB-NOT-FOUND';
      t.click(); return 'clicked';
    })()`)
    await sleep(1000)

    // ---------- U1. 未选代理时按钮应禁用 ----------
    const u1 = await cdpEval(`(() => {
      const b = [...document.querySelectorAll('.ant-drawer button')].find(x => (x.textContent||'').includes('按出口 IP 填充'));
      if (!b) return { found: false };
      return { found: true, disabled: !!b.disabled };
    })()`)
    check(
      'U1 未选代理时「按出口 IP 填充」按钮禁用',
      u1?.found === true && u1?.disabled === true,
      JSON.stringify(u1)
    )

    // ---------- 选代理 ----------
    // 两个 antd 6 的坑：
    //  1) **没有 `.ant-select-selector` 子节点**——`.ant-select` 本身就是触发器。
    //  2) Tabs 会把**所有页签的内容都渲染进 DOM**（只是不可见），
    //     所以抽屉里有 4 个 Select，必须挑**可见的那一个**（offsetParent 非空）。
    const selProbe = await cdpEval(`(() => {
      const drawer = document.querySelector('.ant-drawer');
      const sels = [...(drawer ? drawer.querySelectorAll('.ant-select') : [])];
      return {
        drawerFound: !!drawer,
        selectCount: sels.length,
        detail: sels.map(s => ({
          visible: !!(s.offsetParent),
          text: (s.textContent || '').replace(/\\s+/g, ' ').slice(0, 60)
        }))
      };
    })()`)
    console.log('  [探针] 抽屉内 Select:', JSON.stringify(selProbe))

    const opened = await cdpEval(`(() => {
      const drawer = document.querySelector('.ant-drawer');
      const sels = [...(drawer ? drawer.querySelectorAll('.ant-select') : [])];
      const sel = sels.find(s => s.offsetParent);   // 可见的那个 = 代理选择器
      if (!sel) return 'VISIBLE-SELECT-NOT-FOUND';
      sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, cancelable: true }));
      return 'dispatched';
    })()`)
    console.log('  [探针] mousedown 派发:', opened)

    await waitFor(
      '代理下拉展开',
      async () => {
        const r = await cdpEval(`(() => {
          const opt = [...document.querySelectorAll('.ant-select-item-option, [role="option"]')]
            .find(o => (o.textContent||'').includes(${JSON.stringify(UK_PROXY)}));
          return opt ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      15000
    )
    await cdpEval(`(() => {
      const opt = [...document.querySelectorAll('.ant-select-item-option, [role="option"]')]
        .find(o => (o.textContent||'').includes(${JSON.stringify(UK_PROXY)}));
      if (!opt) return 'OPTION-NOT-FOUND';
      opt.click(); return 'clicked';
    })()`)
    await sleep(900)

    // ---------- U2. 点按钮 → 预演弹窗出现，且列出「当前值 → 新值」 ----------
    await cdpEval(`(() => {
      const b = [...document.querySelectorAll('.ant-drawer button')].find(x => (x.textContent||'').includes('按出口 IP 填充'));
      if (!b) return 'BTN-NOT-FOUND';
      b.click(); return 'clicked';
    })()`)
    await waitFor(
      '预演弹窗出现',
      async () => {
        const r = await cdpEval(`(() => {
          const m = [...document.querySelectorAll('.ant-modal')].find(x => (x.textContent||'').includes('按出口 IP 填充'));
          return m ? 'ok' : null;
        })()`)
        return r === 'ok'
      },
      20000
    )

    const preview = await cdpEval(`(() => {
      const m = [...document.querySelectorAll('.ant-modal')].find(x => (x.textContent||'').includes('按出口 IP 填充'));
      if (!m) return null;
      const text = (m.textContent || '').replace(/\\s+/g, ' ');
      return { text: text.slice(0, 600) };
    })()`)
    check(
      'U2 预演弹窗列出将被改动的字段（时区 → Europe/London）',
      !!preview && preview.text.includes('Europe/London') && preview.text.includes('时区'),
      preview?.text
    )
    check(
      'U3 预演弹窗同时给出新语言（en-GB）',
      !!preview && preview.text.includes('en-GB'),
      preview?.text
    )

    // ---------- U4. 确认填充 → 弹窗关闭、指纹页签显示新值 ----------
    await cdpEval(`(() => {
      const m = [...document.querySelectorAll('.ant-modal')].find(x => (x.textContent||'').includes('按出口 IP 填充'));
      if (!m) return 'MODAL-NOT-FOUND';
      const ok = [...m.querySelectorAll('.ant-modal-footer button')].find(b => (b.textContent||'').includes('确认填充'));
      if (!ok) return 'OK-BTN-NOT-FOUND';
      ok.click(); return 'clicked';
    })()`)
    await sleep(1200)

    const modalGone = await cdpEval(`(() => {
      const m = [...document.querySelectorAll('.ant-modal')].find(x => (x.textContent||'').includes('按出口 IP 填充'));
      return !m;
    })()`)
    check('U4 确认后弹窗关闭', modalGone === true, String(modalGone))

    await cdpEval(`(() => {
      const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => (x.textContent||'').includes('指纹配置'));
      if (!t) return 'TAB-NOT-FOUND';
      t.click(); return 'clicked';
    })()`)
    await sleep(1000)
    // 「基础设置」在编辑态默认展开，时区 Select 的当前值就在标题里
    const fpShown = await cdpEval(`(() => {
      const txt = (document.querySelector('.ant-drawer')?.textContent || '');
      return { hasLondon: txt.includes('Europe/London'), hasGb: txt.includes('en-GB') };
    })()`)
    check(
      'U5 指纹页签已显示新时区与新语言',
      fpShown?.hasLondon === true && fpShown?.hasGb === true,
      JSON.stringify(fpShown)
    )

    // ---------- W. 保存并查库 ----------
    await cdpEval(`(() => {
      const b = [...document.querySelectorAll('.ant-drawer button')].find(x => (x.textContent||'').replace(/\\s/g,'') === '保存');
      if (!b) return 'SAVE-NOT-FOUND';
      b.click(); return 'clicked';
    })()`)
    await sleep(2500)

    const after = await (await fetch(`${apiBase}/api/profiles/${profileId}`, { headers: auth })).json()
    const p = after.profile || after
    const fpp = typeof p.fingerprint === 'string' ? JSON.parse(p.fingerprint) : p.fingerprint || {}
    check('W1 落库的时区已按出口地更新', fpp.timezone === 'Europe/London', `timezone=${fpp.timezone}`)
    check(
      'W2 落库的语言首选已按出口地更新',
      Array.isArray(fpp.languages) && fpp.languages[0] === 'en-GB',
      `languages=${JSON.stringify(fpp.languages)}`
    )
    check(
      'W3 地理位置随新时区同步（欧洲，而非原亚洲城市）',
      typeof fpp.geoLatitude === 'number' && fpp.geoLatitude > 30 && fpp.geoLatitude < 70,
      `lat=${fpp.geoLatitude} lon=${fpp.geoLongitude}`
    )

    // ---------- 汇总 ----------
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
    // 清理测试环境与测试代理
    try {
      if (apiBase && auth) {
        for (const pid of proxyIds) {
          await fetch(`${apiBase}/api/proxies/${pid}`, { method: 'DELETE', headers: auth })
        }
        console.log('已清理测试代理:', proxyIds.join(', '))
      }
      if (profileId && apiBase && auth) {
        await fetch(`${apiBase}/api/profiles/${profileId}`, { method: 'DELETE', headers: auth })
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
