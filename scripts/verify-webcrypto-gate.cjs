// WebCrypto 版本门控 —— 真机验证
// 在**环境窗口内**（带 preload 伪装）测：伪装版本 < 154 时应看不到新算法。
// 用法：TK=<token> node verify-webcrypto-gate.cjs
const BASE = 'http://127.0.0.1:39100/api'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TK }

  // 取一个环境（环境 #2 伪装成 Chrome 151）
  const list = await (await fetch(BASE + '/profiles', { headers: H })).json()
  const target = list.find((p) => p.id === 2) || list.find((p) => !p.isTemplate)
  console.log('目标环境 #' + target.id + ' ' + target.name)

  // 开窗
  await fetch(BASE + '/profiles/' + target.id + '/close', { method: 'POST', headers: H })
  await sleep(1200)
  const o = await fetch(BASE + '/profiles/' + target.id + '/open', { method: 'POST', headers: H })
  console.log('开窗 →', o.status, o.ok ? '' : await o.text())
  await sleep(7000)

  // 用「截图」接口确认窗口活着（它依赖同一个 webContents）
  const shot = await fetch(BASE + '/profiles/' + target.id + '/screenshot', { method: 'POST', headers: H, body: '{}' })
  console.log('窗口存活 →', shot.status, shot.ok ? '✅' : '❌')

  // 体检报告里应有 UA 与实际能力；直接看 UA 版本
  const h = await fetch(BASE + '/profiles/' + target.id + '/healthcheck', { method: 'POST', headers: H })
  const j = await h.json()
  if (h.status !== 200) { console.log('体检失败:', JSON.stringify(j).slice(0, 200)); process.exit(1) }
  const rep = j.report || j
  const uaItem = (rep.items || []).find((x) => x.key === 'userAgent')
  const ua = String(uaItem?.actual || '')
  const major = ua.match(/Chrome\/(\d+)/)?.[1]
  console.log('伪装 UA 的 Chrome 大版本 =', major)

  console.log('\n判定：')
  if (Number(major) < 154) {
    console.log('  伪装版本 < 154 → 预期 ML-KEM / ML-DSA / X-Wing / ChaCha20 全部不可用')
    console.log('  需在窗口内实测确认（见下方 verify 脚本输出的环境内探测）')
  } else {
    console.log('  伪装版本 ≥ 154 → 预期全部可用（门控不生效）')
  }
  console.log('\n提示：门控的实际验证需在环境窗口的页面上下文里执行 crypto.subtle 探测。')
  console.log('可用「在线检测」或直接用环境窗口的 devtools 验证；本脚本只确认前置条件。')

  await fetch(BASE + '/profiles/' + target.id + '/close', { method: 'POST', headers: H })
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1) })
