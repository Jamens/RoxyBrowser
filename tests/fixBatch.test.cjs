/**
 * 批量一致性修复预演（planBatchFix / planOne / effectiveKeysFor）离线单测。
 *
 * 核心承诺：**批量对同一个环境的结论，必须与单环境修复完全一致**。
 * 若两边分叉，用户会遇到「单修说能修，批量说修不了」，而真相只是两套判定各说各话。
 * 故本文件有一整节专门做「批量 vs 单环境」的对拍。
 */
const assert = require('assert')

const { planBatchFix, planOne, effectiveKeysFor, batchFixSummary } = require('../.tmp_fb/shared/fixBatch.js')
const { proposeFixes, mergePatches, fixSummary } = require('../.tmp_fb/shared/healthFix.js')
const { checkConsistency } = require('../.tmp_fb/shared/healthcheck.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

/** 未绑代理的一致性检查器（最常见场景） */
const noProxy = (fp) => checkConsistency(fp, '')

const DESKTOP_WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

/** 一个典型的不一致环境：时区上海、绑了美国代理 → 时区该改成美国时区 */
const tzMismatch = () => ({
  id: 1,
  name: '时区不符',
  fingerprint: { timezone: 'Asia/Shanghai', languages: ['zh-CN'], os: 'windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
  proxyCountry: 'United States'
})

// ============ effectiveKeysFor ============

t('effectiveKeysFor：空选择返回全部', () => {
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], []), ['a', 'b', 'c'])
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], null), ['a', 'b', 'c'])
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], undefined), ['a', 'b', 'c'])
})

t('effectiveKeysFor：全选等价于全部（顺序按 allKeys）', () => {
  // 单环境路由的判定是 keys.length === allKeys.length → 用 allKeys。
  // 顺序必须以 allKeys 为准，否则 proposeFixes 的串行推演顺序会变。
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], ['c', 'b', 'a']), ['a', 'b', 'c'])
})

t('effectiveKeysFor：部分选只保留交集，且保持 allKeys 顺序', () => {
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], ['c']), ['c'])
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], ['c', 'a']), ['a', 'c'])
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b'], ['x']), [])
})

t('effectiveKeysFor：与旧内联实现在「非空选」下等价', () => {
  // 单环境路由原本内联：keys.length === allKeys.length ? allKeys : allKeys.filter(k => keys.includes(k))
  // 注意 **空选是刻意不同的**（旧实现返回 []，新的返回全部）——见下面那条专门用例。
  const legacy = (allKeys, keys) => (keys.length === allKeys.length ? allKeys : allKeys.filter((k) => keys.includes(k)))
  const cases = [
    [['a', 'b', 'c'], ['a']],
    [['a', 'b', 'c'], ['a', 'b', 'c']],
    [['a', 'b', 'c'], ['c', 'a']],
    [[], []],
    [['a'], ['a']]
  ]
  for (const [all, sel] of cases) {
    assert.deepStrictEqual(effectiveKeysFor(all, sel), legacy(all, sel), `all=${all} sel=${sel}`)
  }
})

t('effectiveKeysFor：空选语义为「全部」，这是相对旧内联实现的有意变更', () => {
  // 旧内联：keys.length(0) === allKeys.length(3) 不成立 → filter → 返回 []（什么都不修）。
  // 它从未暴露，是因为单环境路由上游有 `if (!keys.length) return 400` 挡住了。
  // 批量预演不该要求用户先勾选不一致项，空选即「预演全部」才有意义。
  const legacy = (allKeys, keys) => (keys.length === allKeys.length ? allKeys : allKeys.filter((k) => keys.includes(k)))
  assert.deepStrictEqual(legacy(['a', 'b', 'c'], []), [], '旧行为是空数组')
  assert.deepStrictEqual(effectiveKeysFor(['a', 'b', 'c'], []), ['a', 'b', 'c'], '新行为是全部')
  // 代价：单环境路由必须保留自己的空选 400 校验，否则会在没传 keys 时意外修全部。
  // 这里无法直接测路由（需 DB），故以断言形式把该约束固定下来。
})

