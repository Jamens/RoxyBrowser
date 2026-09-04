// 界面支持的语言。语言名一律用「该语言自身」书写，避免切换语言后看不懂选项
export type LocaleCode = 'zh-CN' | 'en-US' | 'ja-JP' | 'de-DE'

export interface LocaleDef {
  code: LocaleCode
  /** 该语言的自称（原生名） */
  nativeName: string
  /** 英文标注，便于不懂该语言时辨认 */
  englishName: string
  /** antd 语言包模块名（ConfigProvider locale） */
  antd: 'zh_CN' | 'en_US' | 'ja_JP' | 'de_DE'
  /** dayjs 语言包名（日期组件） */
  dayjs: 'zh-cn' | 'en' | 'ja' | 'de'
}

export const LOCALES: LocaleDef[] = [
  { code: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)', antd: 'zh_CN', dayjs: 'zh-cn' },
  { code: 'en-US', nativeName: 'English', englishName: 'English', antd: 'en_US', dayjs: 'en' },
  { code: 'ja-JP', nativeName: '日本語', englishName: 'Japanese', antd: 'ja_JP', dayjs: 'ja' },
  { code: 'de-DE', nativeName: 'Deutsch', englishName: 'German', antd: 'de_DE', dayjs: 'de' }
]

export const DEFAULT_LOCALE: LocaleCode = 'zh-CN'

const LOCALE_MAP = new Map(LOCALES.map((l) => [l.code, l]))

export function findLocale(code: string | undefined | null): LocaleDef | undefined {
  if (!code) return undefined
  return LOCALE_MAP.get(code as LocaleCode)
}

/** 校验并归一化语言代码，非法返回 undefined */
export function normalizeLocale(code: string | undefined | null): LocaleCode | undefined {
  return findLocale(code)?.code
}

export function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === 'string' && LOCALE_MAP.has(v as LocaleCode)
}
