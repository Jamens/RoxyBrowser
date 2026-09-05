import type { Fingerprint, FingerprintPresetDTO, OSKind } from './types'

// ============ 随机指纹生成器 ============

function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(Date.now() ^ 0x9e3779b9)
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min
}

// Chrome 大版本池（Win / Mac）
const CHROME_VERSIONS = [
  { major: 130, full: '130.0.6723.92' },
  { major: 131, full: '131.0.6778.86' },
  { major: 132, full: '132.0.6834.110' },
  { major: 129, full: '129.0.6668.100' },
  { major: 128, full: '128.0.6613.120' },
  { major: 127, full: '127.0.6533.119' }
]

const WIN_VERSIONS = [
  { osver: '10.0', platformStr: 'Win32', winPlatform: 'Windows NT 10.0; Win64; x64', winVersionUAD: '10' },
  { osver: '15.0', platformStr: 'Win32', winPlatform: 'Windows NT 10.0; Win64; x64', winVersionUAD: '10' } // Win11 同 NT 10.0
]

const MAC_VERSIONS = [
  { macPlatform: 'Macintosh; Intel Mac OS X 10_15_7', uadPlatform: 'macOS', uadVersion: '14.6.1' },
  { macPlatform: 'Macintosh; Intel Mac OS X 10_15_7', uadPlatform: 'macOS', uadVersion: '13.6.9' },
  { macPlatform: 'Macintosh; Intel Mac OS X 10_15_7', uadPlatform: 'macOS', uadVersion: '12.7.6' }
]

const GPU_WINDOWS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)' }
]

const GPU_MAC = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)' }
]

