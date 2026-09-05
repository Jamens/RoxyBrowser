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
