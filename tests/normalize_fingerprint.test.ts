import { normalizeFingerprint } from '../src/shared/fingerprint.ts'

let failed = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failed++
}

// 1) 模拟「旧导出文件 / 历史数据」：缺 languages 与 fonts
const legacy = { os: 'windows', userAgent: 'Mozilla/5.0', platform: 'Win32' } as any
const a = normalizeFingerprint(legacy)
check('legacy: languages 是非空数组', Array.isArray(a.languages) && a.languages.length > 0)
check('legacy: fonts 是非空数组（有 length，渲染不会崩）', Array.isArray(a.fonts) && a.fonts.length > 0)
check('legacy: 保留传入的 os', a.os === 'windows')

// 2) null / undefined
const b = normalizeFingerprint(null)
check('null: 返回完整指纹', Array.isArray(b.languages) && Array.isArray(b.fonts) && !!b.userAgent)
const c = normalizeFingerprint(undefined)
check('undefined: 返回完整指纹', Array.isArray(c.languages) && Array.isArray(c.fonts))

// 3) 字符串（指纹被存成字符串的极端情况）
const d = normalizeFingerprint('garbage' as any)
check('string: 返回完整指纹', Array.isArray(d.languages) && Array.isArray(d.fonts))

// 4) 完整对象：应原样透传（所有字段保留）
const full = {
  os: 'mac', userAgent: 'UA-MAC', uaFullVersion: '1', platform: 'MacIntel',
  languages: ['en-US'], timezone: 'America/New_York', tzOffset: -240,
  screenWidth: 1920, screenHeight: 1080, hardwareConcurrency: 8, deviceMemory: 16,
  canvasNoise: true, webglVendor: 'V', webglRenderer: 'R', audioNoise: true,
  webrtc: 'disable', doNotTrack: 'unspecified', fonts: ['Arial']
} as any
const e = normalizeFingerprint(full)
check('full: os 保留', e.os === 'mac')
check('full: userAgent 保留', e.userAgent === 'UA-MAC')
check('full: languages 保留', Array.isArray(e.languages) && e.languages[0] === 'en-US')
check('full: fonts 保留（不覆盖）', Array.isArray(e.fonts) && e.fonts[0] === 'Arial')

// 5) 有 os 但缺 fonts：按 os 取确定字体集
const noFonts = { os: 'android', userAgent: 'UA', platform: 'Linux armv8l' } as any
const f = normalizeFingerprint(noFonts)
check('noFonts(android): fonts 补齐且为数组', Array.isArray(f.fonts) && f.fonts.length > 0)

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
