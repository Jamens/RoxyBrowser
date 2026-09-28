// WebGL 显卡品牌 ↔ 操作系统 一致性校验（纯函数，无 Electron / DOM 依赖，便于离线单测）。
//
// 为什么要做：环境体检现有的 webgl 项只比对「设定值 == 回读值」（验证注入是否生效），
// 却不校验「这个 GPU 品牌是否配得上它所声明的系统」。于是会出现——
//   · iOS 伪装环境，WebGL renderer 却写着 NVIDIA GeForce RTX 4090
//   · Android 环境，WebGL 暴露桌面级 AMD / Intel 显卡
//   · 桌面 Windows 环境，WebGL 暴露 Adreno / Mali 这类移动 GPU
// 这类「系统说手机、显卡说台式机」的矛盾，正是检测站（PixelScan / BrowserLeaks / CreepJS）
// 在「移动设备模拟 + 指纹检测同时开启」时会标记的破绽，也是本克隆核心卖点（指纹自洽）的漏洞。
//
// 与既有「不伪造」原则同源：本函数只做「一致性守门」，不篡改任何值；
// 发现矛盾就如实报红，让用户在体检里一眼看到，而不是兜底成某个默认值去和别的维度打架。
//
// 判定口径（只抓「跨形态矛盾」，避免误伤合法稀有配置）：
//   · 移动端（iOS / Android）：不该出现桌面 GPU 品牌（NVIDIA / AMD / Intel）；iOS 还必须是 Apple。
//   · 桌面端（Windows / macOS / Linux）：不该出现移动 GPU 品牌（Adreno / Mali / PowerVR）；
//     macOS 由于 ANGLE 始终报 Apple，额外要求 Apple。Windows / Linux 不强制具体品牌（罕见桌面卡不误报）。

export interface WebglOsMatch {
  /** 是否自洽（True 表示 WebGL 显卡品牌与声明系统不矛盾） */
  ok: boolean
  /** 命中矛盾时的中文原因；ok 时为空串 */
  reason: string
}

const RE_NVIDIA = /nvidia|geforce/i
const RE_AMD = /amd|radeon/i
const RE_INTEL = /intel|iris|uhd|hd\s*graphics/i
const RE_APPLE = /apple/i
const RE_ADRENO = /adreno/i
const RE_MALI = /mali/i
const RE_POWERVR = /powervr/i

function detect(vendor: string, renderer: string) {
  const t = `${vendor || ''} ${renderer || ''}`
  return {
    nvidia: RE_NVIDIA.test(t),
    amd: RE_AMD.test(t),
    intel: RE_INTEL.test(t),
    apple: RE_APPLE.test(t),
    adreno: RE_ADRENO.test(t),
    mali: RE_MALI.test(t),
    powervr: RE_POWERVR.test(t)
  }
}

const OS_LABEL: Record<string, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS'
}

/**
 * 校验 WebGL vendor / renderer 字符串与声明系统是否自洽。
 * @param os 声明操作系统（Fingerprint.os，如 'ios' / 'android' / 'windows' / 'mac'）
 * @param vendor WebGL UNMASKED_VENDOR_WEBGL（Fingerprint.webglVendor）
 * @param renderer WebGL UNMASKED_RENDERER_WEBGL（Fingerprint.webglRenderer）
 */
export function webglMatchesOs(os: string, vendor: string, renderer: string): WebglOsMatch {
  const o = (os || '').toLowerCase()
  const b = detect(vendor, renderer)
  const label = OS_LABEL[o] || o

  if (o === 'ios' || o === 'android') {
    if (b.nvidia || b.amd || b.intel) {
      const brand = b.nvidia ? 'NVIDIA' : b.amd ? 'AMD' : 'Intel'
      return { ok: false, reason: `${label} 环境不应出现桌面 GPU 品牌（检测到 ${brand}）` }
    }
    if (o === 'ios' && !b.apple) {
      return { ok: false, reason: 'iOS 环境的 WebGL 应为 Apple GPU' }
    }
    return { ok: true, reason: '' }
  }

  // 桌面端
  if (b.adreno || b.mali || b.powervr) {
    const brand = b.adreno ? 'Adreno' : b.mali ? 'Mali' : 'PowerVR'
    return { ok: false, reason: `桌面环境（${label}）不应出现移动 GPU 品牌（检测到 ${brand}）` }
  }
  if (o === 'mac' && !b.apple) {
    return { ok: false, reason: 'macOS 环境的 WebGL 应为 Apple GPU' }
  }
  return { ok: true, reason: '' }
}
