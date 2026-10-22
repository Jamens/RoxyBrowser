// 指纹基线采集：开环境窗口 → 跑体检 → 把探针实测值落盘成快照。
//
// 用途：内核升级（Electron 44/Chromium 152 → 45/Chromium 154）前先留底，
// 升完用同一套脚本再采一次，逐项 diff——把"我以为没变"变成"有对照的实验"。
//
// 用法：TK=<token> node scripts/capture-fingerprint-baseline.cjs <输出文件>
const BASE = 'http://127.0.0.1:39100/api'
const fs = require('fs')

async function main() {
  const out = process.argv[2] || 'fingerprint-baseline.json'
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TK }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 取一个可运行的环境
  const list = await (await fetch(BASE + '/profiles', { headers: H })).json()
  const target = list.find((p) => !p.isTemplate) || list[0]
  if (!target) { console.log('没有可用环境'); process.exit(1) }
  console.log('目标环境 #' + target.id + ' ' + target.name)

  // 开窗。若提示「窗口已在运行中」，说明窗口已存在（可能是上一次采集没关干净），
  // 直接复用即可——重复开窗会撞上 DB 里的 running 状态而被拦。
  let r = await fetch(BASE + '/profiles/' + target.id + '/open', { method: 'POST', headers: H })
  let j = await r.json()
  if (!r.ok) {
    const alreadyRunning = String(j.message || '').includes('已在运行')
    if (!alreadyRunning) { console.log('开窗失败:', JSON.stringify(j).slice(0, 200)); process.exit(1) }
    console.log('窗口已存在，复用')
  } else {
    console.log('已开窗，等待加载…')
  }
  await sleep(9000)

  // 体检
  r = await fetch(BASE + '/profiles/' + target.id + '/healthcheck', { method: 'POST', headers: H })
  j = await r.json()
  if (!r.ok) { console.log('体检失败:', JSON.stringify(j).slice(0, 300)); process.exit(1) }

  const report = j.report || j
  console.log('体检完成，伪装度 ' + report.score)

  // 基线主体：**key → actual** 的全量映射。
  // 不用白名单挑字段——体检项的 key 会随版本增删，白名单一漏就静默丢失变化。
  // 「actual」是窗口内实测值（随内核变），「expected」是按设定值算出来的（不随内核变）。
  const actuals = {}
  for (const it of report.items || []) {
    if (it.key) actuals[it.key] = it.actual
  }
  const consistency = {}
  for (const c of report.consistency || []) {
    if (c.key) consistency[c.key] = { ok: c.ok, skipped: !!c.skipped, actual: c.actual }
  }

  const snapshot = {
    capturedAt: new Date().toISOString(),
    electron: process.env.ELECTRON_VERSION || null,
    chromium: process.env.ELECTRON_CHROMIUM || null,
    profileId: target.id,
    profileName: target.name,
    score: report.score,
    actuals,
    consistency
  }
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2))
  console.log('基线已写入 ' + out + '（' + Object.keys(actuals).length + ' 个体检项）')

  console.log('\n=== 窗口内实测值（actual）===')
  Object.entries(actuals).forEach(([k, v]) => {
    console.log('  ' + k.padEnd(22) + ' = ' + String(v).slice(0, 95))
  })

  // 覆盖缺口**必须显式说出来**：无 GPU 环境下 webgl / webgpu 只会报「不可用」，
  // 而这两项恰是内核变化最敏感的（Chrome 151 调过 WebGL 输出规则、152 加了 WebGPU 子群）。
  // 若不提示，产出的基线会被误当成「已覆盖全部维度」，白白丢掉一次复验机会。
  // 判定要精确：只有「因硬件缺失而测不到」的项才算覆盖缺口。
  // webcryptoVersion 的取值是「均不可用」——那是**门控生效的正确结果**（探到了、
  // 结论是这些算法不可见），不是「没测到」，不能混进缺口清单。
  const unavailable = Object.entries(actuals)
    .filter(([k, v]) => k !== 'webcryptoVersion')
    .filter(([, v]) => /^(WebGL|WebGPU)/.test(String(v)) && /不可用/.test(String(v)))
    .map(([k]) => k)
  if (unavailable.length) {
    console.log('\n⚠️ 覆盖缺口：以下项在本机不可用，本次基线**未覆盖**它们')
    unavailable.forEach((k) => console.log('   · ' + k))
    console.log('   这些维度恰是内核变化最敏感的，须在**有独立显卡**的机器上补采，')
    console.log('   再用 diff-fingerprint-baseline.cjs 与本基线对比。')
  }

  // 关窗
  await fetch(BASE + '/profiles/' + target.id + '/close', { method: 'POST', headers: H })
  console.log('\n已关窗')
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1) })