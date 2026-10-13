// 离线单测：回收站批量操作（shared/trashBatch.ts）
// 核心不变量：
//   1) 逐条独立判定——一条失败不影响其他（否则用户要重试几十次）
//   2) 拒绝原因必须如实回报——否则用户以为全删了，实际有几个还在
//   3) 彻底删除运行中的环境会造成数据与内存态不一致，必须拦住
const {
  canPurge,
  canRestore,
  planBatch,
  formatBatchResult
} = require('../.tmp_tb/shared/trashBatch.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

const item = (over) =>
  Object.assign({ id: 1, name: '环境A', deletedAt: '2026-10-01T00:00:00.000Z', status: 'idle' }, over)

// ============ 1) 彻底删除的判定 ============
{
  check('回收站中 + 未运行 → 放行', canPurge(item({})).ok === true)
  const notTrash = canPurge(item({ deletedAt: null }))
  check('不在回收站 → 拦住', notTrash.ok === false)
  check('  拒绝码是 not_in_trash', !notTrash.ok && notTrash.code === 'not_in_trash')
  check('  原因含环境名', !notTrash.ok && notTrash.reason.includes('环境A'))

  const running = canPurge(item({ status: 'running' }))
  check('正在运行 → 拦住（防数据与内存态不一致）', running.ok === false)
  check('  拒绝码是 still_running', !running.ok && running.code === 'still_running')
  check('  原因提示先关闭窗口', !running.ok && running.reason.includes('关闭'))

  const notOwner = canPurge(item({ owned: false }))
  check('非本人 → 拦住', notOwner.ok === false)
  check('  拒绝码是 not_owner', !notOwner.ok && notOwner.code === 'not_owner')

  // 空 deletedAt（undefined）也要当「不在回收站」，不能漏判
  check('deletedAt 为 undefined → 拦住', canPurge({ id: 1, name: 'X' }).ok === false)
}

// ============ 2) 恢复的判定（比 purge 宽松）============
{
  check('回收站中 → 放行', canRestore(item({})).ok === true)
  check('正在运行也放行（它本来就在运行）', canRestore(item({ status: 'running' })).ok === true)
  check('不在回收站 → 拦住', canRestore(item({ deletedAt: null })).ok === false)
  check('非本人 → 拦住', canRestore(item({ owned: false })).ok === false)
}

// ============ 3) 批量计划：逐条独立（核心）============
{
  const items = [
    item({ id: 1, name: 'A', status: 'idle' }),
    item({ id: 2, name: 'B', status: 'running' }),   // 运行中，应被拒
    item({ id: 3, name: 'C', status: 'idle' }),
    item({ id: 4, name: 'D', status: 'running' })    // 运行中，应被拒
  ]
  const plan = planBatch(items, canPurge)
  check('可执行的 2 个', plan.okIds.length === 2, JSON.stringify(plan.okIds))
  check('被拒的 2 个', plan.rejected.length === 2)
  check('被拒的是 B 和 D', plan.rejected.map((r) => r.id).join(',') === '2,4')
  check('  每条拒绝都带原因', plan.rejected.every((r) => typeof r.reason === 'string' && r.reason.length > 0))
  check('  每条拒绝都带分类码', plan.rejected.every((r) => typeof r.code === 'string'))

  // 一条失败**不影响**其他：4 个里 2 个失败，另外 2 个仍要删
  check('失败不阻断其余项（关键不变量）', plan.okIds.includes(1) && plan.okIds.includes(3))

  // 全部成功
  const allOk = planBatch([item({ id: 1 }), item({ id: 2 })], canPurge)
  check('全部成功时无拒绝', allOk.rejected.length === 0 && allOk.okIds.length === 2)

  // 全部失败
  const allBad = planBatch([item({ id: 1, status: 'running' })], canPurge)
  check('全部失败时 okIds 为空', allBad.okIds.length === 0 && allBad.rejected.length === 1)

  // 空输入
  const empty = planBatch([], canPurge)
  check('空输入不崩', empty.okIds.length === 0 && empty.rejected.length === 0)
}

// ============ 4) 重复 id 去重（避免重复删除）============
{
  const plan = planBatch([item({ id: 7 }), item({ id: 7 }), item({ id: 8 })], canPurge)
  check('重复 id 只处理一次', plan.okIds.length === 2 && plan.okIds.indexOf(7) === plan.okIds.lastIndexOf(7))
}

// ============ 5) 提示文案：部分成功必须说清 ============
{
  const none = formatBatchResult('purge', 0, [])
  check('空操作提示', none.includes('没有'), none)

  const all = formatBatchResult('purge', 3, [])
  check('全部成功提示数量', all.includes('3'), all)
  check('  用词是「彻底删除」', all.includes('彻底删除'), all)

  const restored = formatBatchResult('restore', 2, [])
  check('恢复用词正确', restored.includes('恢复') && !restored.includes('彻底'), restored)

  const partial = formatBatchResult('purge', 8, [
    { id: 2, name: 'B', reason: '「B」的窗口正在运行，请先关闭', code: 'still_running' },
    { id: 4, name: 'D', reason: '「D」的窗口正在运行，请先关闭', code: 'still_running' }
  ])
  check('部分成功：含已成功数量', partial.includes('8'), partial)
  check('部分成功：含未成功的名字', partial.includes('B') && partial.includes('D'), partial)
  check('部分成功：含未成功原因', partial.includes('正在运行'), partial)
  check('  未说出「未成功」，会误导', partial.includes('未成功'), partial)

  const allFail = formatBatchResult('purge', 0, [
    { id: 1, name: 'X', reason: '「X」不在回收站中', code: 'not_in_trash' }
  ])
  check('全部失败：说清原因', allFail.includes('不在回收站'), allFail)

  // 超过 3 个失败时要汇总而不是全列（避免刷屏）
  const many = formatBatchResult('purge', 1, [
    { id: 1, name: 'A', reason: 'R1', code: 'still_running' },
    { id: 2, name: 'B', reason: 'R2', code: 'still_running' },
    { id: 3, name: 'C', reason: 'R3', code: 'still_running' },
    { id: 4, name: 'D', reason: 'R4', code: 'still_running' },
    { id: 5, name: 'E', reason: 'R5', code: 'still_running' }
  ])
  check('失败超过 3 个时汇总（不刷屏）', many.includes('等 5 个'), many)
  check('  仍列出前几个名字', many.includes('A') && many.includes('C'), many)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)