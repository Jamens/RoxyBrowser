// 横向 Space 溢出与操作列可访问性的源码级守卫。
//
// ## 要锁住什么
//
// 用户报障：「环境管理的编辑环境的高级设置 ui 有点问题」。
//
// 根因是一条可复用的判据：
//   **横向 Space（flex-wrap: nowrap）+ 子项自然宽度 > 容器宽度 → 溢出**。
//   若该 Form 是 layout="vertical"，antd 会把 label 的 white-space 覆盖成
//   initial，label 就逐字换行——中文直接竖排（「追踪器屏蔽」竖成 6 行）。
//
// 同一判据在三个地方各犯过一次：
//   1. 编辑抽屉「指纹配置 → 高级设置」：7 个表单项自然宽度约 704px，抽屉只有 640px
//   2. 设置页「安全阈值」：三个 InputNumber + extra 说明约 768px，可用宽度约 560px
//   3. 环境管理表格「操作」列：11 个按钮自然宽度 354px，列却声明 276px
//      → 内容溢出单元格 78px，「删除」被推到表格右边界之外
//
// 另外「编辑」是 11 个按钮里唯一没有 Tooltip 的（其余 10 个都有），
// 纯图标按钮悬停无任何提示，也不知道它是什么。
//
// 这些都是"以后可能被顺手改回去"的地方，逐条钉死。行为级验证见
// scripts/verify-env-operations-layout.mjs（真窗口 + CDP，证明"跑起来对"）。
//
// 用法：node tests/envOperationsLayout.test.cjs
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const profileFormSrc = fs.readFileSync(path.join(root, 'src/renderer/src/components/ProfileForm.tsx'), 'utf8')
const settingsSrc = fs.readFileSync(path.join(root, 'src/renderer/src/pages/Settings.tsx'), 'utf8')
const envsSrc = fs.readFileSync(path.join(root, 'src/renderer/src/pages/Environments.tsx'), 'utf8')

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

// ===== 工具 =====

/**
 * 找出所有「横向 Space」：带 style 且没写 flexWrap: 'wrap'、也没写 wrap 属性的。
 * 只看 Space 组件的用法（<Space ...>），避免误伤其它 flex 容器。
 */
function findHorizontalSpaces(src) {
  const out = []
  const re = /<Space\b([^>]*?)>/gs
  let m
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1]
    // 自闭合 / 无 style 的 <Space> 不参与（antd 默认就是 nowrap，
    // 但内层 Space 常见于纯分组场景，这里只抓「明确设了 display:flex」的）
    if (!/display:\s*'flex'/.test(attrs)) continue
    const hasWrap = /\bwrap\b/.test(attrs)
    out.push({ index: m.index, attrs, hasWrap, line: src.slice(0, m.index).split('\n').length })
  }
  return out
}

/** 取出某段源码里指定 label 文案所在 Form.Item 之前最近的 <Space ...> 开标签 */
function spaceBeforeLabel(src, label) {
  const idx = src.indexOf(`label="${label}"`)
  if (idx < 0) return null
  const before = src.slice(0, idx)
  const lastOpen = before.lastIndexOf('<Space')
  if (lastOpen < 0) return null
  const lastClose = before.lastIndexOf('</Space>')
  if (lastClose > lastOpen) return null
  const tagEnd = src.indexOf('>', lastOpen)
  return src.slice(lastOpen, tagEnd + 1)
}

// ===== 1. 编辑抽屉「高级设置」=====

t('高级设置那一排 Space 必须带 wrap', () => {
  const space = spaceBeforeLabel(profileFormSrc, '追踪器屏蔽')
  assert.ok(space, '没找到「追踪器屏蔽」所属的 Space')
  assert.ok(/\bwrap\b/.test(space), `该 Space 缺 wrap：${space}`)
})

t('高级设置的开关排必须用 display:flex（否则 antd 默认 inline-flex 不换行）', () => {
  const space = spaceBeforeLabel(profileFormSrc, '追踪器屏蔽')
  assert.ok(space, '没找到「追踪器屏蔽」所属的 Space')
  assert.ok(/display:\s*'flex'/.test(space), `该 Space 未设 display:flex：${space}`)
})

t('高级设置里 5 个开关的 label 都还在（不能被误删）', () => {
  for (const label of ['Canvas 噪声', 'Audio 噪声', '追踪器屏蔽', 'HTTP 安全警告', '减少动效']) {
    assert.ok(profileFormSrc.includes(`label="${label}"`), `缺少 label：${label}`)
  }
})

// ===== 2. 设置页「安全阈值」=====

t('设置页安全阈值的 Space 必须带 wrap', () => {
  // 安全阈值区紧跟在 security.section 分割线之后
  const secIdx = settingsSrc.indexOf("t('security.section')")
  assert.ok(secIdx > 0, '没找到安全阈值区')
  const region = settingsSrc.slice(secIdx, secIdx + 1200)
  const space = region.match(/<Space\b[^>]*>/)
  assert.ok(space, '安全阈值区没有 Space')
  assert.ok(/\bwrap\b/.test(space[0]), `安全阈值的 Space 缺 wrap：${space[0]}`)
})

// ===== 3. 环境管理「操作」列 =====

t('操作列声明宽度必须容得下 11 个按钮（>= 360px）', () => {
  // 实测：1 个文字按钮 66px + 10 个纯图标按钮 24px + 10 个 4px 间距 = 354px
  // 注意注释里也含 "276" 与 "360"，正则要跳过注释行。
  const m = envsSrc.match(/title: '操作',\s*\n(?:\s*\/\/[^\n]*\n)*\s*width: (\d+)/)
  assert.ok(m, '没找到操作列的宽度声明')
  const w = Number(m[1])
  assert.ok(w >= 360, `操作列宽度 ${w}px 容不下 354px 的按钮，会溢出单元格`)
})

