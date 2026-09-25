// 环境体检：把「数据库里的设定指纹」与「环境窗口内实测回读值」逐项对撞，
// 输出伪装度分与一致性红绿灯。
//
// 设计：本文件是**纯函数**，不依赖 Electron / 数据库，便于单测与前后端复用。
// 采集（在窗口里跑 JS 取真实值）在主进程 src/main/healthProbe.ts，
// 比对与打分在这里，两者通过 FingerprintProbe 结构解耦。
import type { Fingerprint } from './types'
import { COUNTRIES } from './countries'
import { webGpuInfoFor } from './webgpu'
import { audioProfileFor } from './webaudio'

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
  // ---- WebGPU ----
  /** navigator.gpu 是否存在（iOS 伪装时必须不存在） */
  webGpuPresent: boolean
  /** requestAdapter() 是否成功返回 adapter（无 GPU / 被禁用时为 false） */
  webGpuAdapterAvailable: boolean
  /** adapter.info.vendor（小写厂商标识） */
  webGpuVendor: string
  /** adapter.info.architecture */
  webGpuArchitecture: string
  // ---- WebAudio 完整特征 ----
  /** AudioContext.sampleRate */
  audioSampleRate: number
  /** AudioContext.baseLatency（秒） */
  audioBaseLatency: number
  /** destination.maxChannelCount */
  audioMaxChannelCount: number
  /** DynamicsCompressorNode.reduction（dB） */
  audioReduction: number
  /** AudioContext 是否创建成功（失败时上面几项为哨兵值，体检项须标记不适用） */
  audioAvailable: boolean
  // ---- EME / Widevine ----
  /** navigator.requestMediaKeySystemAccess 是否存在（iOS 伪装时必须不存在） */
  emeApiPresent: boolean
  /** com.widevine.alpha 是否可用 */
  emeWidevine: boolean
  /** org.w3.clearkey 是否可用 */
  emeClearKey: boolean
  /** com.microsoft.playready 是否可用（Chrome 原生不支持，应为 false） */
  emePlayReady: boolean
  /** Widevine getConfiguration() 报告的 initDataTypes（真实 Chrome 含 cenc / cbcs） */
  emeInitDataTypes: string[]
  /** Widevine 视频能力数（应 > 0） */
  emeVideoCaps: number
  /** Widevine 音频能力数（应 > 0） */
  emeAudioCaps: number
  /** navigator.webdriver（真实非自动化浏览器应为 false；true 表示被识别为自动化） */
  webdriver: boolean
  /** 是否检测到 CDP / ChromeDriver 等自动化特征全局变量（cdc_ / $cdc_ 等） */
  automationTraces: boolean
  /** navigator.bluetooth 是否暴露（平台 API 一致性） */
  apiBluetooth: boolean
  /** navigator.usb（WebUSB）是否暴露 */
  apiUsb: boolean
  /** navigator.serial（Web Serial）是否暴露 */
  apiSerial: boolean
  /** navigator.hid（WebHID）是否暴露 */
  apiHid: boolean
  /** navigator.nfc（Web NFC）是否暴露 */
  apiNfc: boolean
  /** matchMedia('(prefers-color-scheme: *)') 实际回灌值（dark / light / no-preference） */
  prefersColorScheme: string
  /** matchMedia('(prefers-reduced-motion: reduce)').matches 实际回灌值 */
  prefersReducedMotion: boolean
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
  /**
   * 音频指纹种子（profileId * 2654435761），用于推导音频特征期望值。
   * 音频档案由 seed 派生而非存库，所以期望值也必须由同一 seed 现算，才能对撞。
   */
  audioSeed?: number
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

  // ---- WebGPU：必须与 WebGL 同源 ----
  // 只伪造 WebGL 而放过 WebGPU，会产出「WebGL 说 RTX 4090、WebGPU 说宿主机集显」的矛盾信号——
  // 矛盾比不伪装更可疑（等于告诉检测方「这个环境被改过」），所以单独校验两者是否一致。
  {
    if (s(e.os) === 'ios') {
      // iOS WebKit 不支持 WebGPU，伪装成 iOS 时必须整体不存在
      items.push({
        key: 'webgpu',
        expected: '—',
        actual: actual.webGpuPresent ? s(actual.webGpuVendor) || 'present' : '—',
        ok: !actual.webGpuPresent,
        weight: 8
      })
    } else {
      const want = webGpuInfoFor(s(e.os), s(e.webglVendor), s(e.webglRenderer))
      const wantText = `${want.vendor} / ${want.architecture}`
      // 真实环境拿不到 adapter（无 GPU / 被禁用）时不参与计分，
      // 与 WebGL 不可用同理——环境限制不等于注入失败。
      const applicable = !!want.vendor && actual.webGpuAdapterAvailable
      items.push({
        key: 'webgpu',
        expected: want.vendor ? wantText : '—',
        actual: actual.webGpuAdapterAvailable
          ? `${s(actual.webGpuVendor)} / ${s(actual.webGpuArchitecture)}`
          : 'WebGPU 不可用',
        ok: applicable ? wantText === `${s(actual.webGpuVendor)} / ${s(actual.webGpuArchitecture)}` : true,
        weight: applicable ? 8 : 0
      })
    }
  }

  // ---- WebAudio 完整特征 ----
  // sampleRate / baseLatency / maxChannelCount / compressor.reduction 反映宿主机声卡与驱动特性，
  // 此前全部裸奔，是音频维度的主要泄漏口。期望值由 seed 现算（与注入端同源，才能对撞）。
  {
    const ap = audioProfileFor(opts.audioSeed ?? 0, s(e.os))
    // 三重前提才参与计分：开关打开 + AudioContext 建得起来 + 调用方传了 audioSeed。
    // 缺一即标记「不适用」——环境限制（无音频设备 / 页面改写了 AudioContext）不能被误报成
    // 「指纹注入失败」；缺少 seed 时更不能直接按 0 计算，那会得出与窗口内注入值不同的
    // 期望值导致永久判红且看不出原因。与 webgl / webgpu 项的处理保持一致。
    const on = !!e.audioNoise && actual.audioAvailable && typeof opts.audioSeed === 'number'
    const wantCtx = `${ap.sampleRate} / ${ap.baseLatency} / ${ap.maxChannelCount}`
    const actCtx = `${actual.audioSampleRate} / ${actual.audioBaseLatency} / ${actual.audioMaxChannelCount}`
    items.push({
      key: 'audioProfile',
      expected: on ? wantCtx : '—',
      actual: actual.audioAvailable ? actCtx : 'AudioContext 不可用',
      ok: on ? wantCtx === actCtx : true,
      weight: on ? 6 : 0
    })
    // reduction 是 fingerprintjs 的经典采集向量，单列一项便于定位问题
    const red = Number(actual.audioReduction)
    items.push({
      key: 'audioReduction',
      expected: on ? String(ap.compressorReduction) : '—',
      actual: actual.audioAvailable ? String(red) : 'AudioContext 不可用',
      ok: on ? Math.abs(red - ap.compressorReduction) < 1e-3 : true,
      weight: on ? 3 : 0
    })
  }

  // ---- EME / Widevine：DRM 模块可用性（平台级指纹向量）----
  // 与 WebGPU 同源：iOS 伪装必须整体移除该 API（否则「iOS UA 却报出 Widevine」矛盾）；
  // 其余系统必须报出 Widevine + ClearKey，且绝不伪造 Chrome 不该有的 PlayReady（由宿主原生 reject 保证）。
  {
    const isIosEme = s(e.os) === 'ios'
    if (isIosEme) {
      items.push({
        key: 'eme',
        expected: 'iOS：无 EME',
        actual: actual.emeApiPresent ? 'EME 存在' : '无 EME',
        ok: !actual.emeApiPresent,
        weight: 4
      })
    } else {
      // 不仅要求「Widevine + ClearKey 存在」，还要求 getConfiguration() 真能报出能力集（initDataTypes 含 cenc），
      // 否则「只能 resolve 却拿不到真实能力列表」会被检测站识别为伪装破绽（对标 RoxyChrome 152 加密媒体能力检测）。
      const idtOk =
        Array.isArray(actual.emeInitDataTypes) && actual.emeInitDataTypes.indexOf('cenc') >= 0
      const ok = actual.emeApiPresent && actual.emeWidevine && actual.emeClearKey && idtOk
      items.push({
        key: 'eme',
        expected: 'Widevine + ClearKey + CENC 能力',
        actual: actual.emeApiPresent
          ? `Widevine=${actual.emeWidevine} ClearKey=${actual.emeClearKey} PlayReady=${actual.emePlayReady} initDataTypes=[${actual.emeInitDataTypes.join(',')}] video=${actual.emeVideoCaps} audio=${actual.emeAudioCaps}`
          : 'EME 不可用',
        ok,
        weight: 4
      })
    }
  }

  // ---- 反自动化痕迹（Tier 1 #1）----
  // 真实浏览器 webdriver 恒为 false（iOS Safari 甚至无该属性 → 读为 undefined → !!false），
  // 且不应存在 cdc_ / $cdc_ 等自动化特征变量。两项任一命中即判红——这是检测站（Cloudflare / PerimeterX）首要关卡。
  {
    const ok = !actual.webdriver && !actual.automationTraces
    items.push({
      key: 'automation',
      expected: 'webdriver=false 且无自动化痕迹',
      actual: `webdriver=${actual.webdriver} automationTraces=${actual.automationTraces}`,
      ok,
      weight: 5
    })
  }

  // ---- 平台 API 一致性（Tier 2 #4）----
  // 按 OS 应有的平台能力 API：bluetooth/usb 全桌面+Android；serial/hid 仅桌面；nfc 仅 Android；iOS 一概没有。
  // 不伪造（规则 #22/#30）：宿主没有的 API 不主动新增，故「应有的缺失」不判红；
  // 只判「该 OS 不该有、却暴露了」的矛盾信号（如 iOS 伪装却暴露 bluetooth/usb/serial/hid/nfc）。
  {
    const allowed: { key: keyof FingerprintProbe; os: string[] }[] = [
      { key: 'apiBluetooth', os: ['windows', 'mac', 'android'] },
      { key: 'apiUsb', os: ['windows', 'mac', 'android'] },
      { key: 'apiSerial', os: ['windows', 'mac'] },
      { key: 'apiHid', os: ['windows', 'mac'] },
      { key: 'apiNfc', os: ['android'] }
    ]
    const contradictions: string[] = []
    for (const a of allowed) {
      if (a.os.indexOf(s(e.os)) >= 0) continue
      if (actual[a.key]) contradictions.push(a.key.replace('api', '').toLowerCase())
    }
    const ok = contradictions.length === 0
    items.push({
      key: 'platformApis',
      expected: '不该出现的平台 API 已隐藏',
      actual: contradictions.length
        ? `不该有却出现: ${contradictions.join(', ')}`
        : '无矛盾（应有的缺失不计入）',
      ok,
      weight: 4
    })
  }

  // ---- 媒体查询偏好（Tier 2 #5）----
  // 校验 matchMedia 回灌值与 fp 设定一致：color scheme 的 dark 须与 fp.prefersColorScheme==='dark' 对齐（其余亦然），
  // reduced motion 须与 fp.prefersReducedMotion 对齐；任一不符即判红（说明 preload 注入未生效或 fp 字段丢失）。
  {
    const wantScheme = (e.prefersColorScheme === 'dark' || e.prefersColorScheme === 'light' || e.prefersColorScheme === 'no-preference') ? e.prefersColorScheme : 'light'
    const schemeOk = actual.prefersColorScheme === wantScheme
    const motionOk = actual.prefersReducedMotion === !!e.prefersReducedMotion
    const ok = schemeOk && motionOk
    items.push({
      key: 'mediaPrefs',
      expected: `scheme=${wantScheme} reducedMotion=${!!e.prefersReducedMotion}`,
      actual: `scheme=${actual.prefersColorScheme} reducedMotion=${actual.prefersReducedMotion}`,
      ok,
      weight: 2
    })
  }

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
