// 代理出口 IP 漂移 —— 端到端真机验证
// 场景：用一个本地转发代理（127.0.0.1:18080 → ip-api）作为「代理」，
// 走完整的「检测 → 落库 → 列表 → 日志」链路。
// 第一次检测后，把库里记录的 exitIp 改掉（模拟 IP 池轮换），
// 第二次检测即应触发漂移告警。
// 用法：TK=<token> DBU=<user> DBP=<pass> node verify-proxy-drift-e2e.cjs
const BASE = 'http://127.0.0.1:39100/api'
const mysql = require('mysql2/promise')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TK }
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: process.env.DBU, password: process.env.DBP, database: 'roxy_browser'
  })

  console.log('【准备】创建代理（指向本地转发代理）+ 绑定一个环境')
  let r = await fetch(BASE + '/proxies', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: '漂移验证代理', host: '127.0.0.1', port: 18080, type: 'http' })
  })
  let j = await r.json()
  if (!j.id) { console.log('创建代理失败:', JSON.stringify(j).slice(0, 200)); process.exit(1) }
  const proxyId = j.id
  console.log('  代理 #' + proxyId + ' ' + j.name)

  // 取一个环境，绑到该代理，并把它时区设成与代理国家不一致（模拟失配）
  const [ps] = await c.query('SELECT id, name, fingerprint FROM profiles WHERE isTemplate=0 ORDER BY id LIMIT 1')
  const prof = ps[0]
  // ⚠️ mysql2 把 JSON 列返回为**对象**（不是字符串），直接改它会连"原始值"一起改掉，
  // 复原时就会把测试改动写回去。必须先深拷贝一份原始值留底。
  const origFp = typeof prof.fingerprint === 'string' ? prof.fingerprint : JSON.stringify(prof.fingerprint)
  const fp = typeof prof.fingerprint === 'string' ? JSON.parse(prof.fingerprint) : { ...prof.fingerprint }
  fp.timezone = 'America/New_York'   // 代理出口在 China → 时区应为中国，绝不匹配
  await c.query('UPDATE profiles SET proxyId=?, fingerprint=? WHERE id=?', [proxyId, JSON.stringify(fp), prof.id])
  console.log('  环境 #' + prof.id + ' ' + prof.name + ' 已绑定该代理，时区设为 America/New_York')

  console.log('\n【第 1 次检测】建立基线（此时不该报漂移）')
  r = await fetch(BASE + '/proxies/' + proxyId + '/check', { method: 'POST', headers: H })
  j = await r.json()
  console.log('  HTTP', r.status, '| status=' + j.status, '| exitIp=' + (j.exitIp || '(空)'), '| country=' + (j.country || '(空)'))
  console.log('  exitIpChanged 字段存在:', 'exitIpChanged' in j, '→', j.exitIpChanged ? '❌ 首次检测不该报漂移' : '✅ 未报漂移（正确）')

  console.log('\n【第 2 步】把库里记录的出口 IP 改掉，模拟 IP 池轮换')
  await c.query("UPDATE proxies SET exitIp='198.51.100.99', country='United States' WHERE id=?", [proxyId])
  console.log('  已改为 exitIp=198.51.100.99 country=United States（实际出口仍是 China）')

  console.log('\n【第 2 次检测】应识别出漂移')
  r = await fetch(BASE + '/proxies/' + proxyId + '/check', { method: 'POST', headers: H })
  j = await r.json()
  console.log('  HTTP', r.status)
  console.log('  exitIpChanged =', JSON.stringify(j.exitIpChanged))
  console.log('  misalignedProfiles =', JSON.stringify(j.misalignedProfiles))
  console.log('  提示文案:', j.message)
  if (j.exitIpChanged) console.log('  ✅ 已识别出口漂移')
  else console.log('  ❌ 未识别漂移')

  console.log('\n【第 3 步】代理列表应带出失配环境')
  r = await fetch(BASE + '/proxies', { headers: H })
  const list = await r.json()
  const target = list.find((x) => x.id === proxyId)
  console.log('  misalignedProfiles =', JSON.stringify(target.misalignedProfiles))
  console.log(target.misalignedProfiles && target.misalignedProfiles.length
    ? '  ✅ 列表带出了失配环境（前端会显示红色标记）'
    : '  ⚠️ 列表未带出')

  console.log('\n【第 4 步】操作日志应写入 proxy_exit_ip_changed')
  const [logs] = await c.query(
    "SELECT action, detail FROM operation_logs WHERE action='proxy_exit_ip_changed' ORDER BY id DESC LIMIT 2"
  )
  if (logs.length) {
    logs.forEach((l) => console.log('  [' + l.action + '] ' + String(l.detail)))
    console.log('  ✅ 已写入漂移日志（webhook 也会随之触发）')
  } else console.log('  ❌ 未写入漂移日志')

  console.log('\n【第 5 步】失配环境走一致性修复预演，应给出可修方案')
  r = await fetch(BASE + '/profiles/batch-fix-consistency', {
    method: 'POST', headers: H, body: JSON.stringify({ ids: [prof.id], preview: true })
  })
  j = await r.json()
  const it = j.plan.items[0]
  console.log('  status=' + it.status + ' | changes=' + JSON.stringify(it.changes))
  console.log('  summary:', it.summary)

  // 复原
  console.log('\n【清理】删除测试代理、解绑环境、恢复时区')
  // 注意 1：mysql2 的 JSON 列必须传**字符串**，直接传对象会报
  //   "Invalid value ... for column 'profiles.fingerprint'"（第一次跑就踩了）
  // 注意 2：JSON 列读回来是**对象**，必须用上面留底的 origFp 字符串复原，
  //   否则复原的是被测试改过的值（第二次跑就踩了）
  await c.query('UPDATE profiles SET proxyId=NULL, fingerprint=? WHERE id=?', [origFp, prof.id])
  await fetch(BASE + '/proxies/' + proxyId, { method: 'DELETE', headers: H })
  const [left] = await c.query('SELECT COUNT(*) n FROM proxies')
  const [back] = await c.query('SELECT proxyId, fingerprint FROM profiles WHERE id=?', [prof.id])
  let bf = back[0].fingerprint
  if (typeof bf === 'string') bf = JSON.parse(bf)
  console.log('  剩余代理数:', left[0].n, '| 环境 #' + prof.id + ' proxyId=' + (back[0].proxyId ?? 'NULL') + ' tz=' + bf.timezone)
  await c.end()
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1) })