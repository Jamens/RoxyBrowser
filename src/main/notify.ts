import { Notification } from 'electron'
import type { AppSettings } from '../shared/types'
import {
  classifyNotification,
  normalizeNotifyEvents,
  shouldToast,
  NOTIFY_CATEGORY_LABELS,
  type NotifyCategory
} from '../shared/notifications'

/**
 * 桌面通知（操作系统通知中心弹窗）。
 *
 * 定位：与应用内通知中心（routes/notifications.ts + 前端铃铛）是**两层**——
 * 弹窗负责「用户不在场时主动触达」，铃铛负责「事后可回溯」。
 * 因此这里的所有过滤（白名单 / 订阅 / 去重）都只影响弹窗，不影响铃铛的完整性。
 *
 * 为什么弹窗也做分类订阅：四个来源里只有漂移是「事态正在恶化」，
 * 其余三类用户可能只想在应用内看。全开全关之间需要粒度，
 * 而 webhook 已有的 events 数组语义在这里不适用（那里是事件名，这里是分类）。
 */

/** 同一团队同一分类的弹窗抑制窗口：一次巡检可能打一片漂移，逐个弹等于刷屏 */
const TOAST_DEBOUNCE_MS = 60_000
/** 抑制表上限：teamId × 分类数量有界，防御性截顶避免异常数据把 Map 撑大 */
const DEBOUNCE_MAP_CAP = 500

let toastConfig: { enabled: boolean; events: NotifyCategory[]; language: string } = {
  enabled: true,
  events: normalizeNotifyEvents(null),
  // 界面语言只影响弹窗标题措辞；刷新点见 refreshNotifyConfig（与设置读取同路）
  language: 'zh-CN'
}

/** 弹窗被点击时把主窗口带到前台（由 index.ts 注入，避免本模块反向依赖窗口管理） */
let focusMainWindow: (() => void) | null = null

/** 主窗口是否聚焦：聚焦时跳过弹窗（用户正看着界面，铃铛会更新，弹窗纯属噪音） */
let isMainWindowFocused: (() => boolean) | null = null

const lastToastAt = new Map<string, number>()

/** 由 server.ts 的 getSettings() 在每次读设置后调用，与 webhook 缓存同一条刷新路径 */
export function refreshNotifyConfig(s: AppSettings): void {
  toastConfig = {
    enabled: !!s.desktopNotifyEnabled,
    events: normalizeNotifyEvents(s.desktopNotifyEvents),
    language: s.language || 'zh-CN'
  }
}

/** 注入窗口交互回调（index.ts 启动后调用一次） */
export function setNotifyWindowHooks(hooks: {
  focus: () => void
  isFocused: () => boolean
}): void {
  focusMainWindow = hooks.focus
  isMainWindowFocused = hooks.isFocused
}

/** 测试弹窗（设置页「发送测试通知」）：绕过订阅与去重，强制弹一条 */
export function sendTestNotification(): { ok: boolean; error?: string } {
  if (!Notification.isSupported()) return { ok: false, error: '当前平台不支持系统通知' }
  try {
    const n = new Notification({
      title: 'RoxyBrowser 通知测试',
      body: '桌面通知已正常工作。代理漂移、自动换绑、到期预警与安全告警都会这样提醒你。'
    })
    n.on('click', () => focusMainWindow?.())
    n.show()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 事件发生时调用（与 dispatchWebhook 并列，见 server.ts 三处日志写入点）。
 * fire-and-forget：同步路径上只做内存判定，弹窗异步，绝不阻塞业务。
 */
export function dispatchDesktopNotification(
  event: string,
  ctx: {
    teamId: number | null
    detail: unknown
  }
): void {
  const meta = classifyNotification(event)
  if (!meta) return
  if (!shouldToast(event, toastConfig)) return
  // 聚焦中不弹：界面上的铃铛会即时反映，系统弹窗此时只会叠加噪音
  if (isMainWindowFocused?.()) return
  if (!Notification.isSupported()) return

  // 去重：同团队同分类 60s 内只弹第一条（铃铛里仍能看到全部）
  const key = `${ctx.teamId ?? 0}:${meta.category}`
  const now = Date.now()
  const last = lastToastAt.get(key) ?? 0
  if (now - last < TOAST_DEBOUNCE_MS) return
  if (lastToastAt.size >= DEBOUNCE_MAP_CAP) lastToastAt.clear()
  lastToastAt.set(key, now)

  const lang = toastConfig.language as keyof typeof NOTIFY_CATEGORY_LABELS[NotifyCategory]
  const label = NOTIFY_CATEGORY_LABELS[meta.category][lang] || NOTIFY_CATEGORY_LABELS[meta.category]['zh-CN']
  const body = typeof ctx.detail === 'string' ? ctx.detail : JSON.stringify(ctx.detail)

  try {
    const n = new Notification({
      title: label,
      body: body.length > 200 ? body.slice(0, 200) + '…' : body,
      // 紧急度映射到系统层：error 类（登录被锁）用弹窗式，其余用横幅
      urgency: meta.severity === 'error' ? 'critical' : 'normal'
    })
    n.on('click', () => focusMainWindow?.())
    n.show()
  } catch (e) {
    // 弹窗失败绝不能影响业务：静默记录即可（铃铛那条路不受影响）
    console.warn('[notify] 桌面通知发送失败:', e instanceof Error ? e.message : String(e))
  }
}
