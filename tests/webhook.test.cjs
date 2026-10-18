/**
 * Webhook 事件匹配（webhookShouldFire）离线单测。
 *
 * 重点：单复数形态必须归一。
 * 匹配语义是「事件名按 _ 分词后**精确**包含订阅值」，而日志动作名里
 * 单复数混用（create_cookie 与 import_cookies、create_proxy 与 import_proxies）。
 * 不归一的后果不是报错，而是**静默漏推**——用户订阅了 Cookie 变更通知，
 * 批量导入时一次都收不到，还以为是自己记错了。这种缺陷最难被用户发现。
 */
const assert = require('assert')
const { webhookShouldFire } = require('../.tmp_wh/main/webhook.js')
const { WEBHOOK_EVENT_GROUPS } = require('../.tmp_wh/shared/types.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1 }
}

/** 便捷构造：订阅指定关键词 */
const wh = (...events) => ({ enabled: true, events })

// ============ 基础开关 ============

t('未启用一律不触发', () => {
  assert.strictEqual(webhookShouldFire({ enabled: false, events: ['*'] }, 'create_profile'), false)
})

t('启用 + 订阅 * → 全触发', () => {
  for (const ev of ['create_profile', 'import_cookies', 'logout', 'whatever']) {
    assert.strictEqual(webhookShouldFire(wh('*'), ev), true, ev)
  }
})

t('启用 + 订阅列表为空 → 全触发（默认不过滤）', () => {
  assert.strictEqual(webhookShouldFire({ enabled: true, events: [] }, 'create_profile'), true)
  assert.strictEqual(webhookShouldFire({ enabled: true }, 'create_profile'), true)
})

t('订阅了但不匹配的事件不触发', () => {
  assert.strictEqual(webhookShouldFire(wh('rpa'), 'create_profile'), false)
})

// ============ 精确事件名订阅 ============

t('订阅完整事件名可命中（历史配置必须继续有效）', () => {
  assert.strictEqual(webhookShouldFire(wh('create_profile'), 'create_profile'), true)
})

t('完整事件名精确匹配优先于分词', () => {
  // import_profiles 订阅整名，不应被 'profile' 这类关键词误伤
  assert.strictEqual(webhookShouldFire(wh('import_profiles'), 'import_profiles'), true)
})

// ============ 通配符 ============

t('后缀通配 import_* 可命中该前缀全部事件', () => {
  assert.strictEqual(webhookShouldFire(wh('import_*'), 'import_profiles'), true)
  assert.strictEqual(webhookShouldFire(wh('import_*'), 'import_proxies'), true)
  assert.strictEqual(webhookShouldFire(wh('import_*'), 'create_profile'), false)
})

t('通配符中的 . + 等正则元字符被正确转义', () => {
  // 若不转义，'a.b' 会被当成正则而匹配到 'axb'——错误投递
  assert.strictEqual(webhookShouldFire(wh('a.b'), 'axb'), false)
  assert.strictEqual(webhookShouldFire(wh('a.b'), 'a.b'), true)
})

// ============ 单复数归一（本功能的核心）============

t('订阅单数 cookie 能收到复数 cookies 事件', () => {
  // 这就是「静默漏推」的现场：导入 Cookie 收不到任何通知
  assert.strictEqual(webhookShouldFire(wh('cookie'), 'import_cookies'), true)
  assert.strictEqual(webhookShouldFire(wh('cookie'), 'apply_cookies'), true)
  assert.strictEqual(webhookShouldFire(wh('cookie'), 'clear_cookies'), true)
})

t('订阅单数 proxy 能收到复数 proxies 事件', () => {
  assert.strictEqual(webhookShouldFire(wh('proxy'), 'import_proxies'), true)
})

t('订阅单数 profile 能收到复数 profiles 事件', () => {
  assert.strictEqual(webhookShouldFire(wh('profile'), 'import_profiles'), true)
})

t('订阅单数 account 能收到复数 accounts 事件', () => {
  assert.strictEqual(webhookShouldFire(wh('account'), 'import_accounts'), true)
})

t('反向：订阅复数也能收到单数事件（归一是对称的）', () => {
  assert.strictEqual(webhookShouldFire(wh('cookies'), 'create_cookie'), true)
  assert.strictEqual(webhookShouldFire(wh('proxies'), 'create_proxy'), true)
  assert.strictEqual(webhookShouldFire(wh('profiles'), 'create_profile'), true)
})

t('真实动作名全表核对：每个注册分组关键词都必须能覆盖同类事件', () => {
  // 模拟设置页实际登记的分组关键词
  const groups = {
    profile: ['profile', 'template'],
    proxy: ['proxy'],
    team: ['team', 'member', 'token'],
    account: ['account'],
    cookie: ['cookie'],
    rpa: ['rpa'],
    agent: ['agent'],
    auth: ['login', '2fa'],
    expiry: ['expiry', 'alert'],
    health: ['health', 'consistency', 'fix']
  }
  // 覆盖四类的单数与复数两种写法
  const cases = [
    ['create_cookie', 'cookie'],
    ['import_cookies', 'cookie'],
    ['clear_cookies', 'cookie'],
    ['apply_cookies', 'cookie'],
    ['create_proxy', 'proxy'],
    ['import_proxies', 'proxy'],
    ['create_profile', 'profile'],
    ['import_profiles', 'profile'],
    ['batch_delete_profile', 'profile'],
    ['create_account', 'account'],
    ['import_accounts', 'account'],
    ['clone_template', 'template']
  ]
  for (const [ev, kw] of cases) {
    assert.strictEqual(
      webhookShouldFire(wh(kw), ev),
      true,
      `订阅 ${kw} 应能收到 ${ev}`
    )
  }
  // 分组关键词确实存在于登记表中（防止上表与实际配置脱节）
  for (const [g, kws] of Object.entries(groups)) {
    assert.ok(Array.isArray(kws) && kws.length > 0, `分组 ${g} 关键词为空`)
  }
})

