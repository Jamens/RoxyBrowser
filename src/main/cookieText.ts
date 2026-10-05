/**
 * Cookie 纯函数：实体 → DTO 映射 + 多格式 Cookie 文本解析。
 *
 * 独立成模块的两个理由：
 * 1) **可离线单测**：不依赖 Electron / DB / Express，`tsc` 编成 CJS 即可在 Node 里跑断言
 *    （Netscape / Set-Cookie / JSON 三种格式的解析边界很琐碎，值得用测试钉住）。
 * 2) 路由文件只留「HTTP 与鉴权」，解析逻辑与传输层解耦。
 *
 * 下方 CookieEntity 仅为类型导入，编译期擦除，运行时不依赖 entities。
 */
import type { CookieEntity } from './entities'

export type SameSiteLike = 'no_restriction' | 'lax' | 'strict' | 'unspecified'

/** 实体 → 前端 DTO（日期统一转 ISO 字符串，枚举兜底为 unspecified） */
export function mapCookie(c: CookieEntity) {
  return {
    id: c.id,
    profileId: c.profileId,
    domain: c.domain,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: (c.sameSite as SameSiteLike) || 'unspecified',
    expirationDate: c.expirationDate ? new Date(c.expirationDate).toISOString() : null,
    hostOnly: !!c.hostOnly,
    createdAt: new Date(c.createdAt).toISOString()
  }
}

/**
 * 解析多种格式的 Cookie 文本：Netscape / Set-Cookie（name=value; Domain=...）/ EditThisCookie JSON。
 * 无法解析的行不抛错，而是连同原文片段回传给调用方提示用户。
 */
export function parseCookieText(text: string): { cookies: Partial<CookieEntity>[]; failed: string[] } {
  const failed: string[] = []
  const cookies: Partial<CookieEntity>[] = []
  const trimmed = text.replace(/^﻿/, '').trim()
  if (!trimmed) return { cookies, failed }

  // 整段是 JSON（数组或对象）→ EditThisCookie / 导出格式
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const arr = Array.isArray(JSON.parse(trimmed)) ? JSON.parse(trimmed) : [JSON.parse(trimmed)]
      for (const o of arr) {
        if (!o || !o.name) {
          failed.push(JSON.stringify(o).slice(0, 80))
          continue
        }
        cookies.push({
          domain: o.domain || '',
          name: String(o.name),
          value: o.value != null ? String(o.value) : '',
          path: o.path || '/',
          secure: !!o.secure,
          httpOnly: !!o.httpOnly,
          sameSite: o.sameSite || 'unspecified',
          expirationDate: o.expirationDate ? new Date(o.expirationDate) : null,
          hostOnly: o.hostOnly == null ? true : !!o.hostOnly
        })
      }
    } catch {
      failed.push('JSON 解析失败')
    }
    return { cookies, failed }
  }

  for (let raw of text.split(/\r?\n/)) {
    raw = raw.trim()
    if (!raw || raw.startsWith('# ') || raw.startsWith('//')) continue
    let line = raw
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    }

    // Netscape 格式：7 个 tab 分隔字段
    const tab = line.split('\t')
    if (tab.length >= 7) {
      const [domain, flag, path, secureFlag, exp, name, value] = tab
      const expNum = Number(exp)
      cookies.push({
        domain,
        name,
        value: value || '',
        path: path || '/',
        secure: /^TRUE$/i.test(secureFlag),
        httpOnly,
        sameSite: 'unspecified',
        // flag=TRUE 表示包含子域（hostOnly=false）
        hostOnly: !/^TRUE$/i.test(flag),
        expirationDate: expNum > 0 ? new Date(expNum * 1000) : null
      })
      continue
    }

    // Set-Cookie 风格：name=value; Domain=...; Path=...; Expires=...; Secure; HttpOnly; SameSite=...
    const semi = line.split(';').map((s) => s.trim()).filter(Boolean)
    if (semi.length && semi[0].includes('=')) {
      const [name, ...rest] = semi[0].split('=')
      const cookie: Partial<CookieEntity> = {
        name: name.trim(),
        value: rest.join('=').trim(),
        domain: '',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'unspecified',
        hostOnly: true,
        expirationDate: null
      }
      for (let i = 1; i < semi.length; i++) {
        const seg = semi[i]
        const eq = seg.indexOf('=')
        const key = (eq === -1 ? seg : seg.slice(0, eq)).trim().toLowerCase()
        const val = eq === -1 ? '' : seg.slice(eq + 1).trim()
        if (key === 'domain') {
          cookie.domain = val
          // 带前导点（.example.com）表示含子域 → hostOnly=false；不带点表示仅主机
          cookie.hostOnly = !val.startsWith('.')
        } else if (key === 'path') cookie.path = val || '/'
        else if (key === 'expires') {
          const t = Date.parse(val)
          if (!Number.isNaN(t)) cookie.expirationDate = new Date(t)
        } else if (key === 'max-age') {
          const n = Number(val)
          if (!Number.isNaN(n)) cookie.expirationDate = new Date(Date.now() + n * 1000)
        } else if (key === 'secure') cookie.secure = true
        else if (key === 'httponly') cookie.httpOnly = true
        else if (key === 'samesite') cookie.sameSite = (val.toLowerCase() as SameSiteLike) || 'unspecified'
      }
      if (!cookie.domain) {
        failed.push(raw.slice(0, 80))
        continue
      }
      cookies.push(cookie)
      continue
    }

    failed.push(raw.slice(0, 80))
  }
  return { cookies, failed }
}
