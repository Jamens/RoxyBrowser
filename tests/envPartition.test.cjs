/**
 * 环境分区清理判定的离线单测。
 * 重点覆盖「误清会毁掉用户登录态」的高危分支。
 */
const assert = require('node:assert/strict')
const {
  partitionName,
  partitionDirName,
  canClearPartition,
  formatCleanupLog
} = require('../src/shared/envPartition.ts')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

test('分区名带 persist: 前缀，落盘目录名去掉前缀', () => {
  assert.equal(partitionName(7), 'persist:env-7')
  assert.equal(partitionDirName(7), 'env-7')
})

test('purge 清理：环境在回收站且窗口已关 → 放行', () => {
  const v = canClearPartition({ profileId: 7, inTrash: true, running: false, trigger: 'purge' })
  assert.equal(v.ok, true)
  assert.equal(v.dirName, 'env-7')
})

test('purge 清理：窗口正在运行 → 硬拦', () => {
  const v = canClearPartition({ profileId: 7, inTrash: true, running: true, trigger: 'purge' })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'still_running')
  assert.match(v.reason, /正在运行/)
})

test('purge 清理：环境未处于彻底删除状态 → 拒绝，防止误删要保留的登录态', () => {
  const v = canClearPartition({ profileId: 7, inTrash: false, running: false, trigger: 'purge' })
  assert.equal(v.ok, false)
  assert.equal(v.code, 'not_purged')
})

test('手动清理：不要求在回收站，但窗口仍须已关', () => {
  const ok = canClearPartition({ profileId: 3, inTrash: false, running: false, trigger: 'manual' })
  assert.equal(ok.ok, true)
  const blocked = canClearPartition({ profileId: 3, inTrash: false, running: true, trigger: 'manual' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'still_running')
})

test('非法 id 一律拒绝（0 / 负数 / 小数 / NaN）', () => {
  for (const id of [0, -1, 1.5, Number.NaN]) {
    const v = canClearPartition({ profileId: id, inTrash: true, running: false, trigger: 'purge' })
    assert.equal(v.ok, false, `id=${id} 应被拒绝`)
    assert.equal(v.code, 'invalid_id')
  }
})

test('清理日志文案：成功 / 失败均带环境 id 与目录名，失败必须带原因', () => {
  const okMsg = formatCleanupLog(7, 'env-7', true)
  assert.match(okMsg, /#7/)
  assert.match(okMsg, /env-7/)
  const failMsg = formatCleanupLog(7, 'env-7', false, '文件被占用')
  assert.match(failMsg, /失败/)
  assert.match(failMsg, /文件被占用/)
})

console.log(`✓ envPartition ${passed} 项通过`)