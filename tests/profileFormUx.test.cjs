// 创建环境表单（ProfileForm）减重改造的**源码级回归守卫**。
//
// ## 为什么需要这个测试
//
// 遗留 3「创建窗口流程焕新」把 ProfileForm 拆成了「默认收起的折叠区」，
// 里面藏着三个**看起来像 UI 细节、实际是数据正确性**的陷阱：
//
// 1. **antd 的 Collapse 面板在首次展开前不渲染内容。**
//    备注 / 到期时间 / 启用扩展被收进了默认收起的面板，它们是 Form.Item——
//    未挂载的 Form.Item 不会出现在 onFinish 的 values 里，而后端 PUT 是按
//    values **全量覆盖**的。于是「用户点编辑、什么都不改、直接保存」会把这三个
//    字段悄悄抹成空——一次无操作的编辑就把用户填过的东西弄丢了。
//    对照实验已实测确认：去掉 forceRender 后备注确实被清空（remark = ""）。
//
// 2. **antd 的 `defaultActiveKey` 只在首次挂载生效。**
//    Drawer 的内容默认不销毁，上次展开的状态会黏到下一次打开的表单上——
//    用户明明只想建个环境，却先看到一屏几十行指纹细项。必须用受控的 activeKey。
//
// 3. **新建态与编辑态的默认展开状态不同**（新建全收起 / 编辑展开基础设置），
//    这个差异是刻意的，改坏了不会报错、只会让体验变差。
//
// 上面三条都不会让 typecheck 或 build 失败，tsc 对 JSX 属性语义完全失明。
// 所以必须由源码级断言锁住——但**源码断言只能证明"写对了"，
// 证明不了"跑起来对"**，真正的行为验证在 scripts/verify-profile-form-ux.mjs
// （CDP 驱动真实 UI + 端到端保值核对）。
//
// 用法：node tests/profileFormUx.test.cjs
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'ProfileForm.tsx')
const code = fs.readFileSync(SRC, 'utf8')

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

/**
 * 取包含指定锚点的那一个 Collapse 的源码片段（**从 `<Collapse` 开始到 items 数组闭合**）。
 *
 * 三个坑（都踩过）：
 *  1. 锚点（如 label: '基础设置'）位于 items 数组**内部**，必须向前找
 *     items={[，向后找会跑到下一个 Collapse 上去；
 *  2. `activeKey` 写在 `<Collapse>` 标签上、不在 items 数组内——只切 items
 *     会漏掉它，断言会误判「没用受控 activeKey」；
 *  3. 方括号计数必须**跳过字符串**——JSX 里的 placeholder / extra 文案
 *     常含中英文括号，不跳过就会把配对算错。
 */
