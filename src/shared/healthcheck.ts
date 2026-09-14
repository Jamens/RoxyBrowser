// 环境体检：把「数据库里的设定指纹」与「环境窗口内实测回读值」逐项对撞，
// 输出伪装度分与一致性红绿灯。
//
// 设计：本文件是**纯函数**，不依赖 Electron / 数据库，便于单测与前后端复用。
// 采集（在窗口里跑 JS 取真实值）在主进程 src/main/healthProbe.ts，
// 比对与打分在这里，两者通过 FingerprintProbe 结构解耦。
import type { Fingerprint } from './types'
import { COUNTRIES } from './countries'

/** 环境窗口内实际回读到的特征值（由 executeJavaScript 采集） */
export interface FingerprintProbe {
  userAgent: string
  platform: string
  language: string
  languages: string[]
  hardwareConcurrency: number
  deviceMemory: number
  doNotTrack: string
  maxTouchPoints: number
  ontouchstart: boolean
  devicePixelRatio: number
  /** userAgentData 是否存在（iOS 伪装时必须不存在） */
  uaDataPresent: boolean
  uaDataPlatform: string
  uaDataMobile: boolean | null
  screenWidth: number
  screenHeight: number
  tzOffset: number
  timezone: string
  webglVendor: string
  webglRenderer: string
  /** WebGL 上下文是否可用（无 GPU / 禁用软件光栅化的环境下创建不了，上面两项为空） */
  webglAvailable: boolean
  /** 以下为「注入是否生效」的开关型探测：函数被改写 / 能力被禁用 */
  canvasPatched: boolean
  audioPatched: boolean
  webrtcDisabled: boolean
  fontsGuarded: boolean
  /** 采集脚本自身出错时回传 */
  error?: string
}

export interface HealthItem {
  /** i18n key 后缀，前端拼 t('health.item.' + key) */
  key: string
  expected: string
  actual: string
  ok: boolean
  /** 权重，0 表示该项不适用（不计入总分） */
  weight: number
}

export interface ConsistencyItem {
  /** i18n key 后缀，前端拼 t('health.cons.' + key) */
  key: string
  expected: string
  actual: string
  ok: boolean
  /** 不适用时给出原因（如未绑定代理），前端显示为灰色 */
  skipped?: boolean
}

export interface HealthReport {
  /** 伪装度 0–100（仅由 items 加权得出） */
  score: number
  items: HealthItem[]
  consistency: ConsistencyItem[]
  checkedAt: string
  /** 参与一致性比对的代理出口国家（可能为空） */
  proxyCountry: string
  error?: string
}

const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

/** 从 UA 反推操作系统，用于「UA 与设定 OS 是否自洽」 */
export function uaOs(ua: string): string {
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Windows/i.test(ua)) return 'windows'
  return 'unknown'
}

const OS_TO_UAD_PLATFORM: Record<string, string> = {
  windows: 'Windows',
  mac: 'macOS',
  android: 'Android'
}

/** 语言标签 → 地区码：en-US → US，zh-CN → CN */
function langRegion(lang: string): string {
  const parts = s(lang).split(/[-_]/)
  return parts.length > 1 ? parts[1].toUpperCase() : ''
}

function tzToCountry(tz: string) {
  return COUNTRIES.find((c) => c.timezone === tz)
}

/** 代理检测回写的国家是 ip-api 的英文名，可能也可能是中文名或国码，故宽容匹配 */
function sameCountry(a: string, b: string): boolean {
  const x = s(a).trim().toLowerCase()
  const y = s(b).trim().toLowerCase()
  if (!x || !y) return false
  return x === y
}

export interface BuildReportOptions {
  /** 代理出口国家（ip-api 英文名，如 United States） */
  proxyCountry?: string
}

