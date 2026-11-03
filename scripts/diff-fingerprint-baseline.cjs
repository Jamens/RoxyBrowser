// 指纹基线对比：把两次采集的快照逐项 diff，列出因内核升级而变化的值。
//
// 用法：node scripts/diff-fingerprint-baseline.cjs <基线A.json> <基线B.json>
//
// ## 为什么必须区分「未覆盖」与「无变化」
//
// 无 GPU 的机器上采集时，webgl / webgpu / webgpuSubgroup 三项只会报「不可用」，
// 而这三项恰是内核变化最敏感的（Chrome 151 调过 WebGL 输出规则、152 加了 WebGPU 子群）。
//
// 若把它们当普通实测值参与比较，两份基线都是「不可用」时会输出「变化 0 项」——
// 读起来像「WebGL 维度也没变」，实际是**这一维根本没被覆盖**。这是最危险的一种
// 虚假安心：内核恰好改了 WebGL 输出规则时，回归会被完全漏掉。
//
// 故本脚本把每一项归入四类之一：
//   真变化      两侧都已覆盖且值不同   → 回归信号
//   无变化      两侧都已覆盖且值相同   → 确认未受影响
//   覆盖补齐    A 未覆盖、B 已覆盖     → 是覆盖范围扩大，不是内核引起的变化
//   覆盖丢失    A 已覆盖、B 未覆盖     → 采集环境变了（如换了无 GPU 的机器）
//   双方未覆盖                        → 本轮无对比意义，必须提示补采
const fs = require('fs')

/**
 * 身份字段：由指纹设定 / 环境种子派生，**随环境走，不随内核走**。
 * 依据：healthcheck 的实测项——这些值由 profile 的 fingerprint 字段决定。
 *
 * 为什么必须分组：基线对比的目的是「内核升级是否改变了伪装输出」。但实测值里
 * 混着两类东西——身份字段（UA / 平台 / 语言 / 屏幕 / CPU / 显卡 / 音频档案…）
 * 换一套环境指纹就会全变，与内核毫无关系；行为字段（canvas 噪声一致性 /
 * 音频编码支持 / EME 能力 / 自动化痕迹 / WebCrypto 算法可见性…）才是内核升级
 * 真正可能影响的。旧版 diff 把两者混在「真变化」里，于是「拿新环境采的基线去
 * 和旧基线比」会报出十几项「变化」，读起来像内核改了行为，实际全是环境指纹
 * 差异——**结论方向完全相反**。故：身份字段变化只提示「不是同一环境」，
 * 行为字段变化才是回归信号。
 */
const IDENTITY_KEYS = [
  'userAgent', 'platform', 'languages', 'screen', 'timezone', 'tzOffset',
  'hardwareConcurrency', 'deviceMemory', 'uaData', 'touch', 'webgl', 'webglOsMatch',
  'fonts', 'fontOsConsistency', 'mediaPrefs', 'audioProfile', 'audioReduction',
  'webgpu', 'webgpuSubgroup', 'webrtc', 'platformApis'
]

function isIdentityKey(key) {
  return IDENTITY_KEYS.includes(key)
}

/**
 * 推断一份快照的「未覆盖」项。
 * 优先读快照里结构化的 uncovered 字段；旧快照没有该字段时，从实测值模式反推。
 */
function inferUncovered(snapshot) {
  if (Array.isArray(snapshot && snapshot.uncovered)) return snapshot.uncovered
  return Object.entries((snapshot && snapshot.actuals) || {})
    .filter(([k, v]) => k !== 'webcryptoVersion')
    .filter(([, v]) => /^(WebGL|WebGPU)/.test(String(v)) && /不可用/.test(String(v)))
    .map(([k]) => k)
}

/**
 * 对比两份基线快照。
 * @returns {object} 结构化对比结果（CLI 与单测共用）
 */
