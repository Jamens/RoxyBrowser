// 出口 IP → 语言 / 时区推导的回归验证：
// 1) 一国多时区必须按地区细分，给不出就必须标「需确认」而不是猜
// 2) 推导出的语言 / 时区必须与体检判定口径同源——填完体检不能报红
// 3) 国家表的内在不变式（语言地区码 == 国码、地区映射的时区必须在候选表里）
const assert = require('assert')
const {
  suggestLocaleFromExit,
  timeZoneToCountry,
  findCountryGeo,
  COUNTRY_GEO,
  countryBrowserLanguage,
  timeZoneBelongsToCountry
} = require('../.tmp_ip/shared/ipLocaleSuggest.js')
const { checkConsistency } = require('../.tmp_ip/shared/healthcheck.js')

let pass = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

// ---------- 地区细分：一国多时区不能只给一个值 ----------
t('美国 + 加州 → 洛杉矶时区（不是默认的纽约）', () => {
  const s = suggestLocaleFromExit('United States', 'California')
  assert.strictEqual(s.timeZone, 'America/Los_Angeles')
  assert.strictEqual(s.ambiguous, false)
  assert.strictEqual(s.locale, 'en-US')
})

t('美国 + 德州 → 芝加哥时区（中部与西部时区不同）', () => {
  const s = suggestLocaleFromExit('United States', 'Texas')
  assert.strictEqual(s.timeZone, 'America/Chicago')
})

t('美国 + 亚利桑那 → 凤凰城时区（不实行夏令时的那一档）', () => {
  const s = suggestLocaleFromExit('United States', 'Arizona')
  assert.strictEqual(s.timeZone, 'America/Phoenix')
})

t('加拿大 + 安大略 → 多伦多时区', () => {
  const s = suggestLocaleFromExit('Canada', 'Ontario')
  assert.strictEqual(s.timeZone, 'America/Toronto')
  assert.strictEqual(s.ambiguous, false)
})

t('加拿大 + 不列颠哥伦比亚 → 温哥华时区', () => {
  const s = suggestLocaleFromExit('Canada', 'British Columbia')
  assert.strictEqual(s.timeZone, 'America/Vancouver')
})

t('澳大利亚 + 新南威尔士 → 悉尼时区', () => {
  const s = suggestLocaleFromExit('Australia', 'New South Wales')
  assert.strictEqual(s.timeZone, 'Australia/Sydney')
})

t('澳大利亚 + 维多利亚 → 墨尔本时区', () => {
  const s = suggestLocaleFromExit('Australia', 'Victoria')
  assert.strictEqual(s.timeZone, 'Australia/Melbourne')
})

t('俄罗斯 + 符拉迪沃斯托克 → 海参崴时区（跨 11 个时区的最东端）', () => {
  const s = suggestLocaleFromExit('Russia', 'Vladivostok')
  assert.strictEqual(s.timeZone, 'Asia/Vladivostok')
})

t('巴西 + 带重音的「São Paulo」也能匹配（去重音后比较）', () => {
  const s = suggestLocaleFromExit('Brazil', 'São Paulo')
  assert.strictEqual(s.timeZone, 'America/Sao_Paulo')
})

t('巴西 + 无重音写法同样命中', () => {
  const s = suggestLocaleFromExit('Brazil', 'Sao Paulo')
  assert.strictEqual(s.timeZone, 'America/Sao_Paulo')
})

// ---------- 认不出来就必须说「需确认」，不能猜 ----------
t('美国但地区未知 → 标 ambiguous，给首选 + 全部候选', () => {
  const s = suggestLocaleFromExit('United States', 'Atlantis')
  assert.strictEqual(s.ambiguous, true, '认不出就必须要求确认')
  assert.ok(s.timeZoneOptions.length > 1, '多时区国家必须给候选列表')
  assert.ok(s.timeZoneOptions.includes(s.timeZone), '首选值必须在候选列表里')
})

