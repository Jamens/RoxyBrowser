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

/**
 * 常见变量名的中文显示名（**纯展示层**，不参与步骤替换）。
 *
 * 回放弹窗此前把 `{{keyword}}` 这类**模板字面量**直接当字段名渲染 —— 那是
 * 步骤里给引擎看的写法，不是给人看的标签。用户从市场装完脚本看到一串英文
 * 占位符，第一反应是「模板没渲染 / 脚本坏了」。市场脚本的 9 个变量全部在此收录；
 * 用户自建脚本的任意变量名走 `variableLabel` 的回退分支。
 *
 * 维护约定：往 `main/rpaMarket.ts` 加新预设变量时，必须同步加到这里，
 * 否则 UI 又会露出裸英文名。源码级守卫 tests/rpaVariableUx.test.cjs 会拦截。
 */
export const RPA_VARIABLE_LABELS: Record<string, string> = {
  keyword: '搜索关键词',
  query: '搜索词',
  domain: '域名',
  productUrl: '商品链接',
  loginUrl: '登录页地址',
  username: '账号',
  password: '密码',
  composeUrl: '发布页地址',
  content: '正文内容'
}

/** 变量在 UI 上的可读名字：未收录时回退到变量名本身（**绝不再拼 {{}}**） */
export function variableLabel(key: string): string {
  const k = String(key || '').trim()
  return RPA_VARIABLE_LABELS[k] || k
}

/**
 * 合并「脚本自带变量」与「回放时的覆盖值」，供 run 接口生成最终变量表。
 *
 * ## 修的是什么
 * UI 写着「留空则用脚本默认值」，旧实现却是：只要 body 带 variables 对象就
 * **整体替换**。回放弹窗把默认值预填进输入框，用户一清空 → 传 `{keyword:''}`
 * → `substituteVars` 把 `{{keyword}}` 换成空串 → 打开 `?k=` 空搜索页。
 * 提示语与真实行为相反，且没有任何报错。
 *
 * ## 语义
 * - 覆盖值为空串 / 纯空白 / 缺失 → 回退到脚本默认值；
 * - 非空覆盖值 → 按原名覆盖（值本身不做 trim，保留用户输入的空格）；
 * - 只接受 base 里已有的键：回放时不该凭空造出新变量。
 *
 * 取舍：本约定下「把某变量替换成空串」不可用，需要清空请在「编辑脚本」里
 * 改默认值。这与弹窗提示一致，且避免了「空串」既是有效值又是哨兵的歧义。
 */
export function mergeRunVariables(
  base: Record<string, string> | null | undefined,
  override: Record<string, string | undefined> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...(base || {}) }
  if (!override || typeof override !== 'object') return out
  for (const [k, v] of Object.entries(override)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) continue
    const s = v === undefined || v === null ? '' : String(v)
    if (s.trim() !== '') out[k] = s
  }
  return out
}
