// 体检一致性「一键修复」判定 —— 纯函数，零依赖，可离线单测
//
// 体检目前只能「发现问题」，用户要自己打开编辑弹窗逐项改。多数不一致其实是
// **确定性可修**的：时区该跟代理、语言该跟时区、UA 该跟 OS，改完就自洽了。
// 这个模块只回答一个问题：**给定不一致项，能改哪些？怎么改？**
//
// ## 锚点：谁是「事实」，谁是「配置」
// 修复的核心不是「改成什么」，而是「以谁为准」——同一个不一致可以往两个方向修，
// 方向选错会把原本自洽的一侧改坏：
//
// | 不一致 | 锚点（不可改） | 被改的一方 | 理由 |
// | -- | -- | -- | -- |
// | 时区 ↔ 代理国家 | **代理** | `timezone` | 代理是花钱买的外部事实，改它等于花钱换 IP |
// | 语言 ↔ 时区国家 | **时区** | `languages[0]` | 时区此时已与代理对齐，是更硬的锚 |
// | UA 平台 ↔ 设定 OS | **OS** | `userAgent` / `platform` | OS 决定显卡池 / 字体列表 / 平台 API 一整套，改它会引发新的不一致 |
//
// ## 只修有把握的，其余如实报告不可修
// 最典型的是 UA：移动端 UA 里含**具体设备型号**（Pixel 8 / iPhone 15 Pro…），
// 无法凭空合成一个「合法但具体」的 android/ios UA——瞎编一个只会造出新的破绽。
// 故仅支持 windows ↔ mac 的双向替换（该段替换是 uaOs 解析的严格反向），其余明确返回不可修。

import type { Fingerprint, OSKind } from './types'
import { countryTimezone, countryLanguage, findCountry, COUNTRIES } from './countries'
import { uaOs } from './healthcheck'

export type FixKey = 'tzVsProxy' | 'langVsTz' | 'uaVsOs'

export interface FixProposal {
  key: FixKey
  /** 是否可修 */
  fixable: boolean
  /** 不可修时的原因（**必须**给出，不能静默跳过——否则用户以为「修不了」是工具坏了） */
  reason?: string
  /** 可修时要写入的字段（仅包含真正要改的，其余原样保留） */
  patch?: Partial<Fingerprint>
  /** 人类可读描述，用于确认弹窗与日志 */
  describe?: string
  /** 字段名列表，用于前端做「这些字段会被改」的预览 */
  fields?: string[]
}

/** 修复 UA 里的平台标识段。**只处理桌面端**，与 uaOs 的解析顺序严格反向。 */
const DESKTOP_UA_SEGMENT: Record<'windows' | 'mac', RegExp> = {
  // 匹配 UA 括号里的平台段（第一个括号内的分号前部分）
  windows: /\((?:Windows NT [^;)]+)(?:;[^)]*)?\)/,
  mac: /\((?:Macintosh; Intel Mac OS X [^)]+|Macintosh)(?:;[^)]*)?\)/
}
const DESKTOP_PLATFORM: Record<'windows' | 'mac', string> = { windows: 'Win32', mac: 'MacIntel' }
const DESKTOP_UA_BODY: Record<'windows' | 'mac', string> = {
  windows: '(Windows NT 10.0; Win64; x64)',
  mac: '(Macintosh; Intel Mac OS X 10_15_7)'
}

/**
 * 把 UA 的平台段替换为目标桌面 OS，保留 Chrome 版本号、设备型号等其余部分。
 * 不可换（移动端 ↔ 桌面、或 mac↔mac 无变化）时返回 null。
 */
