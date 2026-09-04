import type { LocaleCode } from './locales'

// 国家 / 地区定义：面向跨境电商与海外社媒的主流市场
// timezone 用 IANA 时区名（而非固定 UTC 偏移），这样冬夏令时由运行时按年份规则自动换算
export interface CountryDef {
  /** ISO 3166-1 alpha-2 */
  code: string
  /** 中文名（固定中文，不随界面语言变化，便于中文用户检索） */
  name: string
  /** 英文名 */
  nameEn: string
  /** IANA 时区，如 America/New_York */
  timezone: string
  /** 该国默认界面语言；不在支持列表内的国家统一回落 en-US */
  language: LocaleCode
}

/** 界面支持的语言 */
export const LOCALE_CODES: LocaleCode[] = ['zh-CN', 'en-US', 'ja-JP', 'de-DE']

export const COUNTRIES: CountryDef[] = [
  { code: 'CN', name: '中国', nameEn: 'China', timezone: 'Asia/Shanghai', language: 'zh-CN' },
  { code: 'US', name: '美国', nameEn: 'United States', timezone: 'America/New_York', language: 'en-US' },
  { code: 'GB', name: '英国', nameEn: 'United Kingdom', timezone: 'Europe/London', language: 'en-US' },
  { code: 'DE', name: '德国', nameEn: 'Germany', timezone: 'Europe/Berlin', language: 'de-DE' },
  { code: 'FR', name: '法国', nameEn: 'France', timezone: 'Europe/Paris', language: 'en-US' },
  { code: 'JP', name: '日本', nameEn: 'Japan', timezone: 'Asia/Tokyo', language: 'ja-JP' },
  { code: 'KR', name: '韩国', nameEn: 'South Korea', timezone: 'Asia/Seoul', language: 'en-US' },
  { code: 'SG', name: '新加坡', nameEn: 'Singapore', timezone: 'Asia/Singapore', language: 'en-US' },
  { code: 'AU', name: '澳大利亚', nameEn: 'Australia', timezone: 'Australia/Sydney', language: 'en-US' },
  { code: 'CA', name: '加拿大', nameEn: 'Canada', timezone: 'America/Toronto', language: 'en-US' },
  { code: 'MX', name: '墨西哥', nameEn: 'Mexico', timezone: 'America/Mexico_City', language: 'en-US' },
  { code: 'BR', name: '巴西', nameEn: 'Brazil', timezone: 'America/Sao_Paulo', language: 'en-US' },
  { code: 'RU', name: '俄罗斯', nameEn: 'Russia', timezone: 'Europe/Moscow', language: 'en-US' },
  { code: 'IN', name: '印度', nameEn: 'India', timezone: 'Asia/Kolkata', language: 'en-US' },
  { code: 'ID', name: '印度尼西亚', nameEn: 'Indonesia', timezone: 'Asia/Jakarta', language: 'en-US' },
  { code: 'AE', name: '阿联酋', nameEn: 'United Arab Emirates', timezone: 'Asia/Dubai', language: 'en-US' }
]

const COUNTRY_MAP = new Map(COUNTRIES.map((c) => [c.code, c]))

export function findCountry(code: string | undefined | null): CountryDef | undefined {
  if (!code) return undefined
  return COUNTRY_MAP.get(String(code).toUpperCase())
}

/** 取国家对应的 IANA 时区，未知国家回落 Asia/Shanghai */
export function countryTimezone(code: string | undefined | null): string {
  return findCountry(code)?.timezone || 'Asia/Shanghai'
}

/** 取国家默认界面语言，未知国家回落 zh-CN */
export function countryLanguage(code: string | undefined | null): LocaleCode {
  return findCountry(code)?.language || 'zh-CN'
}

/** 校验并归一化国家代码，非法返回 undefined */
export function normalizeCountry(code: string | undefined | null): string | undefined {
  return findCountry(code)?.code
}
