#!/usr/bin/env node
/**
 * 反检测审计 —— **行为级验证**（真实环境窗口 + 真实 preload 伪装）
 *
 * ## 这个脚本解决什么问题
 *
 * 离线单测（tests/stealthAudit.test.cjs）能证明「判定逻辑写对了」，
 * 但证明不了三件事，而这三件事恰恰是这个功能最容易翻车的地方：
 *
 *   1. 探针真的能在**真实环境窗口**里采到值（不是采了个空对象回来）；
 *   2. 预加载的伪装**真的瞒过了**外部检测视角的探针；
 *   3. 判定出来的破绽**确实存在**（而不是探针自身测错导致误报）。
 *
 * 所以这个脚本起真实 Electron 应用、开真实环境窗口、跑真实探针，
 * 然后把结果交给 shared/stealthAudit 判定，并把每条结论打印出来。
 *
 * ## 为什么必须开真实窗口
 *
 * 反检测的破绽几乎全部是「**两处值互相矛盾**」——
 * 只有真实浏览器里同时存在这两处时，矛盾才会显现。
 * 用 jsdom / 纯逻辑模拟出来的环境，恰恰不会有这些矛盾，
 * 于是「测一遍全绿」什么也证明不了。
 *
 * ## 前置条件
 *
 *   - MySQL 已启动（默认 127.0.0.1:3306，root/1234560，库名 roxy_browser）
 *   - 已执行 build（脚本跑的是 out/ 产物）
 *   - 默认账号 admin / 123456 存在（首次启动会自动创建）
 *
 * ## 用法
 *
 *   node scripts/verify-stealth-audit.mjs
 *
 * 退出码：0 = 无致命破绽，1 = 有致命破绽或脚本异常。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const apiBaseFile = path.join(os.homedir(), '.roxy-clone', 'api-base.json')

// ===== 断言收集 =====
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
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

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const launchedAt = Date.now()
  const child = spawn(
    electronBin,
    [path.join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9336'],
    { env, stdio: 'ignore' }
  )

  let profileId = null
  const stamp = Date.now()
  const profileName = `反检测审计环境-${stamp}`

  try {
    // ---------- 1. 等 API 服务起来 ----------
    const apiBase = await waitFor(
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
    const auth = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }
    console.log('登录成功')

    // ---------- 3. 造一个测试环境（伪装成 macOS，用来暴露「宿主是 Windows」的矛盾）----------
    // 故意选 macOS 伪装：本机是 Windows，若有「只改 UA 不改 appVersion」这类漏网，
    // 矛盾会立刻显现。伪装成与宿主相同的系统反而最容易「看起来全绿」。
    const fp = {
      os: 'mac',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      uaFullVersion: '154.0.7521.60',
      coreVersion: 154,
      platform: 'MacIntel',
      languages: ['en-GB', 'en'],
      timezone: 'Europe/London',
      tzOffset: 0,
      screenWidth: 2560,
      screenHeight: 1440,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      // 刻意取一个与宿主真实值不同的数（宿主实测 DPR=2），
      // 这样这条断言才能证明「伪装真的生效」而不是「碰巧本来就对」。
      devicePixelRatio: 3,
      canvasNoise: true,
      webglVendor: 'Apple',
      webglRenderer: 'Apple M1',
      audioNoise: true,
      webrtc: 'disable',
      doNotTrack: 'unspecified',
      fonts: ['Arial', 'Times New Roman', 'Courier New', 'Helvetica', 'Verdana'],
      geoLatitude: 51.5074,
      geoLongitude: -0.1278,
      geoAccuracy: 100,
      blockTrackers: false,
      httpWarning: false,
      prefersColorScheme: 'light',
      prefersReducedMotion: false
    }
    const created = await (
      await fetch(`${apiBase}/api/profiles`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: profileName, fingerprint: fp })
      })
    ).json()
    profileId = created.id || created.profile?.id
    if (!profileId) throw new Error('创建测试环境失败：' + JSON.stringify(created).slice(0, 300))
    console.log('测试环境 #' + profileId)

    // ---------- 4. 开窗 ----------
    const openRes = await fetch(`${apiBase}/api/profiles/${profileId}/open`, {
      method: 'POST',
      headers: auth
    })
    if (!openRes.ok) {
      const t = await openRes.text()
      throw new Error('开窗失败：HTTP ' + openRes.status + ' ' + t.slice(0, 200))
    }
    console.log('窗口已打开，等待页面加载…')
    await sleep(6000)

    // ---------- 5. 跑审计端点 ----------
    const auditRes = await fetch(`${apiBase}/api/profiles/${profileId}/stealth-audit`, {
      method: 'POST',
      headers: auth,
      body: '{}'
    })
    const audit = await auditRes.json()
    if (!auditRes.ok) {
      throw new Error('审计端点失败：HTTP ' + auditRes.status + ' ' + JSON.stringify(audit).slice(0, 300))
    }

    const probe = audit.probe || {}
    const findings = audit.findings || []
    const summary = audit.summary || {}
    const pb = probe.protoBypass || {}

    console.log('\n===== 采集到的实测值 =====')
    const show = (k) => console.log(`  ${k.padEnd(22)} ${JSON.stringify(probe[k])}`)
    ;['userAgent', 'appVersion', 'platform', 'vendor', 'oscpu', 'productSub', 'language', 'languages',
      'intlTimeZone', 'intlLocale', 'tzOffset', 'dateStringTzName', 'screenWidth', 'screenHeight',
      'availWidth', 'availHeight', 'outerWidth', 'innerWidth', 'hardwareConcurrency', 'deviceMemory',
      'maxTouchPoints', 'ontouchstart', 'webdriver', 'chromeObjectPresent', 'uaDataPresent',
      'uaDataPlatform', 'uaDataBrands', 'iframePresent', 'iframeUserAgent', 'iframeWebdriver',
      'canvasHash1', 'canvasHash2', 'audioHash1', 'audioHash2', 'platformApis', 'webGpuPresent',
      'fontCount', 'fontMismatchCount'
    ].forEach(show)
    console.log('  automationGlobals     ' + JSON.stringify(probe.automationGlobals))
    console.log('  protoBypass:')
    console.log('    platform            ' + JSON.stringify(pb.platform))
    console.log('    languages           ' + JSON.stringify(pb.languages))
    console.log('    hardwareConcurrency ' + JSON.stringify(pb.hardwareConcurrency))
    console.log('    deviceMemory        ' + JSON.stringify(pb.deviceMemory))
    console.log('    navigatorOwnKeys    ' + JSON.stringify(pb.navigatorOwnKeys))
    console.log('    screenOwnKeys       ' + JSON.stringify(pb.screenOwnKeys))
    console.log('  toStringSamples:')
    for (const [k, v] of Object.entries(probe.toStringSamples || {})) {
      console.log(`    ${k.padEnd(38)} ${JSON.stringify(v)}`)
    }
    const ls = probe.lieScan || { scanned: 0, leaked: [] }
    console.log(
      `  lieScan（穷尽）        扫描 ${ls.scanned} 个函数 · 露馅 ${(ls.leaked || []).length} 个`
    )
    for (const l of ls.leaked || []) {
      console.log(`      ❌ ${l}`)
    }

    console.log('\n===== 审计结论 =====')
    console.log(audit.report)

    // ---------- 6. 断言 ----------
    console.log('\n===== 断言 =====')

    check('探针采到了 UA（非空）', !!probe.userAgent, probe.userAgent)
    check(
      '探针采到了 appVersion（用于交叉验证）',
      !!probe.appVersion,
      probe.appVersion
    )
    check(
      '探针采到了 iframe 的 UA（跨 frame 一致性）',
      probe.iframePresent === true && !!probe.iframeUserAgent,
      `present=${probe.iframePresent} ua=${probe.iframeUserAgent}`
    )
    check(
      '探针采到了 canvas 双读（熵稳定性）',
      !!probe.canvasHash1 && !!probe.canvasHash2,
      `${probe.canvasHash1} / ${probe.canvasHash2}`
    )
    check(
      '探针采到了被改函数的 toString（原生性测谎）',
      Object.keys(probe.toStringSamples || {}).length >= 10,
      `${Object.keys(probe.toStringSamples || {}).length} 个取样`
    )

    // 关键断言：iframe 里的 UA 必须与主 frame 一致
    check(
      'iframe 内 UA 与主 frame 一致（跨 frame 无泄漏）',
      probe.iframePresent === true && probe.iframeUserAgent === probe.userAgent,
      `主=${probe.userAgent}\n        iframe=${probe.iframeUserAgent}`
    )

    // 关键断言：所有被改函数的 toString 都要含 [native code]
    const leaked = Object.entries(probe.toStringSamples || {}).filter(
      ([, v]) => v && !/\[native code\]/i.test(String(v))
    )
    check(
      '被改写的函数全部通过原生性测谎',
      leaked.length === 0,
      leaked.length
        ? leaked.map(([k, v]) => `${k} → ${String(v).slice(0, 60)}`).join(' | ')
        : '全部含 [native code]'
    )

    // 关键断言：穷尽原生性扫描（遍历所有关键原型的全部函数）
    check(
      '穷尽原生性扫描无露馅（遍历全部原型函数）',
      (ls.leaked || []).length === 0 && ls.scanned > 0,
      (ls.leaked || []).length
        ? `扫描 ${ls.scanned} 个，露馅 ${ls.leaked.length} 个：${ls.leaked.slice(0, 3).join(' | ')}`
        : `扫描 ${ls.scanned} 个，露馅 0`
    )

    // 关键断言：Intl 构造器行为保真度（包装器丢了静态方法 → 浏览器直接坏掉）
    check(
      'Intl 构造器行为与原生一致（静态方法在 / new 约束在）',
      probe.intlSupportedLocalesOk === true && probe.intlRequiresNew === true,
      `supportedLocalesOk=${probe.intlSupportedLocalesOk} requiresNew=${probe.intlRequiresNew}`
    )

    // 关键断言：canvas 熵稳定
    check(
      'canvas 指纹两次读一致（熵稳定）',
      !!probe.canvasHash1 && probe.canvasHash1 === probe.canvasHash2,
      `${probe.canvasHash1} vs ${probe.canvasHash2}`
    )

    // 关键断言：appVersion 与 UA 自洽
    check(
      'appVersion 与 UA 自洽（系统段一致）',
      !findings.some((f) => f.key === 'identity:appVersion'),
      findings.find((f) => f.key === 'identity:appVersion')?.actual || 'OK'
    )

    // 关键断言：无自动化痕迹
    check(
      '无自动化痕迹（webdriver=false 且无特征全局变量）',
      probe.webdriver === false && (probe.automationGlobals || []).length === 0,
      `webdriver=${probe.webdriver} globals=${JSON.stringify(probe.automationGlobals)}`
    )

    // 关键断言：原型 getter 绕过不得读出真身
    check(
      '原型 getter 绕过后 platform 仍是伪装值',
      pb.platform === probe.platform,
      `绕过=${pb.platform} 实例=${probe.platform}`
    )
    check(
      '原型 getter 绕过后 languages 仍是伪装值',
      JSON.stringify(pb.languages) === JSON.stringify(probe.languages),
      `绕过=${JSON.stringify(pb.languages)} 实例=${JSON.stringify(probe.languages)}`
    )
    check(
      '原型 getter 绕过后 hardwareConcurrency 仍是伪装值',
      pb.hardwareConcurrency === probe.hardwareConcurrency,
      `绕过=${pb.hardwareConcurrency} 实例=${probe.hardwareConcurrency}`
    )
    check(
      '原型 getter 绕过后 deviceMemory 仍是伪装值',
      pb.deviceMemory === probe.deviceMemory,
      `绕过=${pb.deviceMemory} 实例=${probe.deviceMemory}`
    )
    check(
      'window 自有键基线已采集（该规则确实被武装）',
      Array.isArray(pb.windowOwnKeys) && pb.windowOwnKeys.length > 0,
      `基线 ${(pb.windowOwnKeys || []).length} 个键`
    )
    check(
      'API 存在性已采集（用 in 判定，非读值）',
      probe.apiPresence && typeof probe.apiPresence === 'object' &&
        Object.keys(probe.apiPresence).length > 0,
      `采集 ${Object.keys(probe.apiPresence || {}).length} 个 API`
    )
    // devicePixelRatio 必须真的被改成设定值（测试环境刻意取了 3，宿主真实值是 2）。
    // 这条同时守住一个易错点：devicePixelRatio 在 Chromium 里是 **window 自有的
    // 访问器属性**（不在 Window.prototype 上），若挪到原型上会被自有属性遮蔽而失效。
    check(
      'devicePixelRatio 被真正改成了设定值',
      probe.devicePixelRatio === 3,
      `实测=${probe.devicePixelRatio} 期望=3`
    )
    check(
      'navigator 自有键为空（与真实 Chrome 一致）',
      (pb.navigatorOwnKeys || []).length === 0,
      (pb.navigatorOwnKeys || []).join(', ') || '（空）'
    )
    check(
      'screen 自有键为空（与真实 Chrome 一致）',
      (pb.screenOwnKeys || []).length === 0,
      (pb.screenOwnKeys || []).join(', ') || '（空）'
    )

    // 关键断言：UA 与 UA-CH 自洽
    check(
      'UA 与 UA-CH 的平台/版本自洽',
      !findings.some((f) => f.key.startsWith('uach:')),
      findings.filter((f) => f.key.startsWith('uach:')).map((f) => f.key).join(',') || 'OK'
    )

    // 关键断言：时区自洽
    check(
      '时区三件套自洽（offset / Intl / Date.toString）',
      !findings.some((f) => f.key === 'timezone:offsetMismatch' || f.key === 'timezone:notInjected'),
      findings.filter((f) => f.key.startsWith('timezone:')).map((f) => f.key).join(',') || 'OK'
    )

    // 结论：无致命破绽
    check(
      '无致命破绽（summary.passed === true）',
      summary.passed === true,
      `致命 ${summary.fatal} · 警告 ${summary.warn} · 提示 ${summary.info}`
    )

    // ---------- 7. 关窗清理 ----------
    await fetch(`${apiBase}/api/profiles/${profileId}/close`, {
      method: 'POST',
      headers: auth
    }).catch(() => {})
  } finally {
    child.kill()
    await sleep(1500)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
  if (failed.length) {
    console.error('\n失败项：')
    for (const f of failed) console.error(`  ❌ ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('脚本异常:', e.message)
  process.exit(1)
})
