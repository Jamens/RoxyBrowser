/**
 * 快照导入差异预演（diffSnapshot）离线单测。
 *
 * 为什么这些用例必须严苛：本模块唯一的价值是**如实告诉用户导入会发生什么**。
 * 预览一旦比实际情况乐观，用户就会以为数据完整还原了——而这正是快照
 * 「静默丢数据」缺陷的根源。**说漏比说多说少见得多，但同样有害。**
 *
 * 所以每条用例都在钉死一件事：预演结果必须与 src/main/exporters.ts 的真实导入器
 * （importProxiesStructured / importProfileItems）判定一致。
 */
const assert = require('assert')

const { diffSnapshot } = require('../.tmp_sd/shared/snapshotDiff.js')
const { SNAPSHOT_FORMAT, SNAPSHOT_VERSION } = require('../.tmp_sd/shared/snapshot.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

/** 空团队：没有任何代理 / 分组 / 扩展 */
const EMPTY = { proxies: [], groups: [], extensions: [] }

function snap(over) {
  return Object.assign(
    {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      team: { id: 1, name: 'T1' },
      proxies: [],
      rpa: [],
      extensions: [],
      profiles: []
    },
    over || {}
  )
}

// ============ 代理池段 ============

t('空团队下所有代理都是「将新建」', () => {
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }, { name: 'B', host: '2.2.2.2', port: 1080 }] }),
    EMPTY
  )
  assert.deepStrictEqual(d.proxies.map((x) => x.action), ['create', 'create'])
  assert.strictEqual(d.counts.proxyCreate, 2)
})

t('同名同端点 → 复用现有', () => {
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }] }),
    { ...EMPTY, proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }] }
  )
  assert.strictEqual(d.proxies[0].action, 'reuse')
  assert.strictEqual(d.counts.proxyReuse, 1)
})

t('同名不同 host → conflict，并产出说明', () => {
  // 与真实导入器一致：同名一律跳过、不覆盖，只在 warnings 告知差异
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '9.9.9.9', port: 8080 }] }),
    { ...EMPTY, proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }] }
  )
  assert.strictEqual(d.proxies[0].action, 'conflict')
  assert.strictEqual(d.proxies[0].currentHost, '1.1.1.1')
  assert.strictEqual(d.proxies[0].incomingHost, '9.9.9.9')
  assert.ok(d.notes.some((n) => n.includes('保留现有配置')), '应说明保留现有配置')
})

t('同名不同 port → 也算 conflict', () => {
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: 9999 }] }),
    { ...EMPTY, proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }] }
  )
  assert.strictEqual(d.proxies[0].action, 'conflict')
})

t('端口字符串与数字视为同一端点（避免 8080/"8080" 被误判冲突）', () => {
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: '8080' }] }),
    { ...EMPTY, proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }] }
  )
  assert.strictEqual(d.proxies[0].action, 'reuse')
})

t('缺 name → invalid 并说明', () => {
  const d = diffSnapshot(snap({ proxies: [{ host: '1.1.1.1', port: 80 }] }), EMPTY)
  assert.strictEqual(d.proxies[0].action, 'invalid')
  assert.strictEqual(d.proxies[0].reason, '缺少 name')
})

t('缺 host/port → invalid 并说明', () => {
  const d = diffSnapshot(snap({ proxies: [{ name: 'X' }] }), EMPTY)
  assert.strictEqual(d.proxies[0].action, 'invalid')
  assert.ok(d.proxies[0].reason.includes('host/port'))
  assert.ok(d.notes.some((n) => n.includes('将被跳过')))
})

// ============ 环境段：分组 ============

t('新分组被标记为将新建', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', group: '新组' }] }), EMPTY)
  assert.strictEqual(d.profiles[0].groupWillCreate, true)
  assert.strictEqual(d.counts.groupCreate, 1)
})

t('已有分组标记为复用', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', group: '老组' }] }), { ...EMPTY, groups: ['老组'] })
  assert.strictEqual(d.profiles[0].groupWillCreate, false)
  assert.strictEqual(d.counts.groupCreate, 0)
})

t('同一新分组被多个环境引用只算新建一次（真实导入器也是建一次后复用）', () => {
  const d = diffSnapshot(
    snap({ profiles: [{ name: 'A', group: 'G' }, { name: 'B', group: 'G' }, { name: 'C', group: 'G' }] }),
    EMPTY
  )
  assert.strictEqual(d.counts.groupCreate, 1, '第一个标记新建，后两个应复用')
  assert.deepStrictEqual(d.profiles.map((p) => p.groupWillCreate), [true, false, false])
})