function replaceUaPlatform(ua: string, target: OSKind): string | null {
  if (target !== 'windows' && target !== 'mac') return null
  // 先剥掉现有的桌面平台段，再插入目标的——避免"替换后又匹配到旧的"
  let next = ua
  if (DESKTOP_UA_SEGMENT.windows.test(next)) next = next.replace(DESKTOP_UA_SEGMENT.windows, DESKTOP_UA_BODY.windows)
  if (DESKTOP_UA_SEGMENT.mac.test(next)) next = next.replace(DESKTOP_UA_SEGMENT.mac, DESKTOP_UA_BODY.mac)
  if (next === ua) {
    // 原 UA 里两种桌面段都没有（如 android UA 换 windows）——能换，但要保留其余部分
    const m = ua.match(/^(Mozilla\/[\d.]+)\s*\(([^)]*)\)(.*)$/)
    if (!m) return null
    const rest = m[3] || ''
    // 去掉移动端 UA 里的 "Mobile Safari"（桌面 UA 不该有），否则会出现
    // "Mozilla/5.0 (Windows NT...) ... Mobile Safari/537.36" 这种自相矛盾的组合
    const cleaned = rest.replace(/\s*Mobile(\s+Safari\/[\d.]+)?/g, '').replace(/\s*Safari\/[\d.]+\s*$/, '')
    next = `${m[1]} ${DESKTOP_UA_BODY[target]}${cleaned}`
  } else {
    // 桌面 ↔ 桌面：把刚插入的目标段换成目标（上面已统一成同一段）
    next = next.replace(DESKTOP_UA_BODY.windows === DESKTOP_UA_BODY[target] ? DESKTOP_UA_BODY.windows : DESKTOP_UA_BODY.mac, DESKTOP_UA_BODY[target])
  }
  return next === ua ? null : next
}

/** 把代理国家名（ip-api 英文名 / 中文名 / 国码）解析成 CountryDef */
function resolveProxyCountry(raw: string | null | undefined) {
  const s = String(raw || '').trim()
  if (!s) return undefined
  return COUNTRIES.find((c) =>
    [c.code, c.name, c.nameEn].some((n) => n.toLowerCase() === s.toLowerCase())
  )
}

/**
 * 为一批「一致性不通过」项产出修复提案。
 *
 * @param fp 环境当前指纹
 * @param proxyCountry 已绑定代理的国家（未绑代理时为空字符串）
 * @param failedKeys 体检结果里 `ok === false` 的 consistency key 列表
 */
