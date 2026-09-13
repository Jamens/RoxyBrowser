import dayjs from 'dayjs'

export type ExpiryLevel = 'expired' | 'soon' | null

export interface ExpiryInfo {
  level: ExpiryLevel
  /** 负数 = 已过期天数；0 = 当日到期；正数 = 剩余天数 */
  days: number | null
}

/**
 * 计算代理到期预警级别。
 * - 已过期 → 'expired'
 * - warnDays 天内到期（含当日）→ 'soon'
 * - 否则 → null（长期有效或安全）
 */
export function expiryWarn(expiresAt: string | null | undefined, warnDays = 3): ExpiryInfo {
  if (!expiresAt) return { level: null, days: null }
  const exp = dayjs(expiresAt)
  if (!exp.isValid()) return { level: null, days: null }
  const diffMs = exp.valueOf() - Date.now()
  const days = Math.floor(diffMs / 86_400_000)
  if (diffMs < 0) return { level: 'expired', days }
  if (days <= warnDays) return { level: 'soon', days }
  return { level: null, days }
}

/** 用于紧凑展示的预警文案：已过期 N 天 / 今日到期 / 剩 N 天 */
export function expiryLabel(info: ExpiryInfo): string | null {
  if (!info.level) return null
  if (info.level === 'expired') return `已过期 ${-(info.days ?? 0)} 天`
  if (info.days != null && info.days <= 0) return '今日到期'
  return `剩 ${info.days} 天`
}