t('美国但完全没有地区信息 → 同样标 ambiguous', () => {
  const s = suggestLocaleFromExit('United States')
  assert.strictEqual(s.ambiguous, true)
})

t('地区名属于别的国家时不误命中（美国 + 新南威尔士）', () => {
  const s = suggestLocaleFromExit('United States', 'New South Wales')
  assert.strictEqual(s.ambiguous, true, '别国的州名不该被当成本国的')
})

t('单时区国家永远不 ambiguous', () => {
  for (const c of ['United Kingdom', 'Germany', 'Japan', 'Singapore', 'China']) {
    const s = suggestLocaleFromExit(c)
    assert.strictEqual(s.ambiguous, false, `${c} 不该要求确认`)
    assert.strictEqual(s.timeZoneOptions.length, 1, `${c} 只有一个时区`)
  }
})

// ---------- 语言：地区码必须等于国码 ----------
t('英国给 en-GB 而不是 en-US（这是体检判定 langVsTz 的依据）', () => {
  const s = suggestLocaleFromExit('United Kingdom')
  assert.strictEqual(s.locale, 'en-GB')
  assert.deepStrictEqual(s.languages, ['en-GB', 'en'])
})

t('澳大利亚给 en-AU、加拿大给 en-CA、俄罗斯给 ru-RU', () => {
  assert.strictEqual(suggestLocaleFromExit('Australia').locale, 'en-AU')
  assert.strictEqual(suggestLocaleFromExit('Canada').locale, 'en-CA')
  assert.strictEqual(suggestLocaleFromExit('Russia').locale, 'ru-RU')
})

t('Accept-Language 头按「首选在前、基础语言降权」构造', () => {
  assert.strictEqual(suggestLocaleFromExit('United Kingdom').acceptLanguage, 'en-GB,en;q=0.9')
  assert.strictEqual(suggestLocaleFromExit('Japan').acceptLanguage, 'ja-JP,ja;q=0.9')
})

t('单段语言（中文）不带 q 值', () => {
  assert.strictEqual(suggestLocaleFromExit('China').acceptLanguage, 'zh-CN,zh;q=0.9')
})

// ---------- 找不到就返回 undefined，绝不兜底 ----------
t('未知国家 → undefined（不能拿宿主 IP 或默认国家兜底）', () => {
  assert.strictEqual(suggestLocaleFromExit('Atlantis'), undefined)
  assert.strictEqual(suggestLocaleFromExit(''), undefined)
  assert.strictEqual(suggestLocaleFromExit(null), undefined)
  assert.strictEqual(suggestLocaleFromExit(undefined), undefined)
})

// ---------- 国名宽松匹配 ----------
t('国码 / 中文名 / 英文名 / 别名指向同一份档案', () => {
  for (const raw of ['US', '美国', 'United States', 'USA']) {
    const g = findCountryGeo(raw)
    assert.ok(g, `${raw} 应能查到`)
    assert.strictEqual(g.code, 'US')
  }
  assert.strictEqual(findCountryGeo('韩国').code, 'KR')
  assert.strictEqual(findCountryGeo('Korea, Republic of').code, 'KR')
  assert.strictEqual(findCountryGeo('Czech Republic').code, 'CZ')
  assert.strictEqual(findCountryGeo('Czechia').code, 'CZ', '别名要能命中')
})

t('countryBrowserLanguage：未知国家返回 undefined 而不是猜 en-US', () => {
  assert.strictEqual(countryBrowserLanguage('US'), 'en-US')
  assert.strictEqual(countryBrowserLanguage('Atlantis'), undefined)
})

