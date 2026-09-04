import type { Fingerprint, OSKind } from './types'

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
  return Math.round((asUTC - Math.floor(now.getTime() / 1000) * 1000) / 60000) - now.getTimezoneOffset()
}

export function randomFingerprint(os?: OSKind): Fingerprint {
  const chosenOs: OSKind = os ?? pick<OSKind>(['windows', 'mac'])
  const chrome = pick(CHROME_VERSIONS)
  const tzInfo = pick(TZ_POOL)
  const [screenWidth, screenHeight] = pick(tzInfo.resolutions)
  let userAgent: string
  let platform: string
  let gpu: { vendor: string; renderer: string }

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
    doNotTrack: 'unspecified'
  }
}

export function defaultFingerprint(): Fingerprint {
  return randomFingerprint('windows')
}
