// 修复验证：重现「指纹残缺 → 修复 → 整份被随机替换」的场景，确认已被守卫拦住
// 用法：TK=<token> node verify-fix-guard.cjs
const BASE = 'http://127.0.0.1:39100/api'
const mysql = require('mysql2/promise')

const db = async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: process.env.DBU, password: process.env.DBP,
    database: 'roxy_browser'
  })
  return c
}
const getFp = async (c, id) => {
  const [r] = await c.query('SELECT fingerprint FROM profiles WHERE id=?', [id])
  let f = r[0].fingerprint
  return typeof f === 'string' ? JSON.parse(f) : f
}

async function main() {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TK }
  const c = await db()
  const id = 3
  const orig = await getFp(c, id)
  console.log('原始 #3: os=' + orig.os + ' tz=' + orig.timezone + ' ua=' + (orig.userAgent ? '有' : '无'))

  // 1. 把指纹裁成残缺状态（无 os）——这正是真机验证时命中的场景
  const stripped = { timezone: orig.timezone, languages: orig.languages }
  await c.query('UPDATE profiles SET fingerprint=? WHERE id=?', [JSON.stringify(stripped), id])
  console.log('已裁成残缺指纹:', JSON.stringify(stripped))

  // 2. 预演：应如实报「修不了」，而不是给出「将修复 timezone」
  let r = await fetch(BASE + '/profiles/batch-fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ ids: [id], preview: true })
  })
  let j = await r.json()
  console.log('\n【预演】counts =', JSON.stringify(j.plan.counts))
  const it = j.plan.items[0]
  console.log('  status =', it.status)
  console.log('  changes =', it.changes.length, '(必须为 0)')
  console.log('  reason =', it.reason)
  console.log('  提示:', j.plan.notes.join(' / '))

  // 3. 执行：应进 failed，不写库
  r = await fetch(BASE + '/profiles/batch-fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ ids: [id], preview: false })
  })
  j = await r.json()
  console.log('\n【执行】HTTP', r.status)
  console.log('  applied =', JSON.stringify(j.applied))
  console.log('  failed  =', JSON.stringify(j.failed))

  // 4. 关键断言：库里指纹必须原封不动
  const after = await getFp(c, id)
  const unchanged = JSON.stringify(after) === JSON.stringify(stripped)
  console.log('\n【断言】修复后指纹是否仍为残缺原值:', unchanged ? '✅ 是（未被随机替换）' : '❌ 否（数据被改了）')
  console.log('  当前 os =', JSON.stringify(after.os), '| ua =', after.userAgent ? '有' : '无')

  // 5. 复原
  await c.query('UPDATE profiles SET fingerprint=? WHERE id=?', [JSON.stringify(orig), id])
  const restored = await getFp(c, id)
  console.log('\n[已复原] os=' + restored.os + ' tz=' + restored.timezone)
  await c.end()
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1) })