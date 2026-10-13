// 离线单测：操作日志归档判定（shared/logArchive.ts）
// 核心不变量：
//   1) 只归档**完整**月份——不能把仍在保留期内的记录提前销毁（审计证据不可逆）
//   2) 按本地时区归月，不能用 UTC（跨时区会把当月最后一天算到下个月）
//   3) 不可逆操作必须有前置校验兜底
// 编译：先 `node node_modules/typescript/bin/tsc src/shared/logArchive.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_la`
// 运行：`node tests/logArchive.test.cjs`
const {
  monthKey,
  monthStart,
  nextMonthStart,
  planArchive,
  shouldArchive,
  makeBatchId,
  emptyResult,
  validateArchive,
  ARCHIVE_BATCH_SIZE,
} = require('../.tmp_la/shared/logArchive.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

const d = (y, m, day, h = 0, mi = 0, s = 0) => new Date(y, m - 1, day, h, mi, s, 0)

// ============ 1) monthKey 归月 ============
{
  check('2026-07-15 → 2026-07', monthKey(d(2026, 7, 15)) === '2026-07')
  check('2026-01-01 → 2026-01（补零）', monthKey(d(2026, 1, 1)) === '2026-01')
  check('2026-12-31 → 2026-12', monthKey(d(2026, 12, 31)) === '2026-12')
  // 时区陷阱：本地时间 1 月 1 日 00:30，若误用 toISOString() 会算成去年 12 月
  const ny = d(2026, 1, 1, 0, 30)
  check('元旦凌晨按本地时区归年', monthKey(ny) === '2026-01', monthKey(ny))
  const dec31 = d(2026, 12, 31, 23, 59)
  check('年末最后一刻不跨年', monthKey(dec31) === '2026-12', monthKey(dec31))
}

// ============ 2) monthStart / nextMonthStart ============
{
  const s = monthStart('2026-07')
  check('monthStart 年', s.getFullYear() === 2026)
  check('monthStart 月（0-based）', s.getMonth() === 6)
  check('monthStart 日为 1', s.getDate() === 1)
  check('monthStart 时分秒清零', s.getHours() === 0 && s.getMinutes() === 0 && s.getSeconds() === 0)

  const n = nextMonthStart('2026-07')
  check('nextMonthStart 到 8 月', n.getMonth() === 7)
  // 跨年：2026-12 的下一个月应是 2027-01（Date 会自动进位，不能自己拼字符串）
  const ny = nextMonthStart('2026-12')
  check('12 月的下月跨年到 2027-01', ny.getFullYear() === 2027 && ny.getMonth() === 0, `${ny.getFullYear()}-${ny.getMonth() + 1}`)
}

// ============ 3) planArchive：只归档完整月份（最关键）============
{
  // 场景：今天 7/15，保留 30 天 → 截止 6/15。6/1~6/14 仍在保留期内，不能归档。
  const now = d(2026, 7, 15, 12)
  const plan = planArchive(now, 30)
  check('不归档保留期所在月', !plan.months.includes('2026-06'), plan.months.join(','))
  check('before 为边界月月初', monthKey(plan.before) === '2026-06')

  // 逐条验证：6/1 的记录（仍在保留期内）绝不能被归档
  check('6/1 记录（保留期内）不归档', shouldArchive({ createdAt: d(2026, 6, 1) }, plan) === false)
  check('6/14 记录（保留期内）不归档', shouldArchive({ createdAt: d(2026, 6, 14) }, plan) === false)
  check('7/1 记录不归档', shouldArchive({ createdAt: d(2026, 7, 1) }, plan) === false)
}

// ============ 3b) 只列**实际有记录**的月份（关键约束二）============
{
  const now = d(2026, 7, 15, 12)
  // 传入数据库里真实存在的月份：只有 2026-03 与 2026-05 有数据
  const plan = planArchive(now, 30, ['2026-03', '2026-05', '2026-06'])
  check('只返回有记录的月份', plan.months.join(',') === '2026-03,2026-05', plan.months.join(','))
  check('排除保留期所在月 2026-06', !plan.months.includes('2026-06'))
  check('月份升序排列', plan.months[0] < plan.months[plan.months.length - 1])
  // 不虚报范围：空列表时不得回溯出 600 个月
  const empty = planArchive(now, 30, [])
  check('空列表时退化为仅边界月', empty.months.length <= 1, `${empty.months.length} 个月`)
  check('未提供 existingMonths 时也不虚报', planArchive(now, 30).months.length <= 1)
  // 2/1 的记录属于 2026-02，未传该月份则不归档
  check('未列出的月份不归档', shouldArchive({ createdAt: d(2026, 2, 1) }, plan) === false)
}

// ============ 4) 跨年场景 ============
{
  // 今天 2027-01-10，保留 30 天 → 截止 2026-12-11。2026-12 只有 12-11 前过期，
  // 该月剩余记录仍在保留期内，**不能整月归档**。
  const plan = planArchive(d(2027, 1, 10), 30, ['2026-11', '2026-12'])
  check('跨年时不归档上月（仍有保留期内记录）', !plan.months.includes('2026-12'), plan.months.join(','))
  check('跨年时归档 2026-11', plan.months.includes('2026-11'))
  check('before 落在 2026-12', monthKey(plan.before) === '2026-12')
  check('2026-12-15（保留期内）不归档', shouldArchive({ createdAt: d(2026, 12, 15) }, plan) === false)
  check('2026-11-30 归档', shouldArchive({ createdAt: d(2026, 11, 30) }, plan) === true)

  // 今天 2027-03-10，保留 30 天 → 截止 2027-02-08。2027-02 仍有保留期内记录；
  // 2027-01 整月（1/1~1/31）确实全部早于 2/8，**应当归档**。
  const p2 = planArchive(d(2027, 3, 10), 30, ['2027-01', '2027-02', '2027-03'])
  check('完整过期的 2027-01 可归档', p2.months.includes('2027-01'), p2.months.join(','))
  check('仍有过期记录的 2027-02 不归档', !p2.months.includes('2027-02'))
  check('保留期所在月 2027-03 不归档', !p2.months.includes('2027-03'))
  check('2027-01-31 归档', shouldArchive({ createdAt: d(2027, 1, 31, 23, 59) }, p2) === true)
  check('2027-02-01 不归档', shouldArchive({ createdAt: d(2027, 2, 1) }, p2) === false)
}

// ============ 5) 保留期 = 0 / 负数 / 非数 → 不归档 ============
{
  const now = d(2026, 7, 15)
  for (const v of [0, -1, NaN, Infinity, undefined, null]) {
    check(`retentionDays=${v} 时不归档`, planArchive(now, v).months.length === 0)
  }
}

// ============ 6) 极长保留期不应死循环 / 不虚报 ============
{
  const t0 = Date.now()
  const plan = planArchive(d(2026, 7, 15), 365 * 200)
  check('200 年保留期不产生海量月份', plan.months.length <= 1, `${plan.months.length} 个月`)
  check('200 年保留期计算耗时可接受', Date.now() - t0 < 1000)
  check('无 existingMonths 时边界正确', monthKey(plan.before) < '2026-07', monthKey(plan.before))
}

// ============ 7) shouldArchive 的防御性 ============
{
  const plan = planArchive(d(2026, 7, 15), 30, ['2026-03', '2026-05'])
  // 构造一个「before 很小但 months 为空」的 plan——不应归档任何东西
  const emptyPlan = { months: [], before: new Date(2000, 0, 1) }
  check('months 为空时不归档', shouldArchive({ createdAt: d(2020, 1, 1) }, emptyPlan) === false)

  // months 非空但记录在 before 之后 → 不归档（调用方误传过小 before 时的兜底）
  const badPlan = { months: ['2020-01'], before: d(2026, 1, 1) }
  check('记录晚于 before 时不归档', shouldArchive({ createdAt: d(2025, 5, 1) }, badPlan) === false)
}

// ============ 8) makeBatchId ============
{
  const id = makeBatchId(d(2026, 7, 15, 9, 5, 3), ['2026-05', '2026-03'])
  check('批次号以 arch- 开头', id.startsWith('arch-'), id)
  check('批次号含日期', id.includes('20260715'))
  check('批次号含时间', id.includes('090503'))
  // 月份已升序，首尾应为最早~最晚
  check('批次号标明范围', id.includes('2026-03~2026-05'), id)
  check('同输入产生相同批次号（可测试）', id === makeBatchId(d(2026, 7, 15, 9, 5, 3), ['2026-05', '2026-03']))
  check('空月份批次号不崩', makeBatchId(d(2026, 7, 15), []).includes('none'))
  check('单月份范围不重复', makeBatchId(d(2026, 7, 15), ['2026-05']).includes('2026-05~2026-05'))
}

// ============ 9) validateArchive：不可逆操作的最后闸门 ============
{
  const plan = planArchive(d(2026, 7, 15), 30)
  check('正常情况通过', validateArchive(plan, { totalRows: 1000, oldest: d(2026, 1, 1) }).ok === true)
  check('空表拒绝', validateArchive(plan, { totalRows: 0, oldest: null }).ok === false)
  // 最关键：最老的记录都还在保留期内 → 计算有误，必须拒绝
  const bad = validateArchive(plan, { totalRows: 100, oldest: d(2026, 7, 1) })
  check('最老记录仍在保留期时拒绝', bad.ok === false)
  if (!bad.ok) check('拒绝时给出可读原因', /保留期/.test(bad.reason), bad.reason)
  check('超量拒绝', validateArchive(plan, { totalRows: 600000, oldest: d(2020, 1, 1) }).ok === false)
  check('无归档月份拒绝', validateArchive({ months: [], before: new Date() }, { totalRows: 5, oldest: d(2020, 1, 1) }).ok === false)
  check('恰好 50 万允许（边界）', validateArchive(plan, { totalRows: 500000, oldest: d(2020, 1, 1) }).ok === true)
  check('batchSize 为正整数', Number.isInteger(ARCHIVE_BATCH_SIZE) && ARCHIVE_BATCH_SIZE > 0)
}

// ============ 10) emptyResult ============
{
  const r = emptyResult('b1', ['2026-05'])
  check('初始 moved 为 0', r.moved === 0)
  check('批次号透传', r.batchId === 'b1')
  check('月份透传', r.months.length === 1)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
