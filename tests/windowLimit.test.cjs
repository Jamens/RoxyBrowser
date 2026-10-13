// 离线单测：环境窗口并发上限（shared/windowLimit.ts）
// 核心不变量：
//   1) 达到上限必须**拦住**——放行就是让用户把应用推到崩溃
//   2) 上限 <= 0 表示不限制（用户显式关闭限制）
//   3) 提示必须可执行：说清现状、代价、下一步怎么���
const { DEFAULT_MAX_CONCURRENT_WINDOWS, canOpenWindow } = require('../.tmp_wl/shared/windowLimit.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

// ============ 1) 未达上限应放行 ============
{
  check('0 个窗口时放行', canOpenWindow(0, 3).ok === true)
  check('1 个 / 上限 3 放行', canOpenWindow(1, 3).ok === true)
  check('2 个 / 上限 3 放行', canOpenWindow(2, 3).ok === true)
}

// ============ 2) 达到上限必须拦（这是防崩溃的关键）============
{
  const r = canOpenWindow(3, 3)
  check('3 个 / 上限 3 拦住', r.ok === false)
  check('超出上限也拦住', canOpenWindow(5, 3).ok === false)
  const msg = r.ok ? '' : r.reason
  check('提示含当前数量与上限', msg.includes('3'), msg.slice(0, 40))
  check('提示说明内存代价', msg.includes('内存'))
  check('提示给出下一步（先关闭）', msg.includes('关闭'))
  check('提示指向设置入口', msg.includes('设置'))
}

// ============ 3) 上限 <= 0 表示不限制 ============
{
  check('上限 0 不限制', canOpenWindow(99, 0).ok === true)
  check('上限 -1 不限制', canOpenWindow(99, -1).ok === true)
  check('上限 1 时第 2 个被拦', canOpenWindow(1, 1).ok === false)
  check('上限 1 时第 1 个放行', canOpenWindow(0, 1).ok === true)
}

// ============ 4) 边界与异常输入 ============
{
  check('负数当前数视为 0', canOpenWindow(-5, 3).ok === true)
  check('小数当前数向下取整', canOpenWindow(2.9, 3).ok === true, '2.9 < 3 → 放行')
  check('NaN 当前数视为 0（脏数据不挡用户）', canOpenWindow(NaN, 3).ok === true)
  // Infinity 同样按 0 处理：异常输入不该把用户挡在门外——
  // 「因数据脏而打不开环境」比「多开一个窗口」糟糕得多
  check('Infinity 当前数视为 0（脏数据不挡用户）', canOpenWindow(Infinity, 3).ok === true)
  check('默认值是合理正整数', Number.isInteger(DEFAULT_MAX_CONCURRENT_WINDOWS) && DEFAULT_MAX_CONCURRENT_WINDOWS > 0)
}

// ============ 5) 提示在各种上限下都完整 ============
{
  for (const limit of [1, 2, 3, 10]) {
    const r = canOpenWindow(limit, limit)
    check(`上限 ${limit} 的提示含数字 ${limit}`, !r.ok && r.reason.includes(String(limit)))
  }
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)