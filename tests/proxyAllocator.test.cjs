/**
 * 智能代理分配器（allocateProxies）离线单测。
 *
 * 背景：这个模块被 FEATURES.md 标注「已离线单测 20 例全绿」，但**此前没有任何测试文件**
 * ——那是一条失实记录。本文件补齐，且断言全部来自**先跑真实实现再确认**，
 * 而非凭直觉推断（前几轮已有三次「我以为」与实现不符的教训）。
 *
 * 覆盖重点：
 * - Phase1 独占锁定的优先级与条件
 * - Phase2 按代理 id 取池、互不相同
 * - outsiderUsage 的正负边界（含脏数据导致的负数）
 * - 池不足宁可 skipped 也绝不复用
 * - 运行中环境一律不改动
 */
const assert = require('assert')

const { allocateProxies } = require('../.tmp_pa/shared/proxyAllocator.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const P = (id, extra = {}) => ({ id, name: `P${id}`, status: 'active', ...extra })
const E = (id, extra = {}) => ({ id, name: `E${id}`, status: 'stopped', proxyId: null, ...extra })
const act = (r) => r.results.map((x) => `${x.id}:${x.action}`).join(',')

// ============ 基础 ============

t('空输入：全零、不报错', () => {
  const r = allocateProxies([], [], new Map())
  assert.strictEqual(r.total, 0)
  assert.strictEqual(r.assigned, 0)
  assert.strictEqual(r.kept, 0)
  assert.strictEqual(r.skippedRunning, 0)
  assert.strictEqual(r.skippedNoProxy, 0)
  assert.strictEqual(r.insufficient, false)
  assert.deepStrictEqual(r.results, [])
  assert.deepStrictEqual(r.updates, [])
  assert.deepStrictEqual(r.assignedProxyIds, [])
})

t('一个空环境 + 一个可用代理 → 分配到该代理', () => {
  const r = allocateProxies([E(1)], [P(1)], new Map())
  assert.strictEqual(act(r), '1:assigned')
  assert.strictEqual(r.results[0].proxyId, 1)
  assert.deepStrictEqual(r.updates, [{ id: 1, proxyId: 1 }])
})

t('多个空环境分配到互不相同的代理（防关联核心）', () => {
  const r = allocateProxies([E(1), E(2), E(3)], [P(1), P(2), P(3)], new Map())
  assert.strictEqual(r.assigned, 3)
  const ids = r.results.map((x) => x.proxyId)
  assert.strictEqual(new Set(ids).size, 3, '不得出现重复代理')
  assert.deepStrictEqual(r.updates.map((u) => u.proxyId).sort(), [1, 2, 3])
})

t('updates 只包含 proxyId 发生变化的项', () => {
  // kept 的项不进 updates——调用方据此判断要不要 save
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2)], [P(1), P(2)], new Map([[1, 1]]))
  assert.deepStrictEqual(r.updates, [{ id: 2, proxyId: 2 }])
})

// ============ Phase 1：独占锁定 ============

t('已独占合规代理的环境被 kept，不进入 Phase2', () => {
  // usage[1]=1 且本批仅 E1 用它 → 独占
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2)], [P(1), P(2)], new Map([[1, 1]]))
  assert.strictEqual(act(r), '1:kept,2:assigned')
  assert.strictEqual(r.kept, 1)
  assert.strictEqual(r.results[0].proxyId, 1)
})

t('独占锁定的优先级：Phase1 先跑，Phase2 不会抢走已锁定的代理', () => {
  // E1 独占代理1；E2/E3 无代理。池只有 1、2 → E2 得 2，E3 跳过
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2), E(3)], [P(1), P(2)], new Map([[1, 1]]))
  assert.strictEqual(act(r), '1:kept,2:assigned,3:skipped')
  assert.strictEqual(r.results.find((x) => x.id === 1).proxyId, 1, '已锁定的代理不得被抢')
})

