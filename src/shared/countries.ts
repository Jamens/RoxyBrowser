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

/**
 * 按 **代码 / 中文名 / 英文名** 模糊匹配国家（大小写不敏感）。
 *
 * ## 为什么需要这个函数
 *
 * `findCountry` 只认**代码**（走 COUNTRY_MAP），但代理检测拿到的 `country` 是
 * ip-api 返回的**英文名**（"United States"），两者根本对不上——
 * 直接拿 `findCountry(p.country)` 查永远查不到，会让「出口失配」判定恒为空。
 *
 * `healthFix` 的 `resolveProxyCountry` 早就需要这个宽松匹配（它要靠代理国家反推时区），
 * 但当时写成了**私有函数**，别处无从复用——于是每个「按代理国家反查」的地方
 * 都会各写一套匹配规则，最后口径必然漂移
 * （体检说"不一致"、代理列表说"一致"，用户只会怀疑工具坏了）。
 *
 * 现改为共享实现：`healthFix` 与 `proxyDrift` 都走它，判定口径只有一处。
 */
export function findCountryLoose(raw: string | undefined | null): CountryDef | undefined {
  const s = String(raw || '').trim()
  if (!s) return undefined
  const lower = s.toLowerCase()
  return COUNTRIES.find((c) => [c.code, c.name, c.nameEn].some((n) => String(n).toLowerCase() === lower))
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
