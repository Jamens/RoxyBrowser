import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import jaJP from 'antd/locale/ja_JP'
import deDE from 'antd/locale/de_DE'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/en'
import 'dayjs/locale/ja'
import 'dayjs/locale/de'
import type { LocaleCode } from '@shared/locales'
import { DEFAULT_LOCALE, findLocale } from '@shared/locales'

// antd 与 dayjs 的语言包跟界面语言联动（日期选择器、空状态、分页文案等）
const ANTD_LOCALES = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
  'de-DE': deDE
} as const

export type AntdLocale = (typeof ANTD_LOCALES)[LocaleCode]

export function antdLocaleFor(code: string | undefined | null): AntdLocale {
  const key = findLocale(code)?.code || DEFAULT_LOCALE
  return ANTD_LOCALES[key]
}

export function applyDayjsLocale(code: string | undefined | null): void {
  try {
    dayjs.locale(findLocale(code)?.dayjs || 'zh-cn')
  } catch {
    /* dayjs locale 注册失败不影响主流程 */
  }
}
