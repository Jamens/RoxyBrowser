// 智能助手计划展开（expandActions）离线单测
//
// 重点覆盖 collect（批量汇总）：它是本轮新增的编排方式，
// 且失败模式全是「静默做错」——不多产出动作、或产出 N 条让用户点 N 次，
// 都不会报错，只能靠测试钉住。
const assert = require('assert')
const { expandActions, getPath, resolveRelTime, MAX_COLLECT_IDS } = require('../.tmp_ap/shared/assistantPlan.js')

let pass = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    console.log(`  ❌ ${name}\n${e.message}`)
    process.exitCode = 1
  }
}

const rows = (...ids) => ({ rows: ids.map((id) => ({ _id: id, name: `env-${id}` })) })

// ---------- 兼容旧行为 ----------
t('不带 forEach / collect 的动作原样保留', () => {
  const out = expandActions({ actions: [{ kind: 'openEnv', params: { profileId: 3 } }] }, [])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].kind, 'openEnv')
  assert.strictEqual(out[0].params.profileId, 3)
  assert.strictEqual(out[0].batch, undefined)
  assert.strictEqual(out[0].bulk, undefined)
})

t('forEach 仍是 N 行 → N 条动作', () => {
  const out = expandActions(
    { actions: [{ kind: 'deleteEnv', forEach: { fromQuery: 0, map: { profileId: '_id' } } }] },
    [rows(1, 2, 3)]
  )
  assert.strictEqual(out.length, 3)
  assert.strictEqual(out[0].params.profileId, 1)
  assert.strictEqual(out[2].params.profileId, 3)
  assert.strictEqual(out[0].batch.rowIndex, 0)
  assert.strictEqual(out[2].batch.rowIndex, 2)
})

// ---------- collect：核心 ----------
t('collect 把多行汇总成一条动作，ids 进 profileIds', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchAssignProxy', collect: { fromQuery: 0, collect: 'profileIds' }, params: { proxyId: 7 } }] },
    [rows(11, 12, 13)]
  )
  assert.strictEqual(out.length, 1, '必须只有一条动作，不能退化成 N 条')
  assert.deepStrictEqual(out[0].params.profileIds, [11, 12, 13])
  assert.strictEqual(out[0].params.proxyId, 7, '原有 params 必须保留')
  assert.deepStrictEqual(out[0].bulk, { queryIndex: 0, total: 3 })
  assert.strictEqual(out[0].batch, undefined, 'bulk 与 batch 必须互斥')
})

t('collect 的 label 带上数量', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', label: '删除环境', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [rows(1, 2, 3, 4, 5)]
  )
  assert.strictEqual(out[0].label, '删除环境（5 个）')
})

t('collect 去重：重复行不会让同一环境被改两次', () => {
  const out = expandActions(
    { actions: [{ kind: 'randomizeFingerprints', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [{ rows: [{ _id: 4 }, { _id: 4 }, { _id: 9 }] }]
  )
  assert.deepStrictEqual(out[0].params.profileIds, [4, 9])
  assert.strictEqual(out[0].bulk.total, 2)
})

t('collect 跳过非法 id（0 /负数 / 非整数）', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [{ rows: [{ _id: 3 }, { _id: 0 }, { _id: -2 }, { _id: 1.5 }, { _id: null }] }]
  )
  assert.deepStrictEqual(out[0].params.profileIds, [3])
})

t('collect 退化到裸 id（兼容技能模板里的手写行）', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [{ rows: [{ id: 21 }, { id: 22 }] }]
  )
  assert.deepStrictEqual(out[0].params.profileIds, [21, 22])
})

t('collect 引用空结果 → 不产出任何动作', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [{ rows: [] }]
  )
  assert.strictEqual(out.length, 0, '空结果时必须 0 条，否则会带着空数组去执行')
})

t('collect 引用越界下标 → 不产出任何动作', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', collect: { fromQuery: 5, collect: 'profileIds' } }] },
    [rows(1, 2)]
  )
  assert.strictEqual(out.length, 0)
})

t('collect 全部非法 id → 不产出动作（不能产出 profileIds: []）', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [{ rows: [{ _id: 0 }, { _id: 'abc' }] }]
  )
  assert.strictEqual(out.length, 0)
})

