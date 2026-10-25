/**
 * 通知中心（应用内铃铛 + 桌面通知）的共享纯逻辑。
 *
 * 设计要点：**通知不新建存储**，它是操作日志的一张「值得主动告知」的视图。
 * 代理出口漂移 / 自动换绑 / 到期预警 / 登录锁定这些事件本来就写进了
 * operation_logs（并推 webhook），此处只回答三个问题：
 *   1. 哪些 action 算「值得通知」（NOTIFY_EVENT_MAP 白名单，其余一律不通知）；
 *   2. 每条通知长什么样（分类 / 严重度 / 该跳转到哪个页面处理）；
 *   3. 桌面弹窗该不该弹（按用户订阅的分类过滤 + 主进程去重）。
 *
 * 为什么用白名单而不是「全部系统事件都通知」：通知的价值在稀缺——
 * 把用户自己的每次操作也弹一遍，铃铛就变成了第二个日志页，再也没人看。
 */

/** 通知分类（设置项订阅与 i18n 标题都按它走） */
export type NotifyCategory = 'proxy_drift' | 'proxy_heal' | 'expiry' | 'security' | 'rpa'

/** 严重度：决定列表图标颜色与桌面弹窗的紧急程度 */
export type NotifySeverity = 'error' | 'warning' | 'info'

export interface NotifyEventMeta {
  category: NotifyCategory
  severity: NotifySeverity
  /** 点击通知后跳转的页面（去能直接处理这件事的地方） */
  route: string
}

/**
 * 值得通知的操作日志 action → 元信息。
 *
 * 收录标准（三条同时满足）：
 * 1. **系统自动产生**，不是用户自己刚做的操作——用户对自己的操作有即时反馈，不需要再通知；
 * 2. **不处理会有代价**——出口漂移不处理会静默失配，换绑失败会让环境暴露宿主 IP，
 *    到期不处理环境直接不可用，登录被锁意味着正在被爆破；
 * 3. 用户**可能不在场**——巡检 / 调度器在后台跑，事发的时刻用户往往没盯着界面。
 *
 * 新增事件时同步在 i18n 补 `notif.cat.<分类>` 标题，并在设置项订阅列表里可见。
 */
export const NOTIFY_EVENT_MAP: Record<string, NotifyEventMeta> = {
  // 代理出口 IP 漂移：环境时区/语言按旧国家生成，出口已换国——防关联产品最致命的静默失配
  proxy_exit_ip_changed: { category: 'proxy_drift', severity: 'warning', route: '/proxies' },
  // 自动换绑成功：环境的代理被换了，用户必须知道（IP 变了）
  proxy_heal: { category: 'proxy_heal', severity: 'info', route: '/proxies' },
  // 换绑失败：找不到合规替代，环境仍挂在失效代理上，有暴露宿主 IP 的风险
  proxy_heal_failed: { category: 'proxy_heal', severity: 'warning', route: '/proxies' },
  // 到期预警：代理 / 环境即将不可用
  expiry_alert: { category: 'expiry', severity: 'warning', route: '/logs' },
  // 登录被锁定：账号正在被爆破
  login_locked: { category: 'security', severity: 'error', route: '/logs' },
  // 定时 RPA 执行失败：用户以为自动化在跑，实际每一步都没执行——静默失败
  // （同表的 rpa_schedule_run「成功」与 rpa_schedule_skip「环境未运行」都不通知：
  //  前者是预期结果，后者是刻意设计的跳过语义，都进铃铛只会稀释真正要处理的）
  rpa_schedule_fail: { category: 'rpa', severity: 'warning', route: '/rpa' }
}

/** 全部分类（设置项「全选」与默认订阅用） */
export const NOTIFY_CATEGORIES: NotifyCategory[] = ['proxy_drift', 'proxy_heal', 'expiry', 'security', 'rpa']

/** 分类的默认标签（桌面弹窗标题用；界面内标题走 i18n 的 notif.cat.*） */
export const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, { 'zh-CN': string; 'en-US': string; 'ja-JP': string; 'de-DE': string }> = {
  proxy_drift: { 'zh-CN': '代理出口 IP 漂移', 'en-US': 'Proxy exit IP drift', 'ja-JP': 'プロキシ出口 IP 漂流', 'de-DE': 'Proxy-Exit-IP-Drift' },
  proxy_heal: { 'zh-CN': '代理自动换绑', 'en-US': 'Proxy auto-rebind', 'ja-JP': 'プロキシ自動張り替え', 'de-DE': 'Proxy-Auto-Neubindung' },
  expiry: { 'zh-CN': '到期预警', 'en-US': 'Expiry alert', 'ja-JP': '期限警告', 'de-DE': 'Ablaufwarnung' },
  security: { 'zh-CN': '安全告警', 'en-US': 'Security alert', 'ja-JP': 'セキュリティ警告', 'de-DE': 'Sicherheitswarnung' },
  rpa: { 'zh-CN': '定时任务失败', 'en-US': 'Scheduled task failed', 'ja-JP': '定期タスク失敗', 'de-DE': 'Geplante Aufgabe fehlgeschlagen' }
}

/**
 * 分类一个日志 action：不是白名单内的事件返回 null（调用方据此零成本跳过）。
 * 故意不做「前缀猜测」——猜错会把用户操作也弹成通知。
 */
export function classifyNotification(action: string): NotifyEventMeta | null {
  return NOTIFY_EVENT_MAP[action] || null
}

/** 桌面弹窗订阅配置（与 AppSettings.desktopNotifyEnabled / desktopNotifyEvents 对应） */
export interface NotifyToastConfig {
  enabled: boolean
  /** 订阅的分类；为空数组按「全不订」处理（显式清空 ≠ 恢复默认，避免误开） */
  events: NotifyCategory[]
}

/** 默认订阅全部分类：这些事件每一个都不处理就会有代价，默认就该告知 */
export const NOTIFY_DEFAULT_EVENTS: NotifyCategory[] = [...NOTIFY_CATEGORIES]

/**
 * 某事件是否应该弹桌面窗：先过「值不值得通知」白名单，再过用户订阅。
 * events 为 null/undefined（老设置没有这个字段）时按默认全部分类——
 * 升级用户不该因为多了个设置项就被静音。
 */
export function shouldToast(action: string, cfg: NotifyToastConfig): boolean {
  if (!cfg || !cfg.enabled) return false
  const meta = classifyNotification(action)
  if (!meta) return false
  const subs = Array.isArray(cfg.events) ? cfg.events : NOTIFY_DEFAULT_EVENTS
  return subs.includes(meta.category)
}

/**
 * 归一化设置里存的事件列表：过滤未知分类、去重。
 * 设置页存进来前过一遍，避免脏数据（手改 DB / 旧版本残留）让匹配永远为假。
 */
export function normalizeNotifyEvents(input: unknown): NotifyCategory[] {
  if (!Array.isArray(input)) return [...NOTIFY_DEFAULT_EVENTS]
  const out = NOTIFY_CATEGORIES.filter((c) => input.includes(c))
  return out
}
