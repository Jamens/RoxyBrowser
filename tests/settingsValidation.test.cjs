// 设置页保存链路（src/shared/settingsValidation.ts）的离线单测。
//
// ## 要锁住什么
//
// 1. **SMTP 是可选功能**：三件套全空时必须放行。
//    这条是「改了 AI Agent 开关与视觉模型却存不进去」的根因所在：
//    antd 的 validateFields() 校验整张表，SMTP 的无条件 required 一失败，
//    整次保存连请求都不发，用户改的东西被静默丢弃。
// 2. **填了一半就要填全**：用户开始配 SMTP 就得配完，否则邀请邮件发不出去。
// 3. **条件渲染卸载的字段不能被默认值覆盖**：validateFields() 只返回当前挂载的
//    字段，卸载字段（如切到云端后端后的本地模型）不在返回值里 —— 合并全量
//    store 才是保住用户已改配置的唯一办法。
//
// 用法：node tests/settingsValidation.test.cjs
// （编译产物由 scripts/run-tests.mjs 负责，见 COMPILES 里的 settingsValidation 条目）
const assert = require('assert')
const {
  smtpConfigured,
  missingSmtpFields,
  mergeSettingsPayload,
  SMTP_TRIPLE_FIELDS
} = require('../.tmp_sv/shared/settingsValidation.js')

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

// ===== 1. SMTP 条件必填 =====
t('SMTP 全空 → 未启用（放行，不拦下整表保存）', () => {
  assert.strictEqual(smtpConfigured({ host: '', user: '', pass: '' }), false)
  assert.deepStrictEqual(missingSmtpFields({ host: '', user: '', pass: '' }), [])
})

t('SMTP 整个对象不存在 → 放行', () => {
  assert.strictEqual(smtpConfigured(undefined), false)
  assert.strictEqual(smtpConfigured(null), false)
  assert.deepStrictEqual(missingSmtpFields(undefined), [])
})

t('SMTP 只填了 host → 指出还缺 user 与 pass', () => {
  assert.strictEqual(smtpConfigured({ host: 'smtp.example.com' }), true)
  assert.deepStrictEqual(missingSmtpFields({ host: 'smtp.example.com' }), ['user', 'pass'])
})

t('SMTP 只填了 user → 指出还缺 host 与 pass', () => {
  assert.deepStrictEqual(missingSmtpFields({ user: 'a@b.com' }), ['host', 'pass'])
})

t('SMTP 只填了 pass → 指出还缺 host 与 user', () => {
  assert.deepStrictEqual(missingSmtpFields({ pass: 'secret' }), ['host', 'user'])
})

t('SMTP 三件套填全 → 无缺失', () => {
  const full = { host: 'smtp.example.com', user: 'a@b.com', pass: 'secret' }
  assert.strictEqual(smtpConfigured(full), true)
  assert.deepStrictEqual(missingSmtpFields(full), [])
})

t('只含空格的字符串视为未填（不算"开始配置了"）', () => {
  assert.strictEqual(smtpConfigured({ host: '   ', user: '', pass: '' }), false)
  assert.deepStrictEqual(missingSmtpFields({ host: '  ' }), [])
})

t('SMTP 三件套的字段集合固定为 host/user/pass', () => {
  assert.deepStrictEqual([...SMTP_TRIPLE_FIELDS], ['host', 'user', 'pass'])
})

// ===== 2. 载荷合并：保住条件渲染卸载的字段 =====
t('卸载字段（不在校验结果里）保留 store 中的原值', () => {
  // 场景：backend 切到 cloud 后，「本地模型」两个字段被卸载，
  // validateFields() 的返回值里没有它们 → 只发返回值等于用默认值抹掉。
  const full = {
    aiAgent: {
      enabled: true,
      backend: 'cloud',
      localModel: 'qwen2.5:7b',
      localVisionModel: 'qwen2.5vl:7b'
    }
  }
  const validated = { aiAgent: { enabled: true, backend: 'cloud' } }
  const out = mergeSettingsPayload(full, validated)
  assert.strictEqual(out.aiAgent.localVisionModel, 'qwen2.5vl:7b', '卸载字段被默认值覆盖了')
  assert.strictEqual(out.aiAgent.localModel, 'qwen2.5:7b')
  assert.strictEqual(out.aiAgent.backend, 'cloud', '已挂载字段应以校验结果为准')
})

t('已挂载字段以校验结果为准（用户的新值覆盖旧值）', () => {
  const full = { aiAgent: { enabled: false, localVisionModel: 'old:7b' } }
  const validated = { aiAgent: { enabled: true, localVisionModel: 'new:7b' } }
  const out = mergeSettingsPayload(full, validated)
  assert.strictEqual(out.aiAgent.enabled, true)
  assert.strictEqual(out.aiAgent.localVisionModel, 'new:7b')
})

t('undefined 不覆盖既有值（未提交的字段不该被抹成 undefined）', () => {
  const full = { aiAgent: { localVisionModel: 'keep:7b' } }
  const out = mergeSettingsPayload(full, { aiAgent: { localVisionModel: undefined } })
  assert.strictEqual(out.aiAgent.localVisionModel, 'keep:7b')
})

t('顶层字段同样以校验结果为准', () => {
  const full = { theme: 'auto', language: 'zh-CN' }
  const out = mergeSettingsPayload(full, { theme: 'dark' })
  assert.strictEqual(out.theme, 'dark')
  assert.strictEqual(out.language, 'zh-CN', '未提交的顶层字段应保留')
})

t('数组字段按整体替换（webhooks / aiAutoTasks 不能被逐键合并）', () => {
  const full = { webhooks: [{ id: 1 }], aiAutoTasks: [{ name: 'a' }] }
  const out = mergeSettingsPayload(full, { webhooks: [{ id: 2 }] })
  assert.deepStrictEqual(out.webhooks, [{ id: 2 }])
  assert.deepStrictEqual(out.aiAutoTasks, [{ name: 'a' }])
})

t('smtp 子对象做一层合并（已挂载字段更新，未挂载的 from 保留）', () => {
  const full = { smtp: { host: '', port: 465, from: 'a@b.com', secure: true } }
  const out = mergeSettingsPayload(full, { smtp: { host: 'smtp.example.com' } })
  assert.strictEqual(out.smtp.host, 'smtp.example.com')
  assert.strictEqual(out.smtp.from, 'a@b.com')
  assert.strictEqual(out.smtp.port, 465)
})

t('空输入不炸', () => {
  assert.deepStrictEqual(mergeSettingsPayload(undefined, undefined), {})
  assert.deepStrictEqual(mergeSettingsPayload({}, {}), {})
})

t('合并不会污染入参（不改调用方的对象）', () => {
  const full = { aiAgent: { enabled: false } }
  const validated = { aiAgent: { enabled: true } }
  mergeSettingsPayload(full, validated)
  assert.strictEqual(full.aiAgent.enabled, false, '入参被就地修改了')
})

console.log(`\n${passed} 项通过`)
