// 构造一份「有冲突、有丢失」的快照，验证差异预演的展示能力
// 用法：TK=<token> node verify-snapshot-conflict.cjs
const BASE = 'http://127.0.0.1:39100/api'

async function main() {
  const H = { Authorization: 'Bearer ' + process.env.TK }
  const snap = await (await fetch(BASE + '/snapshot/export', { headers: H })).json()

  // 场景 1：全新代理（库里没有同名）→ 应判 create
  snap.proxies.push({
    id: 90001, name: '全新代理-A', host: '10.9.9.9', port: 9999,
    type: 'http', username: '', password: '', country: 'United States', status: 'unknown'
  })
  // 场景 2：同名但连接信息不同 → 应判 conflict（保留现有，不覆盖）
  snap.proxies.push({
    id: 90002, name: 'US-可用-1', host: '10.1.1.1', port: 1111,
    type: 'socks5', username: 'other', password: 'other', country: 'Japan', status: 'unknown'
  })
  // 场景 3：失效代理 → 应判 invalid（跳过）
  snap.proxies.push({
    id: 90003, name: '失效代理X', host: '10.2.2.2', port: 2222,
    type: 'http', username: '', password: '', country: 'United States', status: 'invalid'
  })
  // 场景 4：环境引用一个不存在的代理，且无 proxyDetail → 最危险的「建成但无代理」
  snap.profiles.push({
    id: 90010, name: '危险环境-无代理', group: '', fingerprint: { os: 'windows', timezone: 'Asia/Tokyo' },
    proxyId: 77777, proxyDetail: null
  })

  const r = await fetch(BASE + '/snapshot/preview', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(snap)
  })
  const p = await r.json()
  console.log('════ 有冲突的快照预演 ════')
  console.log('HTTP', r.status)
  if (r.status !== 200) { console.log('错误:', p.message); return }
  const d = p.diff
  console.log('计数:', JSON.stringify(d.counts))
  console.log('提示:'); (d.notes || []).forEach((n) => console.log('  ·', n))
  console.log('代理明细:')
  ;(d.proxies || []).forEach((x) => console.log('  [' + x.action + '] ' + x.name + ' — ' + x.detail))
  console.log('环境明细:')
  ;(d.profiles || []).forEach((x) => console.log('  [' + x.action + '] ' + x.name + ' — ' + (x.detail || '')))
}

main().catch((e) => console.error('脚本异常:', e.message))
