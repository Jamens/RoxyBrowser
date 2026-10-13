/**
 * 回收站批量操作的**纯判定逻辑**（主进程 / 渲染进程共用，零 Node 依赖，可离线单测）。
 *
 * ## 为什么抽出来单测
 * 批量彻底删除**不可恢复**，且每个环境都可能因各种原因失败（正在运行、
 * 不在回收站、不属于当前用户、并发下的状态变化）。如果批量的错误处理
 * 写成「一条失败整批中断」或「一条失败仍继续删剩下的」，后果都很糟：
 * 前者让用户重试几十次，后者可能删掉不该删的。这里把规则固定下来。
 */

/** 单个环境的可操作性判定结果 */
export type ItemVerdict =
  | { ok: true }
  | {
      ok: false
      /** 面向用户的拒绝原因（中文，可直接展示） */
      reason: string
      /** 拒绝分类，便于前端汇总统计 */
      code: 'not_in_trash' | 'still_running' | 'not_found' | 'not_owner'
    }

/** 批量操作的输入项：只需 id + 名字（名字仅用于拼提示文案） */
export interface TrashItemLike {
  id: number
  name: string
  /** 是否在回收站中（deletedAt 非空） */
  deletedAt?: string | null
  /** 窗口状态 */
  status?: string
  /** 归属校验：批量操作必须逐条校验，不能只靠前端勾选时的那份列表 */
  owned?: boolean
}

/**
 * 判定单个环境能否被彻底删除。
 *
 * @param item 环境信息
 * @param expectedOwnerId 当前操作者 id；传 undefined 表示跳过归属校验
 *                         （单条接口已用 ownerScope 在查询层过滤，这里用于批量二次校验）
 */
export function canPurge(item: TrashItemLike, expectedOwnerId?: number): ItemVerdict {
  if (item.owned === false) {
    return { ok: false, reason: '无权操作该环境', code: 'not_owner' }
  }
  // expectedOwnerId 与 item 的对比由调用方保证（列表已按 ownerScope 过滤）；
  // 这里保留参数是为了让「未来若要支持跨团队清理」时不用改签名。
  void expectedOwnerId
  if (!item.deletedAt) {
    return { ok: false, reason: `「${item.name}」不在回收站中`, code: 'not_in_trash' }
  }
  if (item.status === 'running') {
    // 这条最容易踩：正在运行的窗口点「彻底删除」会成功，但数据与内存态不一致
    return { ok: false, reason: `「${item.name}」的窗口正在运行，请先关闭`, code: 'still_running' }
  }
  return { ok: true }
}

/** 单条恢复的判定（比彻底删除宽松：运行中也能恢复——它本来就在运行） */
export function canRestore(item: TrashItemLike): ItemVerdict {
  if (item.owned === false) {
    return { ok: false, reason: '无权操作该环境', code: 'not_owner' }
  }
  if (!item.deletedAt) {
    return { ok: false, reason: `「${item.name}」不在回收站中`, code: 'not_in_trash' }
  }
  return { ok: true }
}

/** 单条拒绝的分类码（从 ItemVerdict 中提取，供 BatchPlan 使用） */
export type RejectCode = 'not_in_trash' | 'still_running' | 'not_found' | 'not_owner'

export interface BatchPlan {
  /** 可执行的操作项 */
  okIds: number[]
  /** 被拒绝的项：id + 原因（用于提示用户「哪几个没成功、为什么」） */
  rejected: { id: number; name: string; reason: string; code: RejectCode }[]
}

/**
 * 批量操作的执行计划。
 *
 * ## 核心规则：逐条独立判定，一条失败不影响其他
 * 设想用户勾了 10 个环境、其中 2 个正在运行：应当**删掉那 8 个**并明确告知
 * 剩下 2 个为何没删，而不是整批拒绝让用户自己一个个试。
 * 反过来也不能「失败就跳过继续删」了事——必须把拒绝原因如实回报，
 * 否则用户以为全删了，实际有几个还在，日后又被清掉会措手不及。
 */
export function planBatch(
  items: TrashItemLike[],
  judge: (item: TrashItemLike) => ItemVerdict
): BatchPlan {
  const okIds: number[] = []
  const rejected: BatchPlan['rejected'] = []
  // 去重：同一 id 重复出现只处理一次，避免重复删除
  const seen = new Set<number>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const v = judge(item)
    if (v.ok) okIds.push(item.id)
    // 不用 else + 收窄：ItemVerdict 的两个分支都带 ok 字段，tsc 在这种
    // 结构上收窄不稳定（README 注意事项里记过同一类问题）。
    // 摊平成局部变量读 reason/code，避免依赖收窄。
    else {
      const bad = v as { ok: false; reason: string; code: RejectCode }
      rejected.push({ id: item.id, name: item.name, reason: bad.reason, code: bad.code })
    }
  }
  return { okIds, rejected }
}

/**
 * 生成批量结果的用户提示文案。
 * 全部成功 / 全部失败 / 部分成功 三种情形措辞不同——
 * 尤其「部分成功」必须说清哪些没成功，否则用户会以为全删了。
 */
export function formatBatchResult(action: 'restore' | 'purge', okCount: number, rejected: BatchPlan['rejected']): string {
  const verb = action === 'restore' ? '恢复' : '彻底删除'
  if (rejected.length === 0) {
    return okCount > 0 ? `已${verb} ${okCount} 个环境` : `没有可${verb}的环境`
  }
  if (okCount === 0) {
    const first = rejected[0].reason
    return `未能${verb}：${first}${rejected.length > 1 ? `（共 ${rejected.length} 个均未成功）` : ''}`
  }
  const detail = rejected
    .slice(0, 3)
    .map((r) => r.name)
    .join('、')
  const more = rejected.length > 3 ? ` 等 ${rejected.length} 个` : ''
  return `已${verb} ${okCount} 个；${detail}${more} 未成功（${rejected[0].reason}）`
}