t('独占需要 selCount===1：本批内共享不算独占', () => {
  // E1、E2 都绑代理1（本批内共享）→ 无人满足独占 → 都不 kept
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2, { proxyId: 1 })], [P(1), P(2)], new Map([[1, 2]]))
  assert.strictEqual(r.kept, 0, '本批内共享不得判定为独占')
  assert.strictEqual(r.assigned, 2)
})

t('代理被外人占用时不 kept（即使本批只用它一个）', () => {
  // usage[1]=2，本批 E1 用 → 外人 1 → 不可独占
  const r = allocateProxies([E(1, { proxyId: 1 })], [P(1), P(2)], new Map([[1, 2]]))
  assert.strictEqual(r.kept, 0)
  // 代理1 有外人 → 出局，E1 改分代理2
  assert.strictEqual(r.results[0].action, 'assigned')
  assert.strictEqual(r.results[0].proxyId, 2)
})

t('独占的代理本身不合规（失效/过期/不符筛选）时不 kept', () => {
  const r = allocateProxies([E(1, { proxyId: 1 })], [P(1, { status: 'invalid' }), P(2)], new Map([[1, 1]]))
  assert.strictEqual(r.kept, 0)
  assert.strictEqual(r.results[0].action, 'assigned')
  assert.strictEqual(r.results[0].proxyId, 2, '应换到合规代理')
})

t('悬空 proxyId（代理已被删除）：不 kept，改分池中代理', () => {
  // 这条有实际意义：代理被删后，环境的 proxyId 悬空，分配器会顺手修复
  const r = allocateProxies([E(1, { proxyId: 999 })], [P(1)], new Map())
  assert.strictEqual(r.kept, 0)
  assert.strictEqual(act(r), '1:assigned')
  assert.strictEqual(r.results[0].proxyId, 1)
})

// ============ Phase 2：取池规则 ============

t('按代理 id 升序取池（不是按环境顺序）', () => {
  // 池按 id 排序后顺序取：E1 得 1、E2 得 2
  const r = allocateProxies([E(1), E(2)], [P(3), P(1), P(2)], new Map())
  assert.deepStrictEqual(r.results.map((x) => x.proxyId), [1, 2])
})

t('Phase2 不会把同一代理分给第二个环境', () => {
  const r = allocateProxies([E(1), E(2)], [P(1)], new Map())
  assert.strictEqual(act(r), '1:assigned,2:skipped')
  assert.strictEqual(r.insufficient, true)
  assert.ok(r.results[1].reason.includes('无可分配'))
})

t('池不足时 skipped 而非强行复用（宁可少分也不关联）', () => {
  const r = allocateProxies([E(1), E(2), E(3)], [P(1), P(2)], new Map())
  assert.strictEqual(r.assigned, 2)
  assert.strictEqual(r.skippedNoProxy, 1)
  assert.strictEqual(r.insufficient, true)
  // 关键：两个成功分配的必须是不同代理
  const got = r.results.filter((x) => x.action === 'assigned').map((x) => x.proxyId)
  assert.strictEqual(new Set(got).size, 2)
})

t('本批内部共享的代理可被重新平衡（释放并打散）', () => {
  // E1、E2 共用代理1（usage=2，无外人）；池有 1、2
  // 两者都不满足独占 → 都进 Phase2 → E1 得 1、E2 得 2（共享被拆开）
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2, { proxyId: 1 })], [P(1), P(2)], new Map([[1, 2]]))
  assert.strictEqual(act(r), '1:assigned,2:assigned')
  assert.deepStrictEqual(r.results.map((x) => x.proxyId), [1, 2])
})

t('共享代理有外人占用时无法平衡：只搬得走一个', () => {
  // usage[1]=3，本批 2 人 → 外人 1 → 代理1 出局；池只剩 2 → E1 得 2、E2 跳过
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2, { proxyId: 1 })], [P(1), P(2)], new Map([[1, 3]]))
  assert.strictEqual(act(r), '1:assigned,2:skipped')
  assert.strictEqual(r.results[0].proxyId, 2)
  assert.strictEqual(r.skippedNoProxy, 1)
})

