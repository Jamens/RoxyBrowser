// RPA 变量替换（纯函数，主进程 / 渲染进程共用，可 esbuild 单测）
//
// 脚本步骤里可用 `{{变量名}}` 占位符引用脚本变量；回放前由脚本变量（或回放时传入的覆盖值）
// 替换成真实值。作用字段：navigate.url / input.value / change.value。
// 未定义的占位符保留原样（便于排查「漏配变量」）。

const VAR_RE = /\{\{\s*([\w.\-]+)\s*\}\}/g

export function substituteVars(text: string, vars: Record<string, string | undefined>): string {
  if (!text || !vars || !Object.keys(vars).length) return text
  return text.replace(VAR_RE, (m, key: string) => {
    const v = vars[key]
    return v !== undefined && v !== null ? String(v) : m
  })
}

// 注意：仅对携带 url / value 的步骤做替换，其余步骤（click/scroll/wait）原样透传。
export function substituteSteps<T extends { type: string; url?: string; value?: string }>(
  steps: T[],
  vars: Record<string, string | undefined>
): T[] {
  if (!vars || !Object.keys(vars).length) return steps
  return steps.map((s) => {
    const o = { ...s } as T & { url?: string; value?: string }
    if (typeof o.url === 'string') o.url = substituteVars(o.url, vars)
    if (typeof o.value === 'string') o.value = substituteVars(o.value, vars)
    return o
  })
}

/**
 * 定时执行间隔归一化：非法 / 过小一律回到默认 30 分钟（>=1 才有意义）。
 *
 * 上限 525600（一年）：间隔是「分钟」，用户偶尔会填「7」是想表达每周还是每天，
 * 这里不做语义猜测，只保证不出现 0 / 负数 / 溢出这种会让调度器疯狂重试的值。
 */
export function normalizeScheduleInterval(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 30
  return Math.max(1, Math.min(525600, Math.round(n)))
}

/**
 * RPA 变量：接受对象或 [key,value] 数组，统一规整成 {k: string}；空/ 非法 → null。
 *
 * 返回 null 而非 {} 是有意的：调用方靠它区分「用户没配变量」与「配了空变量」，
 * 前者回放时回退到脚本自带变量，后者就是明确的空。
 */
export function normalizeVariables(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, string> = {}
  if (Array.isArray(v)) {
    for (const item of v as Array<{ key?: unknown; value?: unknown }>) {
      const k = String(item?.key ?? '').trim()
      if (k) out[k] = String(item?.value ?? '')
    }
  } else {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k) out[k] = String(val ?? '')
    }
  }
  return Object.keys(out).length ? out : null
}

/** 变量对象 → 表单数组（编辑弹窗 Form.List 用） */
export function varsToArray(vars: Record<string, string> | undefined | null): Array<{ key: string; value: string }> {
  return Object.entries(vars || {}).map(([key, value]) => ({ key, value: String(value) }))
}

/** 表单数组 → 变量对象（保存时转换；空 key 丢弃） */
export function arrayToVars(arr: Array<{ key?: string; value?: string }> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of arr || []) {
    const k = (item?.key || '').trim()
    if (k) out[k] = item?.value ?? ''
  }
  return out
}
