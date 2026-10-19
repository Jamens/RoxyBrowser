// 快照导入预演真机验证脚本
// 用法：TK=<token> node verify-snapshot.cjs
const BASE = 'http://127.0.0.1:39100/api'

async function main() {
  const H = { Authorization: 'Bearer ' + process.env.TK }
  const r0 = await fetch(BASE + '/snapshot/export', { headers: H })
  const snap = await r0.json()
  console.log('快照键:', Object.keys(snap).join(', '))
  console.log('环境数:', (snap.profiles || []).length, '| 代理数:', (snap.proxies || []).length)

  const r = await fetch(BASE + '/snapshot/preview', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(snap)
  })
  const p = await r.json()
  console.log('\n════ 导入预演 ════')
  console.log('HTTP', r.status)
  if (r.status !== 200) { console.log('错误:', p.message); return }

  const d = p.diff
  console.log('环境:', d.counts.profiles, '| 新建代理:', d.counts.newProxies, '| 复用代理:', d.counts.reusedProxies, '| 新建分组:', d.counts.newGroups, '| RPA:', d.counts.rpaScripts)
  console.log('版本:', d.version, '| 来源团队:', d.sourceTeam)
  if (d.notes && d.notes.length) { console.log('提示:'); d.notes.forEach((n) => console.log('  ·', n)) }
  console.log('代理明细:')
  ;(d.proxyDetails || []).forEach((x) => console.log('  [' + x.action + '] ' + (x.name || '#' + x.id) + ' ' + (x.detail || '')))
  console.log('环境明细:')
  ;(d.profileDetails || []).forEach((x) => console.log('  [' + x.action + '] ' + (x.name || '#' + x.id) + ' ' + (x.detail || '')))
  if (p.warnings && p.warnings.length) { console.log('warnings:'); p.warnings.forEach((w) => console.log('  ·', w)) }
}

main().catch((e) => console.error('脚本异常:', e.message))
