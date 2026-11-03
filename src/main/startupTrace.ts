// 启动耗时打点 —— **条件启用，零默认开销**
//
// ## 为什么需要它
//
// FEATURES §12 此前只写了定性描述（「拆了 vendor chunk、路由懒加载，首屏体积下降」），
// **从没量过数字**。这类「据说更快了」的说法在没有数据时无法验证，也无法判断
// 下一次优化该往哪走——而启动耗时是用户对桌面端最直观的感知。
//
// ## 设计约束
//
// 1. **默认零开销**：`ROXY_MEASURE_STARTUP` 未设置时，mark() 直接 return，
//    连 Map 都不写。生产启动路径不受任何影响；
// 2. **可复现**：外部脚本 `scripts/measure-startup.mjs` 负责多次冷启动、收集
//    各阶段耗时并取中位数——单次测量受磁盘缓存 / DB 抖动影响太大，不能当结论；
// 3. **不引入新依赖**：只用 Node 内置 fs / os / path。
//
// ## 时间基准
//
// 用 `performance.now()`（相对**进程启动时刻**）打点，而不是 Date.now()。
// 进程启动到脚本执行之间还有一段 Electron 自身初始化（Node 启动、模块加载），
// 用 Date.now() 会把这部分算进「第一个标记」里，各阶段之间倒是准确的，
// 但「进程启动 → 首屏」的总时长会失真。
const ENABLED = process.env.ROXY_MEASURE_STARTUP === '1'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const marks: Record<string, number> = {}

/** 记录一个阶段耗时（毫秒，相对进程启动） */
export function mark(name: string): void {
  if (!ENABLED) return
  marks[name] = Math.round(performance.now())
}

/** 把打点结果落盘（覆盖写，可重复调用） */
export function flushStartupTrace(extra?: Record<string, unknown>): void {
  if (!ENABLED) return
  const out =
    process.env.ROXY_MEASURE_OUT ||
    join(tmpdir(), `roxy-startup-${process.pid}.json`)
  const payload = {
    pid: process.pid,
    capturedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    argv: process.argv.slice(1),
    marks,
    ...extra
  }
  try {
    writeFileSync(out, JSON.stringify(payload, null, 2))
  } catch {
    /* 打点失败不应影响应用启动 */
  }
}
