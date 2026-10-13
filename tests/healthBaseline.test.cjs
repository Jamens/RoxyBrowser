// 体检基线对比（diffBaseline）离线单测
// 重点：不能误报。单点失败、小样本、真实世界波动都**不应**触发告警
const assert = require('assert')
const {
  diffBaseline, regressedItems, regressedText, MIN_SAMPLES, REGRESS_DELTA
} = require('../.tmp_hb/shared/healthBaseline.js')

let pass = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

// 造一份基线：10 个环境，8 通过 2 失败 → 通过率 80%
const bl = (items, extra = {}) => ({ savedAt: '2026-06-01T00:00:00Z', probed: 10, avgScore: 90, items, ...extra })
const BASE = bl({ ua: { passed: 8, failed: 2, na: 0 }, timezone: { passed: 10, failed: 0, na: 0 } })

// ---------- 基本判定 ----------
t('首次体检（无基线）不产生任何对比结论', () => {
  const d = diffBaseline(null, { ua: { passed: 5, failed: 5, na: 0 } })
  assert.deepStrictEqual(d, [], '没有可比对象时不该凭空判定')
})

t('通过率不变 → 不判回归', () => {
  // 基线含 ua + timezone 两项，本次只跑 ua：并集出 2 条（timezone 记为样本 0），
  // 按 key 取 ua 断言即可 —— 「消失的项也列出」是刻意设计，不是 bug
  const d = diffBaseline(BASE, { ua: { passed: 8, failed: 2, na: 0 } })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.regressed, false)
  assert.strictEqual(ua.delta, 0)
})

t('大幅下滑（80% → 20%）→ 判回归', () => {
  const d = diffBaseline(BASE, { ua: { passed: 2, failed: 8, na: 0 } })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.regressed, true)
  assert.strictEqual(Math.round(ua.delta * 100), -60)
})

t('改善（失败 2 → 0）不判回归', () => {
  const d = diffBaseline(BASE, { ua: { passed: 10, failed: 0, na: 0 } })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.regressed, false)
  assert.ok(ua.delta > 0)
})

// ---------- 防噪音：这是重点 ----------
t('单点失败（1/1 全挂）不判回归 —— 小样本噪音', () => {
  const d = diffBaseline(BASE, { ua: { passed: 0, failed: 1, na: 0 } })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.regressed, false, '1 个环境挂了就告警 = 纯噪音')
  assert.ok(ua.skipReason && ua.skipReason.includes('样本不足'), ua.skipReason)
})

t('样本恰好等于 MIN_SAMPLES 时才参与判定', () => {
  const d = diffBaseline(BASE, { ua: { passed: 1, failed: 4, na: 0 } }, { minSamples: 5, regressDelta: 0.2 })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.sample, 5)
  assert.strictEqual(ua.regressed, true, '5 个样本 20% 通过率相对基线 80% 应判回归')
})

t('微小波动（跌 1~2 个百分点）不判回归', () => {
  // 100 个样本里失败 2 → 3：通过率 98% → 97%，跌 1 个点
  const big = bl({ ua: { passed: 98, failed: 2, na: 0 } })
  const d = diffBaseline(big, { ua: { passed: 97, failed: 3, na: 0 } })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.regressed, false, '真实世界的随机波动不该天天报警')
})

t('上次该项无适用样本 → 明确跳过而非判为「100% → 低」回归', () => {
  const base = bl({ onlyNa: { passed: 0, failed: 0, na: 5 } })
  const d = diffBaseline(base, { onlyNa: { passed: 0, failed: 8, na: 0 } })
  const k = d.find((x) => x.key === 'onlyNa')
  assert.strictEqual(k.regressed, false)
  assert.ok(k.skipReason && k.skipReason.includes('无适用样本'), k.skipReason)
})

t('本次该项全部不适用（na）→ 样本不足，不判回归', () => {
  const d = diffBaseline(BASE, { ua: { passed: 0, failed: 0, na: 10 } })
  const ua = d.find((x) => x.key === 'ua')
  assert.strictEqual(ua.regressed, false)
  assert.ok(ua.skipReason, '应说明是样本不足而非静默')
})

t('门槛可覆盖（regressDelta 放宽 / 收紧）', () => {
  const base = bl({ ua: { passed: 80, failed: 20, na: 0 } })
  const cur = { ua: { passed: 70, failed: 30, na: 0 } }
  assert.strictEqual(diffBaseline(base, cur, { regressDelta: 0.05 })[0].regressed, true, '收紧到 5pp 应判回归')
  assert.strictEqual(diffBaseline(base, cur, { regressDelta: 0.3 })[0].regressed, false, '放宽到 30pp 不应判')
})

// ---------- 新增 / 消失的检查项 ----------
t('本次新增的检查项（上次没有）不判回归', () => {
  const d = diffBaseline(BASE, { ua: { passed: 8, failed: 2, na: 0 }, newItem: { passed: 0, failed: 10, na: 0 } })
  const n = d.find((x) => x.key === 'newItem')
  assert.strictEqual(n.regressed, false, '新加的检查项第一次跑就全挂，不该报「回归」——那是「未验证」不是「变差」')
  assert.ok(n.skipReason, n.skipReason)
})

t('上次有本次没跑的检查项也被列出（数据可比性提醒）', () => {
  const d = diffBaseline(BASE, { ua: { passed: 8, failed: 2, na: 0 } })
  const tz = d.find((x) => x.key === 'timezone')
  assert.ok(tz, '消失的检查项应出现在结果里')
  assert.strictEqual(tz.sample, 0)
})

