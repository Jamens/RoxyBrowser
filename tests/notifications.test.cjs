// 通知中心共享逻辑 —— 离线单测
// 编译命令（在本仓库根目录执行）：
//   node node_modules/typescript/bin/tsc src/shared/notifications.ts \
//     --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_nt
// 然后：node tests/notifications.test.cjs
//
// 背景：应用内铃铛 + 桌面弹窗的数据源是操作日志的「过滤视图」。本测试锁住三件事：
//   1. 白名单收得准——用户自己的操作绝不通知，只有「系统自动产生 + 不处理有代价」的事件才收；
//   2. 订阅语义不混——「显式清空 = 静音」与「字段缺失 = 默认全订」是两种不同的输入；
//   3. 元信息自洽——分类/严重度/跳转路由/四语言标题对得上，缺一项前端就渲染错。
const assert = require('assert')
const {
  classifyNotification,
  shouldToast,
  normalizeNotifyEvents,
  NOTIFY_EVENT_MAP,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY_LABELS,
  NOTIFY_DEFAULT_EVENTS
} = require('../.tmp_nt/shared/notifications.js')

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

// ---------- classifyNotification：白名单 ----------

t('五类系统事件全部入榜，且元信息正确', () => {
  assert.deepStrictEqual(classifyNotification('proxy_exit_ip_changed'), { category: 'proxy_drift', severity: 'warning', route: '/proxies' })
  assert.deepStrictEqual(classifyNotification('proxy_heal'), { category: 'proxy_heal', severity: 'info', route: '/proxies' })
  assert.deepStrictEqual(classifyNotification('proxy_heal_failed'), { category: 'proxy_heal', severity: 'warning', route: '/proxies' })
  assert.deepStrictEqual(classifyNotification('expiry_alert'), { category: 'expiry', severity: 'warning', route: '/logs' })
  assert.deepStrictEqual(classifyNotification('login_locked'), { category: 'security', severity: 'error', route: '/logs' })
  assert.deepStrictEqual(classifyNotification('rpa_schedule_fail'), { category: 'rpa', severity: 'warning', route: '/rpa' })
})

t('用户自己的操作不入榜（create_profile 等一律不通知）', () => {
  // 通知的价值在稀缺：把用户刚做的操作也弹一遍，铃铛就成了第二个日志页
  for (const a of ['create_profile', 'open_profile', 'close_profile', 'create_proxy', 'delete_proxy', 'export_cookies', 'login', 'logout', 'webhook_test']) {
    assert.strictEqual(classifyNotification(a), null, `${a} 不应通知`)
  }
})

t('定时 RPA 的「成功」与「跳过」不入榜——只有失败值得打扰用户', () => {
  assert.strictEqual(classifyNotification('rpa_schedule_run'), null, '成功是预期结果，进铃铛只会稀释真正要处理的')
  assert.strictEqual(classifyNotification('rpa_schedule_skip'), null, '环境未运行的跳过是刻意设计的语义，不是异常')
})

t('空 action / 未知 action 安全返回 null', () => {
  assert.strictEqual(classifyNotification(''), null)
  assert.strictEqual(classifyNotification('proxy_exit_ip_changed_typo'), null, '不做前缀猜测：猜错会把无关事件弹成通知')
})

// ---------- shouldToast：订阅语义 ----------

const ALL = { enabled: true, events: [...NOTIFY_CATEGORIES] }

t('总开关开启 + 分类已订阅 → 弹', () => {
  assert.strictEqual(shouldToast('proxy_exit_ip_changed', ALL), true)
  assert.strictEqual(shouldToast('login_locked', ALL), true)
})

t('总开关关闭 → 一律不弹（即使分类已订阅）', () => {
  assert.strictEqual(shouldToast('proxy_exit_ip_changed', { enabled: false, events: [...NOTIFY_CATEGORIES] }), false)
  assert.strictEqual(shouldToast('login_locked', { enabled: false, events: [] }), false)
})

t('分类未订阅 → 不弹（其它分类不受影响）', () => {
  const cfg = { enabled: true, events: ['expiry'] }
  assert.strictEqual(shouldToast('proxy_exit_ip_changed', cfg), false)
  assert.strictEqual(shouldToast('expiry_alert', cfg), true)
})

t('events 为空数组 = 用户主动静音 → 不弹', () => {
  // 与「字段缺失」严格区分：用户在设置页取消全部勾选后保存，必须保持静音
  assert.strictEqual(shouldToast('proxy_exit_ip_changed', { enabled: true, events: [] }), false)
})

t('events 缺失（升级用户的老设置）= 默认全部分类 → 弹', () => {
  // 不能因为多了个设置项就把升级用户静音了。
  // 两种缺失形态都要覆盖：键存在但值为 undefined（老配置被 JSON 序列化过）、键干脆不存在
  assert.strictEqual(shouldToast('proxy_exit_ip_changed', { enabled: true, events: undefined }), true)
  assert.strictEqual(shouldToast('rpa_schedule_fail', { enabled: true }), true)
})

t('未入榜的事件永不弹（订阅了也不弹）', () => {
  assert.strictEqual(shouldToast('create_profile', ALL), false)
})

// ---------- normalizeNotifyEvents：脏数据收口 ----------

t('非数组输入回落默认全部分类', () => {
  assert.deepStrictEqual(normalizeNotifyEvents(null), NOTIFY_DEFAULT_EVENTS)
  assert.deepStrictEqual(normalizeNotifyEvents('proxy_drift'), NOTIFY_DEFAULT_EVENTS)
  assert.deepStrictEqual(normalizeNotifyEvents(undefined), NOTIFY_DEFAULT_EVENTS)
})

t('未知分类被滤掉，已知分类保留', () => {
  assert.deepStrictEqual(normalizeNotifyEvents(['proxy_drift', 'bogus', 'rpa']), ['proxy_drift', 'rpa'])
})

t('空数组原样保留（显式静音不能被归一化掉）', () => {
  assert.deepStrictEqual(normalizeNotifyEvents([]), [])
})

// ---------- 元信息自洽（防「加了事件忘了配周边」） ----------

t('NOTIFY_EVENT_MAP 里每个分类都在 NOTIFY_CATEGORIES 中', () => {
  for (const [action, meta] of Object.entries(NOTIFY_EVENT_MAP)) {
    assert.ok(NOTIFY_CATEGORIES.includes(meta.category), `${action} 的分类 ${meta.category} 未登记`)
  }
})

t('每个分类都有四语言标题', () => {
  for (const c of NOTIFY_CATEGORIES) {
    const labels = NOTIFY_CATEGORY_LABELS[c]
    assert.ok(labels, `分类 ${c} 缺少标题`)
    for (const lang of ['zh-CN', 'en-US', 'ja-JP', 'de-DE']) {
      assert.ok(labels[lang] && labels[lang].length > 0, `分类 ${c} 缺少 ${lang} 标题`)
    }
  }
})

t('每条通知的 route 都是前端可 navigate 的绝对路径', () => {
  for (const [action, meta] of Object.entries(NOTIFY_EVENT_MAP)) {
    assert.ok(meta.route.startsWith('/'), `${action} 的 route 必须是绝对路径，当前为 ${meta.route}`)
  }
})

t('默认订阅 = 全部分类', () => {
  assert.deepStrictEqual([...NOTIFY_DEFAULT_EVENTS].sort(), [...NOTIFY_CATEGORIES].sort())
})

console.log(`\n${passed} 项通过`)
