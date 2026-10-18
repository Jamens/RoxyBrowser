/**
 * 时区工具（timezone.ts）离线单测。
 *
 * 该模块此前零测试。它是纯函数但依赖 Intl 时区数据库，
 * 断言全部来自**先跑真实实现确认**，并刻意避开机器相关值：
 * 非法时区名的兜底走 `-date.getTimezoneOffset()`（宿主机偏移），
 * 在不同机器上结果不同，故只断言「不抛异常且返回数值」。
 */
const assert = require('assert')

const T = require('../.tmp_tz/shared/timezone.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

// ============ timeZoneUtcOffsetMinutes ============

t('偏移符号与 Date.getTimezoneOffset 相反（北京 +480）', () => {
  // 注释明确写了这个语义：北京 UTC+8 返回 480
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Asia/Shanghai'), 480)
})

t('纽约冬季 -240（UTC-4 或 UTC-5，随季节）', () => {
  const winter = T.timeZoneUtcOffsetMinutes('America/New_York', new Date(2026, 0, 15))
  const summer = T.timeZoneUtcOffsetMinutes('America/New_York', new Date(2026, 6, 15))
  assert.strictEqual(winter, -300, '1 月应为标准时 UTC-5')
  assert.strictEqual(summer, -240, '7 月应为夏令时 UTC-4')
  assert.ok(summer > winter, '夏令时偏移更大')
})

t('东京全年 +540 且无 DST', () => {
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Asia/Tokyo', new Date(2026, 0, 15)), 540)
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Asia/Tokyo', new Date(2026, 6, 15)), 540)
})

t('加尔各答 +330（半小时偏移）', () => {
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Asia/Kolkata'), 330)
})

t('加德满都 +345（45 分钟偏移）', () => {
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Asia/Kathmandu'), 345)
})

t('非法时区名：不抛异常，回落到宿主机偏移', () => {
  // 兜底是 -date.getTimezoneOffset()，值随机器而变，故只验证不抛 + 是有限数
  const v = T.timeZoneUtcOffsetMinutes('Not/AZone')
  assert.ok(Number.isFinite(v), '应返回有限数')
  assert.strictEqual(v, -new Date().getTimezoneOffset(), '应等于宿主机偏移')
})

// ============ isDaylightSaving ============

t('北半球：纽约 7 月是 DST、1 月不是', () => {
  assert.strictEqual(T.isDaylightSaving('America/New_York', new Date(2026, 6, 15)), true)
  assert.strictEqual(T.isDaylightSaving('America/New_York', new Date(2026, 0, 15)), false)
})

t('南半球：悉尼 1 月是 DST、7 月不是（min 逻辑通用）', () => {
  // 这是最容易错的地方：南半球季节相反，但取「1 月与 7 月偏移的较小者」仍得到标准时
  assert.strictEqual(T.isDaylightSaving('Australia/Sydney', new Date(2026, 0, 15)), true)
  assert.strictEqual(T.isDaylightSaving('Australia/Sydney', new Date(2026, 6, 15)), false)
})

t('南半球 DST 偏移方向：悉尼夏令时 +660、标准时 +600', () => {
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Australia/Sydney', new Date(2026, 0, 15)), 660)
  assert.strictEqual(T.timeZoneUtcOffsetMinutes('Australia/Sydney', new Date(2026, 6, 15)), 600)
})

t('无 DST 时区全年 false', () => {
  assert.strictEqual(T.isDaylightSaving('Asia/Tokyo', new Date(2026, 0, 15)), false)
  assert.strictEqual(T.isDaylightSaving('Asia/Tokyo', new Date(2026, 6, 15)), false)
  assert.strictEqual(T.isDaylightSaving('Asia/Shanghai', new Date(2026, 0, 15)), false)
})

t('非法时区名 DST 判定为 false（不抛异常）', () => {
  assert.strictEqual(T.isDaylightSaving('Not/AZone'), false)
})

t('伦敦：3 月与 10 月边界附近能识别 DST 切换', () => {
  // 只验证「不同季节结果不同」，不断言具体切换日（规则随年可能调整）
  const jan = T.isDaylightSaving('Europe/London', new Date(2026, 0, 15))
  const jul = T.isDaylightSaving('Europe/London', new Date(2026, 6, 15))
  assert.strictEqual(jan, false)
  assert.strictEqual(jul, true)
})

// ============ localHourInTimeZone ============

t('本地小时落在 0-23 且随日期推进', () => {
  // UTC 2026-01-01T16:00:00Z → 北京次日 00:00 → 应归一为 0（而非 24）
  const h = T.localHourInTimeZone('Asia/Shanghai', new Date('2026-01-01T16:00:00Z'))
  assert.strictEqual(h, 0, '午夜应归一为 0，这是 hour12:24 的兜底目的')
})

t('同一时刻不同时区的小时不同', () => {
  const d = new Date('2026-06-15T12:00:00Z')
  const tokyo = T.localHourInTimeZone('Asia/Tokyo', d)
  const ny = T.localHourInTimeZone('America/New_York', d)
  assert.strictEqual(tokyo, 21)
  assert.strictEqual(ny, 8)
  assert.ok(tokyo !== ny)
})

t('非法时区名：不抛异常，回落到宿主机小时', () => {
  const d = new Date('2026-06-15T12:00:00Z')
  const h = T.localHourInTimeZone('Not/AZone', d)
  assert.strictEqual(h, d.getHours())
})

// ============ formatUtcOffset ============

t('零偏移格式化为 UTC+00:00（正号）', () => {
  assert.strictEqual(T.formatUtcOffset(0), 'UTC+00:00')
})

t('正负偏移与分钟补零', () => {
  assert.strictEqual(T.formatUtcOffset(480), 'UTC+08:00')
  assert.strictEqual(T.formatUtcOffset(330), 'UTC+05:30')
  assert.strictEqual(T.formatUtcOffset(345), 'UTC+05:45')
  assert.strictEqual(T.formatUtcOffset(-240), 'UTC-04:00')
  assert.strictEqual(T.formatUtcOffset(-45), 'UTC-00:45')
})

t('超过整时的偏移（+9:30）', () => {
  assert.strictEqual(T.formatUtcOffset(570), 'UTC+09:30')
})

t('大偏移不越界（+14:00 为实际最大）', () => {
  assert.strictEqual(T.formatUtcOffset(840), 'UTC+14:00')
})

// ============ formatTimeInZone ============

t('格式化为 HH:mm 且补零', () => {
  const d = new Date('2026-06-15T12:00:00Z')
  assert.strictEqual(T.formatTimeInZone('Asia/Tokyo', d), '21:00')
  assert.strictEqual(T.formatTimeInZone('Asia/Shanghai', d), '20:00')
})

t('个位小时补零', () => {
  // UTC 00:30 → 东京 09:30
  assert.strictEqual(T.formatTimeInZone('Asia/Tokyo', new Date('2026-06-15T00:30:00Z')), '09:30')
})

t('非法时区名返回 --:-- 而非抛异常', () => {
  assert.strictEqual(T.formatTimeInZone('Not/AZone'), '--:--')
})

// ============ formatDateTimeInZone ============

t('按目标时区格式化完整日期时间（含秒）', () => {
  assert.strictEqual(
    T.formatDateTimeInZone('2026-01-02T03:04:05Z', 'Asia/Tokyo'),
    '2026-01-02 12:04:05'
  )
  assert.strictEqual(
    T.formatDateTimeInZone('2026-01-02T03:04:05Z', 'America/New_York'),
    '2026-01-01 22:04:05'
  )
})

t('withSeconds=false 时省略秒', () => {
  assert.strictEqual(
    T.formatDateTimeInZone('2026-01-02T03:04:05Z', 'Asia/Tokyo', false),
    '2026-01-02 12:04'
  )
})

t('跨年边界正确（UTC 23:00 → 目标次日）', () => {
  assert.strictEqual(
    T.formatDateTimeInZone('2026-12-31T23:00:00Z', 'Asia/Tokyo'),
    '2027-01-01 08:00:00'
  )
})

t('非法日期串原样返回（不输出 Invalid Date）', () => {
  assert.strictEqual(T.formatDateTimeInZone('not-a-date', 'Asia/Tokyo'), 'not-a-date')
})

t('空串原样返回', () => {
  assert.strictEqual(T.formatDateTimeInZone('', 'Asia/Tokyo'), '')
})

t('非法时区名时返回原始 ISO 串', () => {
  assert.strictEqual(T.formatDateTimeInZone('2026-01-02T03:04:05Z', 'Not/AZone'), '2026-01-02T03:04:05Z')
})

// ============ describeTimeZone ============

t('一次性返回全部展示字段', () => {
  const d = T.describeTimeZone('Asia/Tokyo', new Date('2026-06-15T12:00:00Z'))
  assert.strictEqual(d.offset, 540)
  assert.strictEqual(d.offsetText, 'UTC+09:00')
  assert.strictEqual(d.localTime, '21:00')
  assert.strictEqual(d.dst, false)
})

t('offsetText 与 offset 自洽', () => {
  for (const tz of ['Asia/Shanghai', 'Asia/Kolkata', 'America/New_York', 'Europe/London']) {
    const d = T.describeTimeZone(tz)
    assert.ok(d.offsetText.startsWith('UTC'), `${tz} 应有 UTC 前缀`)
    assert.ok(d.offsetText === T.formatUtcOffset(d.offset), `${tz} 的 offsetText 应与 offset 自洽`)
  }
})

t('describeTimeZone 的 dst 与单独调用 isDaylightSaving 一致', () => {
  const dt = new Date(2026, 6, 15)
  for (const tz of ['America/New_York', 'Australia/Sydney', 'Asia/Tokyo', 'Europe/London']) {
    assert.strictEqual(
      T.describeTimeZone(tz, dt).dst,
      T.isDaylightSaving(tz, dt),
      `${tz} 的 dst 应一致`
    )
  }
})

console.log(`\ntimezone: ${pass} passed, ${fail} failed`)