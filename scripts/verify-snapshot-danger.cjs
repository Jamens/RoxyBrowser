// 构造「引用不存在代理且无 proxyDetail」的危险快照 —— 验证最易被漏报的场景
// 用法：TK=<token> node verify-snapshot-danger.cjs
const BASE = 'http://127.0.0.1:39100/api'

async function main() {
  const H = { Authorization: 'Bearer ' + process.env.TK }
  const snap = await (await fetch(BASE + '/snapshot/export', { headers: H })).json()

  const base = snap.profiles[0]
  // 关键：proxy 写一个池里不存在的名字，且 proxyDetail 为空
  // → 真实导入器会让环境建成但 proxyId 保持 null，且不报错（最危险的静默失败）
  snap.profiles.push({
    ...base,
    name: '危险环境-引用丢失代理',
    proxy: '池里不存在的代理',
    proxyDetail: null
  })
  // 对照组：引用丢失但带了 proxyDetail → 应当create
  snap.profiles.push({
    ...base,
    name: '可控环境-带明细',
    proxy: '另一个不存在的代理',
    proxyDetail: { name: '另一个不存在的代理', host: '10.5.5.5', port: 5555, type: 'http' }
  })

  const r = await fetch(BASE + '/snapshot/preview', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(snap)
  })
  const p = await r.json()
  console.log('════ 危险场景预演 ════')
  console.log('HTTP', r.status)
  if (r.status !== 200) { console.log('错误:', p.message); return }
  const d = p.diff
  console.log('计数:', JSON.stringify(d.counts))
  console.log('提示:'); (d.notes || []).forEach((n) => console.log('  ·', n))
  console.log('')
  console.log('逐环境:')
  ;(d.profiles || []).forEach((x) => {
    const mark = x.proxyAction === 'missing' ? '  ◄── 危险' : x.proxyAction === 'create' ? '  ◄── 可自建' : ''
    console.log('  ' + x.name + ' | proxy=' + JSON.stringify(x.proxy) + ' | proxyAction=' + x.proxyAction + mark)
  })
}

main().catch((e) => console.error('脚本异常:', e.message))
