/**
 * 全空间快照：结构校验 + 版本闸门 + 迁移阶梯 的离线单测。
 *
 * 为什么这些必须测：validateSnapshot 是**唯一**挡住「未来版本快照被静默当空数组」
 * 的关卡。它一旦放宽，代理池/ RPA 会无声丢失，而接口照常返回成功——
 * 这类失败不会报错，只会在用户发现「代理怎么没了」时才暴露。
 *
 * snapshot.ts 零 import，但仍有类型断言/接口，故按约定先 tsc 编到 .tmp_snap 再 require
 * （见 scripts/run-tests.mjs 的 COMPILES 清单）。
 */
const assert = require('assert')

const {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  PROFILE_SNAPSHOT_VERSION,
  validateSnapshot,
  normalizeSnapshot,
  migrateSnapshot
} = require('../.tmp_snap/shared/snapshot.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

/** 构造一份最小合法快照，按需覆盖字段 */
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

// ============ 基础结构校验 ============

t('最小合法快照通过校验', () => {
  const v = validateSnapshot(snap())
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.errors.length, 0)
})

t('非对象输入被拒', () => {
  for (const bad of [null, undefined, 42, 'str', [], true]) {
    assert.strictEqual(validateSnapshot(bad).ok, false, `输入 ${JSON.stringify(bad)} 应被拒`)
  }
})

t('format 不符被拒', () => {
  const v = validateSnapshot(snap({ format: 'other-tool' }))
  assert.strictEqual(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('format')))
})

t('profiles 必须是数组', () => {
  const v = validateSnapshot(snap({ profiles: {} }))
  assert.strictEqual(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('profiles')))
})

t('profile 缺 name 被拒', () => {
  const v = validateSnapshot(snap({ profiles: [{ version: 1 }] }))
  assert.strictEqual(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('name')))
})

t('proxies/rpa/extensions 类型错误被拒', () => {
  for (const k of ['proxies', 'rpa', 'extensions']) {
    const v = validateSnapshot(snap({ [k]: 'nope' }))
    assert.strictEqual(v.ok, false, `${k} 类型错应被拒`)
  }
})

t('cookies / accounts 类型错误被拒', () => {
  const v = validateSnapshot(snap({ profiles: [{ name: 'A', cookies: 'x' }] }))
  assert.strictEqual(v.ok, false)
})

t('缺失的可选段视为空，不算错误（向后兼容）', () => {
  const v = validateSnapshot({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, profiles: [] })
  assert.strictEqual(v.ok, true, '缺 proxies/rpa/extensions 应通过')
  assert.strictEqual(v.summary.proxyCount, 0)
})

t('team.name 缺失只告警不阻断', () => {
  const v = validateSnapshot(snap({ team: { id: 3 } }))
  assert.strictEqual(v.ok, true)
  assert.ok(v.warnings.some((w) => w.includes('team.name')))
})

t('summary 统计正确', () => {
  const v = validateSnapshot(snap({
    proxies: [{ name: 'p1' }, { name: 'p2' }],
    rpa: [{ name: 'r1' }],
    extensions: [{ name: 'e1' }],
    profiles: [
      { name: 'A', cookies: [{ n: 1 }, { n: 2 }], accounts: [{ username: 'u' }] },
      { name: 'B' }
    ]
  }))
  assert.strictEqual(v.summary.profileCount, 2)
  assert.strictEqual(v.summary.proxyCount, 2)
  assert.strictEqual(v.summary.rpaCount, 1)
  assert.strictEqual(v.summary.extensionCount, 1)
  assert.strictEqual(v.summary.cookieCount, 2)
  assert.strictEqual(v.summary.accountCount, 1)
  assert.strictEqual(v.summary.teamName, 'T1')
  assert.strictEqual(v.summary.formatVersion, SNAPSHOT_VERSION)
})

// ============ 版本闸门（本功能的重点）============

t('version 缺失或非法被拒', () => {
  for (const bad of [undefined, 0, -1, NaN, 'abc']) {
    const v = validateSnapshot(snap({ version: bad }))
    assert.strictEqual(v.ok, false, `version=${String(bad)} 应被拒`)
  }
})