/**
 * 造一个**真正三项一致**的环境。
 * 教训：一开始我只给了 timezone + languages，缺 os / userAgent，
 * 于是 uaVsOs 判为不一致、该环境被正确地判成 blocked ——
 * 结果我误以为是实现有问题。造「应当一致」的用例必须把三项都给全。
 */
const consistentEnv = (id = 2) => ({
  id,
  name: '一致',
  fingerprint: {
    timezone: 'Asia/Shanghai',
    languages: ['zh-CN'],
    os: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    platform: 'Win32'
  }
})

// ============ planOne：跳过条件优先于一切判定 ============

t('运行中的环境被跳过，并说明为什么', () => {
  const r = planOne({ ...tzMismatch(), running: true }, noProxy)
  assert.strictEqual(r.status, 'skipped')
  assert.ok(r.reason.includes('运行'), `原因应提到运行，实际：${r.reason}`)
  assert.deepStrictEqual(r.changes, [])
})

t('已删除的环境被跳过', () => {
  const r = planOne({ ...tzMismatch(), deleted: true }, noProxy)
  assert.strictEqual(r.status, 'skipped')
  assert.ok(r.reason.includes('删除'))
})

t('跳过优先于「本来一致」——已删除的一致环境也该被跳过', () => {
  const r = planOne({ id: 9, name: 'X', fingerprint: { timezone: 'Asia/Shanghai' }, deleted: true }, noProxy)
  assert.strictEqual(r.status, 'skipped')
})

// ============ planOne：一致 / 不可修 / 可修 ============

t('本来就一致的环境：无字段变更', () => {
  const r = planOne(consistentEnv(), noProxy)
  assert.strictEqual(r.status, 'fixable')
  assert.deepStrictEqual(r.changes, [], '三项都一致时不应有任何变更')
  assert.ok(r.summary.includes('无需修复'))
})

t('未绑代理 + 三项自洽的环境：同样无变更', () => {
  // 未绑代理时 tzVsProxy 是 skipped（ok=true），不算不一致
  const r = planOne(consistentEnv(3), noProxy)
  assert.deepStrictEqual(r.changes, [])
})

t('可修：时区改为代理国家对应时区，并给出前后对比', () => {
  const r = planOne(tzMismatch(), (fp, pc) => checkConsistency(fp, pc))
  assert.strictEqual(r.status, 'fixable')
  const tzChange = r.changes.find((c) => c.field === 'timezone')
  assert.ok(tzChange, '应有时区变更')
  assert.strictEqual(tzChange.from, 'Asia/Shanghai')
  assert.ok(tzChange.to && tzChange.to !== 'Asia/Shanghai', '新时区应不同')
})

t('修复时区后新暴露的语言不一致也会一并修（串行推演）', () => {
  // 时区改成美国 → 语言该跟美国走。这条若漏了就是「修完反而多一处不一致」。
  const r = planOne(tzMismatch(), (fp, pc) => checkConsistency(fp, pc))
  const langChange = r.changes.find((c) => c.field === 'languages')
  assert.ok(langChange, '语言应被一并修正，而不是留下新的不一致')
  assert.notStrictEqual(String(langChange.to), 'zh-CN')
})

/** 移动端环境：UA 与 os 一致（android ↔ android），唯一修不了的是 UA 无法合成 */
const androidEnv = (id = 4) => ({
  id,
  name: '移动端',
  fingerprint: {
    timezone: 'Asia/Shanghai',
    languages: ['zh-CN'],
    os: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
  }
})

t('移动端环境三项自洽 → 无变更（不应被当成不一致）', () => {
  const r = planOne(androidEnv(), noProxy)
  assert.deepStrictEqual(r.changes, [], 'UA 与 os 一致时不该报 uaVsOs 不一致')
})

