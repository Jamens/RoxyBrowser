/**
 * 一致性「批量修复」的差异预演 —— 纯函数，零依赖，可离线单测。
 *
 * 为什么需要批量预演：单环境修复有预览（POST /profiles/:id/fix-consistency 的 dryRun），
 * 但批量场景下「选中 20 个环境一起修」这件事仍然是黑盒——修之前你不知道：
 *   - 有几个其实**修不了**（没绑代理 / 移动端 UA / 时区不在国家表里）
 *   - 有几个**正在运行**（改指纹不作用于已开窗口，硬改只会让库与窗口彻底对不上）
 *   - 每一条具体会把哪些字段改成什么
 * 而批量操作的失败如果只回一个「成功 N 个」，用户既不知道剩下的那批为什么没动，
 * 也不知道自己是不是误伤了本来就一致的环境。
 *
 * ## 与单环境修复严格同源
 * 判定完全复用 `proposeFixes` / `mergePatches` / `fixSummary`，并沿用单环境路由里的
 * **effectiveKeys** 规则（见 effectiveKeysFor 注释）。**批量与单个给出不同结论是不可接受的**
 * —— 用户会怀疑「为什么单修提示能修、批量却说修不了」，而真相只是两边各算了一套。
 *
 * 预演与真实执行的唯一区别：不写库。
 */

import {
  proposeFixes,
  mergePatches,
  fixSummary,
  type FixProposal
} from './healthFix'
import type { Fingerprint } from './types'

/** 批量预演所需的单个环境信息（主进程查库后传入） */
export interface BatchFixInput {
  id: number
  name: string
  fingerprint: Partial<Fingerprint> | null | undefined
  /** 已绑定代理的国家名；未绑代理为空 */
  proxyCountry?: string | null
  /** 运行中的环境不可修：改指纹不会作用于已开的窗口 */
  running?: boolean
  /** 回收站中的环境不可修 */
  deleted?: boolean
}

/** 单个环境在批量预演中的结果 */
export interface BatchFixItem {
  id: number
  name: string
  /** 'fixable' 可修 / 'blocked' 不可修 / 'skipped' 运行中或已删除，本轮不动 */
  status: 'fixable' | 'blocked' | 'skipped'
  /** status !== 'fixable' 时的原因 */
  reason?: string
  /** 体检判定出的不一致项（key 列表） */
  failedKeys: string[]
  /** 可修项的提案（status === 'fixable' 时非空） */
  proposals: FixProposal[]
  /** 不可修项的提案（带 reason） */
  unfixable: FixProposal[]
  /** 本环境将被改动的字段：字段名 → { from, to } */
  changes: Array<{ field: string; from: unknown; to: unknown }>
  /** 可读摘要，复用 fixSummary 保证与单环境文案一致 */
  summary: string
}

export interface BatchFixPlan {
  items: BatchFixItem[]
  counts: {
    total: number
    /** 可修 */
    fixable: number
    /** 不可修（没绑代理 / UA 修不了 / 时区不在表里等） */
    blocked: number
    /** 跳过（运行中 / 已删除） */
    skipped: number
    /** 完全没有不一致项，环境本来就是自洽的 */
    consistent: number
    /** 将被修改的环境数（有实际字段变更） */
    willChange: number
  }
  /** 整体提示（如全部不可修 / 全部跳过） */
  notes: string[]
}

/**
 * 一致性判定函数：由调用方注入（通常是 `checkConsistency`）。
 *
 * 为什么不直接 import：checkConsistency 来自 healthcheck.ts，而本模块要能独立编译测试。
 * 注入还能保证**批量用的就是体检用的那一个**——若哪天判定口径变了，
 * 这里不会悄悄用上另一份实现。
 */
export type ConsistencyChecker = (
  fp: Partial<Fingerprint> | null | undefined,
  proxyCountry?: string | null
) => Array<{ key: string; ok: boolean }>

