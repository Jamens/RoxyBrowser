// 体检一致性一键修复（proposeFixes）离线单测
// 核心校验：修完之后 uaOs 判定必须真的通过，而不是「改了但还是错」
const assert = require('assert')
const { proposeFixes, mergePatches, fixSummary } = require('../.tmp_hf/shared/healthFix.js')
const { uaOs } = require('../.tmp_hf/shared/healthcheck.js')
const { buildHealthReport } = require('../.tmp_hf/shared/healthcheck.js')

let pass = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

const fp = (over = {}) => ({
  os: 'windows',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.7521.60 Safari/537.36',
  platform: 'MacIntel',
  languages: ['zh-CN', 'zh', 'en'],
  timezone: 'Asia/Shanghai',
  tzOffset: -480,
  ...over
})

// ---------- 1) 时区 ↔ 代理：以代理为锚 ----------
t('时区不匹配代理 → 改时区（不改代理）', () => {
  const r = proposeFixes(fp(), 'United States', ['tzVsProxy'])
  const p = r.find((x) => x.key === 'tzVsProxy')
  assert.strictEqual(p.fixable, true)
  assert.strictEqual(p.patch.timezone, 'America/New_York', '应改为代理国家对应时区')
  assert.strictEqual(p.patch.proxyId, undefined, '绝不能动 proxyId')
  assert.deepStrictEqual(p.fields, ['timezone'])
})

t('代理国家用中文名 / 国码也能解析', () => {
  for (const c of ['美国', 'US', 'United States']) {
    const r = proposeFixes(fp(), c, ['tzVsProxy'])
    const p = r.find((x) => x.key === 'tzVsProxy')
    assert.strictEqual(p.fixable, true, `${c} 应可解析`)
    assert.strictEqual(p.patch.timezone, 'America/New_York')
  }
})

t('未绑代理 → 不可修且说明原因', () => {
  const r = proposeFixes(fp(), '', ['tzVsProxy'])
  const p = r.find((x) => x.key === 'tzVsProxy')
  assert.strictEqual(p.fixable, false)
  assert.ok(p.reason.includes('未绑定代理'), p.reason)
})

t('代理国家不在内置表 → 不可修且如实说明（不瞎猜时区）', () => {
  const r = proposeFixes(fp(), 'Kazakhstan', ['tzVsProxy'])
  const p = r.find((x) => x.key === 'tzVsProxy')
  assert.strictEqual(p.fixable, false, '不该给一个猜出来的时区')
  assert.ok(p.reason.includes('Kazakhstan'), p.reason)
})

t('时区已是代理国家对应值 → 不可修并提示可能是代理数据有误', () => {
  const r = proposeFixes(fp({ timezone: 'America/New_York' }), 'United States', ['tzVsProxy'])
  const p = r.find((x) => x.key === 'tzVsProxy')
  assert.strictEqual(p.fixable, false)
  assert.ok(p.reason.includes('代理国家'), p.reason)
})

// ---------- 2) 语言 ↔ 时区：以时区为锚 ----------
t('语言地区与时区国家不符 → 改首选语言', () => {
  const r = proposeFixes(fp({ timezone: 'America/New_York', languages: ['zh-CN', 'zh'] }), '', ['langVsTz'])
  const p = r.find((x) => x.key === 'langVsTz')
  assert.strictEqual(p.fixable, true)
  assert.strictEqual(p.patch.languages[0], 'en-US', '应改为时区国家对应语言')
  assert.ok(p.patch.languages.includes('zh-CN'), '其余语言项应保留')
  assert.ok(p.patch.languages.length >= 2, '不能只剩一个语言')
})

t('时区不在内置表 → 语言不可修', () => {
  const r = proposeFixes(fp({ timezone: 'Europe/Zurich' }), '', ['langVsTz'])
  const p = r.find((x) => x.key === 'langVsTz')
  assert.strictEqual(p.fixable, false)
})