t('无分组时不产生新建计数', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P' }] }), EMPTY)
  assert.strictEqual(d.profiles[0].group, '')
  assert.strictEqual(d.counts.groupCreate, 0)
})

// ============ 环境段：代理引用 ============

t('引用代理池里已有的代理 → reuse', () => {
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }], profiles: [{ name: 'P', proxy: 'A' }] }),
    EMPTY
  )
  assert.strictEqual(d.profiles[0].proxyAction, 'reuse')
})

t('关键：池中新建的代理也算「已存在」——同一次导入内先建池再导环境', () => {
  // 真实流程：importProxiesStructured 先建代理池，importProfileItems 再按名引用。
  // 若预演这里判成 missing，就与实际行为不符（实际能引用到刚建的代理）。
  const d = diffSnapshot(
    snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: 8080 }], profiles: [{ name: 'P', proxy: 'A' }] }),
    EMPTY
  )
  assert.strictEqual(d.profiles[0].proxyAction, 'reuse', '同批次新建的代理应视为可引用')
  assert.strictEqual(d.counts.profileProxyCreate, 0)
})

t('池中无同名、但 profile 自带 proxyDetail → create（兜底新建）', () => {
  const d = diffSnapshot(
    snap({ profiles: [{ name: 'P', proxy: 'B', proxyDetail: { host: '3.3.3.3', port: 8080 } }] }),
    EMPTY
  )
  assert.strictEqual(d.profiles[0].proxyAction, 'create')
  assert.strictEqual(d.counts.profileProxyCreate, 1)
})

t('池中无同名且无 proxyDetail → missing（会导入成无代理环境且不报错）', () => {
  // 这是最该被用户看见的一种情况：环境建出来了，但代理没了
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', proxy: '幽灵代理' }] }), EMPTY)
  assert.strictEqual(d.profiles[0].proxyAction, 'missing')
  assert.ok(
    d.notes.some((n) => n.includes('幽灵代理') && n.includes('无代理')),
    '必须明确告知该环境将没有代理'
  )
})

t('proxyDetail 缺 host 或 port 时不算可新建', () => {
  const d = diffSnapshot(
    snap({ profiles: [{ name: 'P', proxy: 'B', proxyDetail: { host: '3.3.3.3' } }] }),
    EMPTY
  )
  assert.strictEqual(d.profiles[0].proxyAction, 'missing')
})

t('无代理引用的环境 → none', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P' }] }), EMPTY)
  assert.strictEqual(d.profiles[0].proxyAction, 'none')
})

// ============ 环境段：扩展引用 ============

t('扩展在目标团队存在 → found', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', extensions: ['ext1'] }] }), { ...EMPTY, extensions: ['ext1'] })
  assert.strictEqual(d.profiles[0].extensions[0].found, true)
  assert.strictEqual(d.counts.extensionDropped, 0)
})

t('扩展不存在 → found=false 且计入丢弃', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', extensions: ['缺失扩展'] }] }), EMPTY)
  assert.strictEqual(d.profiles[0].extensions[0].found, false)
  assert.strictEqual(d.counts.extensionDropped, 1)
  assert.ok(d.notes.some((n) => n.includes('缺失扩展') && n.includes('丢弃')))
})

t('同一个缺失扩展被多环境引用，说明只出现一次（不刷屏）', () => {
  const d = diffSnapshot(
    snap({ profiles: [
      { name: 'A', extensions: ['X'] },
      { name: 'B', extensions: ['X'] },
      { name: 'C', extensions: ['X'] }
    ] }),
    EMPTY
  )
  assert.strictEqual(d.counts.extensionDropped, 3, '计数按引用条数')
  const noteCount = d.notes.filter((n) => n.includes('扩展「X」')).length
  assert.strictEqual(noteCount, 1, '说明文案应去重，避免同一缺失扩展提示 N 次')
})

// ============ 条目版本 ============

t('条目版本超前被标记并产出说明', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', version: 99 }] }), EMPTY)
  assert.strictEqual(d.profiles[0].versionAhead, true)
  assert.strictEqual(d.counts.versionAhead, 1)
  assert.ok(d.notes.some((n) => n.includes('99') && n.includes('无法还原')))
})

t('条目缺 version 按 1 处理，不误报超前', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P' }] }), EMPTY)
  assert.strictEqual(d.profiles[0].version, 1)
  assert.strictEqual(d.profiles[0].versionAhead, false)
  assert.strictEqual(d.counts.versionAhead, 0)
})

