/**
 * 环境窗口并发上限的**纯判定逻辑**（主进程用，可离线单测）。
 *
 * ## 为什么需要上限
 * 实测在本机跑：主进程常驻 390MB，单个环境窗口的渲染/GPU 进程 180~400MB。
 * 开到第 3 个环境窗口时**有概率整个应用退出**——崩的是主进程，不是单个窗口。
 * 原因是资源累积逼近系统上限，Electron 拿不到新的 GPU/渲染上下文就整体崩掉。
 *
 * 用户侧的代价很重：所有窗口一起消失、本地 API 也停止服务，
 * 正在跑的环境窗口全部中断，且现场没有任何提示。
 *
 * ## 为什么选「软拒绝」而不是直接崩
 * 上限的意义在于**提前拦住**并给出可执行的提示（「先关掉几个环境」），
 * 而不是等系统来崩。硬崩掉用户什么都做不了，只能反复重开。
 */

/** 默认上限。实测 3 个窗口即有风险，留 1 个余量取 2 会太紧，故默认 3 */
export const DEFAULT_MAX_CONCURRENT_WINDOWS = 3

/**
 * 是否允许再开一个窗口。
 *
 * @param currentCount 当前已打开的环境窗口数（不含主窗口）
 * @param maxLimit 上限；<= 0 表示不限制（用户显式关掉限制时）
 */
export function canOpenWindow(currentCount: number, maxLimit: number): { ok: true } | { ok: false; reason: string } {
  // 0 / 负数 = 不限制。必须保留这条：有些用户就是想全开，宁可冒风险也不拦
  if (maxLimit <= 0) return { ok: true }

  const current = Number.isFinite(currentCount) ? Math.max(0, Math.floor(currentCount)) : 0
  if (current < maxLimit) return { ok: true }

  return {
    ok: false,
    reason:
      `已达到同时打开环境数上限（当前 ${current} / 上限 ${maxLimit}）。\n` +
      `每个环境窗口会独立占用一份内存（实测单窗口 200~400MB），开太多会导致应用崩溃。\n` +
      `请先关闭不用的环境窗口再打开新的；` +
      `如确需更多，可到「设置」里调整「同时打开环境数上限」。`
  }
}