export function buildHealthReport(
  expected: Partial<Fingerprint> | null | undefined,
  actual: FingerprintProbe,
  opts: BuildReportOptions = {}
): HealthReport {
  const e = (expected || {}) as Partial<Fingerprint>
  const items: HealthItem[] = []

  // 逐项对比：expected 缺失（老数据或该项不适用）时权重置 0，不计入总分
  const cmp = (
    key: string,
    exp: unknown,
    act: unknown,
    weight: number,
    eq: (a: string, b: string) => boolean = (a, b) => a === b
  ) => {
    const es = s(exp)
    const as = s(act)
    const applicable = es !== ''
    const ok = applicable ? eq(es, as) : true
    items.push({ key, expected: applicable ? es : '—', actual: as, ok, weight: applicable ? weight : 0 })
  }

  cmp('userAgent', e.userAgent, actual.userAgent, 12)
  cmp('platform', e.platform, actual.platform, 8)
  cmp('languages', (e.languages || []).join(','), (actual.languages || []).join(','), 8)
  cmp('screen', `${e.screenWidth}×${e.screenHeight}`, `${actual.screenWidth}×${actual.screenHeight}`, 8)
  cmp('timezone', e.timezone, actual.timezone, 12)
  cmp('tzOffset', e.tzOffset, actual.tzOffset, 8)
  // WebGL：无 GPU 环境（CI / 禁用软件光栅化）下上下文创建不出来，此时该项不适用、不参与计分，
  // 否则会把「环境限制」误报成「指纹注入失败」。
  {
    const want = `${s(e.webglVendor)} / ${s(e.webglRenderer)}`
    items.push({
      key: 'webgl',
      expected: want,
      actual: actual.webglAvailable ? `${actual.webglVendor} / ${actual.webglRenderer}` : 'WebGL 不可用',
      ok: actual.webglAvailable ? want === `${actual.webglVendor} / ${actual.webglRenderer}` : true,
      weight: actual.webglAvailable ? 10 : 0
    })
  }
  cmp('hardwareConcurrency', e.hardwareConcurrency, actual.hardwareConcurrency, 4)
  cmp('deviceMemory', e.deviceMemory, actual.deviceMemory, 4)
  cmp('doNotTrack', e.doNotTrack, actual.doNotTrack, 2)

  // ---- UA-CH（userAgentData）----
  // iOS Safari 没有 userAgentData，伪装成 iOS 时必须整体移除，否则一查就穿帮
  {
    const isIos = e.os === 'ios'
    const wantPlatform = isIos ? '' : OS_TO_UAD_PLATFORM[s(e.os)] || ''
    const wantMobile = e.os === 'android' || e.os === 'ios'
    let exp: string
    let act: string
    let ok: boolean
    if (isIos) {
      exp = '—'
      act = actual.uaDataPresent ? actual.uaDataPlatform || 'present' : '—'
      ok = !actual.uaDataPresent
    } else {
      exp = `${wantPlatform} / mobile=${wantMobile}`
      act = actual.uaDataPresent ? `${actual.uaDataPlatform} / mobile=${actual.uaDataMobile}` : 'missing'
      ok = actual.uaDataPresent && actual.uaDataPlatform === wantPlatform && !!actual.uaDataMobile === wantMobile
    }
    items.push({ key: 'uaData', expected: exp, actual: act, ok, weight: wantPlatform || isIos ? 8 : 0 })
  }

  // ---- 触摸能力（移动端注入，桌面必须归 0 防泄漏）----
  {
    const wantPts = e.touch ? 5 : 0
    const ok = actual.maxTouchPoints === wantPts && actual.ontouchstart === !!e.touch
    items.push({
      key: 'touch',
      expected: `${wantPts} / ontouchstart=${!!e.touch}`,
      actual: `${actual.maxTouchPoints} / ontouchstart=${actual.ontouchstart}`,
      ok,
      weight: 4
    })
  }

  // ---- 噪声 / 防护类开关：对比「注入是否真的挂上了」 ----
  // canvasNoise / audioNoise 是开关，实测侧用「原型函数是否被改写」来验证注入生效
  cmp(
    'canvasNoise',
    e.canvasNoise ? 'on' : 'off',
    actual.canvasPatched ? 'on' : 'off',
    6,
    (a, b) => (e.canvasNoise ? b === 'on' : b === 'off')
  )
  cmp(
    'audioNoise',
    e.audioNoise ? 'on' : 'off',
    actual.audioPatched ? 'on' : 'off',
    5,
    (a, b) => (e.audioNoise ? b === 'on' : b === 'off')
  )
  cmp(
    'webrtc',
    e.webrtc === 'disable' ? 'disable' : 'real',
    actual.webrtcDisabled ? 'disable' : 'real',
    8
  )
  // 字体防泄漏总是注入（列表外字体一律判不可用），只要挂载成功即合格
  items.push({
    key: 'fonts',
    expected: 'on',
    actual: actual.fontsGuarded ? 'on' : 'off',
    ok: actual.fontsGuarded,
    weight: 5
  })

  // ---- 一致性红绿灯：四件套是否自洽（不自洽是关联高危信号）----
  const consistency: ConsistencyItem[] = []
  const tzCountry = tzToCountry(s(e.timezone))

  // 1) 时区国家 ↔ 代理出口国家
  {
    const pc = s(opts.proxyCountry)
    if (!pc || !tzCountry) {
      consistency.push({
        key: 'tzVsProxy',
        expected: tzCountry ? tzCountry.name : '—',
        actual: pc || '—',
        ok: true,
        skipped: true
      })
    } else {
      const ok = sameCountry(pc, tzCountry.nameEn) || sameCountry(pc, tzCountry.name) || sameCountry(pc, tzCountry.code)
      consistency.push({ key: 'tzVsProxy', expected: tzCountry.name, actual: pc, ok })
    }
  }

  // 2) 浏览器语言 ↔ 时区国家
  {
    const lang = (e.languages || actual.languages || [])[0] || ''
    const region = langRegion(lang)
    if (!region || !tzCountry) {
      consistency.push({ key: 'langVsTz', expected: '—', actual: lang || '—', ok: true, skipped: true })
    } else {
      consistency.push({
        key: 'langVsTz',
        expected: `${tzCountry.name} (${tzCountry.code})`,
        actual: `${lang} (${region})`,
        ok: region === tzCountry.code
      })
    }
  }

  // 3) UA 平台 ↔ 设定操作系统
  {
    const fromUa = uaOs(actual.userAgent || s(e.userAgent))
    const ok = fromUa === s(e.os)
    consistency.push({ key: 'uaVsOs', expected: s(e.os) || '—', actual: fromUa, ok })
  }

  // ---- 计分 ----
  const total = items.reduce((n, i) => n + i.weight, 0)
  const got = items.reduce((n, i) => n + (i.ok ? i.weight : 0), 0)
  const score = total > 0 ? Math.round((got / total) * 100) : 0

  return {
    score,
    items,
    consistency,
    checkedAt: new Date().toISOString(),
    proxyCountry: s(opts.proxyCountry),
    error: actual.error
  }
}
