// 指纹基线对比：把两次采集的快照逐项 diff，列出因内核升级而变化的值。
// 用法：node scripts/diff-fingerprint-baseline.cjs <基线A.json> <基线B.json>
const fs = require('fs')

function load(p) {
  const b = JSON.parse(fs.readFileSync(p, 'utf8'))
  return b
}

function main() {
  const [fa, fb] = process.argv.slice(2)
  if (!fa || !fb) { console.log('用法: node diff-fingerprint-baseline.cjs <A.json> <B.json>'); process.exit(1) }
  const a = load(fa)
  const b = load(fb)

  console.log('基线 A:', fa)
  console.log('  采集于', a.capturedAt, '| 伪装度', a.score, '|', a.profileName)
  console.log('基线 B:', fb)
  console.log('  采集于', b.capturedAt, '| 伪装度', b.score, '|', b.profileName)
  console.log('')

  const ka = Object.keys(a.actuals || {})
  const kb = Object.keys(b.actuals || {})
  const allKeys = [...new Set([...ka, ...kb])].sort()

  const changed = []
  const added = []
  const removed = []
  for (const k of allKeys) {
    const va = a.actuals?.[k]
    const vb = b.actuals?.[k]
    if (va === undefined) { added.push([k, vb]); continue }
    if (vb === undefined) { removed.push([k, va]); continue }
    if (String(va) !== String(vb)) changed.push([k, va, vb])
  }

  console.log('════ 变化 ' + changed.length + ' 项 ════')
  if (!changed.length) console.log('（无变化）')
  changed.forEach(([k, va, vb]) => {
    console.log('  ⚠ ' + k)
    console.log('      A: ' + String(va).slice(0, 160))
    console.log('      B: ' + String(vb).slice(0, 160))
  })

  console.log('\n════ 新增 ' + added.length + ' 项（B 有 A 无）════')
  added.forEach(([k, v]) => console.log('  + ' + k + ' = ' + String(v).slice(0, 120)))
  console.log('════ 消失 ' + removed.length + ' 项（A 有 B 无）════')
  removed.forEach(([k, v]) => console.log('  - ' + k + ' = ' + String(v).slice(0, 120)))

  console.log('\n════ 一致性项变化 ════')
  const ca = a.consistency || {}
  const cb = b.consistency || {}
  const ck = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()
  let cChanged = 0
  for (const k of ck) {
    const x = ca[k], y = cb[k]
    const sx = x ? (x.skipped ? 'skip' : x.ok ? 'ok' : 'fail') : '(无)'
    const sy = y ? (y.skipped ? 'skip' : y.ok ? 'ok' : 'fail') : '(无)'
    if (sx !== sy) { console.log('  ⚠ ' + k + ': ' + sx + ' → ' + sy); cChanged++ }
  }
  if (!cChanged) console.log('（无变化）')

  console.log('\n伪装度: ' + a.score + ' → ' + b.score)
  console.log('\n总结：变化 ' + changed.length + ' 项 / 新增 ' + added.length + ' / 消失 ' + removed.length +
    ' / 一致性变化 ' + cChanged + ' 项')
}

main()
