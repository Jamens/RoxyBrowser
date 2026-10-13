// 到期预警判定（scanExpiring）离线单测
// 重点覆盖三类易错：不误报、不重复报、边界清晰
const assert = require('assert')
const { scanExpiring, daysUntil, parseExpiry, expiryAlertText, expiryWarnKey } =
  require('../.tmp_xa/shared/expiryAlert.js')

let pass = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`)
    process.exitCode = 1
  }
}

const NOW = new Date('2026-06-01T00:00:00Z')
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString()
const item = (id, days, over = {}) => ({ id, teamId: 1, name: `X${id}`, expiresAt: inDays(days), ...over })

// ---------- parseExpiry ----------
t('parseExpiry：合法 Date / ISO 字符串都能解析', () => {
  assert.strictEqual(parseExpiry(NOW), NOW.getTime())
  assert.strictEqual(parseExpiry(NOW.toISOString()), NOW.getTime())
})

t('parseExpiry：空 / null / undefined / 空串 → null', () => {
  for (const v of [null, undefined, '', '   ']) assert.strictEqual(parseExpiry(v), null)
})

t('parseExpiry：非法字符串 → null（不误判为 epoch）', () => {
  // 这一条是重点：new Date('abc') 是 Invalid Date，但 new Date(null) 是 1970 epoch
  assert.strictEqual(parseExpiry('abc'), null)
  assert.strictEqual(parseExpiry('2026-13-45T99:99:99Z'), null)
})

t('parseExpiry：null 绝不能被当成 1970 年（否则天天误报「过期 20000 天」）', () => {
  assert.notStrictEqual(parseExpiry(null), 0)
  assert.strictEqual(parseExpiry(null), null)
})

// ---------- daysUntil ----------
t('daysUntil：正数=还剩几天，负数=已过期几天', () => {
  assert.strictEqual(daysUntil(inDays(3), NOW), 3)
  assert.strictEqual(daysUntil(inDays(-2), NOW), -2)
  assert.strictEqual(daysUntil(inDays(0), NOW), 0)
})

t('daysUntil：无到期时间返回 null（不是 0，避免与「今天到期」混淆）', () => {
  assert.strictEqual(daysUntil(null, NOW), null)
  assert.strictEqual(daysUntil('', NOW), null)
})

t('daysUntil：剩 23 小时算 1 天（ceil，不用 floor 提前一天报警）', () => {
  const soon = new Date(NOW.getTime() + 23 * 3600 * 1000).toISOString()
  assert.strictEqual(daysUntil(soon, NOW), 1)
})

// ---------- scanExpiring：基本判定 ----------
t('scanExpiring：阈值内的进预警，超出的不进', () => {
  const r = scanExpiring({ items: [item(1, 3), item(2, 30)], thresholdDays: 7, now: NOW })
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, 1)
  assert.strictEqual(r[0].daysLeft, 3)
  assert.strictEqual(r[0].level, 'expiring')
})

t('scanExpiring：已过期单独标记 level=expired', () => {
  const r = scanExpiring({ items: [item(1, -5)], thresholdDays: 7, now: NOW })
  assert.strictEqual(r[0].level, 'expired')
  assert.strictEqual(r[0].daysLeft, -5)
})

t('scanExpiring：边界——恰好等于阈值算「即将到期」（≤ 而非 <）', () => {
  const r = scanExpiring({ items: [item(1, 7)], thresholdDays: 7, now: NOW })
  assert.strictEqual(r.length, 1, '刚好 7 天应算在内')
})

t('scanExpiring：超出阈值 1 天不进', () => {
  const r = scanExpiring({ items: [item(1, 8)], thresholdDays: 7, now: NOW })
  assert.strictEqual(r.length, 0)
})

t('scanExpiring：无到期时间的条目被跳过（长期有效不该报警）', () => {
  const r = scanExpiring({
    items: [
      { id: 1, teamId: 1, name: 'A', expiresAt: null },
      { id: 2, teamId: 1, name: 'B', expiresAt: undefined },
      { id: 3, teamId: 1, name: 'C', expiresAt: '' },
      { id: 4, teamId: 1, name: 'D', expiresAt: '乱码' }
    ],
    thresholdDays: 7,
    now: NOW
  })
  assert.strictEqual(r.length, 0)
})

t('scanExpiring：空列表 / 空 threshold 安全', () => {
  assert.deepStrictEqual(scanExpiring({ items: [], thresholdDays: 7, now: NOW }), [])
  assert.strictEqual(scanExpiring({ items: null, thresholdDays: 7, now: NOW }).length, 0)
})

// ---------- 去重（防重复刷屏） ----------
t('scanExpiring：已预警过的同一到期项不再报第二次', () => {
  const warned = new Map()
  const items = [item(1, 3)]
  const first = scanExpiring({ items, thresholdDays: 7, now: NOW, warned })
  assert.strictEqual(first.length, 1)
  for (const a of first) warned.set(expiryWarnKey(a.id, a.expiresAt), a.expiresAt)
  const second = scanExpiring({ items, thresholdDays: 7, now: NOW, warned })
  assert.strictEqual(second.length, 0, '没改到期时间就不该再报')
})

t('scanExpiring：改了到期时间 → 重新预警（key 含 expiresAt）', () => {
  const warned = new Map()
  const a1 = item(1, 3)
  const first = scanExpiring({ items: [a1], thresholdDays: 7, now: NOW, warned })
  for (const a of first) warned.set(expiryWarnKey(a.id, a.expiresAt), a.expiresAt)
  // 用户把到期时间往后延了
  const a2 = item(1, 60)
  const second = scanExpiring({ items: [a2], thresholdDays: 7, now: NOW, warned })
  assert.strictEqual(second.length, 0, '延到 60 天后本就不在阈值内')
  // 用户又改回 3 天后 → key 变化，应重新预警
  const a3 = item(1, 5)
  const third = scanExpiring({ items: [a3], thresholdDays: 7, now: NOW, warned })
  assert.strictEqual(third.length, 1, '改回临期应能再次预警')
})

t('scanExpiring：不传 warned 时每次都报（无状态可用，属正常降级）', () => {
  const items = [item(1, 3)]
  assert.strictEqual(scanExpiring({ items, thresholdDays: 7, now: NOW }).length, 1)
  assert.strictEqual(scanExpiring({ items, thresholdDays: 7, now: NOW }).length, 1)
})

// ---------- 排序 ----------
t('scanExpiring：按剩余天数升序（最紧急的排最前）', () => {
  const r = scanExpiring({ items: [item(1, 5), item(2, -3), item(3, 1)], thresholdDays: 7, now: NOW })
  assert.deepStrictEqual(r.map((x) => x.daysLeft), [-3, 1, 5])
})

t('scanExpiring：同时包含已过期与即将到期时，过期的排前面', () => {
  const r = scanExpiring({ items: [item(1, 2), item(2, -10)], thresholdDays: 7, now: NOW })
  assert.strictEqual(r[0].level, 'expired')
  assert.strictEqual(r[r.length - 1].level, 'expiring')
})

// ---------- teamId 透传（按团队推 webhook / 写日志要用） ----------
t('scanExpiring：原样透传 teamId，不丢归属', () => {
  const r = scanExpiring({
    items: [{ id: 9, teamId: 42, name: 'Z', expiresAt: inDays(1) }],
    thresholdDays: 7,
    now: NOW
  })
  assert.strictEqual(r[0].teamId, 42)
  assert.strictEqual(r[0].name, 'Z')
})

// ---------- 文案 ----------
t('expiryAlertText：区分已过期与即将到期', () => {
  const r = scanExpiring({ items: [item(1, -2), item(2, 3)], thresholdDays: 7, now: NOW })
  const txt = expiryAlertText('代理', r)
  assert.ok(txt.includes('已过期'), txt)
  assert.ok(txt.includes('即将到期') || txt.includes('天内将到期'), txt)
  assert.ok(txt.startsWith('代理到期预警'), txt)
})

t('expiryAlertText：空列表返回空串（不产生「代理到期预警：」这种空话）', () => {
  assert.strictEqual(expiryAlertText('代理', []), '')
})

t('expiryAlertText：天数写的是真实剩余天数，不是条数', () => {
  // 回归用例：曾把 ${expiring.length} 误用作「天数」，导致
  // 「1 个代理还剩 3 天」被写成「1 天内将到期 1 个」，读起来像只剩 1 天
  const r = scanExpiring({ items: [item(1, 3)], thresholdDays: 7, now: NOW })
  const txt = expiryAlertText('代理', r)
  assert.ok(txt.includes('3 天'), `应含「3 天」：${txt}`)
  assert.ok(!txt.includes('1 天内'), `不该把条数当天数：${txt}`)
})

t('expiryAlertText：多个临期时天数取最短的那条', () => {
  const r = scanExpiring({ items: [item(1, 5), item(2, 2)], thresholdDays: 7, now: NOW })
  const txt = expiryAlertText('代理', r)
  assert.ok(txt.includes('2 天'), `应含最短的 2 天：${txt}`)
  assert.ok(txt.includes('X2（最紧急）'), txt)  // 最短的那条标注为最紧急
})

t('expiryAlertText：当天到期的写「今天」而不是「0 天」', () => {
  const r = scanExpiring({ items: [item(1, 0)], thresholdDays: 7, now: NOW })
  const txt = expiryAlertText('代理', r)
  assert.ok(txt.includes('今天'), txt)
  assert.ok(!txt.includes('0 天'), txt)
})

t('expiryAlertText：超过 5 个时截断名称并给总数（避免日志刷屏）', () => {
  const items = Array.from({ length: 9 }, (_, i) => item(i + 1, 2))
  const r = scanExpiring({ items, thresholdDays: 7, now: NOW })
  const txt = expiryAlertText('代理', r)
  assert.ok(txt.includes('9 个'), txt)
  assert.ok(!txt.includes('X9'), '第 6 个之后的名称不应全部列出')
})

console.log(`\n${pass} passed, ${process.exitCode ? 1 : 0} failed`)
