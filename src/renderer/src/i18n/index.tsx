import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LocaleCode } from '@shared/locales'
import { DEFAULT_LOCALE, findLocale } from '@shared/locales'
import { messages, type MessageDict, type MessageKey } from './messages'
import { antdLocaleFor, applyDayjsLocale } from './antdLocale'

export const LOCALE_STORAGE_KEY = 'roxy_language'
export const LOCALE_CHANGE_EVENT = 'roxy-locale-change'

// 模块级当前语言：供非 React 场景（工具函数、message 提示等）同步读取。
// React 组件内请用 useT()，保证语言切换后随上下文重渲染。
let currentLocale: LocaleCode = readStoredLocale()

function readStoredLocale(): LocaleCode {
  try {
    return findLocale(localStorage.getItem(LOCALE_STORAGE_KEY))?.code || DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function getLocale(): LocaleCode {
  return currentLocale
}

/** 简单插值：把文案里的 {name} 换成传入的变量 */
function interpolate(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/**
 * 翻译。优先取当前语言，缺失时回落简体中文，再缺失则返回 key 本身，
 * 这样未翻译项会暴露成 key 而不是空白或崩溃。
 */
export function translate(
  locale: LocaleCode,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const dict: Partial<MessageDict> = messages[locale] || {}
  const fallback: Partial<MessageDict> = messages[DEFAULT_LOCALE] || {}
  const tpl = dict[key] ?? fallback[key]
  if (tpl === undefined) return key
  return interpolate(tpl, vars)
}

/** 非 React 场景的翻译入口（读取模块级当前语言） */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale, key, vars)
}

export type TranslateFn = (key: MessageKey, vars?: Record<string, string | number>) => string

interface I18nValue {
  locale: LocaleCode
  setLocale: (next: LocaleCode) => void
  t: TranslateFn
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars)
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(() => getLocale())

  const setLocale = useCallback((next: LocaleCode) => {
    currentLocale = next
    applyDayjsLocale(next)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      /* 隐私模式下 localStorage 不可用时忽略 */
    }
    setLocaleState(next)
    window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT))
  }, [])

  // 设置页保存后语言可能变化，这里同步跟随（localStorage 已在 Settings 侧写入）
  useEffect(() => {
    const sync = () => {
      const next = readStoredLocale()
      if (next !== currentLocale) {
        currentLocale = next
        applyDayjsLocale(next)
        setLocaleState(next)
      }
    }
    window.addEventListener(LOCALE_CHANGE_EVENT, sync)
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, sync)
  }, [])

  // 首次挂载时把 dayjs 对齐当前语言
  useEffect(() => {
    applyDayjsLocale(locale)
  }, [locale])

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

/** 组件内常用：只拿翻译函数 */
export function useT(): TranslateFn {
  return useI18n().t
}

export { antdLocaleFor }
