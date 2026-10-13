// 体检基线对比 —— 纯函数，零依赖，可离线单测
//
// 要解决的问题：**注入改坏了这件事，晚发现三个月是真实存在的风险**。
// 单次体检报告是「即用即弃」的，跑完就没了；用户不会每天去点批量体检，
// 更不会把两周前的分数和今天记在心里对比。而指纹注入代码一改，
// 往往是一次改坏影响**全部**环境——这正是最该被立刻发现的信号。
//
// ## 为什么判「集体劣化」而不是「单个环境分数低了」
// - 单个环境分数波动：多半是网络抖动 / 代理出口变了 / 该环境本身配置特殊，噪音大；
// - **所有环境在某一项上同时下滑**：几乎必然是注入代码改坏了（或该检查项失效）。
//   故基线存的是「各检查项的通过率」而不是「每个环境的分数」。
//
// ## 两个防噪音的闸（没有它们这套东西会在第一次用时就变成噪音源）
// 1. **最小样本量**：某项当前样本 < MIN_SAMPLES 个环境时不判定。
//    否则「1 个环境这项没过」就是 100% 失败率，会天天误报。
// 2. **绝对降幅门槛**：通过率下降 ≥ REGRESS_DELTA 个百分点才算回归。
//    跌 1~2 个点通常是真实世界的随机波动，不是代码问题。

/** 某个检查项在一次批量体检中的聚合结果 */
export interface HealthItemStat {
  /** 通过数 */
  passed: number
  /** 不通过数 */
  failed: number
  /** 不适用数（weight=0，如未绑代理时的出口国家比对） */
  na: number
}

/** 一次批量体检的基线快照（存 app_settings.settings.healthBaseline） */
export interface HealthBaseline {
  /** 基线建立时间（ISO） */
  savedAt: string
  /** 本次实际体检的环境数（排除 skipped） */
  probed: number
  /** 平均伪装度分 */
  avgScore: number
  /** 各检查项的聚合，按 key 索引 */
  items: Record<string, HealthItemStat>
}

/** 单个检查项的对比结果 */
export interface BaselineDiff {
  key: string
  /** 上次通过率（0~1） */
  prevPassRate: number
  /** 本次通过率（0~1） */
  currPassRate: number
  /** 百分点变化（负数 = 变差） */
  delta: number
  prevFailed: number
  currFailed: number
  /** 当前样本数（passed + failed） */
  sample: number
  /** 是否判定为回归（达到最小样本量且降幅超门槛） */
  regressed: boolean
  /** 未判定时说明原因，供 UI 如实展示而不是静默跳过 */
  skipReason?: string
}

/** 最小样本量：低于此值不判定，避免单点失败被当成集体回归 */
export const MIN_SAMPLES = 5
/** 回归门槛：通过率下降达到该百分点数才判定（默认 25 个百分点） */
export const REGRESS_DELTA = 0.25

/** 通过率：分母为「适用样本」= passed + failed，na 不计入。
 *  分母为 0 时返回 0 并由调用方按样本量闸拦住——不能返回 1，
 *  否则「这项全部不适用」会被读成「100% 合格」。 */
function passRate(s: HealthItemStat): number {
  const n = s.passed + s.failed
  if (n === 0) return 0
  return s.passed / n
}

/**
 * 对比本次结果与基线。
 *
 * @param baseline 上次基线；null 表示**首次体检**，此时不产生对比结论（没有可比对象）
 * @param current  本次聚合
 * @param minSamples / regressDelta 可覆盖默认门槛（供设置项与测试用）
 */
export function diffBaseline(
  baseline: HealthBaseline | null | undefined,
  current: Record<string, HealthItemStat>,
  opts?: { minSamples?: number; regressDelta?: number }
): BaselineDiff[] {
  const minSamples = opts?.minSamples ?? MIN_SAMPLES
  const regressDelta = opts?.regressDelta ?? REGRESS_DELTA
  if (!baseline || !baseline.items) return []

  const out: BaselineDiff[] = []
  // 取两边的键并集：只在上次出现的项（本次被删掉）与只在本次出现的项（新检查项）都要看
  const keys = Array.from(new Set([...Object.keys(baseline.items), ...Object.keys(current)]))
  for (const key of keys) {
    const prev = baseline.items[key] || { passed: 0, failed: 0, na: 0 }
    const curr = current[key] || { passed: 0, failed: 0, na: 0 }
    const prevRate = passRate(prev)
    const currRate = passRate(curr)
    const sample = curr.passed + curr.failed
    const delta = currRate - prevRate

    let regressed = false
    let skipReason: string | undefined
    if (sample < minSamples) {
      skipReason = `样本不足（${sample} < ${minSamples}）`
    } else if (prev.passed + prev.failed === 0) {
      skipReason = '上次该项无适用样本，无法对比'
    } else if (prevRate - currRate >= regressDelta) {
      regressed = true
    }
    out.push({
      key,
      prevPassRate: prevRate,
      currPassRate: currRate,
      delta,
      prevFailed: prev.failed,
      currFailed: curr.failed,
      sample,
      regressed,
      skipReason
    })
  }
  // 回归的排最前，其余按降幅从大到小（变差的在前，变好的在后）
  out.sort((a, b) => {
    if (a.regressed !== b.regressed) return a.regressed ? -1 : 1
    return a.delta - b.delta
  })
  return out
}

/** 从对比结果里挑出回归项 */
export function regressedItems(diffs: BaselineDiff[]): BaselineDiff[] {
  return diffs.filter((d) => d.regressed)
}

/**
 * 构造告警文案。如实说明「哪一项、跌了多少、样本多少」，
 * 不写「检测到指纹异常」这类会让人误以为检测站判定的说法——
 * 体检是自己出题自己判卷，它能说明的是「某项一致性变差了」，不是「被识别了」。
 */
export function regressedText(diffs: BaselineDiff[], labelOf?: (key: string) => string): string {
  const bad = regressedItems(diffs)
  if (!bad.length) return ''
  const name = (k: string) => (labelOf ? labelOf(k) : k)
  const parts = bad.slice(0, 4).map((d) => {
    const from = Math.round(d.prevPassRate * 100)
    const to = Math.round(d.currPassRate * 100)
    return `${name(d.key)} 通过率 ${from}% → ${to}%（${d.sample} 个环境）`
  })
  const more = bad.length > 4 ? `，另有 ${bad.length - 4} 项` : ''
  return `体检基线回归：${parts.join('；')}${more}`
}