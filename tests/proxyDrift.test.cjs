// 代理出口 IP 漂移检测 —— 离线单测
// 编译命令（在本仓库根目录执行）：
//   node node_modules/typescript/bin/tsc src/shared/proxyDrift.ts src/shared/countries.ts src/shared/locales.ts \
//     --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_pd
// 然后：node tests/proxyDrift.test.cjs
//
// 背景：代理 IP 池会轮换出口 IP。此前 applyProxyCheckResult 直接覆盖 exitIp / country，
// 漂移被完全吞掉 → 环境的时区还按旧国家生成 → 平台侧一眼看出关联异常，界面零提示。
// 本测试锁住「检测得准」与「文案说得清」两件事。
const assert = require('assert')
const { detectExitIpChange, findMisalignedProfiles, describeExitIpChange } = require('../.tmp_pd/shared/proxyDrift.js')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✅', name)
  } catch (e) {
    console.error('  ❌', name)
    console.error('     ', e.message)
    process.exitCode = 1
  }
}

// ---------- detectExitIpChange ----------

t('首次检测（无旧 IP）不算漂移', () => {
  const c = detectExitIpChange({ exitIp: '', country: '' }, { exitIp: '1.2.3.4', country: 'United States' })
  assert.strictEqual(c, null, '没有"旧值"就谈不上变化，不能凭空造一次漂移')
})

t('检测失败（新 IP 为空）不算漂移', () => {
  const c = detectExitIpChange({ exitIp: '1.2.3.4', country: 'US' }, { exitIp: '', country: '' })
  assert.strictEqual(c, null, '检测失败不该覆盖旧事实，更不该报漂移')
})

t('出口 IP 未变不算漂移', () => {
  const c = detectExitIpChange({ exitIp: '1.2.3.4', country: 'United States' }, { exitIp: '1.2.3.4', country: 'United States' })
  assert.strictEqual(c, null)
})

t('出口 IP 变了且国家也变 → 漂移，countryChanged 为真', () => {
  const c = detectExitIpChange(
    { exitIp: '1.2.3.4', country: 'United States' },
    { exitIp: '5.6.7.8', country: 'Germany' }
  )
  assert.ok(c)
  assert.strictEqual(c.oldExitIp, '1.2.3.4')
  assert.strictEqual(c.newExitIp, '5.6.7.8')
  assert.strictEqual(c.oldCountry, 'United States')
  assert.strictEqual(c.newCountry, 'Germany')
  assert.strictEqual(c.countryChanged, true)
})

t('出口 IP 变了但国家未变 → 仍是漂移，countryChanged 为假', () => {
  // 同国不同 IP 同样值得知道：平台"同 IP 多账号"关联规则照样可能命中
  const c = detectExitIpChange(
    { exitIp: '1.2.3.4', country: 'United States' },
    { exitIp: '5.6.7.8', country: 'United States' }
  )
  assert.ok(c, 'IP 换了就是换了，不能因为国家没变就放过')
  assert.strictEqual(c.countryChanged, false)
})

t('null / undefined 输入安全返回 null', () => {
  assert.strictEqual(detectExitIpChange(null, null), null)
  assert.strictEqual(detectExitIpChange(undefined, { exitIp: '1.2.3.4' }), null)
  assert.strictEqual(detectExitIpChange({ exitIp: '1.2.3.4' }, undefined), null)
})

t('IP 前后有空白时按去空白后比较', () => {
  const c = detectExitIpChange({ exitIp: ' 1.2.3.4 ' }, { exitIp: '1.2.3.4' })
  assert.strictEqual(c, null, '空白差异不应被当成出口变更')
})

// ---------- findMisalignedProfiles ----------

const profiles = [
  { id: 1, name: '纽约', proxyId: 10, timezone: 'America/New_York' },
  { id: 2, name: '芝加哥', proxyId: 10, timezone: 'America/Chicago' },
  { id: 3, name: '东京', proxyId: 10, timezone: 'Asia/Tokyo' },
  { id: 4, name: '别人的环境', proxyId: 11, timezone: 'Asia/Tokyo' }
]