// 时区 / 语言 / 分辨率联动池
const TZ_POOL: Array<{ tz: string; languages: string[]; resolutions: Array<[number, number]> }> = [
  { tz: 'America/New_York', languages: ['en-US', 'en'], resolutions: [[1920, 1080], [1366, 768], [1600, 900]] },
  { tz: 'America/Los_Angeles', languages: ['en-US', 'en'], resolutions: [[1920, 1080], [1536, 864]] },
  { tz: 'America/Chicago', languages: ['en-US', 'en'], resolutions: [[1920, 1080], [1440, 900]] },
  { tz: 'Europe/London', languages: ['en-GB', 'en'], resolutions: [[1920, 1080], [1366, 768]] },
  { tz: 'Europe/Berlin', languages: ['de-DE', 'de', 'en-US', 'en'], resolutions: [[1920, 1080], [1680, 1050]] },
  { tz: 'Europe/Paris', languages: ['fr-FR', 'fr', 'en-US', 'en'], resolutions: [[1920, 1080]] },
  { tz: 'Asia/Singapore', languages: ['en-SG', 'en', 'zh-CN', 'zh'], resolutions: [[1920, 1080], [2560, 1440]] },
  { tz: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en-US', 'en'], resolutions: [[1920, 1080], [1366, 768]] },
  { tz: 'Asia/Shanghai', languages: ['zh-CN', 'zh', 'en-US', 'en'], resolutions: [[1920, 1080], [2560, 1440]] },
  { tz: 'Australia/Sydney', languages: ['en-AU', 'en'], resolutions: [[1920, 1080]] },
  { tz: 'America/Sao_Paulo', languages: ['pt-BR', 'pt', 'en-US', 'en'], resolutions: [[1920, 1080]] },
  { tz: 'Europe/Amsterdam', languages: ['nl-NL', 'nl', 'en-US', 'en'], resolutions: [[1920, 1080]] }
]

// 移动设备池（Android：Chrome Mobile；iOS：Safari —— Electron 是 Chromium 内核，
// iOS 场景只能伪装 UA/无 UA-CH 的形态，真实 iOS 上 Chrome 也是 WebKit，语义上一致）
const ANDROID_DEVICES = [
  { model: 'Pixel 8', osver: '14', screen: [412, 915] as [number, number], dpr: 2.625, vendor: 'Qualcomm', renderer: 'Adreno (TM) 730' },
  { model: 'Pixel 7a', osver: '14', screen: [412, 915] as [number, number], dpr: 2.625, vendor: 'Qualcomm', renderer: 'Adreno (TM) 725' },
  { model: 'SM-S928B', osver: '14', screen: [384, 832] as [number, number], dpr: 3, vendor: 'Qualcomm', renderer: 'Adreno (TM) 740' },
  { model: 'SM-A546B', osver: '14', screen: [360, 800] as [number, number], dpr: 2.75, vendor: 'Qualcomm', renderer: 'Adreno (TM) 619' },
  { model: 'SM-A155F', osver: '14', screen: [360, 800] as [number, number], dpr: 2.75, vendor: 'ARM', renderer: 'Mali-G68' },
  { model: '2210132C', osver: '14', screen: [393, 873] as [number, number], dpr: 2.75, vendor: 'Qualcomm', renderer: 'Adreno (TM) 710' },
  { model: 'CPH2529', osver: '14', screen: [360, 800] as [number, number], dpr: 2.75, vendor: 'Qualcomm', renderer: 'Adreno (TM) 610' }
]

const IOS_DEVICES = [
  // Safari WebView 的 WebGL vendor/renderer 固定为 Apple GPU
  { model: 'iPhone 15 Pro', osver: '17_5', safariVer: '17.5', screen: [393, 852] as [number, number], dpr: 3 },
  { model: 'iPhone 14', osver: '17_4', safariVer: '17.4', screen: [390, 844] as [number, number], dpr: 3 },
  { model: 'iPhone 14 Pro Max', osver: '17_4', safariVer: '17.4', screen: [430, 932] as [number, number], dpr: 3 },
  { model: 'iPhone 13', osver: '16_7', safariVer: '16.6', screen: [390, 844] as [number, number], dpr: 3 },
  { model: 'iPhone SE', osver: '17_4', safariVer: '17.4', screen: [375, 667] as [number, number], dpr: 2 }
]

// ============ 字体指纹池 ============
// 真实浏览器里「已安装字体」是强指纹：站点通过 document.fonts.check / Canvas measureText /
// DOM 宽度对照枚举已安装字体，从而泄漏宿主机自身字体。这里按 OS 给出一套「该 OS 默认会有的
// 字体」基础集——既能伪装成真实机器，又彻底挡住宿主机字体泄漏。randomFonts 在其基础上随机剔除
// 约 15% 做环境间差异化；预设则直接用完整确定集（保证预设可复现、各字段一致）。

// 跨平台必定存在的核心安全字体（任何桌面 / 移动浏览器都有）
const CORE_FONTS = ['Arial', 'Arial Black', 'Courier New', 'Georgia', 'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana']

const FONT_POOL: Record<OSKind, string[]> = {
  windows: [
    'Arial Narrow', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
    'Constantia', 'Corbel', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'HoloLens MDL2 Assets',
    'Ink Free', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Marlett',
    'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa',
    'Microsoft Sans Serif', 'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU',
    'Mongolian Baiti', 'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
    'Segoe Print', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'SimSun', 'Sitka', 'Sylfaen', 'Tahoma', 'Webdings', 'Wingdings', 'Yu Gothic'
  ],
  mac: [
    'American Typewriter', 'Andale Mono', 'Arial Rounded MT Bold', 'Avenir', 'Avenir Next',
    'Avenir Next Condensed', 'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand',
    'Brush Script MT', 'Chalkboard', 'Chalkboard SE', 'Chalkduster', 'Charter', 'Cochin',
    'Copperplate', 'Courier', 'Didot', 'DIN Alternate', 'Futura', 'Geneva', 'Gill Sans',
    'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Luminari', 'Marker Felt',
    'Menlo', 'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'Rockwell',
    'Savoye LET', 'Signpainter', 'Skia', 'Snell Roundhand', 'Tahoma', 'Trattatello'
  ],
  android: [
    'Roboto', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Serif', 'Droid Sans', 'Droid Sans Fallback',
    'Droid Serif', 'sans-serif', 'sans-serif-light', 'sans-serif-thin', 'sans-serif-condensed',
    'serif', 'monospace', 'casual', 'cursive'
  ],
  ios: [
    '.SF UI Text', '.SF UI Display', '.SF Pro Text', '.SF Pro Display', 'SF Pro', 'New York',
    'Helvetica', 'Helvetica Neue', 'Courier', 'Apple Color Emoji', 'Chalkboard SE', 'Cochin',
    'Gill Sans', 'Hoefler Text', 'Marker Felt', 'Papyrus', 'Snell Roundhand', 'Optima', 'Futura',
    'Menlo', 'Monaco', 'Noteworthy', 'Savoye LET', 'system-ui', 'sans-serif', 'serif', 'monospace'
  ]
}

/** 某 OS 的完整确定字体集（预设用，保证可复现） */
export function osFontList(os: OSKind): string[] {
  return [...CORE_FONTS, ...FONT_POOL[os]]
}

/** 随机字体集：核心安全字体必含 + OS 池随机剔除约 15%，做环境间差异化 */
export function randomFonts(os: OSKind): string[] {
  const pool = FONT_POOL[os].filter(() => rand() < 0.85)
  return [...CORE_FONTS, ...pool]
}

/** 计算 IANA 时区在当前时刻的 UTC 偏移（分钟），与 Date.getTimezoneOffset 语义一致 */
export function getTimezoneOffsetMinutes(timeZone: string): number {
  const now = new Date()
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const parts = dtf.formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  )
  // (asUTC - now) 即目标时区的「东向偏移」分钟数（东为正，如上海 +480、纽约 -240）。
  // Date.getTimezoneOffset() 的语义与之相反（UTC+8 返回 -480），因此要取负。
  //
  // 注意：这里绝不能减去 now.getTimezoneOffset()——那会把「宿主机自身」的偏移掺进来，
  // 既让结果偏离正确值，又导致同一 profile 在不同时区的机器上生成出不同的 tzOffset。
  // 旧实现正是这么写的：宿主机 UTC+8 时，上海会被算成 960（相当于 UTC-16，根本不存在），
  // 只有偏移恰为 UTC-4 的时区（夏季纽约）才「碰巧」正确。
  return -Math.round((asUTC - Math.floor(now.getTime() / 1000) * 1000) / 60000)
}