/**
 * 计算本次要传给 proposeFixes 的 keys。
 *
 * 规则与单环境路由 `POST /profiles/:id/fix-consistency` 完全一致：
 * 传**全部**一致性项，而非用户勾选的那几个。
 * 原因是修复时区会让原本一致的「语言↔时区」变成不一致——只修勾选项会漏掉这部分，
 * 结果是「修完反而多一处不一致」。proposeFixes 内部串行推演能处理这个依赖。
 *
 * 单独抽成函数是为了让单环境路由与批量预演共用同一份实现。
 *
 * ## 「空选」的语义：这是本次抽函数时最容易被忽略的差异
 * 单环境路由原本内联的是
 * `keys.length === allKeys.length ? allKeys : allKeys.filter(k => keys.includes(k))`
 * ——在 `keys` 为空时会返回**空数组**（什么都不修），只是上游那句
 * `if (!keys.length) return 400` 挡住了，所以这个行为从未暴露。
 * 本函数把空选明确为「全部」，更符合批量预演的意图（用户不必先勾选不一致项）。
 *
 * 因此**单环境路由必须保留它自己的空选 400 校验**：
 * 若哪天去掉那句校验，「空选 = 全修」会让该接口在没传 keys 时意外修复全部。
 */
export function effectiveKeysFor(
  allKeys: string[],
  selected?: string[] | null
): string[] {
  if (!selected || selected.length === 0) return allKeys
  if (selected.length === allKeys.length) return allKeys
  return allKeys.filter((k) => selected.includes(k))
}

/** 预览单个环境：不做任何写库，返回它会被改成什么样 */
export function planOne(
  input: BatchFixInput,
  checkConsistency: ConsistencyChecker,
  selectedKeys?: string[] | null
): BatchFixItem {
  const base = {
    id: input.id,
    name: input.name,
    failedKeys: [] as string[],
    proposals: [] as FixProposal[],
    unfixable: [] as FixProposal[],
    changes: [] as BatchFixItem['changes']
  }

  // 运行中 / 已删除：先于一切判定短路。
  // 运行中改指纹不会作用于已开的窗口，只会让「库里的配置」与「窗口里的实际」彻底对不上；
  // 已删除的环境连一致性体检都不该参与。
  if (input.deleted) {
    return { ...base, status: 'skipped', reason: '该环境已删除，请先从回收站恢复', summary: '已删除，跳过' }
  }
  if (input.running) {
    return {
      ...base,
      status: 'skipped',
      reason: '该环境窗口正在运行，修复不会生效（库与窗口会不一致），请先关闭窗口',
      summary: '运行中，跳过'
    }
  }

  const fp = input.fingerprint
  const pc = input.proxyCountry || ''
  const cons = checkConsistency(fp, pc) || []
  // 只统计真正不通过（ok === false）的项。
  // 注意 ConsistencyItem.skipped 的项 ok 为 **true**（如未绑代理时「时区↔代理」
  // 判为不适用），它们不算「不一致」——但仍会进入 allKeys 传给 proposeFixes，
  // 由 proposeFixes 自己判定「未绑代理无法修复」。这点与单环境路由一致，不在此处额外过滤。
  const failedKeys = cons.filter((c) => !c.ok).map((c) => c.key)
  const allKeys = cons.map((c) => c.key)
  const effective = effectiveKeysFor(allKeys, selectedKeys)

  if (!failedKeys.length) {
    return {
      ...base,
      status: 'fixable',
      summary: '一致性检查全部通过，无需修复',
      failedKeys
    }
  }

  const proposals = proposeFixes(fp, pc, effective)
  const okList = proposals.filter((p) => p.fixable)
  const noList = proposals.filter((p) => !p.fixable)
  const { patch, conflicts } = mergePatches(proposals)

  if (conflicts.length) {
    return {
      ...base,
      status: 'blocked',
      failedKeys,
      proposals: okList,
      unfixable: noList,
      reason: `多项修复指向同一字段（${conflicts.join('、')}），已放弃以免相互覆盖`,
      summary: fixSummary(proposals)
    }
  }

  if (!Object.keys(patch).length) {
    // 理由只取**本次真正判定为不一致**的项。
    // 否则会出现答非所问：未绑代理时 tzVsProxy 判为 skipped（不算不一致），
    // 但它仍在 proposals 里，若不挑就会把「未绑定代理」当成用户本次修不了的答案，
    // 而他真正关心的是 uaVsOs 那条。修不了的原因必须指向他勾的那几项。
    const relevant = noList.filter((p) => failedKeys.includes(p.key))
    const pickFrom = relevant.length ? relevant : noList
    return {
      ...base,
      status: 'blocked',
      failedKeys,
      unfixable: noList,
      reason: pickFrom[0]?.reason || '没有可自动修复的项',
      summary: fixSummary(proposals)
    }
  }

  // 逐字段给出「从什么改成什么」——这是用户决定要不要修的唯一依据
  const before = (fp || {}) as Record<string, unknown>
  const changes = Object.keys(patch).map((field) => ({
    field,
    from: before[field],
    to: (patch as Record<string, unknown>)[field]
  }))

  return {
    ...base,
    status: 'fixable',
    failedKeys,
    proposals: okList,
    unfixable: noList,
    changes,
    summary: fixSummary(proposals)
  }
}

