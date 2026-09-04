import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'auto'

// 自动模式时段：7:00（含）至 18:00（不含）为白天，其余为黑夜
export function resolveDark(mode: string): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  const h = new Date().getHours()
  return !(h >= 7 && h < 18)
}

// 模块级单一定时器 + 订阅者集合：无论多少个组件调用 useIsDark，
// 只要还有挂载的订阅者就只存在「一个」60s 定时器，全部卸载后自动清理，
// 避免每个 useIsDark 实例各起一个定时器（原 App + Layout 会起两个）。
const subscribers = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function notify() {
  subscribers.forEach((fn) => fn())
}

function ensureTimer() {
  if (timer !== null) return
  timer = setInterval(() => {
    // 仅自动模式需随时间重算，其余模式不会因时间变化
    if ((localStorage.getItem('roxy_theme') || 'auto') === 'auto') notify()
  }, 60_000)
}

function clearTimerIfIdle() {
  if (subscribers.size === 0 && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

// 全局唯一主题判定：App 与 Layout 共用，避免多处重复实现导致口径不一致
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() =>
    resolveDark(localStorage.getItem('roxy_theme') || 'auto')
  )

  useEffect(() => {
    const sync = () => setIsDark(resolveDark(localStorage.getItem('roxy_theme') || 'auto'))
    window.addEventListener('roxy-theme-change', sync)
    subscribers.add(sync)
    ensureTimer()
    return () => {
      window.removeEventListener('roxy-theme-change', sync)
      subscribers.delete(sync)
      clearTimerIfIdle()
    }
  }, [])

  return isDark
}