t('collect 超过上限被截断', () => {
  const many = rows(...Array.from({ length: MAX_COLLECT_IDS + 50 }, (_, i) => i + 1))
  const out = expandActions(
    { actions: [{ kind: 'batchDeleteEnvs', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [many]
  )
  assert.strictEqual(out[0].params.profileIds.length, MAX_COLLECT_IDS, '必须截断，不能全量放行')
  assert.strictEqual(out[0].bulk.total, MAX_COLLECT_IDS, 'bulk.total 要报截断后的真实数，不能报原始行数')
})

t('collect 的 target.id 取首个 id 供日志展示', () => {
  const out = expandActions(
    { actions: [{ kind: 'batchAssignProxy', collect: { fromQuery: 0, collect: 'profileIds' } }] },
    [rows(30, 31)]
  )
  assert.strictEqual(out[0].target.id, 30)
})

t('forEach 与 collect 同时存在时以 forEach 为准', () => {
  const out = expandActions(
    {
      actions: [{
        kind: 'deleteEnv',
        forEach: { fromQuery: 0, map: { profileId: '_id' } },
        collect: { fromQuery: 0, collect: 'profileIds' }
      }]
    },
    [rows(1, 2)]
  )
  assert.strictEqual(out.length, 2, 'forEach 优先，不应被 collect 覆盖')
  assert.ok(out[0].batch, '应标记为 batch')
})

t('混合：基动作 + forEach + collect 各自产出正确条数', () => {
  const out = expandActions(
    {
      actions: [
        { kind: 'openEnv', params: { profileId: 1 } },
        { kind: 'deleteProxy', forEach: { fromQuery: 0, map: { proxyId: '_id' } } },
        { kind: 'batchAssignProxy', collect: { fromQuery: 1, collect: 'profileIds' }, params: { proxyId: 9 } }
      ]
    },
    [rows(5, 6), rows(101, 102, 103)]
  )
  assert.strictEqual(out.length, 4)
  assert.deepStrictEqual(out.map((a) => a.kind), ['openEnv', 'deleteProxy', 'deleteProxy', 'batchAssignProxy'])
  assert.deepStrictEqual(out[3].params.profileIds, [101, 102, 103])
  assert.strictEqual(out[3].params.proxyId, 9)
})

t('无 kind 的动作被丢弃', () => {
  assert.strictEqual(expandActions({ actions: [{ params: {} }, { kind: 'openEnv', params: { profileId: 2 } }] }, []).length, 1)
})

// ---------- getPath ----------
t('getPath 支持嵌套与数组下标', () => {
  assert.strictEqual(getPath({ a: { b: [{ c: 7 }] } }, 'a.b.0.c'), 7)
  assert.strictEqual(getPath({ a: 1 }, 'a.b.c'), undefined, '中途为 null 应返回 undefined 而非抛错')
  assert.strictEqual(getPath(null, 'a'), undefined)
})

// ---------- 相对时间 ----------
t('resolveRelTime 解析 @rel:now+7d（返回可直接喂给 SQL 的字符串）', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  // 注意返回的是 ISO 字符串而非 Date：这些值最终进 TypeORM 的 where，
  // 字符串可直接落库，Date 则要驱动层再转换，多一层不确定性
  const r = resolveRelTime('@rel:now+7d', now)
  assert.strictEqual(typeof r, 'string')
  assert.strictEqual(new Date(r).getTime() - now.getTime(), 7 * 24 * 3600 * 1000)
})

t('resolveRelTime 解析对象写法 {__rel}', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const r = resolveRelTime({ __rel: 'now-3d' }, now)
  assert.strictEqual(new Date(r).getTime() - now.getTime(), -3 * 24 * 3600 * 1000)
})

t('resolveRelTime 支持小时单位', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const r = resolveRelTime('@rel:now+12h', now)
  assert.strictEqual(new Date(r).getTime() - now.getTime(), 12 * 3600 * 1000)
})

t('resolveRelTime 数组逐元素解析', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const r = resolveRelTime(['@rel:now', '@rel:now+7d'], now)
  assert.ok(Array.isArray(r))
  assert.strictEqual(new Date(r[1]).getTime() - now.getTime(), 7 * 24 * 3600 * 1000)
})

t('resolveRelTime 非相对标记原样返回', () => {
  assert.strictEqual(resolveRelTime('abc', new Date()), 'abc')
})

console.log(`\n${pass} passed, ${process.exitCode ? 1 : 0} failed`)
