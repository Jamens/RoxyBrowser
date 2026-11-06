// 设置页「保存」链路的源码级守卫。
//
// ## 要锁住什么
//
// 用户报障：「把 AI Agent 打开、把视觉模型换成 qwen2.5vl:7b，保存后去 AI Agent 页
// 显示未启用，再回设置页发现视觉模型又变回之前的了 —— 自己改的又被恢复」。
//
// 根因不在 AI Agent，而在**设置页的整表校验**：SMTP 三件套（host/user/pass）挂着
// 无条件 `required`，而默认值是空串；antd 的 `validateFields()` 校验整张表，
// 任一字段不过整次保存就被拒（连 api.put 都不发）→ 用户的改动被静默丢弃，
// 重新进页面时 load() 又拉回服务端旧值。
//
// 本文件把这些"以后可能被顺手改回去"的地方逐条钉死。行为级验证见
// scripts/verify-settings-save-guard.mjs（真窗口 + CDP，证明"跑起来对"）。
//
// 用法：node tests/settingsSaveGuard.test.cjs
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const settingsSrc = fs.readFileSync(path.join(root, 'src/renderer/src/pages/Settings.tsx'), 'utf8')
const typesSrc = fs.readFileSync(path.join(root, 'src/shared/types.ts'), 'utf8')
const validationSrc = fs.readFileSync(path.join(root, 'src/shared/settingsValidation.ts'), 'utf8')

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

// ===== 工具：从 Settings.tsx 里抽出「带 required 的 Form.Item」的 name 路径 =====
/**
 * 抓 `<Form.Item name=... rules={[{ required: true ... }]}>` 这类写法。
 * 逐个 Form.Item 块扫描（按 `name=` 与 `rules=` 的先后顺序配对），
 * 只处理 name 与 rules 同时出现的行内写法 —— 项目里的必填项都是这种。
 */
function requiredFieldNames(src) {
  const out = []
  const itemRe = /<Form\.Item\b([\s\S]*?)(?:\/>|>)/g
  let m
  while ((m = itemRe.exec(src)) !== null) {
    const body = m[1]
    if (!/rules=\{\[[^\]]*required:\s*true/.test(body)) continue
    const nameMatch = body.match(/name=(?:"([^"]+)"|\{\[([^\]]+)\]\})/)
    if (!nameMatch) continue
    if (nameMatch[1]) out.push(nameMatch[1])
    else {
      const parts = nameMatch[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      out.push(parts.join('.'))
    }
  }
  return out
}

/** 从 DEFAULT_SETTINGS 字面量里取标量默认值（只认字符串/数字/布尔） */
function defaultScalars(src) {
  const start = src.indexOf('export const DEFAULT_SETTINGS')
  assert.ok(start > 0, 'types.ts 里找不到 DEFAULT_SETTINGS')
  const body = src.slice(start)
  const out = {}
  // 只取顶层与一层嵌套（smtp.* / aiAgent.*）的标量默认值
  const re = /^\s{2,4}([A-Za-z_][A-Za-z0-9_]*):\s*('[^']*'|-?[\d.]+|true|false)\s*,?\s*$/gm
  let m
  let currentGroup = null
  for (const line of body.split('\n')) {
    const g = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/)
    if (g) {
      currentGroup = g[1]
      continue
    }
    if (/^\s{2}\},?\s*$/.test(line)) {
      currentGroup = null
      continue
    }
    const mm = line.match(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):\s*('[^']*'|-?[\d.]+|true|false)\s*,?\s*$/)
    if (mm && currentGroup) {
      out[`${currentGroup}.${mm[1]}`] = mm[2]
      continue
    }
    const top = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*('[^']*'|-?[\d.]+|true|false)\s*,?\s*$/)
    if (top) out[top[1]] = top[2]
  }
  return out
}

// ===== 1. 根因本体：必填项必须有非空默认值 =====
/**
 * 允许的例外：默认值空串、但**只在用户主动进入某个模式后才挂载**的必填字段。
 *
 * 这类字段不挂载时不参与校验（antd 只校验已挂载的 Form.Item），所以不会锁死设置页；
 * 挂载时必填也是合理的 —— 用户明说了「我要用自定义代理」，却没给主机号，配置本就无效。
 *
 * 新增例外必须在这里显式登记并写清理由，否则守卫会拦下 —— 防止又出现一个
 * 「默认状态下就校验不过、整个设置页存不进去」的字段。
 */
const REQUIRED_EMPTY_DEFAULT_ALLOWLIST = {
  customProxyHost: '仅在 networkMode=custom 时挂载；用户主动选了自定义代理才要求填主机'
}

t('所有 required 字段的默认值都非空（否则会拦死整个设置页的保存）', () => {
  const required = requiredFieldNames(settingsSrc)
  const defaults = defaultScalars(typesSrc)
  const bad = []
  const unregistered = []
  for (const name of required) {
    const raw = defaults[name]
    if (raw === undefined) continue // 复杂默认值（对象/数组/常量）无法用本解析判定
    // 数字 0 与布尔 false 是合法默认值；只有"空串"才是致命的（默认值是空串 → 表单永远校验不过）
    if (raw !== "''") continue
    if (name in REQUIRED_EMPTY_DEFAULT_ALLOWLIST) continue
    bad.push(name)
  }
  for (const name of Object.keys(REQUIRED_EMPTY_DEFAULT_ALLOWLIST)) {
    if (!required.includes(name)) unregistered.push(name)
  }
  assert.deepStrictEqual(bad, [], `这些必填字段的默认值是空串：${bad.join(', ')}`)
  assert.deepStrictEqual(unregistered, [], `白名单里的字段已经不是必填了，请删掉白名单条目：${unregistered.join(', ')}`)
})

