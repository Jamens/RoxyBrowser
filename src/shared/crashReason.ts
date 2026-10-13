/**
 * 渲染进程崩溃的**判定逻辑**（纯函数，零 Electron 依赖，可离线单测）。
 *
 * 为什么抽出来：真正难的不是「监听 render-process-gone」（一行 API 调用），
 * 而是**判定哪些 reason 该纠状态、哪些是正常路径**。后者容易出错且无法靠
 * 手点复现（要真的把页面 OOM 掉），必须用测试锁死。
 *
 * 编译：node node_modules/typescript/bin/tsc src/shared/crashReason.ts \
 *   --module commonjs --target es2020 --moduleResolution node --skipLibCheck \
 *   --rootDir src --outDir .tmp_cr
 * 运行：node tests/crashReason.test.cjs
 */

/** Electron `RenderProcessGoneDetails.reason` 的取值 */
export type CrashReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'

/**
 * 是否属于「该把环境状态拉回 idle」的异常退出。
 *
 * ## 甄别依据
 * - `clean-exit`：渲染进程正常结束（页面 close / 导航到 about:blank 等）
 * - `killed`：**我们或系统主动杀的** —— 含用户关闭环境、主动 destroy、
 *   以及内存压力下的驱逐前的正常 kill。
 *
 * 这两个走的是 `win.on('closed')` 那条正常路径，若在这里也纠状态会
 * 产生一次多余的 UPDATE —— 不算错，但会掩盖真实问题（把「主动关闭」
 * 误报成「崩溃」，用户排查时会被带偏）。
 *
 * 其余（crashed / oom / launch-failed / integrity-failure / memory-eviction）
 * 才是真异常：`closed` 可能永远不触发，必须主动纠正状态。
 */
export function isAbnormalExit(reason: string): boolean {
  return reason !== 'clean-exit' && reason !== 'killed'
}

/**
 * 崩溃原因的中文说明，用于写日志 / 给用户看。
 * 未收录的原因原样返回——Electron 未来新增 reason 时不至于显示 undefined。
 */
export function describeCrashReason(reason: string): string {
  switch (reason) {
    case 'crashed':
      return '渲染进程崩溃'
    case 'oom':
      return '内存耗尽'
    case 'launch-failed':
      return '渲染进程启动失败'
    case 'integrity-failure':
      return '代码完整性校验失败'
    case 'memory-eviction':
      return '被系统内存压力驱逐'
    case 'abnormal-exit':
      return '异常退出'
    case 'clean-exit':
      return '正常结束'
    case 'killed':
      return '被主动终止'
    default:
      return reason
  }
}

/**
 * 日志行格式：[roxy] 环境「name」(#id) 渲染进程异常退出: reason=xxx exitCode=yyy
 *
 * 单独抽出来是为了让**日志格式**也能被测试锁住——排查线上问题时，
 * 日志格式不一致会让 grep 失效，而这类问题只有等真出事故才发现。
 */
export function formatCrashLog(envName: string, profileId: number, reason: string, exitCode: number): string {
  return `[roxy] 环境「${envName}」(#${profileId}) 渲染进程异常退出: reason=${reason} exitCode=${exitCode}`
}