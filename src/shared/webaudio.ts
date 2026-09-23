// WebAudio 指纹：由环境 seed 确定性派生 AudioContext 的可观测特征值。
//
// 为什么必须做：音频指纹是 fingerprintjs 的核心熵源之一。此前本项目只注入了
// AudioBuffer.getChannelData 的噪声（1 个维度），而 sampleRate / baseLatency /
// DynamicsCompressor.reduction / maxChannelCount 这些**更常被采集**的向量全部裸奔，
// 等于音频维度大半没伪装——宿主机声卡的采样率与压缩器响应会直接泄漏。
//
// 为什么不加数据库字段：这些值互相牵制（baseLatency 必须是 sampleRate 的整数分之一），
// 由 seed 派生既能保证「同环境稳定、异环境不同」，免去迁移与表单负担，
// 又能顺带保证 baseLatency 与 sampleRate 之间自洽（不会出现矛盾的数值组合）。
// 复用既有 audioNoise 开关：关掉即完全不伪装，尊重用户显式设置。
//
// 纯函数、无 Electron / DOM 依赖，便于离线单测。

export interface AudioProfile {
  /** 采样率：44100 或 48000 */
  sampleRate: number
  /** AudioContext.baseLatency（秒），真实值为 bufferSize / sampleRate */
  baseLatency: number
  /** destination.maxChannelCount（声道数上限） */
  maxChannelCount: number
  /**
   * DynamicsCompressorNode.reduction（dB），指纹采集的经典向量。
   * 取小幅负值：真实 AudioContext 在**无信号流过时**读到的就是 0，
   * 若每个环境都给出 -1~-20 的常量，反而与真实人群分布脱节（等于自我标记）。
   */
  compressorReduction: number
}

/** 由 seed + salt 生成确定性 [0,1) 随机数（与 preload 的 mulberry32 同族，保证同环境稳定） */
function rnd(seed: number, salt: number): number {
  let t = (seed + salt * 0x9e3779b9) >>> 0
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// 桌面以 48000 为主（近代声卡默认），44100 亦常见；移动端 48000 占比更高
const RATE_48K_DESKTOP = 0.72
const RATE_48K_MOBILE = 0.85
// reduction 幅度上限（dB）：刻意取小值，贴合「轻压缩 / 小信号」的真实区间
const REDUCTION_MAX = 3

/**
 * 生成音频指纹档案。
 *
 * 刻意不注入 outputLatency：真实 AudioContext 在无音频播放时该值为 0，
 * 强行填 0.015~0.045 会与真实人群脱节；而它本身几乎不泄漏硬件信息，
 * 注入的收益不足以抵消穿帮风险（宁缺毋滥）。
 *
 * @param seed 环境种子（profileId * 2654435761），保证同环境稳定、异环境不同
 * @param os   操作系统
 */
export function audioProfileFor(seed: number, os: string): AudioProfile {
  const s = Number(seed) || 0
  const mobile = os === 'android' || os === 'ios'

  const use48k = rnd(s, 1) < (mobile ? RATE_48K_MOBILE : RATE_48K_DESKTOP)
  const sampleRate = use48k ? 48000 : 44100

  // baseLatency = bufferSize / sampleRate，真实 bufferSize 多为 128 / 256 / 512
  const buffers = [128, 256, 512]
  const bufferSize = buffers[Math.floor(rnd(s, 2) * buffers.length)]
  const baseLatency = bufferSize / sampleRate

  // maxChannelCount：绝大多数为 2（立体声），少数多声道输出设备为 6 / 8
  const chRoll = rnd(s, 4)
  const maxChannelCount = chRoll < 0.9 ? 2 : chRoll < 0.97 ? 6 : 8

  // 小幅负 dB，保留环境间区分度的同时贴近真实量级
  const compressorReduction = -(0.001 + rnd(s, 5) * REDUCTION_MAX)

  return {
    sampleRate,
    baseLatency: Number(baseLatency.toFixed(6)),
    maxChannelCount,
    compressorReduction: Number(compressorReduction.toFixed(4))
  }
}