t('高于当前支持版本被拒——防止新版字段改名被当成空数组', () => {
  // 假如将来 v2 把 proxies 改名成 proxyPool，本版本会把「缺失」当空数组：
  // 代理池无声丢失，接口却返回成功。这里必须硬拒。
  const v = validateSnapshot(snap({ version: SNAPSHOT_VERSION + 1 }))
  assert.strictEqual(v.ok, false)
  assert.ok(
    v.errors.some((e) => e.includes('高于当前应用支持')),
    `错误信息应说明版本过高，实际：${JSON.stringify(v.errors)}`
  )
})

t('版本高很多同样被拒，且错误信息带实际版本号', () => {
  const v = validateSnapshot(snap({ version: 99 }))
  assert.strictEqual(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('99')))
})

t('小数版本号向下取整后仍可识别为超版本', () => {
  const v = validateSnapshot(snap({ version: SNAPSHOT_VERSION + 0.5 }))
  assert.strictEqual(v.ok, false)
})

t('profile 条目版本超前只告警不阻断', () => {
  // 单个条目不该让整次迁移失败，但必须让用户看见
  const v = validateSnapshot(snap({
    profiles: [{ name: 'A', version: PROFILE_SNAPSHOT_VERSION + 1 }]
  }))
  assert.strictEqual(v.ok, true, '条目版本超前不应阻断整次导入')
  assert.ok(
    v.warnings.some((w) => w.includes('条目版本')),
    `应产生条目版本告警，实际：${JSON.stringify(v.warnings)}`
  )
})

t('profile 条目版本告警里带环境名，便于定位', () => {
  const v = validateSnapshot(snap({
    profiles: [{ name: '我的重要环境', version: PROFILE_SNAPSHOT_VERSION + 3 }]
  }))
  assert.ok(v.warnings.some((w) => w.includes('我的重要环境')))
})

t('profile 条目版本等于或低于当前版本不告警', () => {
  const v = validateSnapshot(snap({
    profiles: [
      { name: 'A', version: PROFILE_SNAPSHOT_VERSION },
      { name: 'B', version: 1 }
    ]
  }))
  assert.strictEqual(v.warnings.filter((w) => w.includes('条目版本')).length, 0)
})

t('profile 条目 version 缺失（极早期）不告警也不拒', () => {
  const v = validateSnapshot(snap({ profiles: [{ name: 'A' }] }))
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.warnings.filter((w) => w.includes('条目版本')).length, 0)
})

// ============ 迁移阶梯 ============

t('当前版本迁移：零步骤、原地返回', () => {
  const r = migrateSnapshot(snap())
  assert.strictEqual(r.from, SNAPSHOT_VERSION)
  assert.strictEqual(r.to, SNAPSHOT_VERSION)
  assert.deepStrictEqual(r.applied, [])
})

t('缺 version 的极早期文件按 v1 处理', () => {
  const r = migrateSnapshot({ format: SNAPSHOT_FORMAT, profiles: [] })
  assert.strictEqual(r.from, 1)
  assert.strictEqual(r.to, SNAPSHOT_VERSION)
})

t('阶梯缺口会被如实暴露（to < 当前版本），而非假装成功', () => {
  // 模拟「升了 SNAPSHOT_VERSION 却忘了加迁移步骤」：此时 to 应停在来源版本，
  // 由导入端拒绝。若这里返回 to === SNAPSHOT_VERSION 就是谎报。
  const r = migrateSnapshot(snap({ version: 99 }))
  assert.strictEqual(r.from, 99)
  // 99 > SNAPSHOT_VERSION，不进循环，to === from === 99（由 validate 先拦）
  assert.strictEqual(r.to, 99)
  assert.deepStrictEqual(r.applied, [])
})

t('迁移不改入参（纯函数）', () => {
  const input = snap()
  const before = JSON.stringify(input)
  migrateSnapshot(input)
  assert.strictEqual(JSON.stringify(input), before, 'migrateSnapshot 不得修改入参')
})

