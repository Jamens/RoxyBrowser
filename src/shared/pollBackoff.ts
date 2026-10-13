/**
 * 轮询退避工具：让高频轮询在遇到限流时自动放缓，而不是继续加压。
 *
 * ## 为什么需要
 * 全站有多处 `setInterval` 轮询（环境列表 5s、窗口状态 3s、日志 10s、RPA 5s…），
 * 而默认接口限额只有 120 次/分钟。单个页面的轮询就吃掉 20~30 次/分钟，
 * 再叠加用户点击，撞限流很容易。
 *
 * 更糟的是**限流后仍继续轮询**：每次 429 依然算一次请求，会让限流窗口一直不恢复，
 * 形成「越限流越打、越打越限流」的负反馈——用户看到的现象是
 * 「提示请求过于频繁，然后过一会儿自己又好了」。
 *
 * ## 策略
 * 遇 429 时按 `Retry-After`（服务端给的建议秒数）暂停轮询，且带**上限**，
 * 避免服务端给了个 300 秒就真等 5 分钟。恢复后回到正常间隔。
 * 非 429 的错误不改变节奏——那通常是个别接口的问题，不该拖慢整个轮询。
 */

/** 限流时的最大退避时长（秒）。超过则截断，避免「等几分钟」失去可用性 */
export const MAX_BACKOFF_SEC = 60

export interface PollOptions {
  /** 正常间隔（毫秒） */
  intervalMs: number
  /** 执行一次；返回 false 表示本次失败（用于判定是否需要退避） */
  fn: () => Promise<unknown>
  /** 页面隐藏时是否暂停（默认 true：后台标签页没必要轮询） */
  pauseWhenHidden?: boolean
  /** 退避时的回调，用于给用户提示 */
  onRateLimited?: (retryAfterSec: number) => void
}

/**
 * 创建可暂停、可退避的轮询器。
 * 返回值需在组件卸载时调用 `stop()`，否则定时器会泄漏。
 */
export function createPoller(opts: PollOptions): { stop: () => void } {
  const { intervalMs, fn, pauseWhenHidden = true, onRateLimited } = opts
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let backoffUntil = 0

  const tick = async () => {
    if (stopped) return
    // 退避未到期：直接安排到退避结束，不再发请求
    const now = Date.now()
    if (now < backoffUntil) {
      schedule(backoffUntil - now)
      return
    }
    try {
      await fn()
    } catch (e) {
      const anyErr = e as { isRateLimited?: boolean; retryAfterSec?: number }
      if (anyErr?.isRateLimited) {
        const sec = Math.min(anyErr.retryAfterSec || 3, MAX_BACKOFF_SEC)
        backoffUntil = Date.now() + sec * 1000
        onRateLimited?.(sec)
        schedule(sec * 1000)
        return
      }
      // 其他错误：保持原节奏，不拖慢
    }
    schedule(intervalMs)
  }

  const schedule = (delay: number) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void tick(), delay)
  }

  // 页面切到后台时暂停：用户自己都看不见，没必要继续打接口。
  // 切回前台立即补一次，让用户看到最新数据而不必干等一个完整周期。
  const onVisibility = () => {
    if (!pauseWhenHidden) return
    if (typeof document === 'undefined') return
    if (document.hidden) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    } else if (!stopped && !timer) {
      void tick()
    }
  }
  if (pauseWhenHidden && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  void tick()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (pauseWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }
}

/** 人类可读的等待时长文案（「5 秒」/「1 分 30 秒」） */
export function formatRetryAfter(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`
}