/**
 * 代理分配决策解释（explainAllocation）离线单测。
 *
 * 核心约束：**解释必须与 allocateProxies 的实际行为一致**。
 * 用户是靠这份解释决定「该补代理」还是「该改筛选条件」——
 * 若解释与实际分叉，他会往错误方向补货，比没有解释更糟。
 * 故本文件除了单独测解释，还会**对拍**：先跑真实分配，再核对解释的每一条。
 */
const assert = require('assert')

const { allocateProxies } = require('../.tmp_px/shared/proxyAllocator.js')
const { explainAllocation, sharedBrokeList } = require('../.tmp_px/shared/proxyAllocExplain.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const FUTURE = new Date(Date.now() + 86400000 * 30)
const PAST = new Date(Date.now() - 86400000)

/** 跑一遍真实分配 + 解释，供对拍使用 */
function run(envs, proxies, usage, opts) {
  const r = allocateProxies(envs, proxies, usage, opts)
  return { r, e: explainAllocation(envs, proxies, usage, r, opts) }
}

// ============ 池构成：排除原因 ============

t('失效代理被标为不可用并说明原因', () => {
  const proxies = [
    { id: 1, name: '好的', status: 'active' },
    { id: 2, name: '坏的', status: 'invalid' }
  ]
  const { e } = run([], proxies, new Map())
  const bad = e.pool.items.find((i) => i.id === 2)
  assert.strictEqual(bad.usable, false)
  assert.ok(bad.reasons.includes('invalid'))
  assert.strictEqual(bad.detail, '已失效')
  assert.strictEqual(e.pool.usable, 1)
  assert.strictEqual(e.pool.rejected.invalid, 1)
})

t('过期代理被排除', () => {
  const { e } = run([], [{ id: 1, name: '过期', status: 'active', expiresAt: PAST }], new Map())
  assert.strictEqual(e.pool.usable, 0)
  assert.ok(e.pool.items[0].reasons.includes('expired'))
})

t('未过期的代理不因 expiresAt 被排除', () => {
  const { e } = run([], [{ id: 1, name: '有效', status: 'active', expiresAt: FUTURE }], new Map())
  assert.strictEqual(e.pool.usable, 1)
})

t('无 expiresAt 的代理视为永久有效', () => {
  const { e } = run([], [{ id: 1, name: '无期限', status: 'active' }], new Map())
  assert.strictEqual(e.pool.usable, 1)
})

t('国家筛选：不符的被排除并计入 countryFilter', () => {
  const proxies = [
    { id: 1, name: '美国', status: 'active', country: 'United States' },
    { id: 2, name: '日本', status: 'active', country: 'Japan' }
  ]
  const { e } = run([], proxies, new Map(), { country: 'United' })
  assert.strictEqual(e.pool.usable, 1)
  assert.strictEqual(e.pool.rejected.countryFilter, 1)
  const jp = e.pool.items.find((i) => i.id === 2)
  assert.ok(jp.reasons.includes('countryFilter'))
  assert.ok(jp.detail.includes('国家不符'))
})

t('类型筛选：不符的被排除', () => {
  const proxies = [
    { id: 1, name: 'HTTP', status: 'active', type: 'http' },
    { id: 2, name: 'SOCKS', status: 'active', type: 'socks5' }
  ]
  const { e } = run([], proxies, new Map(), { type: 'http' })
  assert.strictEqual(e.pool.usable, 1)
  assert.strictEqual(e.pool.rejected.typeFilter, 1)
})

t('失效优先于过期（与 isUsable 的短路顺序一致）', () => {
  // isUsable 是 `status !== 'invalid' && (!expiresAt || ...)`：命中 invalid 就短路返回，
  // 不再判过期。故一个「既失效又过期」的代理只会列出 invalid。
  // 解释必须与之一致——多报一条原因会让用户以为「续期就能用」，而它其实已经失效了。
  const { e } = run([], [{ id: 1, name: 'X', status: 'invalid', country: 'Japan', expiresAt: PAST }], new Map(), { country: 'US' })
  const it = e.pool.items[0]
  assert.deepStrictEqual(it.reasons.slice().sort(), ['countryFilter', 'invalid'])
  assert.strictEqual(it.reasons.includes('expired'), false, 'invalid 已短路，不应再报 expired')
  assert.strictEqual(e.pool.rejected.invalid, 1)
  // 键不存在时是 undefined 而非 0——说明分布是「按需累加」，不是全量零填充
  assert.ok(!e.pool.rejected.expired, '未出现的原因不应凭空为 0')
})

t('未失效但已过期 → 只报 expired', () => {
  const { e } = run([], [{ id: 1, name: 'Y', status: 'active', expiresAt: PAST }], new Map())
  assert.deepStrictEqual(e.pool.items[0].reasons, ['expired'])
})

t('筛选不符会与状态原因并存（两者是不同维度，各自独立判定）', () => {
  const { e } = run([], [{ id: 1, name: 'Z', status: 'invalid', country: 'Japan' }], new Map(), { country: 'US' })
  const it = e.pool.items[0]
  assert.deepStrictEqual(it.reasons.slice().sort(), ['countryFilter', 'invalid'])
  assert.ok(it.detail.includes('已失效'))
  assert.ok(it.detail.includes('国家不符'))
})

t('被未选中环境占用的代理标记 occupied 且不可抢占', () => {
  // 代理 1 被本批外的环境 A 使用（usage=1），本批无人占用 → 应被排除
  const envs = [{ id: 10, name: '本批环境', status: 'stopped', proxyId: null }]
  const proxies = [{ id: 1, name: '被占', status: 'active' }]
  const usage = new Map([[1, 1]])
  const { r, e } = run(envs, proxies, usage)
  assert.strictEqual(e.pool.usable, 0)
  assert.strictEqual(e.pool.items[0].reasons.includes('occupied'), true)
  assert.strictEqual(e.pool.items[0].heldByCount, 1)
  // 池空 → 该环境被跳过
  assert.strictEqual(r.skippedNoProxy, 1)
})

t('本批内部共享的代理不算 occupied（可重新平衡）', () => {
  // 两个选中环境共用代理1，usage=2、selCount=2 → outsider=0 → 应可用
  const envs = [
    { id: 10, name: 'A', status: 'stopped', proxyId: 1 },
    { id: 11, name: 'B', status: 'stopped', proxyId: 1 },
    { id: 12, name: 'C', status: 'stopped', proxyId: null }
  ]
  const proxies = [{ id: 1, name: '共享', status: 'active' }, { id: 2, name: '空闲', status: 'active' }]
  const usage = new Map([[1, 2]])
  const { r, e } = run(envs, proxies, usage)
  const shared = e.pool.items.find((i) => i.id === 1)
  assert.strictEqual(shared.usable, true, '本批内部共享不应被排除')
  assert.strictEqual(shared.heldBySelected, 2)
  assert.strictEqual(e.pool.usable, 2)
  // A 保留（独占性不成立，selCount=2），B 与 C 各拿一个
  assert.strictEqual(r.assigned, 2)
})

// ============ 逐环境决策 ============

t('kept：已独占合规代理，说明「保持不变」', () => {
  const envs = [{ id: 10, name: 'A', status: 'stopped', proxyId: 1 }]
  const proxies = [{ id: 1, name: '我的代理', status: 'active' }]
  const { r, e } = run(envs, proxies, new Map([[1, 1]]))
  assert.strictEqual(r.kept, 1)
  const d = e.decisions[0]
  assert.strictEqual(d.action, 'kept')
  assert.strictEqual(d.fromProxy, '我的代理')
  assert.strictEqual(d.toProxy, '我的代理')
  assert.ok(d.why.includes('保持不变'))
})

t('assigned：从共享代理拆开时标记 brokeShared 并说明', () => {
  // A、B 原本共用代理1；池里有 1 和 2，分配器按 id 顺序取：
  // A 先拿到 1（仍与 B 共享），B 拿到 2 → **B 才是脱离共享的那个**。
  // 我一开始以为「B 分到新代理」，写反了——分配顺序是按代理 id，不是按环境。
  const envs = [
    { id: 10, name: 'A', status: 'stopped', proxyId: 1 },
    { id: 11, name: 'B', status: 'stopped', proxyId: 1 }
  ]
  const proxies = [{ id: 1, name: '原代理', status: 'active' }, { id: 2, name: '新代理', status: 'active' }]
  const usage = new Map([[1, 2]])
  const { r, e } = run(envs, proxies, usage)
  const b = e.decisions.find((d) => d.id === 11)
  assert.strictEqual(b.action, 'assigned')
  assert.strictEqual(b.fromProxy, '原代理')
  assert.strictEqual(b.toProxy, '新代理')
  assert.strictEqual(b.brokeShared, true, 'B 拿到新代理、脱离共享')
  assert.ok(b.why.includes('已拆开'))
  // A 仍拿原代理，但它的 brokeShared 同样为 true——原代理确实是共享的，
  // 整批完成后共享被拆开。**不能据此说 A「由 X 改为 X」**（那文案自相矛盾）。
  const a = e.decisions.find((d) => d.id === 10)
  assert.strictEqual(a.toProxy, '原代理')
  assert.strictEqual(a.fromProxy, '原代理')
  assert.ok(!a.why.includes('改为独占'), `仍拿原代理时不应说「改为独占」，实际：${a.why}`)
  assert.ok(a.why.includes('仍使用'))
  assert.ok(a.why.includes('拆开'), '应说明共享会被拆开')
  assert.strictEqual(sharedBrokeList(e).length, 2, '两个环境的原代理都是共享的')
})

t('assigned：原本无代理时说明是「新分配」', () => {
  const envs = [{ id: 10, name: 'A', status: 'stopped', proxyId: null }]
  const proxies = [{ id: 1, name: '空闲', status: 'active' }]
  const { e } = run(envs, proxies, new Map())
  assert.strictEqual(e.decisions[0].fromProxy, '')
  assert.ok(e.decisions[0].why.includes('新分配'))
})

t('skipped：保留原代理名并给出原因', () => {
  const envs = [{ id: 10, name: 'A', status: 'running', proxyId: null }]
  const { e } = run(envs, [{ id: 1, name: 'X', status: 'active' }], new Map())
  const d = e.decisions[0]
  assert.strictEqual(d.action, 'skipped')
  assert.ok(d.why.includes('运行中'))
})

t('运行中的环境即使池里有代理也不参与分配', () => {
  const envs = [{ id: 10, name: 'A', status: 'running', proxyId: null }]
  const { r, e } = run(envs, [{ id: 1, name: '空闲', status: 'active' }], new Map())
  assert.strictEqual(r.assigned, 0)
  assert.strictEqual(r.skippedRunning, 1)
  assert.strictEqual(e.decisions[0].action, 'skipped')
})

// ============ notes：告诉用户该往哪补 ============

t('池不足时说明差几个', () => {
  const envs = [
    { id: 1, name: 'A', status: 'stopped', proxyId: null },
    { id: 2, name: 'B', status: 'stopped', proxyId: null },
    { id: 3, name: 'C', status: 'stopped', proxyId: null }
  ]
  const { e } = run(envs, [{ id: 1, name: '唯一', status: 'active' }], new Map())
  assert.ok(e.notes.some((n) => n.includes('缺 2 个')), `应说明缺口，实际：${e.notes}`)
})

t('筛选过严时建议放宽筛选（而不是让用户去补货）', () => {
  const proxies = [
    { id: 1, name: 'US', status: 'active', country: 'United States' },
    { id: 2, name: 'JP', status: 'active', country: 'Japan' }
  ]
  const { e } = run([], proxies, new Map(), { country: 'United' })
  assert.ok(e.notes.some((n) => n.includes('放宽筛选')), `应建议放宽筛选，实际：${e.notes}`)
})

t('被占用时建议把占用的环境也一起选进来', () => {
  const envs = [{ id: 10, name: 'A', status: 'stopped', proxyId: null }]
  const { e } = run(envs, [{ id: 1, name: '被占', status: 'active' }], new Map([[1, 1]]))
  assert.ok(e.notes.some((n) => n.includes('一起选进来')), `应给出可执行的建议，实际：${e.notes}`)
})

t('过期与失效各有对应建议', () => {
  const proxies = [
    { id: 1, name: '过期', status: 'active', expiresAt: PAST },
    { id: 2, name: '失效', status: 'invalid' }
  ]
  const { e } = run([], proxies, new Map())
  assert.ok(e.notes.some((n) => n.includes('已过期')))
  assert.ok(e.notes.some((n) => n.includes('已失效')))
})

t('没有任何代理时明确说明', () => {
  const { e } = run([{ id: 1, name: 'A', status: 'stopped', proxyId: null }], [], new Map())
  assert.ok(e.notes.some((n) => n.includes('没有任何代理')))
})

// ============ 对拍：解释与实际分配必须一致 ============

t('对拍：每个 assigned 决策的代理确实是本次新分配的那个', () => {
  const envs = [
    { id: 10, name: 'A', status: 'stopped', proxyId: null },
    { id: 11, name: 'B', status: 'stopped', proxyId: null },
    { id: 12, name: 'C', status: 'stopped', proxyId: null }
  ]
  const proxies = [
    { id: 1, name: 'P1', status: 'active' },
    { id: 2, name: 'P2', status: 'active' },
    { id: 3, name: 'P3', status: 'active' }
  ]
  const { r, e } = run(envs, proxies, new Map())
  const assignedIds = new Set(r.results.filter((x) => x.action === 'assigned').map((x) => x.proxyId))
  for (const d of e.decisions.filter((x) => x.action === 'assigned')) {
    const real = r.results.find((x) => x.id === d.id)
    const nameOf = new Map(proxies.map((p) => [p.id, p.name]))
    assert.strictEqual(d.toProxy, nameOf.get(real.proxyId), `环境 ${d.id} 的代理名与实际不符`)
    assert.ok(assignedIds.has(real.proxyId))
  }
})

t('对拍：kept 的环境在解释里也必须标为 kept', () => {
  const envs = [
    { id: 10, name: 'A', status: 'stopped', proxyId: 1 },
    { id: 11, name: 'B', status: 'stopped', proxyId: null }
  ]
  const proxies = [{ id: 1, name: 'P1', status: 'active' }, { id: 2, name: 'P2', status: 'active' }]
  const usage = new Map([[1, 1]])
  const { r, e } = run(envs, proxies, usage)
  assert.strictEqual(r.kept, 1)
  assert.strictEqual(e.decisions.filter((d) => d.action === 'kept').length, 1)
})

t('对拍：解释的 decision 数量恒等于结果数量', () => {
  const envs = [
    { id: 1, name: 'A', status: 'stopped', proxyId: null },
    { id: 2, name: 'B', status: 'running', proxyId: null },
    { id: 3, name: 'C', status: 'stopped', proxyId: 9 }
  ]
  const { r, e } = run(envs, [{ id: 1, name: 'P1', status: 'active' }], new Map([[9, 1]]))
  assert.strictEqual(e.decisions.length, r.results.length)
})

t('对拍：池可用数与实际能分配的代理集合一致', () => {
  // 可用池 ≥ 可分配数（会被本批逐步 claim），但可用数必须 ≥ 实际 assigned + kept
  const envs = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `E${i + 1}`, status: 'stopped', proxyId: null }))
  const proxies = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, status: i < 3 ? 'active' : 'invalid' }))
  const { r, e } = run(envs, proxies, new Map())
  assert.strictEqual(e.pool.usable, 3)
  assert.strictEqual(r.assigned + r.skippedNoProxy, 5)
  assert.strictEqual(r.assigned, 3, '可用 3 个，应只分到 3 个')
})

t('无副作用：不修改传入对象', () => {
  const envs = [{ id: 10, name: 'A', status: 'stopped', proxyId: null }]
  const proxies = [{ id: 1, name: 'P1', status: 'active' }]
  const usage = new Map()
  const before = JSON.stringify({ envs, proxies })
  const r = allocateProxies(envs, proxies, usage)
  explainAllocation(envs, proxies, usage, r)
  assert.strictEqual(JSON.stringify({ envs, proxies }), before)
})

t('空代理列表不报错', () => {
  const r = allocateProxies([], [], new Map())
  const e = explainAllocation([], [], new Map(), r)
  assert.strictEqual(e.pool.total, 0)
  assert.deepStrictEqual(e.decisions, [])
})

console.log(`\nproxyAllocExplain: ${pass} passed, ${fail} failed`)