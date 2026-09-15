import type { OperationLogEntity } from './entities'

/**
 * 操作日志导出（CSV / JSON）纯函数层。
 * 与 webhook.ts 同构：不含 express 依赖，可离线单测。
 */

// CSV 字段转义：含逗号 / 引号 / 换行时整体加双引号，内部引号翻倍。
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

const CSV_HEADERS = ['id', 'createdAt', 'teamId', 'userId', 'username', 'action', 'detail', 'sensitive']

/**
 * 把操作日志拼成带 UTF-8 BOM 的 CSV 文本。
 * createdAt 输出 ISO UTC（审计溯源 unambiguous），敏感标记输出 0/1。
 */
export function logsToCsv(logs: OperationLogEntity[]): string {
  const rows = logs.map((l) =>
    [l.id, l.createdAt.toISOString(), l.teamId, l.userId, l.username, l.action, l.detail, l.sensitive ? 1 : 0]
      .map(escapeCsvField)
      .join(',')
  )
  return '﻿' + [CSV_HEADERS.join(','), ...rows].join('\r\n')
}

export function logsToJson(logs: OperationLogEntity[]): string {
  return JSON.stringify(logs, null, 2)
}

// 导出文件名时间戳：YYYYMMDD-HHmmss（本地时间，便于用户辨识）
export function exportStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}
