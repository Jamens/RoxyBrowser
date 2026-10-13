// 离线单测：渲染进程崩溃判定（shared/crashReason.ts）
// 核心不变量：
//   1) 只对「异常退出」纠状态——clean-exit / killed 走的是 closed 正常路径
//   2) 漏判的代价是用户被「窗口已在运行中」永久拦住（只能重启应用恢复）
//   3) 日志格式要稳定，否则线上 grep 失效
const {
  isAbnormalExit,
  describeCrashReason,
  formatCrashLog
} = require('../.tmp_cr/shared/crashReason.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

// ============ 1) 正常路径必须被排除 ============
{
  check('clean-exit 不纠状态', isAbnormalExit('clean-exit') === false)
  check('killed 不纠状态', isAbnormalExit('killed') === false)
}

// ============ 2) 异常路径必须被识别（漏判 = 用户卡死）============
{
  check('crashed 纠状态', isAbnormalExit('crashed') === true)
  check('oom 纠状态', isAbnormalExit('oom') === true)
  check('launch-failed 纠状态', isAbnormalExit('launch-failed') === true)
  check('integrity-failure 纠状态', isAbnormalExit('integrity-failure') === true)
  check('memory-eviction 纠状态', isAbnormalExit('memory-eviction') === true)
  check('abnormal-exit 纠状态', isAbnormalExit('abnormal-exit') === true)
}

// ============ 3) 未知 reason 的处理 ============
{
  // Electron 未来新增 reason 时：宁可误纠状态，也不能漏——漏判的代价是用户卡死
  check('未知 reason 默认纠状态', isAbnormalExit('some-future-reason') === true)
  check('空字符串纠状态', isAbnormalExit('') === true)
  check('大小写敏感（Clean-Exit 视为未知→纠状态）', isAbnormalExit('Clean-Exit') === true)
}

// ============ 4) 崩溃原因中文说明 ============
{
  check('crashed → 渲染进程崩溃', describeCrashReason('crashed') === '渲染进程崩溃')
  check('oom → 内存耗尽', describeCrashReason('oom') === '内存耗尽')
  check('launch-failed → 渲染进程启动失败', describeCrashReason('launch-failed') === '渲染进程启动失败')
  check('memory-eviction → 被系统内存压力驱逐', describeCrashReason('memory-eviction') === '被系统内存压力驱逐')
  check('clean-exit → 正常结束', describeCrashReason('clean-exit') === '正常结束')
  check('killed → 被主动终止', describeCrashReason('killed') === '被主动终止')
  // 关键：未知 reason 不能返回 undefined/空，那会让日志出现「异常退出: undefined」
  check('未知 reason 原样返回', describeCrashReason('weird') === 'weird')
  check('未知 reason 非 undefined', describeCrashReason('weird') !== undefined)
}

// ============ 5) 日志格式稳定性（排查线上问题靠它）============
{
  const line = formatCrashLog('测试环境', 42, 'oom', -1073741819)
  check('含环境名', line.includes('测试环境'))
  check('含 id', line.includes('#42'))
  check('含 reason', line.includes('reason=oom'))
  check('含 exitCode', line.includes('exitCode=-1073741819'))
  check('含 [roxy] 前缀（与其他日志一致）', line.startsWith('[roxy]'))
  check('同一输入产出同一日志', line === formatCrashLog('测试环境', 42, 'oom', -1073741819))
  // 环境名里带引号/括号时不应破坏结构
  const weird = formatCrashLog('环境「A」(旧)#1', 7, 'crashed', 1)
  check('环境名含特殊字符仍产出完整日志', weird.includes('reason=crashed'))
}

// ============ 6) 判定与说明一致性 ============
{
  const all = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']
  for (const r of all) {
    const abnormal = isAbnormalExit(r)
    const desc = describeCrashReason(r)
    check(`${r}: 判定与说明均有定义`, typeof abnormal === 'boolean' && desc.length > 0)
  }
  // 两个正常路径的说明不应被写成「异常」
  check('clean-exit 说明不含「异常」', !describeCrashReason('clean-exit').includes('异常'))
  check('killed 说明不含「异常」', !describeCrashReason('killed').includes('异常'))
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)