// ============ 版本信息透传 ============

t('migration 参数被透传到结果（来源版本 / 迁移步骤）', () => {
  const d = diffSnapshot(snap(), EMPTY, { from: 1, applied: ['v1 → v2'] })
  assert.strictEqual(d.sourceVersion, 1)
  assert.deepStrictEqual(d.migrations, ['v1 → v2'])
  assert.strictEqual(d.formatVersion, SNAPSHOT_VERSION)
})

t('未传 migration 时来源版本取快照自身版本', () => {
  const d = diffSnapshot(snap(), EMPTY)
  assert.strictEqual(d.sourceVersion, SNAPSHOT_VERSION)
  assert.deepStrictEqual(d.migrations, [])
})

t('来源团队名被带出', () => {
  const d = diffSnapshot(snap({ team: { id: 9, name: '海外团队' } }), EMPTY)
  assert.strictEqual(d.sourceTeam, '海外团队')
  assert.ok(d.notes.some((n) => n.includes('海外团队')))
})

// ============ 计数与鲁棒性 ============

t('counts 各字段与明细一致（UI 只展示计数，错了就误导）', () => {
  const d = diffSnapshot(
    snap({
      proxies: [
        { name: 'A', host: '1.1.1.1', port: 1 },
        { name: 'B', host: '2.2.2.2', port: 2 }
      ],
      rpa: [{ name: 'r1', steps: [] }, { name: 'r2', steps: [] }],
      profiles: [
        { name: 'P1', group: 'G' },
        { name: 'P2', group: 'G', extensions: ['E'] }
      ]
    }),
    { ...EMPTY, proxies: [{ name: 'B', host: '9.9.9.9', port: 2 }] }
  )
  assert.strictEqual(d.counts.proxyCreate, 1)
  assert.strictEqual(d.counts.proxyConflict, 1)
  assert.strictEqual(d.counts.proxyReuse, 0)
  assert.strictEqual(d.counts.groupCreate, 1)
  assert.strictEqual(d.counts.profileTotal, 2)
  assert.strictEqual(d.counts.rpaTotal, 2)
  assert.strictEqual(d.counts.extensionDropped, 1)
  assert.strictEqual(d.proxies.length, 2)
  assert.strictEqual(d.profiles.length, 2)
  assert.deepStrictEqual(d.rpaNames, ['r1', 'r2'])
})

t('空快照不报错，计数全零', () => {
  const d = diffSnapshot(snap(), EMPTY)
  assert.strictEqual(d.counts.profileTotal, 0)
  assert.strictEqual(d.counts.proxyCreate, 0)
  assert.deepStrictEqual(d.proxies, [])
  assert.deepStrictEqual(d.profiles, [])
  // 唯一可能的提示是「来自哪个团队」——这是有用信息而非噪声
  assert.deepStrictEqual(d.notes, ['快照来自团队「T1」，将导入到当前团队（团队成员、角色等不随快照迁移）'])
})

t('缺失的可选段（rpa / extensions）不炸', () => {
  const raw = { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, team: { id: 1, name: 'T' }, profiles: [] }
  const d = diffSnapshot(raw, EMPTY)
  assert.strictEqual(d.counts.rpaTotal, 0)
})

t('环境条目字段缺失/为 null 时鲁棒', () => {
  const d = diffSnapshot(
    snap({ profiles: [null, {}, { name: 'X', group: null, proxy: null, extensions: null }] }),
    EMPTY
  )
  assert.strictEqual(d.profiles.length, 3)
  assert.strictEqual(d.counts.profileTotal, 3)
})

t('extensions 非数组时视为空（不抛异常）', () => {
  const d = diffSnapshot(snap({ profiles: [{ name: 'P', extensions: 'bad' }] }), EMPTY)
  assert.deepStrictEqual(d.profiles[0].extensions, [])
  assert.strictEqual(d.counts.extensionDropped, 0)
})

t('无副作用：不修改传入的快照与 ctx', () => {
  const data = snap({ proxies: [{ name: 'A', host: '1.1.1.1', port: 1 }], profiles: [{ name: 'P', group: 'G' }] })
  const ctx = { proxies: [{ name: 'A', host: '1.1.1.1', port: 1 }], groups: ['G'], extensions: [] }
  const before = JSON.stringify({ data, ctx })
  diffSnapshot(data, ctx)
  assert.strictEqual(JSON.stringify({ data, ctx }), before, 'diffSnapshot 不得修改入参')
})

console.log(`\nsnapshotDiff: ${pass} passed, ${fail} failed`)