// 修复后的回归验证：确认正常路径未被守卫误伤 + 单环境预演如实反映
// 用法：TK=<token> node verify-fix-guard-regress.cjs
const BASE = 'http://127.0.0.1:39100/api'
const mysql = require('mysql2/promise')

async function main() {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TK }
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: process.env.DBU, password: process.env.DBP, database: 'roxy_browser'
  })
  const id = 3
  const [rs] = await c.query('SELECT fingerprint FROM profiles WHERE id=?', [id])
  let orig = rs[0].fingerprint
  if (typeof orig === 'string') orig = JSON.parse(orig)

  // 场景 1：合法指纹 + 代理国家不符 → 批量预演应照常出方案
  console.log('【场景1】合法指纹（守卫不得误伤）')
  let r = await fetch(BASE + '/profiles/batch-fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ ids: [id], preview: true })
  })
  let j = await r.json()
  let it = j.plan.items[0]
  console.log('  status=' + it.status + ' | changes=' + it.changes.length + ' | willChange=' + j.plan.counts.willChange)
  it.changes.forEach((c2) => console.log('    ' + c2.field + ': ' + JSON.stringify(c2.from) + ' → ' + JSON.stringify(c2.to)))
  console.log(it.status === 'fixable' ? '  ✅ 未被守卫误伤' : '  ❌ 被误伤了')

  // 场景 2：单环境预演分支，合法指纹应回 fixable:true
  console.log('\n【场景2】单环境预演（合法指纹）')
  r = await fetch(BASE + '/profiles/' + id + '/fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ keys: ['tzVsProxy'], preview: true })
  })
  j = await r.json()
  console.log('  fixable =', j.fixable, '| proposals =', (j.proposals || []).length)
  console.log('  summary =', j.summary)
  console.log(j.fixable === true ? '  ✅ 正常' : '  ❌ 异常')

  // 场景 3：单环境预演，残缺指纹应回 fixable:false（不���给出「将修复」）
  console.log('\n【场景3】单环境预演（残缺指纹）')
  const stripped = { timezone: orig.timezone, languages: orig.languages }
  await c.query('UPDATE profiles SET fingerprint=? WHERE id=?', [JSON.stringify(stripped), id])
  r = await fetch(BASE + '/profiles/' + id + '/fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ keys: ['tzVsProxy'], preview: true })
  })
  j = await r.json()
  console.log('  fixable =', j.fixable, '| proposals =', (j.proposals || []).length)
  console.log('  reason =', j.reason)
  console.log(j.fixable === false && (j.proposals || []).length === 0 ? '  ✅ 如实报不可修' : '  ❌ 仍在承诺能修')

  // 场景 4：单环境执行，残缺指纹应 400
  console.log('\n【场景4】单环境执行（残缺指纹）')
  r = await fetch(BASE + '/profiles/' + id + '/fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ keys: ['tzVsProxy'], preview: false })
  })
  j = await r.json()
  console.log('  HTTP', r.status)
  console.log('  message =', j.message)
  console.log(r.status === 400 ? '  ✅ 已拒绝' : '  ❌ 未拒绝')

  // 复原
  await c.query('UPDATE profiles SET fingerprint=? WHERE id=?', [JSON.stringify(orig), id])
  const [rv] = await c.query('SELECT fingerprint FROM profiles WHERE id=?', [id])
  let back = rv[0].fingerprint
  if (typeof back === 'string') back = JSON.parse(back)
  console.log('\n[已复原] os=' + back.os + ' tz=' + back.timezone)
  await c.end()
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1) })