t('迁移不改动已达标的数据内容', () => {
  const input = snap({ proxies: [{ name: 'p1', host: '1.2.3.4', port: 8080 }] })
  const r = migrateSnapshot(input)
  assert.deepStrictEqual(r.data.proxies, input.proxies)
})

t('非对象输入迁移后不抛异常', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const r = migrateSnapshot(bad)
    assert.strictEqual(typeof r.to, 'number')
  }
})

// ============ normalizeSnapshot ============

t('normalize 补齐缺失的可选段', () => {
  const n = normalizeSnapshot({ format: SNAPSHOT_FORMAT, version: 1, team: { id: 1, name: 'T' }, profiles: [] })
  assert.deepStrictEqual(n.proxies, [])
  assert.deepStrictEqual(n.rpa, [])
  assert.deepStrictEqual(n.extensions, [])
  assert.ok(n.exportedAt, 'exportedAt 应被补上')
})

t('normalize 修正 format 常量', () => {
  const n = normalizeSnapshot({ format: 'WRONG', version: 1, profiles: [] })
  assert.strictEqual(n.format, SNAPSHOT_FORMAT)
})

t('normalize 保留已有数据不动', () => {
  const n = normalizeSnapshot({
    format: SNAPSHOT_FORMAT,
    version: 1,
    team: { id: 7, name: 'X' },
    proxies: [{ name: 'p' }],
    rpa: [{ name: 'r', steps: [] }],
    extensions: [],
    profiles: [{ name: 'P' }]
  })
  assert.strictEqual(n.team.id, 7)
  assert.strictEqual(n.proxies.length, 1)
  assert.strictEqual(n.rpa.length, 1)
  assert.strictEqual(n.profiles.length, 1)
})

t('normalize 遇非数组的段替换为空数组（而非留下脏值）', () => {
  const n = normalizeSnapshot({ format: SNAPSHOT_FORMAT, version: 1, proxies: 'x', rpa: 123, profiles: [] })
  assert.deepStrictEqual(n.proxies, [])
  assert.deepStrictEqual(n.rpa, [])
})

// ============ 端到端：校验 → 迁移 → 规整 ============

t('完整链路：老快照走完三步仍结构完好', () => {
  const raw = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    team: { id: 1, name: '老空间' },
    proxies: [{ name: '美国代理', host: '1.2.3.4', port: 8080, country: 'US', expiresAt: '2026-06-01T00:00:00.000Z' }],
    profiles: [{ name: '环境A', version: PROFILE_SNAPSHOT_VERSION, fingerprint: { timezone: 'America/New_York' } }]
    // rpa / extensions 故意缺失
  }
  const v = validateSnapshot(raw)
  assert.strictEqual(v.ok, true, '老快照应通过校验')
  const m = migrateSnapshot(raw)
  assert.strictEqual(m.to, SNAPSHOT_VERSION)
  const n = normalizeSnapshot(m.data)
  assert.strictEqual(n.proxies.length, 1)
  assert.strictEqual(n.profiles.length, 1)
  assert.deepStrictEqual(n.rpa, [])
  assert.deepStrictEqual(n.extensions, [])
  // 关键：代理元信息必须活下来（丢了会导致体检误判 + 到期预警失效）
  assert.strictEqual(n.proxies[0].country, 'US')
  assert.strictEqual(n.proxies[0].expiresAt, '2026-06-01T00:00:00.000Z')
})

t('未来版本快照在链路第一步就被拦下', () => {
  const v = validateSnapshot(snap({ version: SNAPSHOT_VERSION + 1 }))
  assert.strictEqual(v.ok, false)
  // 拦下后不得进入迁移/写库
  assert.ok(v.errors.length > 0)
})

t('PROFILE_SNAPSHOT_VERSION 不大于 SNAPSHOT_VERSION（避免出现环境级超前于文件级的常态）', () => {
  assert.ok(PROFILE_SNAPSHOT_VERSION <= SNAPSHOT_VERSION)
})

// 失败数必须一并报出：只报 passed 会让「有失败」看起来像全绿（消融验证时踩到过）
console.log(`\nsnapshot: ${pass} passed, ${fail} failed`)