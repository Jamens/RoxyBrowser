// 针对性验证：单环境执行时守卫是否真的触发（需要一个「确实可修」的残缺指纹）
// 场景：timezone=Asia/Shanghai（语言应为 zh-CN）但 languages[0]='en-US' → langVsTz 可修
// 用法：TK=<token> node verify-fix-guard-400.cjs
const BASE = 'http://127.0.0.1:39100/api'
const mysql = require('mysql2/promise')

async function main() {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TK }
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: process.env.DBU, password: process.env.DBP, database: 'roxy_browser'
  })
  const id = 4
  const [rs] = await c.query('SELECT fingerprint FROM profiles WHERE id=?', [id])
  let orig = rs[0].fingerprint
  if (typeof orig === 'string') orig = JSON.parse(orig)

  // 残缺但**确实可修**：无 os，且语言与时区不符（langVsTz 会给出 patch）
  const broken = { timezone: 'Asia/Shanghai', languages: ['en-US', 'en'] }
  await c.query('UPDATE profiles SET fingerprint=? WHERE id=?', [JSON.stringify(broken), id])
  console.log('已设置为残缺且可修的指纹:', JSON.stringify(broken))

  // 先看预演说什么（此时该环境既无 os、langVsTz 又可修）
  let r = await fetch(BASE + '/profiles/batch-fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ ids: [id], preview: true })
  })
  let j = await r.json()
  console.log('\n【批量预演】status =', j.plan.items[0].status, '| changes =', j.plan.items[0].changes.length)

  // 单环境执行：守卫必须以「指纹残缺」为由 400，而不是走到无���修项那条
  r = await fetch(BASE + '/profiles/' + id + '/fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ keys: ['langVsTz'], preview: false })
  })
  j = await r.json()
  console.log('\n【单环境执行】HTTP', r.status)
  console.log('  message =', j.message)
  const hitGuard = (j.message || '').includes('整份指纹被替换为随机值')
  console.log('  ' + (hitGuard ? '✅ 命中的是守卫（非「无可修复项」分支）' : '❌ 命中的是别的分支：' + j.message))

  // 断言：库里指纹未被改动
  const [rv] = await c.query('SELECT fingerprint FROM profiles WHERE id=?', [id])
  let after = rv[0].fingerprint
  if (typeof after === 'string') after = JSON.parse(after)
  const untouched = JSON.stringify(after) === JSON.stringify(broken)
  console.log('  指纹是否未被改动: ' + (untouched ? '✅ 未改动' : '❌ 被改动：' + JSON.stringify(after)))

  await c.query('UPDATE profiles SET fingerprint=? WHERE id=?', [JSON.stringify(orig), id])
  const [bv] = await c.query('SELECT fingerprint FROM profiles WHERE id=?', [id])
  let back = bv[0].fingerprint
  if (typeof back === 'string') back = JSON.parse(back)
  console.log('\n[已复原] os=' + back.os + ' tz=' + back.timezone + ' lang=' + JSON.stringify(back.languages))
  await c.end()
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1) })