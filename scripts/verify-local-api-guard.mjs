#!/usr/bin/env node
/**
 * 本地 API 请求守卫 —— **行为级验证**（起真实应用 + 裸 HTTP 请求）
 *
 * ## 这个脚本解决什么问题
 *
 * `tests/localRequestGuard.test.cjs` 锁的是**判定函数的纯逻辑**，
 * 但它证明不了「中间件真的挂在服务上」「预检真的被正确响应」。
 * 本脚本起真实应用，用裸 `http.request`（**不能用 fetch**——undici 会拦掉
 * 手工设置的 `Host` 头，而伪造 Host 正是 DNS rebinding 的核心手法）打真实请求。
 *
 * ## 断言清单
 *
 *   G1  无 Origin（curl / 第三方自动化脚本）→ 200 —— 自动化 API 不能被堵死
 *   G2  Origin: https://evil.com → 403，且响应里**没有任何 CORS 允许头**
 *   G3  Host: evil.com（DNS rebinding）→ 403
 *   G4  Origin: null 且无 nonce → 403（沙箱 iframe 拿不到 nonce）
 *   G5  Origin: null + 正确 nonce → 200，回显 Access-Control-Allow-Origin: null
 *   G6  Origin: null + 错误 nonce → 403
 *   G7  Host 伪造优先于 Origin 合法 → 403
 *   G8  本机来源 Origin（http://127.0.0.1:<port>）→ 200
 *   G9  预检 OPTIONS + 合法 Origin → 204，带 Allow-Headers 含 X-Roxy-Nonce
 *   G10 预检 OPTIONS + 恶意 Origin → 403
 *
 * G2 / G4 / G6 / G10 是最关键的：**拒绝时不能回 CORS 允许头**，
 * 回了头浏览器就会把响应交给恶意脚本，等于没拒绝。
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认 127.0.0.1:3306，root/1234560）
 *   - 已执行 pnpm build（本脚本跑的是 out/ 产物）
 *
 * ## 用法
 *
 *   node scripts/verify-local-api-guard.mjs
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.GUARD_VERIFY_PORT || 9334)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const apiBaseFile = path.join(os.homedir(), '.roxy-clone', 'api-base.json')

// ===== CDP 小客户端（只为读 window.roxy.apiNonce）=====
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
    throw new Error(res.result.exceptionDetails.text || 'CDP 求值异常')
  }
  return res?.result?.result?.value
}

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 400) {
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

// ===== 裸 HTTP 请求（能伪造 Host 头，fetch 做不到）=====
function rawRequest({ port, reqPath = '/healthz', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

// ===== 断言收集 =====
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 响应里是否带 CORS 允许头（带了就等于放行，必须为否） */
function hasCorsAllow(res) {
  return !!res.headers['access-control-allow-origin']
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
    const port = Number(new URL(apiBase).port)
    console.log('API 服务:', apiBase)

    // ---------- 2. 从主窗口读出 nonce ----------
    // nonce 只注入应用自己的页面（preload → window.roxy.apiNonce），
    // 外部站点拿不到——这正是 G4/G6 要验的边界。
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
    const nonce = await cdpEval('window.roxy && window.roxy.apiNonce ? window.roxy.apiNonce : null')
    if (!nonce || typeof nonce !== 'string' || nonce.length < 32) {
      throw new Error('未能从主窗口读到 apiNonce：' + JSON.stringify(nonce))
    }
    console.log('已从主窗口取得 nonce（长度 ' + nonce.length + '）')

    // ---------- 3. 逐条断言 ----------
    console.log('\n--- 攻击面断言 ---')

    const noOrigin = await rawRequest({ port, reqPath: '/healthz' })
    check('G1 无 Origin（第三方自动化脚本）→ 200', noOrigin.status === 200, `status=${noOrigin.status}`)

    const evil = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Origin: 'https://evil.com' }
    })
    check('G2 Origin: https://evil.com → 403', evil.status === 403, `status=${evil.status}`)
    check('G2 拒绝响应里没有任何 CORS 允许头', !hasCorsAllow(evil), JSON.stringify(evil.headers['access-control-allow-origin']))

    const evilHost = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Host: 'evil.com' }
    })
    check('G3 Host: evil.com（DNS rebinding）→ 403', evilHost.status === 403, `status=${evilHost.status}`)

    const nullNoNonce = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Origin: 'null' }
    })
    check('G4 Origin: null 且无 nonce → 403', nullNoNonce.status === 403, `status=${nullNoNonce.status}`)

    const nullOk = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Origin: 'null', 'X-Roxy-Nonce': nonce }
    })
    check('G5 Origin: null + 正确 nonce → 200', nullOk.status === 200, `status=${nullOk.status}`)
    check(
      'G5 回显 Access-Control-Allow-Origin: null',
      nullOk.headers['access-control-allow-origin'] === 'null',
      String(nullOk.headers['access-control-allow-origin'])
    )

    const nullWrong = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Origin: 'null', 'X-Roxy-Nonce': 'wrong-nonce-value' }
    })
    check('G6 Origin: null + 错误 nonce → 403', nullWrong.status === 403, `status=${nullWrong.status}`)

    const hostWins = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Host: 'evil.com', Origin: 'null', 'X-Roxy-Nonce': nonce }
    })
    check('G7 Host 伪造优先于 Origin 合法 → 403', hostWins.status === 403, `status=${hostWins.status}`)

    const loopbackOrigin = await rawRequest({
      port,
      reqPath: '/healthz',
      headers: { Origin: `http://127.0.0.1:${port}` }
    })
    check('G8 本机来源 Origin → 200', loopbackOrigin.status === 200, `status=${loopbackOrigin.status}`)

    const preflightOk = await rawRequest({
      port,
      reqPath: '/api/profiles',
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'X-Roxy-Nonce': nonce,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-roxy-nonce'
      }
    })
    check('G9 预检 OPTIONS + 合法 Origin → 204', preflightOk.status === 204, `status=${preflightOk.status}`)
    check(
      'G9 预检回 Allow-Headers 含 X-Roxy-Nonce',
      /x-roxy-nonce/i.test(preflightOk.headers['access-control-allow-headers'] || ''),
      String(preflightOk.headers['access-control-allow-headers'])
    )

    const preflightEvil = await rawRequest({
      port,
      reqPath: '/api/profiles',
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST'
      }
    })
    check('G10 预检 OPTIONS + 恶意 Origin → 403', preflightEvil.status === 403, `status=${preflightEvil.status}`)
  } finally {
    try {
      if (ws) ws.close()
    } catch {
      /* ignore */
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }

  // ===== 汇总 =====
  const passed = results.filter((r) => r.ok).length
  console.log('\n──────── 汇总 ────────')
  console.log(`通过 ${passed}/${results.length}`)
  if (passed !== results.length) {
    console.error('存在失败断言')
    process.exitCode = 1
  } else {
    console.log('全部通过')
  }
}

main().catch((e) => {
  console.error('\n验证脚本异常:', e.message)
  process.exitCode = 1
})