function compareBaselines(a, b) {
  const aUn = inferUncovered(a)
  const bUn = inferUncovered(b)
  const aa = a.actuals || {}
  const bb = b.actuals || {}
  const allKeys = [...new Set([...Object.keys(aa), ...Object.keys(bb)])].sort()

  const changed = []       // 真变化：两侧都覆盖且值不同
  const unchanged = []     // 无变化：两侧都覆盖且值相同
  const identityChanged = [] // 真变化中的身份字段（换了环境，不是内核回归）
  const behaviorChanged = [] // 真变化中的行为字段（**这才是内核回归信号**）
  const coverageFilled = []// A 未覆盖 → B 已覆盖
  const coverageLost = []  // A 已覆盖 → B 未覆盖
  const bothUncovered = [] // 两侧都未覆盖
  const added = []         // B 有 A 无
  const removed = []       // A 有 B 无

  for (const k of allKeys) {
    const va = aa[k]
    const vb = bb[k]
    const aHas = va !== undefined
    const bHas = vb !== undefined
    const aCov = aHas && !aUn.includes(k)
    const bCov = bHas && !bUn.includes(k)

    if (!aHas && !bHas) continue
    if (!aHas) { (bCov ? added : bothUncovered).push({ key: k, b: vb }); continue }
    if (!bHas) { (aCov ? removed : bothUncovered).push({ key: k, a: va }); continue }
    if (!aCov && !bCov) { bothUncovered.push({ key: k, a: va, b: vb }); continue }
    if (!aCov && bCov) { coverageFilled.push({ key: k, a: va, b: vb }); continue }
    if (aCov && !bCov) { coverageLost.push({ key: k, a: va, b: vb }); continue }
    if (String(va) !== String(vb)) {
      const rec = { key: k, a: va, b: vb }
      changed.push(rec)
      ;(isIdentityKey(k) ? identityChanged : behaviorChanged).push(rec)
    } else unchanged.push({ key: k })
  }

  const ca = a.consistency || {}
  const cb = b.consistency || {}
  const ck = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()
  const consistencyChanged = []
  for (const k of ck) {
    const x = ca[k], y = cb[k]
    const sx = x ? (x.skipped ? 'skip' : x.ok ? 'ok' : 'fail') : '(无)'
    const sy = y ? (y.skipped ? 'skip' : y.ok ? 'ok' : 'fail') : '(无)'
    if (sx !== sy) consistencyChanged.push({ key: k, a: sx, b: sy })
  }

  const coveredKeys = allKeys.filter((k) => aa[k] !== undefined && !aUn.includes(k)).length
  return {
    changed, unchanged, identityChanged, behaviorChanged,
    coverageFilled, coverageLost, bothUncovered, added, removed,
    consistencyChanged,
    // 两份基线是否同一套环境指纹：身份字段全同才算。
    // 不同 → 本次「真变化」不可归因于内核，只能说明换了环境。
    sameEnvironment: identityChanged.length === 0,
    coverage: {
      a: { total: allKeys.length, covered: allKeys.filter((k) => aa[k] !== undefined && !aUn.includes(k)).length, uncovered: aUn },
      b: { total: allKeys.length, covered: allKeys.filter((k) => bb[k] !== undefined && !bUn.includes(k)).length, uncovered: bUn },
      coveredKeys
    },
    score: { a: a.score, b: b.score },
    meta: {
      a: { capturedAt: a.capturedAt, profileName: a.profileName },
      b: { capturedAt: b.capturedAt, profileName: b.profileName }
    }
  }
}