t('首选语言已正确 → 不可修并提示口径不一致', () => {
  const r = proposeFixes(fp({ timezone: 'America/New_York', languages: ['en-US'] }), '', ['langVsTz'])
  const p = r.find((x) => x.key === 'langVsTz')
  assert.strictEqual(p.fixable, false)
  assert.ok(p.reason.includes('口径'), p.reason)
})

// ---------- 3) UA ↔ OS：以 OS 为锚 ----------
t('UA 是 mac 但 os=windows → 改 UA 与 platform', () => {
  const r = proposeFixes(fp(), '', ['uaVsOs'])
  const p = r.find((x) => x.key === 'uaVsOs')
  assert.strictEqual(p.fixable, true)
  assert.strictEqual(uaOs(p.patch.userAgent), 'windows', '修完 UA 判定必须真的通过')
  assert.strictEqual(p.patch.platform, 'Win32', 'platform 必须同步改，否则换个地方露馅')
  assert.ok(p.patch.userAgent.includes('Windows NT'), p.patch.userAgent)
  assert.ok(!p.patch.userAgent.includes('Macintosh'), p.patch.userAgent)
})

t('修 UA 时保留 Chrome 版本号', () => {
  const r = proposeFixes(fp(), '', ['uaVsOs'])
  const p = r.find((x) => x.key === 'uaVsOs')
  assert.ok(p.patch.userAgent.includes('154.0.7521.60'), '版本号不该被改掉：' + p.patch.userAgent)
})

t('UA 是 windows 但 os=mac → 反向也能修', () => {
  const f = fp({
    os: 'mac',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.7521.60 Safari/537.36',
    platform: 'Win32'
  })
  const r = proposeFixes(f, '', ['uaVsOs'])
  const p = r.find((x) => x.key === 'uaVsOs')
  assert.strictEqual(p.fixable, true)
  assert.strictEqual(uaOs(p.patch.userAgent), 'mac')
  assert.strictEqual(p.patch.platform, 'MacIntel')
})

t('移动端目标系统 → 明确不可修（UA 需绑定具体设备型号）', () => {
  for (const os of ['android', 'ios']) {
    const r = proposeFixes(fp({ os }), '', ['uaVsOs'])
    const p = r.find((x) => x.key === 'uaVsOs')
    assert.strictEqual(p.fixable, false, `${os} 应不可修`)
    assert.ok(p.reason.includes('设备型号'), `${os}: ${p.reason}`)
  }
})

t('android UA 换 windows：去掉 Mobile Safari，避免自相矛盾', () => {
  const f = fp({
    os: 'windows',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.7521.60 Mobile Safari/537.36',
    platform: 'Linux armv8l'
  })
  const r = proposeFixes(f, '', ['uaVsOs'])
  const p = r.find((x) => x.key === 'uaVsOs')
  assert.strictEqual(p.fixable, true)
  assert.strictEqual(uaOs(p.patch.userAgent), 'windows')
  assert.ok(!/Mobile/.test(p.patch.userAgent), '桌面 UA 不该残留 Mobile：' + p.patch.userAgent)
  assert.ok(p.patch.userAgent.includes('Chrome/154.0.7521.60'), '版本号要保留')
})

t('UA 已与 OS 一致 → 不可修', () => {
  const f = fp({ os: 'windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.7521.60', platform: 'Win32' })
  const r = proposeFixes(f, '', ['uaVsOs'])
  assert.strictEqual(r.find((x) => x.key === 'uaVsOs').fixable, false)
})

t('空 UA → 不可修而非崩溃', () => {
  const r = proposeFixes(fp({ userAgent: '', os: 'windows' }), '', ['uaVsOs'])
  const p = r.find((x) => x.key === 'uaVsOs')
  assert.strictEqual(p.fixable, false)
  assert.ok(p.reason)
})

// ---------- 多项合并 ----------
t('三项同时不修 → 产出三条提案', () => {
  const r = proposeFixes(fp(), 'United States', ['tzVsProxy', 'langVsTz', 'uaVsOs'])
  assert.strictEqual(r.length, 3)
  assert.deepStrictEqual(r.map((x) => x.key), ['tzVsProxy', 'langVsTz', 'uaVsOs'], '顺序应稳定')
})