// ============ outsiderUsage 边界 ============

t('脏数据：usage 少于本批占用时 outsiderUsage 为负，代理被判「有外人」', () => {
  // usage[1]=0 而本批 2 人都绑它 → outsider = 0-2 = -2 ≠ 0 → 代理出局。
  // 这是保守行为：宁可判为被占用也不复用，符合「不强行复用」的总原则。
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2, { proxyId: 1 })], [P(1)], new Map([[1, 0]]))
  assert.strictEqual(act(r), '1:skipped,2:skipped')
  assert.strictEqual(r.insufficient, true)
})

t('usage 缺 key 时 outsiderUsage 为负 → 判「有外人」（防御性保守行为）', () => {
  // 实测：E1 绑代理1、usage Map 无 key 1 → outsider = 0 - 1 = -1 ≠ 0
  // → 独占判定不成立，E1 被换到代理2。
  // 这是**保守**方向：宁可将已绑定的环境判为「可能被外人占用」而换绑，
  // 也不冒复用同一出口 IP 的关联风险。
  // 当前路由下不可达（computeProxyUsage 用 GROUP BY 统计全团队，
  // 计数恒 ≥ 本批占用数），故此处仅固定语义，不改实现。
  const r = allocateProxies([E(1, { proxyId: 1 })], [P(1), P(2)], new Map())
  assert.strictEqual(act(r), '1:assigned')
  assert.strictEqual(r.results[0].proxyId, 2)
  assert.strictEqual(r.kept, 0)
})

// ============ 过滤与有效期 ============

t('失效代理不进池', () => {
  const r = allocateProxies([E(1)], [P(1, { status: 'invalid' }), P(2)], new Map())
  assert.strictEqual(r.results[0].proxyId, 2)
})

t('过期代理不进池', () => {
  const past = new Date(Date.now() - 86400000)
  const r = allocateProxies([E(1)], [P(1, { expiresAt: past }), P(2)], new Map())
  assert.strictEqual(r.results[0].proxyId, 2)
})

t('expiresAt 恰好等于当前时刻 → 判为过期（边界 <=）', () => {
  // isUsable 是 `> now`，恰好相等时不算可用。
  // 实测确认：用当前时刻构造会被判过期。
  const r = allocateProxies([E(1)], [P(1, { expiresAt: new Date(Date.now()) })], new Map())
  assert.strictEqual(act(r), '1:skipped')
})

t('expiresAt 在未来 → 可用', () => {
  const future = new Date(Date.now() + 86400000)
  const r = allocateProxies([E(1)], [P(1, { expiresAt: future })], new Map())
  assert.strictEqual(act(r), '1:assigned')
})

t('无 expiresAt → 视为永久有效', () => {
  const r = allocateProxies([E(1)], [P(1)], new Map())
  assert.strictEqual(act(r), '1:assigned')
})

t('国家筛选：仅保留匹配项', () => {
  const proxies = [P(1, { country: 'United States' }), P(2, { country: 'Japan' })]
  const r = allocateProxies([E(1), E(2)], proxies, new Map(), { country: 'united' })
  assert.strictEqual(act(r), '1:assigned,2:skipped')
  assert.strictEqual(r.results[0].proxyId, 1)
})

t('类型筛选：精确匹配', () => {
  const proxies = [P(1, { type: 'http' }), P(2, { type: 'socks5' })]
  const r = allocateProxies([E(1)], proxies, new Map(), { type: 'socks5' })
  assert.strictEqual(r.results[0].proxyId, 2)
})