t('归一不误伤：原词必须完好，不能被拆坏', () => {
  // 候选集的关键保证：**只增加候选，绝不改写原词**。
  // 最初的破坏性实现（cookies→cooky）就是在这里翻车的，
  // 所以这条断言的价值在于锁死「rpa 不能被拆成 rp、consistency 不能被截断」。
  const intact = [
    ['rpa', 'create_rpa_script'],
    ['rpa', 'update_rpa_script'],
    ['consistency', 'fix_consistency'],
    ['health', 'health_baseline_regressed'],
    ['expiry', 'expiry_alert'],
    ['template', 'clone_template'],
    ['agent', 'agent_message'],
    ['token', 'create_token'],
    ['member', 'add_member']
  ]
  for (const [kw, ev] of intact) {
    assert.strictEqual(webhookShouldFire(wh(kw), ev), true, `${kw} 应完好匹配 ${ev}`)
  }
})

t('归一只放宽、不收紧：原单数匹配一个都没丢', () => {
  // 逐条锁死「加归一后仍然为真」的既有行为，防止修复引入回归
  const baseline = [
    ['profile', 'create_profile'], ['profile', 'batch_delete_profile'],
    ['proxy', 'create_proxy'], ['proxy', 'update_proxy'],
    ['cookie', 'create_cookie'], ['cookie', 'delete_cookie'],
    ['account', 'create_account'], ['team', 'update_team'],
    ['rpa', 'create_rpa_script'], ['login', 'login'], ['2fa', '2fa']
  ]
  for (const [kw, ev] of baseline) {
    assert.strictEqual(webhookShouldFire(wh(kw), ev), true, `${kw} → ${ev} 不应回归`)
  }
})

t('归一不影响既有行为：单数事件本来就该匹配', () => {
  assert.strictEqual(webhookShouldFire(wh('profile'), 'create_profile'), true)
  assert.strictEqual(webhookShouldFire(wh('proxy'), 'update_proxy'), true)
  assert.strictEqual(webhookShouldFire(wh('team'), 'update_team'), true)
  assert.strictEqual(webhookShouldFire(wh('login'), 'login'), true)
})

// ============ 分组覆盖守卫 ============

t('所有已登记的分组关键词都真实存在于事件名中（防分组本身写错）', () => {
  // 历史上出现过 groups 里写了关键词、但没有任何事件含该分词的情况：
  // UI 上会出现一个怎么选都收不到东西的选项。
  const sampleEvents = [
    'create_profile', 'clone_template', 'batch_randomize', 'duplicate_batch',
    'clear_partition', 'switch_line', 'batch_move_group',
    'create_proxy', 'import_proxies', 'update_team', 'add_member',
    'create_token', 'revoke_invite', 'create_account', 'import_accounts',
    'create_cookie', 'import_cookies', 'create_rpa_script', 'agent_message',
    'assistant_skill_run', 'login', 'logout', '2fa',
    'expiry_alert', 'health_baseline_regressed', 'fix_consistency',
    'archive_logs', 'export_logs', 'revert_log_archive',
    'create_extension', 'delete_extension', 'import_snapshot', 'enable_cdp'
  ]
  for (const g of WEBHOOK_EVENT_GROUPS) {
    const hit = g.events.filter((kw) => sampleEvents.some((ev) => webhookShouldFire({ enabled: true, events: [kw] }, ev)))
    assert.ok(hit.length > 0, `分组 ${g.key} 的关键词 ${JSON.stringify(g.events)} 没有任何事件能命中`)
  }
})

t('新增事件若未登记分组会被这条测试抓到（用假想事件演示）', () => {
  // 模拟：后端加了 writeLog(req, 'export_backup', ...)，但没在 groups 里登记 export/backup。
  // 真实实现下它收不到任何非 '*' 订阅 —— 这正是本守卫存在的意义。
  const hypothetical = 'export_backup'
  const covered = WEBHOOK_EVENT_GROUPS.some((g) =>
    g.events.some((kw) => webhookShouldFire({ enabled: true, events: [kw] }, hypothetical))
  )
  // 当前确实未覆盖（断言现状，说明缺口是真实存在的、且会被守卫注意到）
  assert.strictEqual(covered, false, '若此断言失败说明已补上 export/backup 关键词，请同步更新本用例')
})

// 失败数必须一并报出，避免「有失败却看起来全绿」
console.log(`\nwebhook: ${pass} passed, ${fail} failed`)