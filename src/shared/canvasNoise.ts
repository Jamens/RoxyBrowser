// Canvas 噪声派生：把「确定性噪声种子」与「极小画布守卫」抽成纯函数，
// 供 main/browser-preload.ts 注入端使用，且可离线单测。
//
// 为什么必须按画布确定性派生（而非共享一个随调用推进的 rng）：
// 检测站判定「Canvas 被注入」的**首要检查点**是「同一画布两次读取是否一致」——
// 真实硬件画两遍相同内容必然拿到相同像素（无随机源）。若噪声序列随调用推进，
// 两个相同画布（或同一画布的两次 toDataURL）会拿到不同的噪声，哈希不一致，
// 等于主动承认「我被改过」。这里让噪声种子 = f(环境种子, 画布宽, 画布高)，
// 于是「相同尺寸 + 相同环境」的画布得到**完全相同**的噪声序列，跨读取 / 跨会话稳定。
//
// 纯函数、无 Electron / DOM 依赖，便于离线单测。

/** FNV-1a 字符串哈希：把 webglVendor 等文本派生为稳定数值种子（seed 异常时的回退源） */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0
  const s = `${str || ''}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/**
 * 由「环境种子 + 画布尺寸」确定性派生噪声种子。
 * 用三个大质数做维度混合，避免 (宽, 高) 与 seed 线性耦合；结果恒为 uint32。
 * 相同 (seed, width, height) 必返回相同值；任一维度变化大概率改变序列（区分不同画布）。
 */
export function canvasNoiseSeed(profileSeed: number, width: number, height: number): number {
  const s = Number(profileSeed) || 0
  return (
    (s ^ Math.imul(width | 0, 73856093) ^ Math.imul(height | 0, 19349663)) >>> 0
  )
}

/**
 * 极小画布守卫：1×N 纯色参考条 / 实心探针尺寸极小，扰动它们会被「反篡改」探针
 * （画一块纯色再读回，断言颜色未变）立即识别，且极小画布本就不是指纹采集对象，
 * 扰动收益低、暴露风险高。默认阈值 8px。
 */
export function isTinyCanvas(width: number, height: number, limit = 8): boolean {
  return (width | 0) < limit || (height | 0) < limit
}

/**
 * 综合派生入口：环境种子缺失 / 为 0 时（极端情况下 profileId 未注入）退回文本哈希，
 * 避免所有「无种子」环境共用同一套噪声（等于互相撞车、且可被聚类识别）。
 * 返回可直接喂给 mulberry32 的稳定噪声种子。
 */
export function effectiveCanvasSeed(profileSeed: number, fallbackText: string): number {
  return profileSeed && profileSeed !== 0 ? profileSeed : hashString(fallbackText || 'roxy')
}