function load(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function main() {
  const [fa, fb] = process.argv.slice(2)
  if (!fa || !fb) { console.log('用法: node diff-fingerprint-baseline.cjs <A.json> <B.json>'); process.exit(1) }
  const r = compareBaselines(load(fa), load(fb))

  console.log('基线 A:', fa)
  console.log('  采集于', r.meta.a.capturedAt, '| 伪装度', r.score.a, '|', r.meta.a.profileName)
  console.log('基线 B:', fb)
  console.log('  采集于', r.meta.b.capturedAt, '| 伪装度', r.score.b, '|', r.meta.b.profileName)
  console.log('')

  console.log('════ 覆盖情况 ════')
  console.log('  A：已覆盖 ' + r.coverage.a.covered + '/' + r.coverage.a.total +
    (r.coverage.a.uncovered.length ? '　未覆盖：' + r.coverage.a.uncovered.join(' / ') : ''))
  console.log('  B：已覆盖 ' + r.coverage.b.covered + '/' + r.coverage.b.total +
    (r.coverage.b.uncovered.length ? '　未覆盖：' + r.coverage.b.uncovered.join(' / ') : ''))

  if (!r.sameEnvironment) {
    console.log('\n⚠️ 两份基线**不是同一套环境指纹**（身份字段有差异）')
    console.log('   下面的「真变化」里，身份字段的变化只是换了环境，**不能归因于内核**。')
    console.log('   要做内核升级回归，必须对**同一个环境**（同一 profileId / 同一套指纹）前后各采一次。')
  }

  console.log('\n════ 真变化 · 行为字段 ' + r.behaviorChanged.length + ' 项（内核回归信号）════')
  if (!r.behaviorChanged.length) console.log('（无变化）')
  r.behaviorChanged.forEach(({ key, a, b }) => {
    console.log('  ⚠ ' + key)
    console.log('      A: ' + String(a).slice(0, 160))
    console.log('      B: ' + String(b).slice(0, 160))
  })

  console.log('\n════ 真变化 · 身份字段 ' + r.identityChanged.length + ' 项（随环境走，非内核）════')
  if (!r.identityChanged.length) console.log('（无变化）')
  r.identityChanged.forEach(({ key, a, b }) => {
    console.log('  · ' + key + ': ' + String(a).slice(0, 70) + ' → ' + String(b).slice(0, 70))
  })

  if (r.coverageFilled.length) {
    console.log('\n════ 覆盖补齐 ' + r.coverageFilled.length + ' 项（不是回归）════')
    r.coverageFilled.forEach(({ key, a, b }) => {
      console.log('  + ' + key + ': A=' + String(a).slice(0, 60) + ' → B=' + String(b).slice(0, 60))
    })
  }
  if (r.coverageLost.length) {
    console.log('\n════ 覆盖丢失 ' + r.coverageLost.length + ' 项（采集环境变了）════')
    r.coverageLost.forEach(({ key, a, b }) => {
      console.log('  - ' + key + ': A=' + String(a).slice(0, 60) + ' → B=' + String(b).slice(0, 60))
    })
  }

  console.log('\n════ 新增 ' + r.added.length + ' 项（B 有 A 无）════')
  r.added.forEach(({ key, b }) => console.log('  + ' + key + ' = ' + String(b).slice(0, 120)))
  console.log('════ 消失 ' + r.removed.length + ' 项（A 有 B 无）════')
  r.removed.forEach(({ key, a }) => console.log('  - ' + key + ' = ' + String(a).slice(0, 120)))

  console.log('\n════ 一致性项变化 ════')
  if (!r.consistencyChanged.length) console.log('（无变化）')
  r.consistencyChanged.forEach(({ key, a, b }) => console.log('  ⚠ ' + key + ': ' + a + ' → ' + b))

  console.log('\n伪装度: ' + r.score.a + ' → ' + r.score.b)

  console.log('\n════ 总结 ════')
  console.log('  行为字段变化 ' + r.behaviorChanged.length + ' 项（内核回归信号） / 身份字段变化 ' +
    r.identityChanged.length + ' 项（随环境走） / 无变化 ' + r.unchanged.length +
    ' / 覆盖补齐 ' + r.coverageFilled.length + ' / 覆盖丢失 ' + r.coverageLost.length +
    ' / 新增 ' + r.added.length + ' / 消失 ' + r.removed.length +
    ' / 一致性变化 ' + r.consistencyChanged.length + ' 项')
  console.log('  有效覆盖 ' + r.coverage.coveredKeys + '/' + r.coverage.a.total + ' 项参与对比')

  if (r.bothUncovered.length) {
    console.log('\n⚠️ 覆盖缺口 ' + r.bothUncovered.length + ' 项：两侧都未覆盖，本轮「无变化」不代表没变')
    r.bothUncovered.forEach(({ key, a, b }) => {
      console.log('   · ' + key + ': A=' + String(a).slice(0, 60) + ' / B=' + String(b).slice(0, 60))
    })
    console.log('   这些维度恰是内核变化最敏感的，须在**有独立显卡**的机器上补采后再对比。')
  }
}

module.exports = { compareBaselines, inferUncovered }

if (require.main === module) main()