// ---------- 时区反查 ----------
t('时区反查覆盖多时区国家的全部候选（否则体检会把该检查项静默跳过）', () => {
  assert.strictEqual(timeZoneToCountry('America/Los_Angeles').code, 'US')
  assert.strictEqual(timeZoneToCountry('America/Chicago').code, 'US')
  assert.strictEqual(timeZoneToCountry('Australia/Melbourne').code, 'AU')
  assert.strictEqual(timeZoneToCountry('America/Vancouver').code, 'CA')
  assert.strictEqual(timeZoneToCountry('Asia/Vladivostok').code, 'RU')
})

t('未知时区 → undefined', () => {
  assert.strictEqual(timeZoneToCountry('Europe/Zurich'), undefined)
  assert.strictEqual(timeZoneToCountry(''), undefined)
})

t('timeZoneBelongsToCountry：时区与国家同源判定', () => {
  assert.strictEqual(timeZoneBelongsToCountry('America/New_York', 'United States'), true)
  assert.strictEqual(timeZoneBelongsToCountry('Europe/London', 'United States'), false)
  assert.strictEqual(timeZoneBelongsToCountry('Europe/London', 'GB'), true)
})

// ---------- 国家表内在不变式 ----------
t('不变式：每个国家的浏览器语言地区码 == 国码', () => {
  for (const g of COUNTRY_GEO) {
    const region = g.browserLanguage.split('-')[1]
    assert.strictEqual(region, g.code, `${g.code} 的语言 ${g.browserLanguage} 地区码与国码不符`)
  }
})

t('不变式：地区映射出的时区必须在该国候选表里（否则用户选了也填不进去）', () => {
  for (const g of COUNTRY_GEO) {
    for (const [region, tz] of Object.entries(g.regions || {})) {
      assert.ok(g.timeZones.includes(tz), `${g.code} 的 ${region} 映射到 ${tz}，但不在候选表里`)
    }
  }
})

t('不变式：每个国家都有时区，且首选时区就是列表第一项', () => {
  for (const g of COUNTRY_GEO) {
    assert.ok(g.timeZones.length > 0, `${g.code} 没有时区`)
    assert.ok(g.timeZones[0], `${g.code} 首选时区为空`)
  }
})

t('不变式：多时区国家必须带地区细分表（否则永远只能给首选）', () => {
  for (const g of COUNTRY_GEO) {
    if (g.timeZones.length > 1) {
      assert.ok(g.regions && Object.keys(g.regions).length > 0, `${g.code} 是多时区国家却没有地区细分`)
    }
  }
})

// ---------- 与体检口径同源：填完不能报红 ----------
t('按出口 IP 填出的指纹，跑体检不应报「时区/语言与代理国家不一致」', () => {
  for (const [country, region] of [
    ['United States', 'California'],
    ['United States', 'Texas'],
    ['United Kingdom', 'England'],
    ['Australia', 'New South Wales'],
    ['Canada', 'Ontario'],
    ['Russia', 'Moscow'],
    ['Germany', ''],
    ['Japan', '']
  ]) {
    const s = suggestLocaleFromExit(country, region)
    const fp = {
      os: 'windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0',
      languages: s.languages,
      timezone: s.timeZone
    }
    const c = checkConsistency(fp, s.countryNameEn)
    const tz = c.find((x) => x.key === 'tzVsProxy')
    const lang = c.find((x) => x.key === 'langVsTz')
    assert.strictEqual(tz.ok, true, `${country}/${region} 时区应判一致：${JSON.stringify(tz)}`)
    assert.strictEqual(lang.ok, true, `${country}/${region} 语言应判一致：${JSON.stringify(lang)}`)
  }
})

t('反过来：填了英国语言却配美国时区，体检必须报不一致（守卫没被写坏）', () => {
  const c = checkConsistency(
    { os: 'windows', userAgent: 'x', languages: ['en-GB'], timezone: 'America/New_York' },
    'United States'
  )
  assert.strictEqual(c.find((x) => x.key === 'langVsTz').ok, false)
})

console.log(`\n${pass} passed, ${process.exitCode ? 1 : 0} failed`)