t('操作列的编辑按钮必须有 Tooltip', () => {
  const idx = envsSrc.indexOf('<EditOutlined />')
  assert.ok(idx > 0, '没找到编辑按钮')
  // Tooltip 必须包在按钮外层：<Tooltip ...><Button ... icon={<EditOutlined />} ... /></Tooltip>
  const before = envsSrc.slice(Math.max(0, idx - 400), idx)
  assert.ok(/<Tooltip[\s\S]*$/.test(before), '编辑按钮没有被 Tooltip 包裹')
})

t('操作列所有纯图标按钮都必须有 Tooltip（防止以后又漏一个）', () => {
  // 取出「操作」列的 render 函数体（到列定义结束为止）
  const opIdx = envsSrc.indexOf("title: '操作',")
  assert.ok(opIdx > 0, '没找到操作列')
  const region = envsSrc.slice(opIdx, opIdx + 6000)
  // render 结束的标志：`</Space>` → `)` → `}`（列定义闭合）。
  // 本仓库文件是 CRLF 换行，正则必须同时兼容 \r\n 与 \n。
  const endMatch = region.match(/<\/Space>\s*<\/Space>|<\/Space>\r?\n\s*\)\r?\n\s{4}\}/)
  assert.ok(endMatch, '没定位到操作列 render 的结尾')
  const body = region.slice(0, endMatch.index)

  // 找出所有 icon={<XxxOutlined />} 的 Button，逐个检查外层是否有 Tooltip / Popconfirm。
  //
  // 定位方式：先扫 icon={...}，再**向前回溯**找最近的 <Button。
  // 不能用「<Button ...>...</Button>」整块正则——onClick={() => ...}
  // 里的箭头与花括号会破坏 [^<>]* 的匹配，整块正则只能盖住 5 个按钮。
  const iconRe = /icon=\{<[A-Za-z]+Outlined\s*\/>/g
  const found = []
  let m
  while ((m = iconRe.exec(body)) !== null) {
    const btnIdx = body.lastIndexOf('<Button', m.index)
    assert.ok(btnIdx >= 0, `icon 前面找不到 <Button：${m[0]}`)
    found.push({ index: m.index, btnIdx, icon: m[0] })
  }
  assert.ok(found.length >= 10, `只找到 ${found.length} 个图标按钮，预期 >= 10（断言可能失效）`)

  for (const b of found) {
    // 带文案（「打开」「关闭」）的按钮本身就有提示，不需要 Tooltip。
    // 只管**纯图标**按钮——它们全靠 Tooltip 说明用途。
    const btnText = body.slice(b.btnIdx, b.btnIdx + 200)
    const hasLabel = />\s*[^<>{}]*\s*<\/Button>/.test(btnText)
    if (hasLabel) continue
    // 从 <Button 往前看 600 字符：应有 Tooltip / Popconfirm 的开标签且尚未闭合
    const before = body.slice(Math.max(0, b.btnIdx - 600), b.btnIdx)
    const wrapped = /<(Tooltip|Popconfirm)\b[^>]*>[\s\S]*$/.test(before)
    assert.ok(wrapped, `操作列有个纯图标按钮没有 Tooltip/Popconfirm：${b.icon}`)
  }
})

// ===== 4. 通用：横向 Space 的溢出判据 =====

/**
 * 判据：横向 Space（nowrap）+ 子项自然宽度 > 容器宽度 → 溢出。
 *
 * 这里不追求「所有横向 Space 都加 wrap」——设置页里 1~3 项的 Space
 * （窗口尺寸 / 自动主题 / 代理检测 / SMTP 三件套）自然宽度远小于容器，
 * 实测普查（scripts 下的溢出普查脚本）确认它们都不溢出，强行加 wrap
 * 反而会让表单在宽屏下显得松散。
 *
 * 真正会溢出的是**子项多**的那几排，所以断言只针对已实测会溢出的区域。
 */
t('已实测会溢出的区域都带 wrap（子项多的三处）', () => {
  const cases = [
    ['ProfileForm 高级设置', spaceBeforeLabel(profileFormSrc, '追踪器屏蔽')],
    [
      'Settings 安全阈值',
      (() => {
        const secIdx = settingsSrc.indexOf("t('security.section')")
        assert.ok(secIdx > 0, '没找到安全阈值区')
        const region = settingsSrc.slice(secIdx, secIdx + 1200)
        return region.match(/<Space\b[^>]*>/)
      })()
    ]
  ]
  for (const [name, space] of cases) {
    assert.ok(space, `${name}：没找到 Space`)
    assert.ok(/\bwrap\b/.test(space), `${name} 的 Space 缺 wrap：${space}`)
  }
})

t('横向 Space 一旦子项超过 4 个就必须带 wrap', () => {
  // 逐个横向 Space 数直接子项个数（<Form.Item 作为子项）。
  // 少于等于 4 项的自然宽度不会超容器，超过就必须 wrap。
  const offenders = []
  for (const [file, src] of [['ProfileForm.tsx', profileFormSrc], ['Settings.tsx', settingsSrc]]) {
    const re = /<Space\b([^>]*?)>([\s\S]*?)<\/Space>/g
    let m
    while ((m = re.exec(src)) !== null) {
      const attrs = m[1]
      if (!/display:\s*'flex'/.test(attrs)) continue
      if (/\bwrap\b/.test(attrs)) continue
      const items = (m[2].match(/<Form\.Item\b/g) || []).length
      if (items > 4) {
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}(${items} 项)`)
      }
    }
  }
  assert.strictEqual(offenders.length, 0, `这些横向 Space 子项超过 4 个却没 wrap：${offenders.join(', ')}`)
})

console.log(`\n  ${passed} 项通过`)
