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

/**
 * mulberry32 确定性伪随机数发生器（与浏览器端注入脚本同一实现）。
 * 抽到 shared 是为了让噪声变换可离线单测——注入端与测试端必须跑**同一个** PRNG，
 * 否则「测试过的噪声」与「注入的噪声」不是一回事。
 */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 噪声像素数：约每 1000 像素扰动 1 个（至少 2 个）。
 * 240×60（指纹站常用尺寸）→ 14 个；300×150 → 45 个；1920×1080 → 2073 个。
 *
 * 密度权衡（两个下界都必须满足）：
 * 1. 每个位置写 LSB 有约 1/8 概率三个通道的比特都已匹配而成为空操作
 *    （写 LSB 是内容无关投影，不能用「重试到生效」——那破坏幂等）。
 *    若密度过低（旧实现每 5000 像素 1 个、单通道），小画布只有几个位置，
 *    「整个画布零噪声」的概率高到实测复现（seed 42 @300×150 全落空）。
 *    取 /1000 后即使最小的 220×40（8 个位置）全空概率也仅 ~6e-8。
 * 2. 密度不能过高：单像素 ±1 的 LSB 扰动虽不可见，但过大比例的扰动像素
 *    会成为统计特征。千分之一的像素各改 3 个 LSB，PNG 无损编码下足以
 *    让哈希完全改变，同时远低于任何可视化/统计可辨阈值。
 */
export function noisePixelCount(width: number, height: number): number {
  return Math.max(2, Math.floor((width * height) / 1000))
}

/**
 * 幂等像素噪声：在确定性选中的像素位置上，把 R/G/B 三个通道的最低位改写为派生比特。
 *
 * 为什么必须「幂等」而不能用叠加式扰动（±1 / alpha 混色）：
 * 指纹站的「图像回环」检查（browserscan e0/n0）会把 toDataURL 的输出解码后画到
 * 另一块画布再读回，与直接读原画布逐像素比对。数学上这要求噪声变换 N 满足
 *     read(c) === read(decode(encode(read(c))))
 * 即 N(N(x)) === N(x)。叠加式噪声第二次施加会翻倍（±1 变 ±2），回环必然不一致，
 * 直接判「Canvas 被注入」；而「重试到生效」的选择逻辑又依赖内容、同样破坏幂等。
 * 「写 LSB」是内容无关的投影：位置与比特都由 (种子,宽,高) 派生，重复施加结果不变，
 * 于是回环几遍读取始终一致——这是唯一同时满足「有噪声」与「回环一致」的形态。
 *
 * 为什么按 (种子, 宽, 高) 派生而不按画布身份：
 * 指纹站的「双绘一致性」检查（s0/x0）会连读同一画布两次、或对比两块同尺寸画布
 * （如两块都填纯色），要求输出完全一致——只有与画布身份无关的确定性派生才能
 * 同时满足「跨读取稳定」与「跨画布一致」。
 *
 * 只动 RGB、不碰 Alpha，且只在**不透明像素**上施加：透明像素改了会无缘无故
 * 改变空画布哈希，而空画布本就不是指纹采集对象。
 *
 * 位置选择为什么用「索引表」而不是「抽到透明就重抽」：
 * 重抽（retry-until-opaque）看似只依赖 Alpha，但指纹画布不透明率可能极低
 * （browserscan 图案实测仅 ~13%），固定次数内抽不中的概率依然可观；
 * 而「重试到生效（RGB 改变）」则依赖内容、必然破坏幂等。索引表法先扫一遍
 * Alpha 收集全部不透明像素，再从中抽取——不透明集合在施加噪声前后不变
 * （Alpha 永不被修改），因此 rng 的消耗序列与 RGB 内容完全无关：
 * 二次施加时抽到同一批位置、写入同样的比特，图像不再变化（N(N(x))===N(x)），
 * 同时保证每个被选位置 100% 落在不透明像素上，彻底消除「完全落空」。
 *
 * @param data   RGBA 像素数组（getImageData 的 .data，原地修改）
 * @param seed  环境种子（effectiveCanvasSeed 的产出）
 * @param width / height  画布尺寸（噪声派生的两个维度）
 */
export function applyIdempotentNoise(
  data: Uint8ClampedArray | number[],
  seed: number,
  width: number,
  height: number
): void {
  const w = width | 0
  const h = height | 0
  if (w <= 0 || h <= 0) return
  const rng = mulberry32(canvasNoiseSeed(seed, w, h))
  const count = noisePixelCount(w, h)
  const pixels = w * h
  // 收集不透明像素索引（只读 Alpha；本函数永不写 Alpha，故该集合对同一画布恒定）
  const opaque: number[] = []
  for (let i = 0; i < pixels; i++) {
    if (data[i * 4 + 3] !== 0) opaque.push(i)
  }
  if (opaque.length === 0) return // 全透明画布：无可施加对象（两块全透明画布仍彼此一致）
  for (let i = 0; i < count; i++) {
    const p = opaque[Math.floor(rng() * opaque.length)] * 4
    // 三个通道一起写：把「该位置完全落空」的概率从 ~2/3 压到 1/8
    for (let ch = 0; ch < 3; ch++) {
      const bit = rng() < 0.5 ? 0 : 1
      data[p + ch] = (data[p + ch] & 0xfe) | bit
    }
  }
}
