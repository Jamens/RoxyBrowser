/**
 * 环境到期时间（生命周期管理，候选③：对标竞品订阅到期，去计费本地化版）。
 *
 * 遵守项目规则 #24「不新增数据库列」：到期时间承载于 ProfileEntity.fingerprint
 * 这一 JSON 列内，键名 `expiresAt`（ISO 字符串；留空 / 不存在 = 长期有效）。
 *
 * 之所以能放进 fingerprint 而不被 `normalizeFingerprint` 抹掉：
 * 归一化逻辑是 `{ ...base, ...fp, ...覆盖项 }`，传入指纹原样经 `...fp` 展开，
 * 因此自定义键会被保留（见 tests/envExpiry.test.cjs 的不变量测试）。
 *
 * 这两个纯函数零依赖、可在 main / renderer 共用，且适合离线单测。
 */

/** 从指纹对象读取环境到期时间（ISO 字符串）；非法 / 缺失返回 null。参数放宽到 unknown，兼容 Fingerprint 与 Record<string, unknown> 两种形态 */
export function getEnvExpiresAt(fp?: unknown): string | null {
  if (!fp || typeof fp !== 'object') return null
  const v = (fp as Record<string, unknown>).expiresAt
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * 返回一个「写入 / 清除到期时间」后的新指纹对象（不修改入参）。
 * - iso 非空：写入 expiresAt
 * - iso 为 null / 空：删除 expiresAt 键（清空到期 = 长期有效）
 */
export function withEnvExpiresAt(fp: Record<string, unknown>, iso: string | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fp }
  if (iso) next.expiresAt = iso
  else delete (next as Record<string, unknown>).expiresAt
  return next
}