export function randomFingerprint(os?: OSKind): Fingerprint {
  const chosenOs: OSKind = os ?? pick<OSKind>(['windows', 'mac'])
  const chrome = pick(CHROME_VERSIONS)
  const tzInfo = pick(TZ_POOL)
  const [screenWidth, screenHeight] = pick(tzInfo.resolutions)
  let userAgent: string
  let platform: string
  let gpu: { vendor: string; renderer: string }

  // ===== 移动端 =====
  if (chosenOs === 'android' || chosenOs === 'ios') {
    if (chosenOs === 'android') {
      const dev = pick(ANDROID_DEVICES)
      return {
        os: 'android',
        userAgent: `Mozilla/5.0 (Linux; Android ${dev.osver}; ${dev.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Mobile Safari/537.36`,
        uaFullVersion: chrome.full,
        platform: 'Linux armv8l',
        languages: tzInfo.languages,
        timezone: tzInfo.tz,
        tzOffset: getTimezoneOffsetMinutes(tzInfo.tz),
        screenWidth: dev.screen[0],
        screenHeight: dev.screen[1],
        hardwareConcurrency: 8,
        deviceMemory: 8,
        canvasNoise: true,
        webglVendor: dev.vendor,
        webglRenderer: dev.renderer,
        audioNoise: true,
        webrtc: 'disable',
        doNotTrack: 'unspecified',
        touch: true,
        devicePixelRatio: dev.dpr,
        fonts: randomFonts('android')
      }
    }
    const dev = pick(IOS_DEVICES)
    return {
      os: 'ios',
      userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${dev.osver} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${dev.safariVer} Mobile/15E148 Safari/604.1`,
      uaFullVersion: dev.safariVer,
      platform: 'iPhone',
      languages: tzInfo.languages,
      timezone: tzInfo.tz,
      tzOffset: getTimezoneOffsetMinutes(tzInfo.tz),
      screenWidth: dev.screen[0],
      screenHeight: dev.screen[1],
      hardwareConcurrency: 4,
      deviceMemory: 8,
      canvasNoise: true,
      webglVendor: 'Apple Inc.',
        webglRenderer: 'Apple GPU',
        audioNoise: true,
        webrtc: 'disable',
        doNotTrack: 'unspecified',
        touch: true,
        devicePixelRatio: dev.dpr,
        fonts: randomFonts('ios')
      }
  }

  // ===== 桌面端 =====
  if (chosenOs === 'windows') {
    const win = pick(WIN_VERSIONS)
    userAgent = `Mozilla/5.0 (${win.winPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Safari/537.36`
    platform = win.platformStr
    gpu = pick(GPU_WINDOWS)
  } else {
    const mac = pick(MAC_VERSIONS)
    userAgent = `Mozilla/5.0 (${mac.macPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Safari/537.36`
    platform = 'MacIntel'
    gpu = pick(GPU_MAC)
  }

  return {
    os: chosenOs,
    userAgent,
    uaFullVersion: chrome.full,
    platform,
    languages: tzInfo.languages,
    timezone: tzInfo.tz,
    tzOffset: getTimezoneOffsetMinutes(tzInfo.tz),
    screenWidth,
    screenHeight,
    hardwareConcurrency: pick([4, 8, 12, 16]),
    deviceMemory: pick([4, 8, 16]),
    canvasNoise: true,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    audioNoise: true,
    webrtc: 'disable',
    doNotTrack: 'unspecified',
    fonts: randomFonts(chosenOs)
  }
}

export function defaultFingerprint(): Fingerprint {
  return randomFingerprint('windows')
}

/**
 * 把任意（可能不完整 / 旧版 / 缺字段）的指纹数据规整成完整且自洽的 Fingerprint。
 * - 空 / 非对象 / 缺 os：直接返回一套随机完整指纹，绝不抛错。
 * - 有 os 但缺部分字段：先按该 os 生成一套自洽基准，再用传入值覆盖；fonts 缺失时
 *   按该 os 取确定字体集，保证渲染层 `fp.languages.join` / `fp.fonts.length` 不会因
 *   undefined 而崩溃（旧导出文件 / 历史数据常缺 fonts 等新字段）。
 * 设计要点：纯函数、零异常，用于导入落库前与编辑表单加载时，杜绝「点击编辑一片空白」。
 */
export function normalizeFingerprint(fp?: Partial<Fingerprint> | null): Fingerprint {
  if (!fp || typeof fp !== 'object' || typeof fp.os !== 'string' || (fp.os !== 'windows' && fp.os !== 'mac' && fp.os !== 'android' && fp.os !== 'ios')) {
    return defaultFingerprint()
  }
  const os = fp.os
  const base = randomFingerprint(os as OSKind)
  return {
    ...base,
    ...fp,
    fonts: Array.isArray(fp.fonts) ? fp.fonts : osFontList(os as OSKind)
  } as Fingerprint
}

// ============ 指纹预设库 ============
// 内置的「经过验证的指纹组合」：各字段之间保持一致性（UA ↔ platform ↔ UA-CH ↔ GPU ↔ 屏幕 ↔ 时区语言），
// 用户一键套用，避免手工拼出互相矛盾的指纹被检测站点识破。

function presetFingerprint(
  core: Pick<Fingerprint, 'os' | 'userAgent' | 'uaFullVersion' | 'platform' | 'languages' | 'timezone' | 'screenWidth' | 'screenHeight' | 'hardwareConcurrency' | 'deviceMemory' | 'webglVendor' | 'webglRenderer'> &
    Partial<Pick<Fingerprint, 'touch' | 'devicePixelRatio'>>
): Fingerprint {
  return {
    canvasNoise: true,
    audioNoise: true,
    webrtc: 'disable',
    doNotTrack: 'unspecified',
    tzOffset: getTimezoneOffsetMinutes(core.timezone),
    fonts: osFontList(core.os),
    ...core
  }
}

interface FingerprintPreset {
  id: string
  name: string
  description: string
  build: () => Fingerprint
}

export const FINGERPRINT_PRESETS: FingerprintPreset[] = [
  {
    id: 'win10-chrome-us',
    name: 'Windows 10 · Chrome 130 · 美东',
    description: 'GTX 1650 / 8 核 16G / 1920×1080 / en-US（纽约）',
    build: () =>
      presetFingerprint({
        os: 'windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36',
        uaFullVersion: '130.0.6723.92',
        platform: 'Win32',
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
        screenWidth: 1920,
        screenHeight: 1080,
        hardwareConcurrency: 8,
        deviceMemory: 16,
        webglVendor: 'Google Inc. (NVIDIA)',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)'
      })
  },
  {
    id: 'win11-chrome-de',
    name: 'Windows 11 · Chrome 129 · 德国',
    description: 'RTX 3060 / 12 核 16G / 1920×1080 / de-DE（柏林）',
    build: () =>
      presetFingerprint({
        os: 'windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Safari/537.36',
        uaFullVersion: '129.0.6668.100',
        platform: 'Win32',
        languages: ['de-DE', 'de', 'en-US', 'en'],
        timezone: 'Europe/Berlin',
        screenWidth: 1920,
        screenHeight: 1080,
        hardwareConcurrency: 12,
        deviceMemory: 16,
        webglVendor: 'Google Inc. (NVIDIA)',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)'
      })
  },
  {
    id: 'win10-chrome-uk',
    name: 'Windows 10 · Chrome 131 · 英国',
    description: 'UHD 630 / 4 核 8G / 1920×1080 / en-GB（伦敦）',
    build: () =>
      presetFingerprint({
        os: 'windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36',
        uaFullVersion: '131.0.6778.86',
        platform: 'Win32',
        languages: ['en-GB', 'en'],
        timezone: 'Europe/London',
        screenWidth: 1920,
        screenHeight: 1080,
        hardwareConcurrency: 4,
        deviceMemory: 8,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)'
      })
  },
  {
    id: 'mac-m1-chrome-us',
    name: 'MacBook M1 · Chrome 130 · 美西',
    description: 'Apple M1 / 8 核 16G / 2560×1440 / en-US（洛杉矶）',
    build: () =>
      presetFingerprint({
        os: 'mac',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36',
        uaFullVersion: '130.0.6723.92',
        platform: 'MacIntel',
        languages: ['en-US', 'en'],
        timezone: 'America/Los_Angeles',
        screenWidth: 2560,
        screenHeight: 1440,
        hardwareConcurrency: 8,
        deviceMemory: 16,
        webglVendor: 'Google Inc. (Apple)',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'
      })
  },
  {
    id: 'mac-m2-chrome-sg',
    name: 'MacBook M2 · Chrome 132 · 新加坡',
    description: 'Apple M2 / 8 核 8G / 1920×1080 / en-SG（新加坡）',
    build: () =>
      presetFingerprint({
        os: 'mac',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.110 Safari/537.36',
        uaFullVersion: '132.0.6834.110',
        platform: 'MacIntel',
        languages: ['en-SG', 'en', 'zh-CN', 'zh'],
        timezone: 'Asia/Singapore',
        screenWidth: 1920,
        screenHeight: 1080,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        webglVendor: 'Google Inc. (Apple)',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'
      })
  },
  {
    id: 'mac-intel-chrome-jp',
    name: 'MacBook Intel · Chrome 129 · 日本',
    description: 'Iris Plus 655 / 4 核 8G / 1920×1080 / ja-JP（东京）',
    build: () =>
      presetFingerprint({
        os: 'mac',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Safari/537.36',
        uaFullVersion: '129.0.6668.100',
        platform: 'MacIntel',
        languages: ['ja-JP', 'ja', 'en-US', 'en'],
        timezone: 'Asia/Tokyo',
        screenWidth: 1920,
        screenHeight: 1080,
        hardwareConcurrency: 4,
        deviceMemory: 8,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)'
      })
  },
  {
    id: 'android-pixel8-us',
    name: 'Pixel 8 · Android 14 · 美东',
    description: 'Adreno 730 / 412×915 @2.625 / en-US（纽约）',
    build: () =>
      presetFingerprint({
        os: 'android',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Mobile Safari/537.36',
        uaFullVersion: '130.0.6723.92',
        platform: 'Linux armv8l',
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
        screenWidth: 412,
        screenHeight: 915,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        webglVendor: 'Qualcomm',
        webglRenderer: 'Adreno (TM) 730',
        touch: true,
        devicePixelRatio: 2.625
      })
  },
  {
    id: 'android-s24-de',
    name: 'Galaxy S24 Ultra · Android 14 · 德国',
    description: 'Adreno 740 / 384×832 @3 / de-DE（柏林）',
    build: () =>
      presetFingerprint({
        os: 'android',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Mobile Safari/537.36',
        uaFullVersion: '131.0.6778.86',
        platform: 'Linux armv8l',
        languages: ['de-DE', 'de', 'en-US', 'en'],
        timezone: 'Europe/Berlin',
        screenWidth: 384,
        screenHeight: 832,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        webglVendor: 'Qualcomm',
        webglRenderer: 'Adreno (TM) 740',
        touch: true,
        devicePixelRatio: 3
      })
  },
  {
    id: 'android-xiaomi-cn',
    name: 'Xiaomi · Android 14 · 中国',
    description: 'Adreno 710 / 393×873 @2.75 / zh-CN（上海）',
    build: () =>
      presetFingerprint({
        os: 'android',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; 2210132C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Mobile Safari/537.36',
        uaFullVersion: '129.0.6668.100',
        platform: 'Linux armv8l',
        languages: ['zh-CN', 'zh', 'en-US', 'en'],
        timezone: 'Asia/Shanghai',
        screenWidth: 393,
        screenHeight: 873,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        webglVendor: 'Qualcomm',
        webglRenderer: 'Adreno (TM) 710',
        touch: true,
        devicePixelRatio: 2.75
      })
  },
  {
    id: 'ios-iphone15-us',
    name: 'iPhone 15 Pro · iOS 17.5 · 美西',
    description: 'Apple GPU / 393×852 @3 / en-US（洛杉矶）',
    build: () =>
      presetFingerprint({
        os: 'ios',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        uaFullVersion: '17.5',
        platform: 'iPhone',
        languages: ['en-US', 'en'],
        timezone: 'America/Los_Angeles',
        screenWidth: 393,
        screenHeight: 852,
        hardwareConcurrency: 4,
        deviceMemory: 8,
        webglVendor: 'Apple Inc.',
        webglRenderer: 'Apple GPU',
        touch: true,
        devicePixelRatio: 3
      })
  },
  {
    id: 'ios-iphone14-jp',
    name: 'iPhone 14 · iOS 17.4 · 日本',
    description: 'Apple GPU / 390×844 @3 / ja-JP（东京）',
    build: () =>
      presetFingerprint({
        os: 'ios',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        uaFullVersion: '17.4',
        platform: 'iPhone',
        languages: ['ja-JP', 'ja', 'en-US', 'en'],
        timezone: 'Asia/Tokyo',
        screenWidth: 390,
        screenHeight: 844,
        hardwareConcurrency: 4,
        deviceMemory: 8,
        webglVendor: 'Apple Inc.',
        webglRenderer: 'Apple GPU',
        touch: true,
        devicePixelRatio: 3
      })
  }
]

/** 预设的对外形态（build 展开成完整 Fingerprint，随调用实时计算 tzOffset） */
export function listFingerprintPresets(): FingerprintPresetDTO[] {
  return FINGERPRINT_PRESETS.map(({ build, ...rest }) => ({ ...rest, fingerprint: build() }))
}