t('mergePatches：合并多个提案且不覆盖冲突字段', () => {
  const r = proposeFixes(fp(), 'United States', ['tzVsProxy', 'langVsTz', 'uaVsOs'])
  const { patch, conflicts } = mergePatches(r)
  assert.deepStrictEqual(conflicts, [], '本例不该有冲突：' + JSON.stringify(conflicts))
  assert.strictEqual(patch.timezone, 'America/New_York')
  assert.strictEqual(patch.languages[0], 'en-US')
  assert.strictEqual(uaOs(patch.userAgent), 'windows')
})

t('mergePatches：同一字段被两个提案指向时报冲突而非静默覆盖', () => {
  const r = [
    { key: 'tzVsProxy', fixable: true, patch: { timezone: 'A' } },
    { key: 'langVsTz', fixable: true, patch: { timezone: 'B' } }
  ]
  const { patch, conflicts } = mergePatches(r)
  assert.deepStrictEqual(conflicts, ['timezone'])
  assert.strictEqual(patch.timezone, 'A', '保留先到的那个，不被静默覆盖')
})

t('未传失败项 → 无提案（不凭空修）', () => {
  assert.deepStrictEqual(proposeFixes(fp(), 'US', []), [])
  assert.deepStrictEqual(proposeFixes(null, 'US', []), [])
})

t('fixSummary：可修与不可修都要说清', () => {
  // tzVsProxy 可修 → 时区改成 America/New_York → 串行推演后 langVsTz 也可修
  // （若并行按旧值算，时区还是 Zurich，两项都会判不可修）
  const r = proposeFixes(fp({ timezone: 'Europe/Zurich' }), 'United States', ['tzVsProxy', 'langVsTz'])
  const s = fixSummary(r)
  assert.ok(s.includes('可修 2 项'), s)
  assert.ok(s.includes('America/New_York'), s)
  assert.ok(s.includes('en-US'), s)
  assert.strictEqual(fixSummary([]), '没有需要修复的不一致项')
})

t('串行推演：语言本来就匹配新时区时不动它', () => {
  // languages 已是 en-US（匹配新时区 America/New_York），故不该被改。
  // 反过来说：若按旧时区 Asia/Shanghai(中国) 判，就会错判成「需改成 zh-CN」——
  // 那正是串行推演要避免的越修越不自洽。
  const f = fp({ timezone: 'Asia/Shanghai', languages: ['en-US', 'en'] })
  const r = proposeFixes(f, 'United States', ['tzVsProxy', 'langVsTz'])
  const lang = r.find((x) => x.key === 'langVsTz')
  assert.strictEqual(lang.fixable, false, '语言已匹配新时区，不该被改')
  assert.ok(lang.reason.includes('en-US'), lang.reason)
  const { patch } = mergePatches(r)
  assert.strictEqual(patch.timezone, 'America/New_York', '时区仍应匹配代理')
  assert.strictEqual(patch.languages, undefined, '语言字段不该出现在 patch 里')
})

t('串行推演：新时区与旧时区属不同语言区时，结论才真正不同', () => {
  // 旧时区 Asia/Shanghai(中国,zh-CN) → 新时区 America/New_York(美国,en-US)
  const f = fp({ timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] })
  const r = proposeFixes(f, 'Japan', ['tzVsProxy', 'langVsTz'])
  const { patch } = mergePatches(r)
  assert.strictEqual(patch.timezone, 'Asia/Tokyo', '应匹配日本代理')
  assert.strictEqual(patch.languages[0], 'ja-JP', '语言必须按新时区(日本)推成 ja-JP，而不是旧值 zh-CN')
})

t('undefined / null 输入不崩', () => {
  assert.doesNotThrow(() => proposeFixes(undefined, undefined, ['tzVsProxy', 'langVsTz', 'uaVsOs']))
  assert.doesNotThrow(() => proposeFixes({}, null, ['uaVsOs']))
  assert.doesNotThrow(() => mergePatches([]))
})

console.log(`\n${pass} passed, ${process.exitCode ? 1 : 0} failed`)