t('筛选条件同样作用于 Phase1 的独占判定', () => {
  // E1 独占代理1（US），但筛选只要 JP → 独占不成立 → 换到合规代理
  const proxies = [P(1, { country: 'United States' }), P(2, { country: 'Japan' })]
  const r = allocateProxies([E(1, { proxyId: 1 })], proxies, new Map([[1, 1]]), { country: 'japan' })
  assert.strictEqual(r.kept, 0)
  assert.strictEqual(r.results[0].proxyId, 2)
})

// ============ 运行中环境 ============

t('运行中的环境一律不改动，标记 skipped', () => {
  const r = allocateProxies([E(1, { status: 'running', proxyId: null })], [P(1)], new Map())
  assert.strictEqual(act(r), '1:skipped')
  assert.strictEqual(r.skippedRunning, 1)
  assert.strictEqual(r.assigned, 0)
  assert.deepStrictEqual(r.updates, [])
})

t('运行中的环境即使已独占代理也不 kept（Phase1 直接跳过它）', () => {
  // Phase1 首行就是 `if (env.status === 'running') continue`，
  // 所以运行中的环境连独占判定都不参与，最终落到 Phase2 的 running 分支。
  const r = allocateProxies([E(1, { status: 'running', proxyId: 1 })], [P(1)], new Map([[1, 1]]))
  assert.strictEqual(act(r), '1:skipped')
  assert.strictEqual(r.kept, 0, '运行中的环境不得记为 kept')
  assert.strictEqual(r.skippedRunning, 1)
})

t('运行中环境不占用池中的代理（不会白占一个）', () => {
  const r = allocateProxies([E(1, { status: 'running' }), E(2)], [P(1)], new Map())
  assert.strictEqual(act(r), '1:skipped,2:assigned')
  assert.strictEqual(r.results[1].proxyId, 1)
})

// ============ 结果字段语义 ============

t('assignedProxyIds 实际含 kept 与 assigned（名字有误导，按真实行为钉住）', () => {
  // 字段名是 assigned，但实现是 Array.from(claimed)——Phase1 锁定的也在内。
  // 该字段目前**无任何读取方**（仅存于前端类型声明），故不改实现、只在此固定语义，
  // 避免将来有人按名字误用。
  const r = allocateProxies([E(1, { proxyId: 1 }), E(2)], [P(1), P(2)], new Map([[1, 1]]))
  assert.deepStrictEqual(r.assignedProxyIds.slice().sort(), [1, 2])
  // 注意：assigned 计数只有 1（E2），但 assignedProxyIds 有 2 个
  assert.strictEqual(r.assigned, 1)
  assert.strictEqual(r.assignedProxyIds.length, 2)
})

t('total 恒等于输入环境数', () => {
  const envs = [E(1), E(2, { status: 'running' }), E(3)]
  const r = allocateProxies(envs, [P(1)], new Map())
  assert.strictEqual(r.total, 3)
  assert.strictEqual(r.results.length, 3)
})

t('insufficient 仅由 skippedNoProxy 决定', () => {
  const a = allocateProxies([E(1), E(2)], [P(1)], new Map())
  assert.strictEqual(a.insufficient, true)
  const b = allocateProxies([E(1), E(2, { status: 'running' })], [P(1)], new Map())
  assert.strictEqual(b.insufficient, false, '运行中跳过不算池不足')
})

t('跳过原因文案区分「运行中」与「池不足」', () => {
  const r = allocateProxies([E(1, { status: 'running' }), E(2)], [], new Map())
  assert.ok(r.results[0].reason.includes('运行中'))
  assert.ok(r.results[1].reason.includes('无可分配'))
})

t('无副作用：不修改输入的 envs / proxies / usage', () => {
  const envs = [E(1, { proxyId: 1 }), E(2)]
  const proxies = [P(1), P(2)]
  const usage = new Map([[1, 1]])
  const snap = () => JSON.stringify({ envs, proxies, usage: [...usage] })
  const before = snap()
  allocateProxies(envs, proxies, usage)
  assert.strictEqual(snap(), before)
})

console.log(`\nproxyAllocator: ${pass} passed, ${fail} failed`)