t('代理国家用英文名也能匹配（ip-api 返回的就是英文名）', () => {
  // 回归：早先用 findCountry（只认代码）导致这里恒为空数组 —— 失配永远检测不到
  const r = findMisalignedProfiles({ id: 10, country: 'United States' }, profiles)
  assert.strictEqual(r.length, 2, '芝加哥 + 东京应被判失配')
  assert.deepStrictEqual(r.map((x) => x.id).sort(), [2, 3])
})

t('代理国家用代码也能匹配', () => {
  const r = findMisalignedProfiles({ id: 10, country: 'US' }, profiles)
  assert.strictEqual(r.length, 2)
})

t('代理国家用中文名也能匹配', () => {
  const r = findMisalignedProfiles({ id: 10, country: '美国' }, profiles)
  assert.strictEqual(r.length, 2)
})

t('时区与代理国家一致的环境不算失配', () => {
  const r = findMisalignedProfiles({ id: 10, country: 'United States' }, profiles)
  assert.ok(!r.some((x) => x.id === 1), '纽约时区正是美国对应时区，不该算失配')
})

t('只统计绑定了该代理的环境', () => {
  const r = findMisalignedProfiles({ id: 10, country: 'United States' }, profiles)
  assert.ok(!r.some((x) => x.id === 4), '绑在别的代理上的环境与本代理无关')
})

t('代理国家为空 → 不报失配（不制造噪音）', () => {
  assert.deepStrictEqual(findMisalignedProfiles({ id: 10, country: '' }, profiles), [])
  assert.deepStrictEqual(findMisalignedProfiles({ id: 10, country: null }, profiles), [])
})

t('代理国家不在内置表里 → 不报失配', () => {
  assert.deepStrictEqual(findMisalignedProfiles({ id: 10, country: 'Atlantis' }, profiles), [])
})

t('失配项带出"应为哪个时区"，供 UI 提示与修复预览用', () => {
  const r = findMisalignedProfiles({ id: 10, country: 'Germany' }, profiles)
  const t0 = r.find((x) => x.id === 1)
  assert.ok(t0)
  assert.strictEqual(t0.timezone, 'America/New_York')
  assert.strictEqual(t0.expectedTimezone, 'Europe/Berlin', '德国对应时区应为 Europe/Berlin')
})

t('环境时区为空时不算失配（无时区是另一种问题，不该混在这里）', () => {
  const r = findMisalignedProfiles({ id: 10, country: 'United States' }, [
    { id: 9, name: '无时区', proxyId: 10, timezone: '' }
  ])
  assert.deepStrictEqual(r, [])
})

// ---------- describeExitIpChange ----------

t('文案：IP 与国家都变 → 写明旧新值，并列出受影响环境', () => {
  const change = detectExitIpChange(
    { exitIp: '1.2.3.4', country: 'United States' },
    { exitIp: '5.6.7.8', country: 'Germany' }
  )
  const s = describeExitIpChange(change, '我的代理', [
    { id: 1, name: '纽约', timezone: 'America/New_York', expectedTimezone: 'Europe/Berlin' }
  ])
  assert.ok(s.includes('1.2.3.4'), '要写明旧出口 IP')
  assert.ok(s.includes('5.6.7.8'), '要写明新出口 IP')
  assert.ok(s.includes('United States') && s.includes('Germany'), '要写明国家变化')
  assert.ok(s.includes('纽约') && s.includes('#1'), '要列出受影响环境')
  assert.ok(s.includes('America/New_York') && s.includes('Europe/Berlin'), '要写明当前时区与应有时区')
  assert.ok(s.includes('一致性修复'), '要告诉用户下一步怎么做')
})

t('文案：国家未变也要说明「出口节点已更换」', () => {
  const change = detectExitIpChange(
    { exitIp: '1.2.3.4', country: 'United States' },
    { exitIp: '5.6.7.8', country: 'United States' }
  )
  const s = describeExitIpChange(change, '我的代理', [])
  assert.ok(s.includes('出口节点已更换'), '同国换 IP 时若只写"国家未变"，用户会以为没事')
})

t('文案：没有受影响环境时明说无需处理', () => {
  const change = detectExitIpChange({ exitIp: '1.2.3.4', country: 'US' }, { exitIp: '5.6.7.8', country: 'US' })
  const s = describeExitIpChange(change, '我的代理', [])
  assert.ok(s.includes('无需处理'), '无受影响环境时应明确说明，避免用户困惑')
})

console.log(`\nproxyDrift: ${passed} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