export function proposeFixes(
  fp: Partial<Fingerprint> | null | undefined,
  proxyCountry: string | null | undefined,
  failedKeys: string[]
): FixProposal[] {
  const out: FixProposal[] = []
  const f = fp || {}
  const has = (k: FixKey) => failedKeys.includes(k)
  // **串行推演**：三项之间有顺序依赖——时区改完后，语言该匹配的是**新**时区的国家。
  // 并行按旧值算的话，修复会出现「时区已改成纽约、语言却按上海推成 zh-CN」，
  // 一次修完反而更不自洽。故每修一项就把新值代入后续判定。
  const working: Partial<Fingerprint> = { ...f }

  // ---- 1) 时区 ↔ 代理国家：以代理为锚，改时区 ----
  if (has('tzVsProxy')) {
    const c = resolveProxyCountry(proxyCountry)
    if (!c) {
      out.push({
        key: 'tzVsProxy',
        fixable: false,
        reason: proxyCountry
          ? `代理国家「${proxyCountry}」不在内置国家表里，无法推导对应时区；请手动指定时区`
          : '未绑定代理，无从判断应匹配哪个时区'
      })
    } else {
      const tz = countryTimezone(c.code)
      if (tz === f.timezone) {
        out.push({ key: 'tzVsProxy', fixable: false, reason: `时区已是代理国家（${c.name}）对应的 ${tz}，可能是代理国家数据有误` })
      } else {
        working.timezone = tz
        out.push({
          key: 'tzVsProxy',
          fixable: true,
          patch: { timezone: tz },
          describe: `时区改为 ${tz}（匹配代理国家 ${c.name}）`,
          fields: ['timezone']
        })
      }
    }
  }

  // ---- 2) 语言 ↔ 时区国家：以时区为锚，改首选语言 ----
  if (has('langVsTz')) {
    // 时区 → 国家：用 COUNTRIES 反查（与体检 tzToCountry 同一套表，判定口径一致）
    const tzCountry = COUNTRIES.find((x) => x.timezone === String(working.timezone || ''))
    if (!tzCountry) {
      out.push({
        key: 'langVsTz',
        fixable: false,
        reason: `时区 ${working.timezone || '（空）'} 不在内置国家表里，无法推导应匹配的语言；请手动指定`
      })
    } else {
      const want = countryLanguage(tzCountry.code)
      const cur = Array.isArray(working.languages) ? working.languages : []
      if (cur[0] === want) {
        out.push({ key: 'langVsTz', fixable: false, reason: `首选语言已是 ${want}，可能语言的地区码与时区判定口径不一致` })
      } else {
        // 保留其余语言项，只换首个 —— navigator.languages 是数组，改第一个最贴近「改首选语言」的意图，
        // 全换掉会丢掉用户刻意排好的次选顺序。
        const langs = [want, ...cur.filter((x) => x !== want)]
        out.push({
          key: 'langVsTz',
          fixable: true,
          patch: { languages: langs },
          describe: `首选语言改为 ${want}（匹配时区国家 ${tzCountry.name}）`,
          fields: ['languages']
        })
      }
    }
  }

  // ---- 3) UA 平台 ↔ 设定 OS：以 OS 为锚，改 UA + platform ----
  if (has('uaVsOs')) {
    const target = (f.os || '') as OSKind
    const fromUa = uaOs(String(f.userAgent || ''))
    if (fromUa === target) {
      out.push({ key: 'uaVsOs', fixable: false, reason: 'UA 解析出的平台已与设定 OS 一致，可能是判定口径不一致' })
    } else if (target !== 'windows' && target !== 'mac') {
      // 移动端 UA 含具体设备型号（Pixel 8 / iPhone 15 Pro），无法凭空合成合法的 android/ios UA
      out.push({
        key: 'uaVsOs',
        fixable: false,
        reason: `目标系统是 ${target}，UA 需绑定具体设备型号，无法自动生成；请在编辑里手动选择设备`
      })
    } else {
      const ua = replaceUaPlatform(String(f.userAgent || ''), target)
      if (!ua) {
        out.push({ key: 'uaVsOs', fixable: false, reason: `无法从当前 UA（${String(f.userAgent || '').slice(0, 40)}…）解析出可替换的平台段` })
      } else {
        out.push({
          key: 'uaVsOs',
          fixable: true,
          // platform 必须一起改：navigator.platform 与 UA 平台段不一致，
          // 本身就是一条自相矛盾的信号，只改 UA 等于换个地方露馅
          patch: { userAgent: ua, platform: DESKTOP_PLATFORM[target] },
          describe: `UA 平台改为 ${target}（同步更新 navigator.platform）`,
          fields: ['userAgent', 'platform']
        })
      }
    }
  }

  return out
}

/** 合并多个提案的 patch；冲突时后者不覆盖前者（同一字段被两个提案指向即视为冲突） */
export function mergePatches(proposals: FixProposal[]): { patch: Partial<Fingerprint>; conflicts: string[] } {
  const patch: Partial<Fingerprint> = {}
  const owner: Record<string, string> = {}
  const conflicts: string[] = []
  for (const p of proposals) {
    if (!p.fixable || !p.patch) continue
    for (const [k, v] of Object.entries(p.patch)) {
      if (owner[k] && owner[k] !== p.key) {
        conflicts.push(k)
        continue
      }
      owner[k] = p.key
      ;(patch as Record<string, unknown>)[k] = v
    }
  }
  return { patch, conflicts }
}

/** 汇总成一句可执行摘要，用于确认弹窗与日志 */
export function fixSummary(proposals: FixProposal[]): string {
  const ok = proposals.filter((p) => p.fixable)
  const no = proposals.filter((p) => !p.fixable)
  const parts: string[] = []
  if (ok.length) parts.push(`可修 ${ok.length} 项：${ok.map((p) => p.describe).join('；')}`)
  if (no.length) parts.push(`不可修 ${no.length} 项：${no.map((p) => p.reason).join('；')}`)
  return parts.join('。') || '没有需要修复的不一致项'
}