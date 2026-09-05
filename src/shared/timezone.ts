// 时区工具：全部基于 IANA 时区名（如 America/New_York）实时换算，
// 冬夏令时（DST）由运行时的时区数据库按当年的实际规则自动处理，无需手工维护偏移表。
/* eslint-disable @typescript-eslint/no-explicit-any */

const PART_OPTS: Intl.DateTimeFormatOptions = {
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
}

type Parts = Record<string, number>

function partsInZone(timeZone: string, date: Date): Parts {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, ...PART_OPTS })
  const out: Parts = {}
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return out
}

/**
 * 取指定 IANA 时区当前的本地小时（0-23）。
 * 注意：hour12:false 在部分引擎里午夜会给出 "24"，因此统一 % 24 兜底。
 */
export function localHourInTimeZone(timeZone: string, date: Date = new Date()): number {
  try {
    const h = partsInZone(timeZone, date).hour
    return Number.isFinite(h) ? ((h % 24) + 24) % 24 : new Date().getHours()
  } catch {
    // 时区名非法（老运行库）时退回宿主机本地时间，保证不崩
    return date.getHours()
  }
}

/**
 * 取指定时区当前的 UTC 偏移（分钟）。
 * 语义与 Date.getTimezoneOffset() **相反**：北京 UTC+8 返回 480，纽约 UTC-4 返回 -240。
 */
export function timeZoneUtcOffsetMinutes(timeZone: string, date: Date = new Date()): number {
  try {
    const p = partsInZone(timeZone, date)
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
    return Math.round((asUTC - date.getTime()) / 60000)
  } catch {
    return -date.getTimezoneOffset()
  }
}

/**
 * 当前是否处于夏令时。
 * 做法：取该时区同年 1 月与 7 月的偏移，较小者为「标准时」（南北半球通用——
 * 北半球冬季标准时更小，南半球夏季反而更大，取 min 恰好都是标准时）。
 * 当前偏移大于标准时即为夏令时。
 */
export function isDaylightSaving(timeZone: string, date: Date = new Date()): boolean {
  try {
    const y = date.getFullYear()
    const jan = timeZoneUtcOffsetMinutes(timeZone, new Date(y, 0, 1))
    const jul = timeZoneUtcOffsetMinutes(timeZone, new Date(y, 6, 1))
    const standard = Math.min(jan, jul)
    return timeZoneUtcOffsetMinutes(timeZone, date) > standard
  } catch {
    return false
  }
}

/** 格式化为 UTC+08:00 / UTC-04:00 */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `UTC${sign}${hh}:${mm}`
}

/** 格式化指定时区的当前时间为 HH:mm */
export function formatTimeInZone(timeZone: string, date: Date = new Date()): string {
  try {
    const p = partsInZone(timeZone, date)
    return `${String(p.hour % 24).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  } catch {
    return '--:--'
  }
}

/**
 * 把一个 UTC（或任意时区）时间字符串，按指定 IANA 时区格式化为 'YYYY-MM-DD HH:mm[:ss]'。
 * 用途：操作日志 / RPA 更新时间等需要「按用户所选地区」展示，而不是按数据库存储的 UTC。
 * 全程用 Intl.DateTimeFormat 在目标时区逐字段换算，冬夏令时由运行时处理。
 */
export function formatDateTimeInZone(iso: string, timeZone: string, withSeconds = true): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return String(iso ?? '')
  try {
    const p = partsInZone(timeZone, date)
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = `${p.year}-${pad(p.month)}-${pad(p.day)}`
    const t = `${pad(p.hour % 24)}:${pad(p.minute)}` + (withSeconds ? `:${pad(p.second)}` : '')
    return `${d} ${t}`
  } catch {
    return String(iso)
  }
}

/** 一次性给出展示所需的全部时区信息（设置页的国家选择器用） */
export function describeTimeZone(timeZone: string, date: Date = new Date()) {
  const offset = timeZoneUtcOffsetMinutes(timeZone, date)
  return {
    offset,
    offsetText: formatUtcOffset(offset),
    localTime: formatTimeInZone(timeZone, date),
    dst: isDaylightSaving(timeZone, date)
  }
}
