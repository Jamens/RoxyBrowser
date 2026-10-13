// 抽取 checkConsistency 后的回归验证：
// 1) 体检（传 actual）与原实现逐字一致
// 2) 助手场景（不传 actual）用配置值算，且口径与体检一致
const assert = require('assert')
const { checkConsistency, inconsistentKeys, buildHealthReport, uaOs } = require('../.tmp_hc/shared/healthcheck.js')

let pass = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const fp = (over = {}) => ({
  os: 'windows',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.7521.60 Safari/537.36',
  languages: ['zh-CN', 'zh'],
  timezone: 'Asia/Shanghai',
  ...over
})

// ---------- 体检口径：传 actual ----------
t('传 actual：UA 优先用实测值（实测才是真正生效的那串）', () => {
  const c = checkConsistency(fp(), 'United States', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.7521.60' })
  const ua = c.find((x) => x.key === 'uaVsOs')
  assert.strictEqual(ua.actual, 'windows', '应取实测 UA 的平台')
  assert.strictEqual(ua.ok, true, '实测是 windows、设定也是 windows → 应一致')
})

t('传 actual：语言仍用配置优先（配置才是可控的那份）', () => {
  const c = checkConsistency(fp({ languages: ['en-US'] }), 'United States', { languages: ['zh-CN'] })
  const lang = c.find((x) => x.key === 'langVsTz')
  assert.ok(lang.actual.includes('en-US'), `应取配置里的 en-US：${lang.actual}`)
})

t('不传 actual：全部回落到配置值', () => {
  const c = checkConsistency(fp(), 'United States')
  const ua = c.find((x) => x.key === 'uaVsOs')
  assert.strictEqual(ua.actual, 'mac', '无实测时应取配置 UA 的平台')
  assert.strictEqual(ua.ok, false, '配置 UA 是 mac、设定 windows → 应判不一致')
})

// ---------- 与体检口径一致 ----------
t('同一份数据：体检结果与 checkConsistency 结果逐项一致', () => {
  const f = fp()
  const actual = { userAgent: f.userAgent, languages: f.languages }
  const viaReport = buildHealthReport(f, actual, { proxyCountry: 'United States', audioSeed: 1 }).consistency
  const viaFn = checkConsistency(f, 'United States', actual)
  assert.strictEqual(viaFn.length, viaReport.length)
  for (let i = 0; i < viaReport.length; i++) {
    assert.strictEqual(viaFn[i].key, viaReport[i].key, `第 ${i} 项 key 不一致`)
    assert.strictEqual(viaFn[i].ok, viaReport[i].ok, `${viaReport[i].key} 的 ok 不一致`)
    assert.strictEqual(viaFn[i].expected, viaReport[i].expected, `${viaReport[i].key} 的 expected 不一致`)
    assert.strictEqual(viaFn[i].actual, viaReport[i].actual, `${viaReport[i].key} 的 actual 不一致`)
    assert.strictEqual(Boolean(viaFn[i].skipped), Boolean(viaReport[i].skipped), `${viaReport[i].key} 的 skipped 不一致`)
  }
})

t('跳过语义未被改变：未绑代理 → tzVsProxy 标 skipped 而非判红', () => {
  const c = checkConsistency(fp(), '')
  const tz = c.find((x) => x.key === 'tzVsProxy')
  assert.strictEqual(tz.skipped, true)
  assert.strictEqual(tz.ok, true, 'skipped 项 ok 必须为 true，不能混进「不一致」里')
})

t('跳过语义未被改变：时区不在内置表 → langVsTz 标 skipped', () => {
  const c = checkConsistency(fp({ timezone: 'Europe/Zurich' }), 'United States')
  const lang = c.find((x) => x.key === 'langVsTz')
  assert.strictEqual(lang.skipped, true)
})

// ---------- inconsistentKeys ----------
t('inconsistentKeys：只取未通过且未跳过的 key', () => {
  const c = checkConsistency(fp({ timezone: 'Asia/Shanghai' }), '')
  const keys = inconsistentKeys(c)
  assert.ok(!keys.includes('tzVsProxy'), 'skipped 的不该进来：' + JSON.stringify(keys))
  assert.ok(keys.includes('uaVsOs'), 'UA 不一致应在列表里：' + JSON.stringify(keys))
  assert.ok(!keys.includes('langVsTz'), '上海时区 + zh-CN 语言是一致的')
})

t('inconsistentKeys：全部一致时返回空数组（不凭空造修复项）', () => {
  const c = checkConsistency(fp({ timezone: 'America/New_York', languages: ['en-US'], userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.7521.60' }), 'United States')
  assert.deepStrictEqual(inconsistentKeys(c), [], JSON.stringify(c))
})

// ---------- 边界 ----------
t('空指纹不崩', () => {
  assert.doesNotThrow(() => checkConsistency(null, ''))
  assert.doesNotThrow(() => checkConsistency(undefined, undefined, null))
  assert.strictEqual(checkConsistency(null, '').length, 3)
})

t('缺 languages / timezone 时给出 skipped 而非抛错', () => {
  const c = checkConsistency({ os: 'windows', userAgent: 'x' }, 'United States')
  assert.strictEqual(c.length, 3)
  assert.strictEqual(c.find((x) => x.key === 'langVsTz').skipped, true)
  assert.strictEqual(c.find((x) => x.key === 'tzVsProxy').skipped, true)
})

console.log(`\n${pass} passed, ${process.exitCode ? 1 : 0} failed`)