/**
 * 造一个**确实修不了**的环境：目标 OS 是移动端，但 UA 是桌面端。
 * 两次踩坑才想清楚：
 * 1) 一开始用「android UA + os:windows」当不可修用例 —— 错，replaceUaPlatform
 *    支持 android UA → windows（当初为「Mobile Safari 残留」专门处理过），那是可修的。
 * 2) 改成「android UA + os:android」 —— 错，这两项本来就一致，根本不算不一致。
 * 真正的不可修是：**os 是移动端 + UA 是桌面端**。此时 replaceUaPlatform 的
 * target 是 android，函数直接返回 null（无法凭空合成绑定设备型号的 UA）。
 */
const mobileTargetEnv = (id = 4) => ({
  id,
  name: `M${id}`,
  fingerprint: {
    timezone: 'Asia/Shanghai',
    languages: ['zh-CN'],
    os: 'android',
    userAgent: DESKTOP_WIN_UA
  }
})

/** 移动端 UA 与 windows 目标 → 可修（UA 平台段可替换） */
const androidUaWindowsOsEnv = (id = 4) => {
  const base = androidEnv(id)
  return { ...base, fingerprint: { ...base.fingerprint, os: 'windows' } }
}

t('android UA + os:windows → 可修（replaceUaPlatform 支持该方向）', () => {
  // 这条看似反直觉，但它是对的：改 UA 平台段比合成一个移动端 UA 容易得多。
  // 移动端目标才是不可修的那一侧（见下一条）。
  const r = planOne(androidUaWindowsOsEnv(), noProxy)
  assert.strictEqual(r.status, 'fixable')
  const ua = r.changes.find((c) => c.field === 'userAgent')
  assert.ok(ua, 'UA 应被修正')
  assert.ok(!String(ua.to).includes('Mobile Safari'), `替换后不应残留 Mobile Safari，实际：${ua.to}`)
  assert.strictEqual(r.changes.find((c) => c.field === 'platform')?.to, 'Win32')
})

t('目标系统为移动端 → 不可修并说明「需绑定设备型号」', () => {
  const r = planOne(mobileTargetEnv(4), noProxy)
  assert.strictEqual(r.status, 'blocked')
  assert.ok(r.reason.includes('设备型号'), `原因应说明设备型号，实际：${r.reason}`)
  assert.ok(!r.reason.includes('未绑定代理'), '理由必须指向真正不一致的那项，而非 skipped 项')
})

t('完全不修：无任何可修项时状态为 blocked', () => {
  const r = planOne(mobileTargetEnv(5), noProxy)
  assert.strictEqual(r.status, 'blocked')
  assert.strictEqual(r.changes.length, 0)
})

// ============ 与单环境修复对拍（本文件的核心）============