// ---------- 排序 ----------
t('回归项排最前，其次按降幅从大到小', () => {
  const base = bl({
    a: { passed: 8, failed: 2, na: 0 },   // → 会回归
    b: { passed: 9, failed: 1, na: 0 },   // 小幅改善
    c: { passed: 8, failed: 2, na: 0 },   // 也会回归
    d: { passed: 6, failed: 4, na: 0 },   // 会回归
  })
  const cur = {
    a: { passed: 1, failed: 9, na: 0 },   // -70pp
    b: { passed: 10, failed: 0, na: 0 },  // +10pp
    c: { passed: 5, failed: 5, na: 0 },   // -30pp
    d: { passed: 3, failed: 7, na: 0 },   // -50pp
  }
  const d = diffBaseline(base, cur)
  assert.strictEqual(d[0].regressed, true, '第一个必须是回归项')
  const regressed = regressedItems(d).map((x) => x.key)
  // 基线均为 80%：a→10%(-70)、c→50%(-30)、d→30%(-50)，故 a、d、c
  // 降幅：a -70pp、c -30pp、d -30pp；c 与 d 持平，按 key 字典序 c 在前
  assert.deepStrictEqual(regressed, ['a', 'c', 'd'], '回归项内按降幅从大到小')
  assert.deepStrictEqual(d.map((x) => x.key), ['a', 'c', 'd', 'b'], '整体：回归在前，改善在后')
  assert.ok(d.find((x) => x.key === 'b'), '改善项也要列出（让用户知道在变好）')
})

// ---------- 并列项顺序：必须是契约，不能靠 sort 的稳定性兜 ----------
t('并列项（delta 相同）按 key 字典序，不随输入键序漂移', () => {
  // 回归用例：原先只写 `a.delta - b.delta`，并列时返回 0，顺序取决于
  // Object.keys 的插入顺序 + V8 排序稳定性。实测 15 项并列时顺序会随输入键序漂移，
  // 表现为告警顺序随机跳动、用户误以为是误报。
  const items = {}
  const cur = {}
  for (let i = 0; i < 15; i++) {
    items[`k${i}`] = { passed: 8, failed: 2, na: 0 }
    cur[`k${i}`] = { passed: 5, failed: 5, na: 0 } // 全部 -30pp，完全并列
  }
  const mk = (obj) => ({ savedAt: '', probed: 10, avgScore: 90, items: obj })

  const forward = diffBaseline(mk(items), cur).map((x) => x.key)
  const reversed = {}
  Object.keys(items).reverse().forEach((k) => { reversed[k] = items[k] })
  const backward = diffBaseline(mk(reversed), cur).map((x) => x.key)

  assert.deepStrictEqual(forward, backward, '仅键书写顺序不同，输出却不同 → 顺序依赖输入顺序')
  assert.deepStrictEqual(forward, [...forward].sort(), '并列项应按 key 字典序排列')
})

t('小样本量的并列项同样按 key 排序（≤10 项也走同一规则）', () => {
  const items = { b: { passed: 8, failed: 2, na: 0 }, a: { passed: 8, failed: 2, na: 0 }, c: { passed: 8, failed: 2, na: 0 } }
  const cur = { a: { passed: 0, failed: 10, na: 0 }, b: { passed: 0, failed: 10, na: 0 }, c: { passed: 0, failed: 10, na: 0 } }
  const d = diffBaseline({ savedAt: '', probed: 10, avgScore: 90, items }, cur)
  assert.deepStrictEqual(d.map((x) => x.key), ['a', 'b', 'c'])
})

t('delta 不同时仍按降幅排序（tie-breaker 不影响主序）', () => {
  const base = bl({ a: { passed: 8, failed: 2, na: 0 }, b: { passed: 8, failed: 2, na: 0 } })
  const cur = { a: { passed: 3, failed: 7, na: 0 }, b: { passed: 6, failed: 4, na: 0 } } // a -50pp, b -20pp
  const d = diffBaseline(base, cur)
  assert.deepStrictEqual(d.map((x) => x.key), ['a', 'b'], '降幅大的必须在前，与 key 无关')
})

// ---------- 文案 ----------
t('regressedText：无回归时返回空串', () => {
  assert.strictEqual(regressedText(diffBaseline(BASE, { ua: { passed: 8, failed: 2, na: 0 } })), '')
})

t('regressedText：含通过率变化与样本量', () => {
  const d = diffBaseline(BASE, { ua: { passed: 1, failed: 9, na: 0 } })
  const txt = regressedText(d, (k) => (k === 'ua' ? 'UA 平台' : k))
  assert.ok(txt.includes('体检基线回归'), txt)
  assert.ok(txt.includes('UA 平台'), txt)
  assert.ok(txt.includes('80% → 10%'), txt)
  assert.ok(txt.includes('10 个环境'), txt)
})

t('regressedText：超过 4 项只列前 4 并给总数', () => {
  const items = {}
  const cur = {}
  for (let i = 0; i < 7; i++) {
    items[`k${i}`] = { passed: 9, failed: 1, na: 0 }
    cur[`k${i}`] = { passed: 0, failed: 10, na: 0 }
  }
  const txt = regressedText(diffBaseline(bl(items), cur))
  assert.ok(txt.includes('另有 3 项'), txt)
})

t('regressedText：不使用「检测到指纹异常」这类易误解措辞', () => {
  const d = diffBaseline(BASE, { ua: { passed: 0, failed: 10, na: 0 } })
  const txt = regressedText(d)
  assert.ok(!txt.includes('检测到'), `文案不该暗示检测站判定：${txt}`)
  assert.ok(txt.includes('基线'), txt)
})

// ---------- 常量 ----------
t('默认门槛常量符合预期', () => {
  assert.strictEqual(MIN_SAMPLES, 5)
  assert.strictEqual(REGRESS_DELTA, 0.25)
})

console.log(`\n${pass} passed, ${process.exitCode ? 1 : 0} failed`)