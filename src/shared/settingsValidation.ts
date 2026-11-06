/**
 * 设置页「保存」的校验与载荷合并 —— 纯函数（无 React / Electron 依赖，可离线单测）。
 *
 * ## 要解决什么
 *
 * antd 的 `form.validateFields()` 校验的是**整个表单**：任一字段不过，整次保存就被拒
 * （连 `api.put` 都不会发出）。这意味着**任何一个可选功能的必填项，都会静默阻塞
 * 所有其它设置的保存**。
 *
 * 本项目踩过这个坑：SMTP（仅「团队空间 → 邮箱邀请成员」用到的**可选**功能）的
 * host / user / pass 挂着无条件 `required`，而三者的默认值是空串 —— 于是「没配 SMTP」
 * 的用户连设置页都存不下去：改了 AI Agent 开关与视觉模型，点保存没反应，重新进页面
 * 又变回原值，看起来像「被系统恢复」。
 *
 * 对应的两条修法：
 *
 * 1. **可选功能的必填要条件化**：没配就放行，填了一半才要求填全
 *    （见 `missingSmtpFields`）。
 * 2. **条件渲染卸载的字段不能丢**：antd 的 `validateFields()` 只返回**当前挂载**的
 *    字段；设置页大量用条件渲染（如 backend 切到 cloud 后本地模型字段被卸载），
 *    卸载字段的值不在返回值里，服务端会用默认值补齐 → 用户改过的东西被抹掉
 *    （见 `mergeSettingsPayload`）。
 */

/** SMTP 三件套：服务器 / 账号 / 密码 —— 三者同进同出 */
export type SmtpTripleField = 'host' | 'user' | 'pass'

export const SMTP_TRIPLE_FIELDS: readonly SmtpTripleField[] = ['host', 'user', 'pass']

export interface SmtpConfigLike {
  host?: string | null
  user?: string | null
  pass?: string | null
  port?: number | null
}

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** SMTP 是否「已开始配置」：三件套任一有值即视为启用 */
export function smtpConfigured(smtp: SmtpConfigLike | null | undefined): boolean {
  if (!smtp) return false
  return SMTP_TRIPLE_FIELDS.some((f) => trimmed(smtp[f]) !== '')
}

/**
 * SMTP 三件套里还缺哪些。
 *
 * - 全空 → `[]`：SMTP 是可选功能，未配置必须放行，否则会拦死整个设置页的保存
 *   （这正是「改了 AI Agent 却存不进去」的根因）。
 * - 填了任一项 → 缺的那几项：用户既然开始配了，就得配全，否则邀请邮件发不出去。
 */
export function missingSmtpFields(smtp: SmtpConfigLike | null | undefined): SmtpTripleField[] {
  if (!smtpConfigured(smtp)) return []
  const s = smtp as SmtpConfigLike
  return SMTP_TRIPLE_FIELDS.filter((f) => trimmed(s[f]) === '')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 合并「表单全量 store」与「校验通过的值」，产出真正要 PUT 的载荷。
 *
 * @param full      `form.getFieldsValue(true)` —— 含条件渲染卸载后仍保留在 store 里的值
 * @param validated `form.validateFields()` 的返回值 —— 只含**当前挂载**的字段
 *
 * 为什么要合：antd 的 `Form.Item` 默认 `preserve`，字段被条件渲染卸载后**值仍留在
 * store 里**，只是不再出现在 `validateFields()` 的返回值中。若只发返回值，服务端
 * （`{ ...defaultSettings, ...body }` + 对 aiAgent 的默认值补齐）会用默认值把那些
 * 字段填回去 —— 用户切走再切回来，发现自己配的模型名「被恢复」了。
 *
 * 嵌套对象（`aiAgent` / `smtp`）做一层浅合并：校验后的值覆盖同名字段，
 * 未挂载因而未提交的字段保留 store 里的原值。
 */
export function mergeSettingsPayload(
  full: Record<string, unknown> | null | undefined,
  validated: object | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(full || {}) }
  const entries = Object.entries((validated || {}) as Record<string, unknown>)
  for (const [k, v] of entries) {
    // undefined = 这次没提交这个字段，不能拿它去覆盖 store 里的既有值
    if (v === undefined) continue
    const fv = out[k]
    if (isPlainObject(fv) && isPlainObject(v)) {
      const merged: Record<string, unknown> = { ...fv }
      for (const [nk, nv] of Object.entries(v)) {
        if (nv !== undefined) merged[nk] = nv
      }
      out[k] = merged
    } else {
      out[k] = v
    }
  }
  return out
}
