const D = require('../.tmp_pd/shared/proxyDrift.js')
const { COUNTRIES, countryTimezone } = require('../.tmp_pd/shared/countries.js')
console.log('=== 国家表样例 ===')
;['US', 'DE', 'JP', 'GB', 'AU'].forEach((c) => {
  const e = COUNTRIES.find((x) => x.code === c)
  console.log(' ', c, e ? e.name : '无', '| tz =', countryTimezone(c))
})
console.log('\n=== detectExitIpChange 各种输入 ===')
const cases = [
  ['首次检测（旧 IP 空）', { exitIp: '', country: '' }, { exitIp: '1.2.3.4', country: 'United States' }],
  ['检测失败（新 IP 空）', { exitIp: '1.2.3.4', country: 'US' }, { exitIp: '', country: '' }],
  ['IP 相同', { exitIp: '1.2.3.4', country: 'US' }, { exitIp: '1.2.3.4', country: 'US' }],
  ['IP 变 + 国家变', { exitIp: '1.2.3.4', country: 'United States' }, { exitIp: '5.6.7.8', country: 'Germany' }],
  ['IP 变 + 国家不变', { exitIp: '1.2.3.4', country: 'United States' }, { exitIp: '5.6.7.8', country: 'United States' }],
  ['null 输入', null, null]
]
for (const [label, a, b] of cases) {
  console.log(' ', label.padEnd(18), '→', JSON.stringify(D.detectExitIpChange(a, b)))
}
console.log('\n=== findMisalignedProfiles ===')
const profiles = [
  { id: 1, name: '纽约', proxyId: 10, timezone: 'America/New_York' },
  { id: 2, name: '芝加哥', proxyId: 10, timezone: 'America/Chicago' },
  { id: 3, name: '东京', proxyId: 10, timezone: 'Asia/Tokyo' },
  { id: 4, name: '别的代理', proxyId: 11, timezone: 'Asia/Tokyo' }
]
console.log(' 代理 US:', JSON.stringify(D.findMisalignedProfiles({ id: 10, country: 'United States' }, profiles)))
console.log(' 代理国家空:', JSON.stringify(D.findMisalignedProfiles({ id: 10, country: '' }, profiles)))
console.log(' 代理国家未知:', JSON.stringify(D.findMisalignedProfiles({ id: 10, country: 'Atlantis' }, profiles)))