function collapseBlock(marker) {
  const anchor = code.indexOf(marker)
  assert.ok(anchor >= 0, `未找到锚点：${marker}`)
  const itemsStart = code.lastIndexOf('items={[', anchor)
  assert.ok(itemsStart >= 0, `锚点之前未找到 items 数组：${marker}`)
  const tagStart = code.lastIndexOf('<Collapse', itemsStart)
  assert.ok(tagStart >= 0, `未找到 <Collapse 标签：${marker}`)

  let depth = 0
  let quote = null // 当前所处的引号字符
  for (let i = itemsStart + 'items={'.length; i < code.length; i++) {
    const ch = code[i]
    if (quote) {
      // 字符串内部：只有同种引号且未转义才结束
      if (ch === quote && code[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return code.slice(tagStart, i + 1)
    }
  }
  throw new Error(`items 数组未闭合：${marker}`)
}

// ===== 1. forceRender：低频项面板必须预渲染 =====
t('基本信息低频项面板带 forceRender: true', () => {
  const block = collapseBlock('更多选项（备注 / 到期时间 / 扩展）')
  assert.ok(
    /forceRender:\s*true/.test(block),
    'forceRender 缺失或不为 true —— 收起状态下备注/到期时间/扩展不会挂载，\n' +
      '        「什么都没改的编辑」会把这些字段静默清空。'
  )
})

t('forceRender 出现在 Form.Item 所在的同一个面板内（不是别的面板）', () => {
  const block = collapseBlock('更多选项（备注 / 到期时间 / 扩展）')
  const forceIdx = block.indexOf('forceRender')
  const remarkIdx = block.indexOf('name="remark"')
  const expiresIdx = block.indexOf('name="expiresAt"')
  const extIdx = block.indexOf('name="extensions"')
  assert.ok(forceIdx >= 0, 'forceRender 不在该面板内')
  for (const [label, i] of [['remark', remarkIdx], ['expiresAt', expiresIdx], ['extensions', extIdx]]) {
    assert.ok(i >= 0, `面板内未找到字段：${label}`)
    assert.ok(i > forceIdx, `字段 ${label} 不在 forceRender 之后（结构异常）`)
  }
})

// ===== 2. 指纹区必须用受控 activeKey，而非 defaultActiveKey =====
t('指纹折叠区用受控 activeKey（不是 defaultActiveKey）', () => {
  const block = collapseBlock("label: '基础设置'")
  assert.ok(/activeKey=\{fpSections\}/.test(block), '指纹折叠区未使用受控 activeKey={fpSections}')
  assert.ok(
    !/defaultActiveKey/.test(block),
    '指纹折叠区仍在用 defaultActiveKey —— 它只在首次挂载生效，\n' +
      '        上次展开的状态会黏到下一次打开的表单上。'
  )
})

t('基本信息低频项折叠区用受控 activeKey（不是 defaultActiveKey）', () => {
  const block = collapseBlock('更多选项（备注 / 到期时间 / 扩展）')
  assert.ok(/activeKey=\{baseExtras\}/.test(block), '低频项折叠区未使用受控 activeKey={baseExtras}')
  assert.ok(!/defaultActiveKey/.test(block), '低频项折叠区仍在用 defaultActiveKey')
})

// ===== 3. 打开时必须重置展开状态 =====
t('打开抽屉时重置展开状态（新建全收起 / 编辑展开基础设置）', () => {
  assert.ok(/setFpSections\(initial \? \['basic'\] : \[\]\)/.test(code), '未找到新建/编辑态的展开状态重置逻辑')
  assert.ok(/setBaseExtras\(\[\]\)/.test(code), '未找到低频项面板的重置逻辑')
})

t('重置逻辑挂在 open 变化上（依赖数组含 open）', () => {
  const m = code.match(/useEffect\(\(\) => \{[\s\S]{0,400}?setFpSections\([\s\S]{0,200}?\}, \[([^\]]*)\]\)/)
  assert.ok(m, '未找到负责重置展开状态的 useEffect')
  assert.ok(/\bopen\b/.test(m[1]), `重置 effect 的依赖数组里没有 open：${m[1]}`)
})

// ===== 4. 指纹区不能被塞进 Form.Item（收起会丢值）=====
t('指纹折叠区不在 Form.Item 内（避免收起即丢值）', () => {
  const block = collapseBlock("label: '基础设置'")
  // 指纹折叠区是 Collapse 直接子级（内部自己管理 Form.Item），
  // 若被外层 <Form.Item name="..."> 包住，收起时字段就不在 values 里。
  assert.ok(
    !/<Form\.Item[^>]*name=/.test(block),
    '指纹折叠区被包在了带 name 的 Form.Item 里 —— 收起时字段会从 values 中消失。'
  )
})

t('指纹折叠区内部的 Form.Item 一律不带 name（受控组件，非表单绑定）', () => {
  // 指纹字段是 value/onChange 手动写进 fp 状态的（setFpField），
  // 不是 antd 表单绑定。若误加了 name，antd 会接管这些 Input 的值，
  // 出现「输入框改不动」或「收起后值丢失」两类怪现象。
  const block = collapseBlock("label: '基础设置'")
  const named = block.match(/<Form\.Item[^>]*\bname=/g)
  assert.ok(
    !named,
    `指纹区出现了带 name 的 Form.Item：${named && named.join(', ')}\n` +
      '        指纹字段是受控组件，name 会让 antd 接管它们的值。'
  )
})

// ===== 5. 新建态提示语存在 =====
t('指纹 Tab 有「一般只需选一个预设或点一键随机指纹」的提示', () => {
  assert.ok(/一般只需选一个预设/.test(code), '缺少新建态的操作提示语')
})

console.log(`\n${passed} 项断言通过`)
if (passed < 9) {
  console.error('断言数异常偏少，检查测试是否被意外跳过')
  process.exitCode = 1
}
