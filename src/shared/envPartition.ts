/**
 * 环境持久化分区（`persist:env-<id>`）的**纯判定逻辑**，零 Node 依赖，可离线单测。
 *
 * ## 为什么这个分区需要显式清理
 * 每个环境用 `session.fromPartition('persist:env-<id>')` 拿到独立的
 * Cookie / localStorage / IndexedDB / HTTP 缓存。persist 前缀意味着这些数据
 * **落盘**到 `userData/Partitions/env-<id>/`，进程退出、窗口关闭都不会清。
 *
 * 于是产生两个真实问题：
 * 1. **磁盘与内存无界增长**：环境越多、跑得越久，Cookie 与缓存只增不减。
 *    实测三个窗口就能把进程内存推到 1.4GB（README 注意事项记过），
 *    Chromium 的缓存/IndexedDB 是其中一大块。
 * 2. **残留登录态**：环境彻底删除后，磁盘上的分区目录还在。
 *    MySQL 里的 Cookie 记录已被 `cookieRepo.delete` 清掉，但 Chromium
 *    自己写的 localStorage / IndexedDB / Service Worker **还在**。
 *    若 id 被复用（自增主键在测试、清库、重装场景下并不罕见），
 *    新环境会直接继承上一个环境的登录态 —— 这是指纹浏览器最不能容忍的串号。
 *
 * ## 为什么不自动清
 * partition 里的数据是环境的一部分，关窗口就清等于「指纹掉线」：
 * 用户手动关掉窗口再打开 expecting 还在登录，结果被踢下线。
 * 故只在**环境被彻底删除**（不可恢复）这一唯一确定的时机清理。
 */

/** Electron 分区名。persist 前缀决定了它会落盘。 */
export function partitionName(profileId: number): string {
  return `persist:env-${profileId}`
}

/**
 * 落盘目录名（相对 `userData/Partitions/`）。
 * Electron 会把 `persist:env-1` 映射到目录 `env-1`（去掉 persist: 前缀）。
 */
export function partitionDirName(profileId: number): string {
  return `env-${profileId}`
}

/** 清理时机 */
export type CleanupTrigger = 'purge' | 'manual'

export interface CleanupInput {
  profileId: number
  /** 环境是否还在回收站（软删除但未彻底删除） */
  inTrash: boolean
  /** 该环境当前是否有活着的窗口 */
  running: boolean
  trigger: CleanupTrigger
}

export type CleanupVerdict =
  | { ok: true; dirName: string }
  | { ok: false; code: CleanupRejectCode; reason: string }

export type CleanupRejectCode = 'invalid_id' | 'still_running' | 'not_purged'

/**
 * 判定能否对某环境的分区执行清理。
 *
 * ## 关键约束：运行中的环境一律不清
 * `clearStorageData()` 会删掉 Chromium 正在使用的存储，窗口里的页面会立刻
 * 出现「登录态丢失 / localStorage 读不到」的诡异报错，而 status 仍是 running，
 * 用户完全看不懂发生了什么。故 `running` 时硬拦。
 */
export function canClearPartition(input: CleanupInput): CleanupVerdict {
  const { profileId, inTrash, running, trigger } = input
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return { ok: false, code: 'invalid_id', reason: '环境 id 非法' }
  }
  if (running) {
    return {
      ok: false,
      code: 'still_running',
      reason: `环境 #${profileId} 的窗口正在运行，请先关闭窗口再清理浏览器数据`
    }
  }
  // 手动清理允许用户主动清自己的在用环境数据（但仍要窗口已关）；
  // 自动清理（purge）必须确认确实已被彻底删除，否则会误删要保留的登录态。
  if (trigger === 'purge' && !inTrash) {
    return {
      ok: false,
      code: 'not_purged',
      reason: `环境 #${profileId} 未处于彻底删除状态，拒绝清理浏览器数据`
    }
  }
  return { ok: true, dirName: partitionDirName(profileId) }
}

/** 清理结果的日志文案（失败必须留痕，绝不静默吞掉） */
export function formatCleanupLog(profileId: number, dirName: string, ok: boolean, detail?: string): string {
  const head = ok ? `[roxy] 已清理环境 #${profileId} 的浏览器数据分区 ${dirName}` : `[roxy] 清理环境 #${profileId} 的浏览器数据分区 ${dirName} 失败`
  return detail ? `${head}：${detail}` : head
}