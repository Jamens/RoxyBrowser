import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'auto'

// 自动模式时段：7:00（含）至 18:00（不含）为白天，其余为黑夜
export function resolveDark(mode: string): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  const h = new Date().getHours()
  return !(h >= 7 && h < 18)
}

// 全局唯一主题判定：App 与 Layout 共用，避免多处重复实现导致口径不一致
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() =>
    resolveDark(localStorage.getItem('roxy_theme') || 'auto')
  )

  useEffect(() => {
    const sync = () => setIsDark(resolveDark(localStorage.getItem('roxy_theme') || 'auto'))
    window.addEventListener('roxy-theme-change', sync)
    // 自动模式每分钟重算一次，确保跨过 7:00 / 18:00 边界时自动切换
    const timer = setInterval(() => {
      if ((localStorage.getItem('roxy_theme') || 'auto') === 'auto') sync()
    }, 60_000)
    return () => {
      window.removeEventListener('roxy-theme-change', sync)
      clearInterval(timer)
    }
  }, [])

  return isDark
}