/**
 * 批量预演：对一批环境逐个算出「会改成什么样」。
 *
 * @param inputs       环境列表（主进程查库后传入，含指纹与代理国家）
 * @param checkConsistency 一致性判定函数（注入的 checkConsistency）
 * @param selectedKeys 用户勾选的不一致项；空表示全部
 */
export function planBatchFix(
  inputs: BatchFixInput[],
  checkConsistency: ConsistencyChecker,
  selectedKeys?: string[] | null
): BatchFixPlan {
  const items = (inputs || []).map((i) => planOne(i, checkConsistency, selectedKeys))
  const counts = {
    total: items.length,
    fixable: 0,
    blocked: 0,
    skipped: 0,
    consistent: 0,
    willChange: 0
  }
  const notes: string[] = []

  for (const it of items) {
    if (it.status === 'skipped') counts.skipped++
    else if (it.status === 'blocked') counts.blocked++
    else {
      counts.fixable++
      if (it.changes.length) counts.willChange++
      else counts.consistent++
    }
  }

  // 提示：让用户在点确认之前就知道「这批里有几个是动不了的」
  const reasons = new Map<string, number>()
  for (const it of items) {
    // 与 planOne 同理：只聚合**本次真正不一致**的那条的 reason，
    // 否则「未绑定代理」这种 skipped 项会淹没真正的原因。
    const relevant = it.unfixable.find((p) => it.failedKeys.includes(p.key))
    const r = it.reason || relevant?.reason || ''
    if (!r) continue
    reasons.set(r, (reasons.get(r) || 0) + 1)
  }
  for (const [r, n] of reasons) {
    if (n === 1) notes.push(`${r}（1 个环境）`)
    else notes.push(`${r}（${n} 个环境）`)
  }
  if (!counts.willChange && counts.total) {
    notes.push('本次没有任何字段会被修改，无需执行修复')
  }

  return { items, counts, notes }
}

/** 汇总成一句日志描述 */
export function batchFixSummary(plan: BatchFixPlan): string {
  const c = plan.counts
  const parts: string[] = []
  if (c.willChange) parts.push(`将修复 ${c.willChange} 个环境`)
  if (c.consistent) parts.push(`${c.consistent} 个已自洽`)
  if (c.blocked) parts.push(`${c.blocked} 个不可修`)
  if (c.skipped) parts.push(`${c.skipped} 个跳过（运行中 / 已删除）`)
  return parts.join('，') || '没有可修复的环境'
}

// 曾经在这里导出了 FIX_FIELD_LABELS / FIX_KEY_LABELS（字段与不一致项的中文名），
// 但预演弹窗最终直接展示原始 field 名（timezone / languages）与 changes 明细，
// 这两个映射表无人使用，已删除。
// 若将来要做「字段中文名」列，记得：**先有用例再导出**——
// 没有调用方的导出等于死代码，还会让读者误以为界面已经做了本地化。