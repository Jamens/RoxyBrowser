// WebGPU 指纹伪装：由既有 WebGL vendor/renderer 推导 navigator.gpu.requestAdapter() 暴露的 GPUAdapterInfo。
//
// 为什么必须做：真实 Chrome 的 WebGPU 会暴露 GPUAdapterInfo（vendor / architecture），
// 检测站（creepjs / pixelscan / browserleaks）已普遍采集。此前本项目只伪造了 WebGL 而放过
// WebGPU，会出现「WebGL 说 RTX 4090、WebGPU 说宿主机集显」的自相矛盾信号——
// 矛盾信号比不伪装更可疑，等于主动暴露「这个环境被改过」。
//
// 为什么不加数据库字段：info 完全由 webglVendor / webglRenderer 推导，天然与 WebGL 自洽，
// 且历史环境零迁移即可生效（不需要 normalizeFingerprint 兜底，也不用改指纹表单）。
//
// 纯函数、无 Electron / DOM 依赖，便于离线单测。

export interface WebGpuInfo {
  /** 小写厂商标识：nvidia / intel / amd / apple / qualcomm / arm */
  vendor: string
  /** 架构代号：ampere / turing / gen-12lp / rdna-2 / adreno … */
  architecture: string
  /** 设备名：真实 Chrome 出于隐私默认返回空串，这里保持一致（填值反而穿帮） */
  device: string
  /** 描述：同上，默认空串 */
  description: string
}

/** 空信息：识别不出厂商时使用，表示「不支持 / 不暴露」，不伪造 */
export const EMPTY_WEBGPU_INFO: WebGpuInfo = { vendor: '', architecture: '', device: '', description: '' }

/**
 * 该 OS 是否支持 WebGPU。
 * iOS 上 Safari/WebKit 至今不支持 WebGPU，伪装成 iOS 时若暴露 navigator.gpu 会立刻穿帮，
 * 因此必须整体隐藏（与 UA-CH 在 iOS 下必须整体移除同一道理）。
 */
export function webGpuSupported(os: string): boolean {
  return os !== 'ios'
}

/** WebGL vendor / renderer 字符串 → WebGPU 厂商标识 */
function vendorOf(webglVendor: string, webglRenderer: string): string {
  const v = `${webglVendor || ''}`.toLowerCase()
  if (v.includes('nvidia')) return 'nvidia'
  if (v.includes('intel')) return 'intel'
  if (v.includes('amd') || v.includes('radeon')) return 'amd'
  if (v.includes('apple')) return 'apple'
  if (v.includes('qualcomm')) return 'qualcomm'
  if (v.includes('arm')) return 'arm'
  // 移动端 vendor 常只写 "Qualcomm"/"ARM"，型号在 renderer 里（Adreno / Mali），故回退再判一次
  const r = `${webglRenderer || ''}`.toLowerCase()
  if (r.includes('adreno')) return 'qualcomm'
  if (r.includes('mali')) return 'arm'
  if (r.includes('apple')) return 'apple'
  if (r.includes('nvidia')) return 'nvidia'
  if (r.includes('intel')) return 'intel'
  if (r.includes('radeon')) return 'amd'
  return ''
}

/**
 * GPU 型号 → 架构代号（真实 Chrome 从驱动报告，这里按型号族推断）。
 * 识别不出型号时返回空串（调用方据此判定"不伪造"）——
 * 指纹表里的 webglRenderer 允许手填，若遇到没见过的型号就兜底成某个架构，
 * 会产出「WebGL 说 RTX 5090、WebGPU 说 ampere」的内部矛盾，正是本功能要消灭的东西。
 */
function architectureOf(vendor: string, renderer: string): string {
  const r = `${renderer || ''}`
  switch (vendor) {
    case 'nvidia':
      // 40 系 Ada / 30 系 Ampere / 20·16 系 Turing / 10 系 Pascal
      if (/RTX\s*40\d\d/i.test(r)) return 'ada-lovelace'
      if (/RTX\s*30\d\d/i.test(r)) return 'ampere'
      if (/RTX\s*20\d\d/i.test(r)) return 'turing'
      if (/GTX\s*16\d\d/i.test(r)) return 'turing'
      if (/GTX\s*10\d\d/i.test(r)) return 'pascal'
      return ''
    case 'intel':
      if (/Arc/i.test(r)) return 'xe-lpg'
      if (/Iris.*Xe/i.test(r)) return 'gen-12lp'
      // UHD / HD Graphics / Iris（含 Iris Plus / Iris Pro）均为 Gen9 家族核显。
      // 注意 Iris 要单独兜底：指纹池里的 "Iris(TM) Plus Graphics 655" 既不是 Xe 也不带 HD 前缀。
      if (/UHD|HD\s*Graphics|Iris/i.test(r)) return 'gen-9'
      return ''
    case 'amd':
      if (/RX\s*7\d\d\d/i.test(r)) return 'rdna-3'
      if (/RX\s*6\d\d\d/i.test(r)) return 'rdna-2'
      if (/RX\s*5\d\d\d|Vega/i.test(r)) return 'rdna-1'
      return ''
    case 'apple':
      return 'apple'
    case 'qualcomm':
      return 'adreno'
    case 'arm':
      return 'mali'
    default:
      return ''
  }
}

/**
 * 由 WebGL 指纹推导 WebGPU adapter.info。
 * os 为 'ios' 时返回 EMPTY（该平台不支持 WebGPU，由调用方整体隐藏 navigator.gpu）。
 */
export function webGpuInfoFor(os: string, webglVendor: string, webglRenderer: string): WebGpuInfo {
  if (!webGpuSupported(os)) return EMPTY_WEBGPU_INFO
  const vendor = vendorOf(webglVendor, webglRenderer)
  if (!vendor) return EMPTY_WEBGPU_INFO
  const architecture = architectureOf(vendor, webglRenderer)
  // 型号识别不出时不伪造：宁可让该项在体检里标记为「不适用」，
  // 也不要给出与 WebGL 自相矛盾的架构。
  if (!architecture) return EMPTY_WEBGPU_INFO
  return {
    vendor,
    architecture,
    // 真实 Chrome 在未开启 WebGPU 开发者特性时，device / description 均为空串，
    // 这里填 ANGLE 字符串会与「绝大多数真实用户」的分布不符，反而成为特征。
    device: '',
    description: ''
  }
}