t('批量预演对同一环境，与直接调 proposeFixes 的结果一致', () => {
  const cases = [
    tzMismatch(),
    consistentEnv(6),
    {
      id: 7,
      name: 'UA不符',
      fingerprint: {
        timezone: 'Asia/Shanghai',
        languages: ['zh-CN'],
        os: 'windows',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    },
    androidEnv(8)
  ]
  for (const input of cases) {
    const plan = planOne(input, (fp, pc) => checkConsistency(fp, pc))
    // 单环境路由的算法：checkConsistency → allKeys → effectiveKeysFor → proposeFixes → mergePatches
    const cons = checkConsistency(input.fingerprint, input.proxyCountry || '')
    const allKeys = cons.map((c) => c.key)
    const effective = effectiveKeysFor(allKeys, [])
    const direct = mergePatches(proposeFixes(input.fingerprint, input.proxyCountry || '', effective))
    const planFields = plan.changes.map((c) => c.field).sort()
    const directFields = Object.keys(direct.patch).sort()
    assert.deepStrictEqual(planFields, directFields, `环境「${input.name}」批量与单环境给出的字段不一致`)
    // 值也必须一致
    for (const c of plan.changes) {
      assert.deepStrictEqual(c.to, direct.patch[c.field], `环境「${input.name}」的 ${c.field} 新值不一致`)
    }
  }
})

t('摘要文案与单环境 fixSummary 完全一致', () => {
  const input = tzMismatch()
  const plan = planOne(input, (fp, pc) => checkConsistency(fp, pc))
  const cons = checkConsistency(input.fingerprint, input.proxyCountry)
  const direct = fixSummary(proposeFixes(input.fingerprint, input.proxyCountry, cons.map((c) => c.key)))
  assert.strictEqual(plan.summary, direct)
})

// ============ planBatchFix 汇总 ============

t('混合批次计数正确', () => {
  const plan = planBatchFix(
    [
      tzMismatch(),                                                   // 可修
      { ...tzMismatch(), id: 2, running: true },                      // 跳过
      { ...tzMismatch(), id: 3, deleted: true },                       // 跳过
      consistentEnv(4),                                                 // 已自洽
      mobileTargetEnv(5) // 不可修
    ],
    (fp, pc) => checkConsistency(fp, pc)
  )
  assert.strictEqual(plan.counts.total, 5)
  assert.strictEqual(plan.counts.willChange, 1)
  assert.strictEqual(plan.counts.consistent, 1)
  assert.strictEqual(plan.counts.skipped, 2)
  assert.strictEqual(plan.counts.blocked, 1)
  assert.strictEqual(plan.items.length, 5)
})

t('全部已自洽时给出提示，不静默返回空', () => {
  const plan = planBatchFix([consistentEnv(1), consistentEnv(2)], noProxy)
  assert.strictEqual(plan.counts.willChange, 0)
  assert.ok(plan.notes.some((n) => n.includes('没有任何字段会被修改')), '应明确告知无需执行')
})

t('全部不可修时也给出「无需执行」提示', () => {
  const bad = (id) => mobileTargetEnv(id)
  const plan = planBatchFix([bad(1), bad(2)], noProxy)
  assert.strictEqual(plan.counts.willChange, 0)
  assert.strictEqual(plan.counts.blocked, 2)
  assert.ok(plan.notes.some((n) => n.includes('没有任何字段会被修改')))
})

t('相同原因聚合为一条并带数量（不刷屏）', () => {
  // 必须造真正「不可修」的用例：UA 与 os 不符且是移动端 → 无法合成
  const bad = (id) => ({ ...mobileTargetEnv(id), name: `M${id}` })
  const plan = planBatchFix([bad(1), bad(2), bad(3)], noProxy)
  assert.strictEqual(plan.counts.blocked, 3)
  const related = plan.notes.filter((n) => n.includes('3 个环境'))
  assert.strictEqual(related.length, 1, '相同原因应聚合成一条')
})

t('单个原因也标明数量「1 个环境」', () => {
  const plan = planBatchFix(
    [
      tzMismatch(),
      { ...mobileTargetEnv(2), name: 'M' }
    ],
    (fp, pc) => checkConsistency(fp, pc)
  )
  assert.ok(plan.notes.some((n) => n.includes('1 个环境')), '单条原因应标明数量')
})

t('batchFixSummary 覆盖各类结果', () => {
  const plan = planBatchFix([tzMismatch(), { ...tzMismatch(), id: 2, running: true }], (fp, pc) => checkConsistency(fp, pc))
  const s = batchFixSummary(plan)
  assert.ok(s.includes('将修复 1 个环境'))
  assert.ok(s.includes('跳过'))
})

t('空批次不报错', () => {
  const plan = planBatchFix([], noProxy)
  assert.strictEqual(plan.counts.total, 0)
  assert.strictEqual(plan.items.length, 0)
  assert.strictEqual(batchFixSummary(plan), '没有可修复的环境')
})

t('无副作用：不修改传入对象', () => {
  const input = tzMismatch()
  const before = JSON.stringify(input)
  planBatchFix([input], (fp, pc) => checkConsistency(fp, pc))
  assert.strictEqual(JSON.stringify(input), before)
})

console.log(`\nfixBatch: ${pass} passed, ${fail} failed`)
// ============ 指纹残缺守卫（真机验证发现的严重 bug 的回归测试）============
//
// 背景：`normalizeFingerprint` 对 os 缺失/非法的输入**返回一整套随机指纹**，
// 而修复路径是 `normalizeFingerprint({...before, ...patch})` ——
// 于是 patch 连同 before 一起被丢弃，接口却回报「已修复 timezone/languages」。
// 真机实测过：某环境指纹被裁成 {timezone, languages}，修复后 os/UA/分辨率/字体
// 全变随机值，用户毫无察觉。守卫必须让预演就说「修不了」。

t('残缺指纹（无 os）被判 blocked，不出任何字段变更', () => {
  const r = planOne(
    { id: 1, name: '残缺', fingerprint: { timezone: 'Australia/Sydney' }, proxyCountry: 'United States' },
    (fp, pc) => checkConsistency(fp, pc)
  )
  assert.strictEqual(r.status, 'blocked')
  assert.deepStrictEqual(r.changes, [], '绝不能出变更项，否则执行时会被随机指纹替换')
  assert.ok(r.reason.includes('未设置系统类型'), `原因应说明缺 os，实际：${r.reason}`)
  assert.ok(r.reason.includes('整份指纹被替换为随机值'), '原因必须讲清后果，用户才知道要去补全')
})

t('非法 os（bogus）同样被拦', () => {
  const r = planOne(
    { id: 1, name: '非法os', fingerprint: { os: 'bogus', timezone: 'Asia/Tokyo' } },
    (fp, pc) => checkConsistency(fp, pc)
  )
  assert.strictEqual(r.status, 'blocked')
  assert.ok(r.reason.includes('不是受支持的取值'), `实际：${r.reason}`)
})

t('合法指纹不受守卫影响，仍能正常出方案（防「修过头」）', () => {
  const r = planOne(
    {
      id: 1, name: '正常',
      fingerprint: {
        timezone: 'Australia/Sydney', languages: ['en-AU'], os: 'windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      },
      proxyCountry: 'United States'
    },
    (fp, pc) => checkConsistency(fp, pc)
  )
  assert.strictEqual(r.status, 'fixable')
  assert.strictEqual(r.changes.length, 2, '时区 + 语言两项')
})

t('守卫早于「已自洽」判定：残缺但本来一致的指纹也应报 blocked', () => {
  // 若守卫排在一致性检查之后，残缺指纹会先被判为「一致」而被静默放过——
  // 那正是真机验证前的老问题。
  const r = planOne({ id: 1, name: '残缺但一致', fingerprint: { timezone: 'Asia/Shanghai' } }, noProxy)
  assert.strictEqual(r.status, 'blocked')
})

t('守卫早于「跳过」判定之外：运行中/已删除优先于 blocked', () => {
  // 跳过规则优先级更高：窗口开着时用户首先要知道的是「关窗口」，而不是 os 问题
  const r = planOne({ id: 1, name: 'x', fingerprint: { timezone: 'Asia/Tokyo' }, running: true }, noProxy)
  assert.strictEqual(r.status, 'skipped')
  const d = planOne({ id: 2, name: 'y', fingerprint: { timezone: 'Asia/Tokyo' }, deleted: true }, noProxy)
  assert.strictEqual(d.status, 'skipped')
})

t('批量计数把残缺指纹计入 blocked 而非 consistent', () => {
  const plan = planBatchFix(
    [
      { id: 1, name: '残缺', fingerprint: { timezone: 'Australia/Sydney' }, proxyCountry: 'United States' },
      { id: 2, name: '正常', fingerprint: { timezone: 'Asia/Shanghai', languages: ['zh-CN'], os: 'windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } }
    ],
    (fp, pc) => checkConsistency(fp, pc)
  )
  assert.strictEqual(plan.counts.blocked, 1)
  assert.strictEqual(plan.counts.consistent, 1)
  assert.ok(plan.notes.some((n) => n.includes('系统类型')), `应聚合提示，实际：${plan.notes}`)
})