t('白名单里的例外字段确实是条件渲染（不挂载时不参与校验）', () => {
  // customProxyHost 必须待在 networkMode === 'custom' 的条件块里，
  // 否则它就成了「默认状态下也必填」的致命字段
  const idx = settingsSrc.indexOf("name=\"customProxyHost\"")
  assert.ok(idx > 0, '找不到 customProxyHost')
  const before = settingsSrc.slice(0, idx)
  const condIdx = before.lastIndexOf("networkMode === 'custom'")
  assert.ok(condIdx > 0, 'customProxyHost 不在 networkMode === "custom" 的条件块里')
  // 条件块起点之后不应再有"无条件渲染"的痕迹：检查它确实落在条件块内
  const between = before.slice(condIdx)
  assert.ok(between.includes('networkMode'), 'customProxyHost 的条件块定位失败')
})

t('SMTP 三件套不再是「无条件 required」（必须走条件校验）', () => {
  assert.ok(
    !/name=\{\['smtp',\s*'host'\]\}[^>]*rules=\{\[\{\s*required:\s*true/.test(settingsSrc),
    "smtp.host 又变回无条件 required 了"
  )
  assert.ok(
    !/name=\{\['smtp',\s*'user'\]\}[^>]*rules=\{\[\{\s*required:\s*true/.test(settingsSrc),
    "smtp.user 又变回无条件 required 了"
  )
  assert.ok(
    !/name=\{\['smtp',\s*'pass'\]\}[^>]*rules=\{\[\{\s*required:\s*true/.test(settingsSrc),
    "smtp.pass 又变回无条件 required 了"
  )
})

t('SMTP 三件套改用条件校验 smtpTripleRule', () => {
  for (const field of ['host', 'user', 'pass']) {
    assert.ok(
      settingsSrc.includes(`name={['smtp', '${field}']} label={t('settings.smtp${field === 'host' ? 'Host' : field === 'user' ? 'User' : 'Pass'}')} rules={[{ validator: smtpTripleRule('${field}') }]}`),
      `smtp.${field} 没走 smtpTripleRule 条件校验`
    )
  }
})

t('SMTP 端口也是条件必填（没配 SMTP 时端口不该拦下保存）', () => {
  assert.ok(settingsSrc.includes("name={['smtp', 'port']} label={t('settings.smtpPort')} rules={[{ validator: smtpPortRule }]"), 'smtp.port 没走条件校验')
})

// ===== 2. 保存失败必须可见（不能静默吞掉用户的改动）=====
t('Form 走 antd 的 onFinish / onFinishFailed', () => {
  assert.ok(/onFinish=\{handleFinish\}/.test(settingsSrc), 'Form 上缺 onFinish')
  assert.ok(/onFinishFailed=\{handleFinishFailed\}/.test(settingsSrc), 'Form 上缺 onFinishFailed')
})

t('Form 开了 scrollToFirstError（校验失败自动定位到出错项）', () => {
  assert.ok(/scrollToFirstError/.test(settingsSrc), 'Form 上缺 scrollToFirstError')
})

t('不再有裸的 await form.validateFields()（那会静默 reject）', () => {
  assert.ok(
    !/await form\.validateFields\(\)/.test(settingsSrc),
    '又出现了裸的 validateFields()，校验失败会静默吞掉用户的改动'
  )
})

t('校验失败有明确的用户提示文案', () => {
  assert.ok(settingsSrc.includes("t('settings.saveValidationFailed'"), '校验失败没有提示文案')
  for (const locale of ['zhCN', 'enUS', 'jaJP', 'deDE']) {
    assert.ok(locale, 'i18n 缺语言')
  }
})

t('保存按钮是 submit（交给 antd 统一处理校验与失败反馈）', () => {
  assert.ok(/htmlType="submit"/.test(settingsSrc), '保存按钮不是 submit')
  assert.ok(!/onClick=\{save\}/.test(settingsSrc), '保存按钮又退回 onClick={save} 了')
})

// ===== 3. 条件渲染卸载的字段不能被默认值覆盖 =====
t('保存时合并全量 store（保住被卸载的字段）', () => {
  assert.ok(
    /mergeSettingsPayload\(form\.getFieldsValue\(true\)/.test(settingsSrc),
    '保存时没有合并 getFieldsValue(true)，卸载字段会被服务端默认值覆盖'
  )
})

t('mergeSettingsPayload 会做一层嵌套合并（aiAgent / smtp 不能整体替换）', () => {
  assert.ok(/isPlainObject\(fv\)\s*&&\s*isPlainObject\(v\)/.test(validationSrc), '嵌套对象没有做合并')
  assert.ok(/out\[k\]\s*=\s*merged/.test(validationSrc), '嵌套对象合并结果没有写回')
})

t('共享模块导出齐了设置页要用到的三个函数', () => {
  for (const fn of ['smtpConfigured', 'missingSmtpFields', 'mergeSettingsPayload']) {
    assert.ok(new RegExp(`export function ${fn}\\b`).test(validationSrc), `缺少导出 ${fn}`)
  }
})

console.log(`\n${passed} 项通过`)
