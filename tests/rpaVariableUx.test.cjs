// 源码级守卫：RPA 变量覆盖「把模板占位符当字段名」+「留空不回退默认值」不许回归。
//
// 纯读源码，无需编译，进 pnpm test。
//
// 用户从脚本市场装完「亚马逊商品搜索比价」后，回放弹窗的变量覆盖区显示
// `{{keyword}}` —— 那是步骤里给引擎看的模板字面量，不是给人看的字段名，
// 看起来就像模板没渲染 / 脚本坏了。同时弹窗写着「留空则用脚本默认值」，
// 实际后端只要收到 variables 对象就整体替换，清掉输入框会得到 `{keyword:''}`，
// 把 URL 变成 `?k=`。两处都没有编译错误、没有报错，只能靠源码守卫锁住：
//
//   shared/rpa.ts 提供 variableLabel + mergeRunVariables
//     → 前端标签用中文名、run 过滤空覆盖值
//     → /api/rpa/:id/run 与 /v1/rpa/:id/run 逐键合并回退
//
// 行为级（真 HTTP + 真 UI）验证见 scripts/verify-rpa-variable-ux.mjs。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

const shared = read('src/shared/rpa.ts')
const page = read('src/renderer/src/pages/Rpa.tsx')
const market = read('src/main/rpaMarket.ts')
const routeRpa = read('src/main/routes/rpa.ts')
const routeV1 = read('src/main/routes/v1.ts')
const unitTest = read('tests/rpa.test.ts')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✅', name)
  } catch (e) {
    console.error('  ❌', name)
    console.error('     ', e.message)
    process.exitCode = 1
  }
}

/** 取从锚点开始的一段源码，避免断言被文件其它位置"凑巧"满足 */
function sliceFrom(src, anchor, span = 1200) {
  const i = src.indexOf(anchor)
  assert.ok(i >= 0, `源码里找不到锚点：${anchor}`)
  return src.slice(i, i + span)
}

/** 市场脚本里声明的所有变量名 */
function marketVariableKeys() {
  const keys = new Set()
  const blocks = market.matchAll(/variables:\s*\{([^}]*)\}/g)
  for (const b of blocks) {
    // 先抹掉字符串字面量，否则 loginUrl: 'https://example.com/login'
    // 里的 "https:" 会被当成变量名（本守卫第一次跑就踩了这个坑）。
    const body = b[1].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
    for (const m of body.matchAll(/([A-Za-z_][\w]*)\s*:/g)) keys.add(m[1])
  }
  return [...keys]
}

const labelBlock = (() => {
  const m = shared.match(/export const RPA_VARIABLE_LABELS[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(m, 'shared/rpa.ts 里找不到 RPA_VARIABLE_LABELS')
  return m[1]
})()

console.log('\n  RPA 变量覆盖显示与回退（源码级守卫）')

t('共享层导出中英标签表、标签函数与合并函数', () => {
  assert.ok(/export const RPA_VARIABLE_LABELS/.test(shared))
  assert.ok(/export function variableLabel\(/.test(shared))
  assert.ok(/export function mergeRunVariables\(/.test(shared))
})

t('variableLabel 的回退分支不再拼接 {{}}', () => {
  // 只取函数体，别把紧随其后的 mergeRunVariables 文档注释（里面引用了
  // {{keyword}} 作为反例）算进来 —— 否则守卫会自己误报。
  const body = sliceFrom(shared, 'export function variableLabel(', 400).split('/**')[0]
  assert.ok(/RPA_VARIABLE_LABELS\[k\]\s*\|\|\s*k/.test(body), '未收录变量应回退到变量名本身')
  assert.ok(!body.includes('{{'), '回退分支仍在拼模板括号')
})

t('市场脚本的每个变量都有中文显示名', () => {
  const keys = marketVariableKeys()
  assert.ok(keys.length >= 9, `只提取到 ${keys.length} 个市场变量，正则可能失效了：${keys.join(',')}`)
  for (const k of keys) {
    assert.ok(
      new RegExp(`\\b${k}:\\s*'[^']+'`, 'g').test(labelBlock),
      `市场变量 ${k} 没有中文显示名，UI 又会露出裸英文名`
    )
  }
})

t('中文显示名里不得混入模板括号', () => {
  const values = [...labelBlock.matchAll(/:\s*'([^']*)'/g)].map((m) => m[1])
  assert.ok(values.length >= 9, '标签表条目太少')
  for (const v of values) assert.ok(!/[{}]/.test(v), `标签「${v}」含模板括号`)
})

t('回放弹窗不再把 {{${k}}} 当字段名渲染', () => {
  const body = sliceFrom(page, '变量覆盖（默认值已预填', 1100)
  assert.ok(!body.includes('{`{{${k}}}`}'), '仍在把模板字面量作为可见标签')
  assert.ok(/\{variableLabel\(k\)\}/.test(body), '标签没有改用 variableLabel(k)')
})

t('回放弹窗提示语说明清空会恢复默认值', () => {
  const body = sliceFrom(page, '变量覆盖（默认值已预填', 200)
  assert.ok(/清空则恢复脚本默认值/.test(body), '提示语与后端行为又不一致了')
})

t('run() 只把非空覆盖值发给后端', () => {
  const body = sliceFrom(page, 'const run = async () =>', 1000)
  assert.ok(/Object\.entries\(runVars\)\.filter/.test(body), '没有过滤空的覆盖值')
  assert.ok(/String\(v \?\? ''\)\.trim\(\) !== ''/.test(body), '过滤条件不是「非空」')
  assert.ok(!/if \(Object\.keys\(runVars\)\.length\) payload\.variables = runVars/.test(body), '仍在无条件下发整个 runVars')
})

t('市场卡片也用中文变量名，不裸露占位符', () => {
  const body = sliceFrom(page, '步骤 {m.stepCount}', 300)
  assert.ok(/variableLabel\(k\)/.test(body))
  assert.ok(!body.includes('` {{${k}}}`'), '市场卡片仍在显示 {{key}}')
})

t('编辑弹窗保留 {{变量名}} 的教学说明（别被误删）', () => {
  assert.ok(/\{'\{\{变量名\}\}'\}/.test(page), '步骤里如何引用变量的说明被删了')
})

t('两条 run 路由都 import mergeRunVariables', () => {
  assert.ok(/import\s*\{[^}]*mergeRunVariables[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/rpa'/.test(routeRpa))
  assert.ok(/import\s*\{[^}]*mergeRunVariables[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/rpa'/.test(routeV1))
})

t('两条 run 路由都逐键合并，空覆盖回退默认值', () => {
  for (const [name, src] of [['/api/rpa', routeRpa], ['/v1/rpa', routeV1]]) {
    assert.ok(
      /const vars = mergeRunVariables\(s\.variables \|\| \{\}, normalizeVariables\(reqVars\)\)/.test(src),
      `${name} 没有调用 mergeRunVariables，整体替换会吞掉默认值`
    )
    assert.ok(
      !/\? normalizeVariables\(reqVars\) \|\| \{\}/.test(src),
      `${name} 仍残留旧的整体替换表达式`
    )
  }
})

t('纯函数测试含「清空覆盖 → URL 保留默认关键词」回归用例', () => {
  assert.ok(/mergeRunVariables\(\{ keyword: 'wireless earbuds' \}, \{ keyword: '' \}\)/.test(unitTest))
  assert.ok(/旧整体替换语义会把 URL 变成 \?k=/.test(unitTest))
})

console.log(`\n  ${passed} passed`)
