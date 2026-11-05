// 反检测审计 —— 判定逻辑离线单测
//
// ## 为什么必须有这个测试
//
// `shared/stealthAudit.ts` 是「外部检测视角」的判定规则集，判的是
// 「这个浏览器整体像不像一台真实存在的电脑」。这类规则的失效是**静默**的：
// 少判一条 → 线上环境带着致命破绽放出去；多判一条 → 误报把用户吓一跳。
//
// 而且这些规则的输入是「矛盾」，矛盾必须**同时**看到两处才能判出来，
// 单看一处永远测不出来。故本测试的核心手法是：
//
//   构造「两处互相矛盾」的探针值 → 断言审计能抓到；
//   构造「两处自洽」的探针值   → 断言审计不误报。
//
// 「不误报」和「能抓到」同等重要：一个到处误报的审计等于没有审计。
//
// 用法：node tests/stealthAudit.test.cjs
const assert = require('assert')
const {
  auditStealth,
  summarizeFindings,
  formatStealthReport
} = require('../.tmp_sa/shared/stealthAudit.js')

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
 * 构造一份「自洽的」探针基线。
 *
 * ��认值模拟一个伪装成 macOS / en-GB / Europe/London 的真实环境：
 * 所有跨维度的量都彼此吻合，不存在任何矛盾。
 * 各条用例只改动其中一项，用来验证「改动这一项能否被抓到」。
 */
function baseProbe() {
  return {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    appVersion:
      '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    vendor: 'Google Inc.',
    platform: 'MacIntel',
    oscpu: '',
    productSub: '20030107',
    buildId: '',

    uaDataPresent: true,
    uaDataPlatform: 'macOS',
    uaDataBrands: ['Chromium/154', 'Google Chrome/154', 'Not A;Brand/99'],
    uaDataMobile: false,
    uaDataFullVersion: '154.0.7521.60',

    language: 'en-GB',
    languages: ['en-GB', 'en'],
    intlTimeZone: 'Europe/London',
    tzOffset: 0,
    dateStringTzName: 'GMT+0000 (Greenwich Mean Time)',
    intlLocale: 'en-GB',
    intlSupportedLocalesOk: true,
    intlRequiresNew: true,

    screenWidth: 2560,
    screenHeight: 1440,
    availWidth: 2560,
    availHeight: 1415,
    outerWidth: 1280,
    outerHeight: 820,
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 2,

    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    ontouchstart: false,

    webdriver: false,
    automationGlobals: [],
    chromeObjectPresent: true,

    toStringSamples: {
      'window.matchMedia': 'function matchMedia() { [native code] }',
      'Date.prototype.getTimezoneOffset': 'function getTimezoneOffset() { [native code] }'
    },

    // 穷尽扫描基线：扫了 148 个函数、0 露馅（真实窗口实测值）
    lieScan: {
      scanned: 148,
      leaked: []
    },

    iframeUserAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    iframeWebdriver: false,
    iframePresent: true,

    canvasHash1: 'hash-abc',
    canvasHash2: 'hash-abc',
    audioHash1: 'audio-1',
    audioHash2: 'audio-1',

    platformApis: ['bluetooth', 'usb', 'serial', 'hid'],
    webGpuPresent: true,
    emePresent: true,
    fontMismatchCount: 0,
    fontCount: 5,
    apiPresence: {
      userAgentData: true,
      gpu: true,
      requestMediaKeySystemAccess: true,
      webdriver: false,
      bluetooth: true,
      usb: true,
      serial: true,
      hid: true,
      nfc: false,
      deviceMemory: true
    },

    protoBypass: {
      platform: 'MacIntel',
      languages: ['en-GB', 'en'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      navigatorOwnKeys: [],
      screenOwnKeys: [],
      windowOwnKeys: ['window', 'self', 'document', 'location', 'screen'],
      windowOwnKeysExtra: []
    }
  }
}

function baseExpected() {
  return {
    os: 'mac',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    languages: ['en-GB', 'en'],
    timezone: 'Europe/London',
    screenWidth: 2560,
    screenHeight: 1440,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    devicePixelRatio: 2,
    touch: false
  }
}

const audit = (mutate) => {
  const probe = baseProbe()
  const expected = baseExpected()
  if (mutate) mutate(probe, expected)
  return auditStealth({ expected, probe })
}

const has = (findings, key) => findings.find((f) => f.key === key)
const hasFatal = (findings, key) => {
  const f = has(findings, key)
  return !!f && f.severity === 'fatal'
}

// ===== 1. 自洽基线：不该报任何致命/警告 =====
t('自洽基线不报任何致命或警告', () => {
  const f = audit()
  const bad = f.filter((x) => x.severity === 'fatal' || x.severity === 'warn')
  assert.strictEqual(bad.length, 0, '误报了：' + bad.map((x) => x.key).join(', '))
})

t('自洽基线 summary.passed 为 true', () => {
  const f = audit()
  assert.strictEqual(summarizeFindings(f).passed, true)
})

// ===== 2. 自动化痕迹 =====
t('webdriver=true → 致命', () => {
  const f = audit((p) => {
    p.webdriver = true
  })
  assert.ok(hasFatal(f, 'automation:webdriver'), '没抓到 webdriver')
})

t('存在 cdc_ 等特征全局变量 → 致命', () => {
  const f = audit((p) => {
    p.automationGlobals = ['cdc_', '$cdc_']
  })
  assert.ok(hasFatal(f, 'automation:globals'), '没抓到自动化全局变量')
})

t('缺 window.chrome → 警告（真实 Chrome 恒有）', () => {
  const f = audit((p) => {
    p.chromeObjectPresent = false
  })
  const x = has(f, 'automation:noChromeObject')
  assert.ok(x && x.severity === 'warn', '没抓到 window.chrome 缺失')
})

// ===== 3. 身份三元组 =====
t('appVersion 与 UA 系统段不一致 → 致命', () => {
  const f = audit((p) => {
    p.appVersion = '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
  })
  assert.ok(hasFatal(f, 'identity:appVersion'), '没抓到 appVersion 矛盾')
})

t('appVersion 与 UA 完全一致 → 不报', () => {
  const f = audit()
  assert.ok(!has(f, 'identity:appVersion'))
})

t('oscpu 有值（Firefox 特征）→ 警告', () => {
  // oscpu / buildID 是 Firefox 专有属性。规则只在「伪装成 Chrome 系」时判定——
  // 伪装 iOS Safari 时 oscpu 同样不该有，但那条由 iOS 的 UA-CH 规则覆盖。
  const f = audit((p, e) => {
    e.os = 'windows'
    p.oscpu = 'Linux i686'
    p.uaDataPlatform = 'Windows'
  })
  const x = has(f, 'identity:oscpu')
  assert.ok(x && x.severity === 'warn', '没抓到 oscpu')
})

t('productSub 与真实 Chrome 不符 → 提示', () => {
  const f = audit((p) => {
    p.productSub = '20100101'
  })
  const x = has(f, 'identity:productSub')
  assert.ok(x && x.severity === 'info', 'productSub 偏差不应算 fatal/warn')
})

// ===== 4. UA-CH =====
t('UA 说 macOS 而 UA-CH 说 Windows → 致命', () => {
  const f = audit((p) => {
    p.uaDataPlatform = 'Windows'
  })
  assert.ok(hasFatal(f, 'uach:platformMismatch'), '没抓到 UA/UA-CH 平台矛盾')
})

t('UA 版本与 UA-CH brands 版本不一致 → 致命', () => {
  const f = audit((p) => {
    p.uaDataBrands = ['Chromium/150', 'Google Chrome/150', 'Not A;Brand/99']
  })
  assert.ok(hasFatal(f, 'uach:versionMismatch'), '没抓到 UA/UA-CH 版本矛盾')
})

t('iOS 伪装下 userAgentData 仍存在 → 致命', () => {
  const f = audit((p, e) => {
    e.os = 'ios'
    p.uaDataPresent = true
  })
  assert.ok(hasFatal(f, 'uach:iosHasUaData'), '没抓到 iOS 残留 UA-CH')
})

t('iOS 伪装下 userAgentData 缺失 → 不报', () => {
  const f = audit((p, e) => {
    e.os = 'ios'
    p.uaDataPresent = false
    p.uaDataPlatform = ''
    p.uaDataBrands = []
  })
  assert.ok(!has(f, 'uach:iosHasUaData'))
})

t('桌面伪装下 userAgentData 缺失 → 致命', () => {
  const f = audit((p) => {
    p.uaDataPresent = false
  })
  assert.ok(hasFatal(f, 'uach:missing'), '没抓到 UA-CH 缺失')
})

// ===== 5. 语言 / 时区 =====
t('language 与 languages[0] 不一致 → 致命', () => {
  const f = audit((p) => {
    p.language = 'en-US'
  })
  assert.ok(hasFatal(f, 'locale:languageVsList'), '没抓到 language/languages 矛盾')
})

t('窗口内首选语言与设定不一致 → 致命', () => {
  const f = audit((p) => {
    p.languages = ['zh-CN', 'zh']
    p.language = 'zh-CN'
  })
  assert.ok(hasFatal(f, 'locale:expectedMismatch'), '没抓到语言未注入')
})

t('Date.toString 的偏移与 getTimezoneOffset 矛盾 → 致命', () => {
  const f = audit((p) => {
    p.dateStringTzName = 'GMT+0800 (中国标准时间)'
  })
  assert.ok(hasFatal(f, 'timezone:offsetMismatch'), '没抓到时区偏移矛盾')
})

t('Date.toString 与 getTimezoneOffset 一致 → 不报', () => {
  const f = audit()
  assert.ok(!has(f, 'timezone:offsetMismatch'))
})

t('Intl 时区与设定不一致 → 致命', () => {
  const f = audit((p) => {
    p.intlTimeZone = 'Asia/Shanghai'
    p.tzOffset = -480
    p.dateStringTzName = 'GMT+0800 (中国标准时间)'
  })
  assert.ok(hasFatal(f, 'timezone:notInjected'), '没抓到时区未注入')
})

t('Intl locale 与 navigator.language 地区码不一致 → 警告', () => {
  const f = audit((p) => {
    p.intlLocale = 'zh-CN'
  })
  const x = has(f, 'locale:intlVsNavigator')
  assert.ok(x && x.severity === 'warn', '没抓到 Intl locale 偏差')
})

// ===== 6. 屏幕 / 视口 =====
t('屏幕宽高与设定不一致 → 致命', () => {
  const f = audit((p) => {
    p.screenWidth = 1920
  })
  assert.ok(hasFatal(f, 'screen:width'), '没抓到屏幕宽度不一致')
})

t('availWidth ≠ width → 警告', () => {
  const f = audit((p) => {
    p.availWidth = 2400
  })
  const x = has(f, 'screen:availWidth')
  assert.ok(x && x.severity === 'warn', '没抓到 availWidth 异常')
})

t('availHeight > height → 警告（数值关系不成立）', () => {
  const f = audit((p) => {
    p.availHeight = 1600
  })
  const x = has(f, 'screen:availHeight')
  assert.ok(x && x.severity === 'warn', '没抓到 availHeight 越界')
})

t('innerWidth > outerWidth → 警告', () => {
  const f = audit((p) => {
    p.innerWidth = 1400
    p.outerWidth = 1280
  })
  const x = has(f, 'screen:innerVsOuter')
  assert.ok(x && x.severity === 'warn', '没抓到内外框倒挂')
})

// ===== 7. 硬件 =====
t('CPU 核心数与设定不一致 → 致命', () => {
  const f = audit((p) => {
    p.hardwareConcurrency = 16
  })
  assert.ok(hasFatal(f, 'hw:concurrency'), '没抓到核心数不一致')
})

t('内存与设定不一致 → 致命', () => {
  const f = audit((p) => {
    p.deviceMemory = 32
  })
  assert.ok(hasFatal(f, 'hw:deviceMemory'), '没抓到内存不一致')
})

t('桌面伪装却报多点触摸 → 致命（宿主触摸屏泄漏）', () => {
  const f = audit((p) => {
    p.maxTouchPoints = 10
    p.ontouchstart = true
  })
  assert.ok(hasFatal(f, 'hw:touchLeaked'), '没抓到触摸能力泄漏')
})

t('移动端伪装却无触摸点 → 致命', () => {
  const f = audit((p, e) => {
    e.os = 'android'
    e.touch = true
    p.maxTouchPoints = 0
    p.ontouchstart = false
  })
  assert.ok(hasFatal(f, 'hw:touchMissing'), '没抓到触摸能力缺失')
})

t('ontouchstart 与 maxTouchPoints 互相矛盾 → 警告', () => {
  const f = audit((p) => {
    p.maxTouchPoints = 0
    p.ontouchstart = true
  })
  const x = has(f, 'hw:touchInconsistent')
  assert.ok(x && x.severity === 'warn', '没抓到触摸自相矛盾')
})

// ===== 8. 跨 frame =====
t('iframe UA 与主 frame 不同 → 致命', () => {
  const f = audit((p) => {
    p.iframeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36'
  })
  assert.ok(hasFatal(f, 'crossframe:iframeUA'), '没抓到 iframe 泄漏')
})

t('iframe 内 webdriver=true → 致命', () => {
  const f = audit((p) => {
    p.iframeWebdriver = true
  })
  assert.ok(hasFatal(f, 'crossframe:iframeWebdriver'), '没抓到 iframe webdriver')
})

t('iframe 不存在 → 不报（探测失败不算破绽）', () => {
  const f = audit((p) => {
    p.iframePresent = false
    p.iframeUserAgent = ''
  })
  assert.ok(!has(f, 'crossframe:iframeUA'))
})

// ===== 9. 原型 getter 绕过（本项目此前最大的漏洞）=====
t('原型绕过读出真实 platform → 致命', () => {
  const f = audit((p) => {
    p.protoBypass.platform = 'Win32'
  })
  assert.ok(hasFatal(f, 'bypass:platform'), '没抓到 platform 绕过')
})

t('原型绕过读出真实 languages → 致命', () => {
  const f = audit((p) => {
    p.protoBypass.languages = ['zh-CN', 'zh-Hans-CN']
  })
  assert.ok(hasFatal(f, 'bypass:languages'), '没抓到 languages 绕过')
})

t('原型绕过读出真实核心数 → 致命', () => {
  const f = audit((p) => {
    p.protoBypass.hardwareConcurrency = 16
  })
  assert.ok(hasFatal(f, 'bypass:hardwareConcurrency'), '没抓到核心数绕过')
})

t('原型绕过读出真实内存 → 致命', () => {
  const f = audit((p) => {
    p.protoBypass.deviceMemory = 32
  })
  assert.ok(hasFatal(f, 'bypass:deviceMemory'), '没抓到内存绕过')
})

t('devicePixelRatio 与设定不一致 → 致命', () => {
  // devicePixelRatio 在 Chromium 里是 window **自有的**访问器属性，
  // 没有「原型绕过」这条路，故直接比对实测值即可。
  // 它常与分辨率一起被交叉验证（2560×1440 的屏却报 DPR=1 本身就不自洽）。
  const f = audit((p) => {
    p.devicePixelRatio = 1
  })
  const x = has(f, 'screen:devicePixelRatio')
  assert.ok(x && x.severity === 'fatal', '没抓到 DPR 不一致')
})

t('devicePixelRatio 一致 → 不报', () => {
  const f = audit()
  assert.ok(!f.some((x) => x.key === 'screen:devicePixelRatio'))
})

t('window 比基线多出可枚举自有键 → 提示（不判警告：起始页上页面脚本本来就会加键）', () => {
  const f = audit((p) => {
    p.protoBypass.windowOwnKeysExtra = ['__reactRouterVersion']
  })
  const x = has(f, 'bypass:windowOwnKeys')
  assert.ok(x && x.severity === 'info', '没抓到 window 新增自有键')
})

t('window 自有键「多」但不超基线 → 不报（真实 Chromium 本来就有几十个键）', () => {
  // 真实 Chromium 的 Object.keys(window) 是一份约 50 项的清单，
  // 不是空的。规则只能判「比基线多了什么」，不能判「非空即错」。
  const f = audit()
  assert.ok(!f.some((x) => x.key === 'bypass:windowOwnKeys'))
})

t('navigator 有自有键 → 警告', () => {
  const f = audit((p) => {
    p.protoBypass.navigatorOwnKeys = ['userAgent', 'platform', 'languages']
  })
  const x = has(f, 'bypass:navigatorOwnKeys')
  assert.ok(x && x.severity === 'warn', '没抓到 navigator 自有键')
})

t('screen 有自有键 → 警告', () => {
  const f = audit((p) => {
    p.protoBypass.screenOwnKeys = ['width', 'height']
  })
  const x = has(f, 'bypass:screenOwnKeys')
  assert.ok(x && x.severity === 'warn', '没抓到 screen 自有键')
})

t('原型绕过后各值与实例一致 → 不报绕过类问题', () => {
  const f = audit()
  assert.ok(!f.some((x) => x.key.startsWith('bypass:')), '误报了绕过：' + f.map((x) => x.key).join(','))
})

// ===== 10. 原生性测谎 =====
t('被改函数暴露源码 → 致命', () => {
  const f = audit((p) => {
    p.toStringSamples['window.matchMedia'] = 'function(query) { const m = spoofed(query); }'
  })
  const x = has(f, 'nativeLie:window.matchMedia')
  assert.ok(x && x.severity === 'fatal', '没抓到测谎')
})

t('所有被改函数都是原生形态 → 不报测谎问题', () => {
  const f = audit()
  assert.ok(!f.some((x) => x.key.startsWith('nativeLie:')))
})

t('空的 toString 取样不误报', () => {
  const f = audit((p) => {
    p.toStringSamples = { 'x.y': '' }
  })
  assert.ok(!f.some((x) => x.key.startsWith('nativeLie:')))
})

// ===== 10b. 穷尽原生性扫描 =====
// 手写取样列表会漏，所以审计必须认穷尽扫描的结果。
t('穷尽扫描发现露馅函数 → 致命', () => {
  const f = audit((p) => {
    p.lieScan = {
      scanned: 148,
      leaked: ['Navigator.prototype.someNewPatch → function someNewPatch() { return spoofed }']
    }
  })
  const x = has(f, 'nativeLie:exhaustive')
  assert.ok(x && x.severity === 'fatal', '没抓到穷尽扫描露馅')
})

t('穷尽扫描无露馅 → 不报', () => {
  const f = audit()
  assert.ok(!f.some((x) => x.key.startsWith('nativeLie:')))
})

t('穷尽扫描本身没跑起来 → 警告（不能当作通过）', () => {
  const f = audit((p) => {
    p.lieScan = { scanned: 0, leaked: [] }
  })
  const x = has(f, 'nativeLie:scanNotRun')
  assert.ok(x && x.severity === 'warn', '没抓到扫描未执行')
})

t('探针没有 lieScan 字段（旧探针）→ 不误报', () => {
  const f = audit((p) => {
    delete p.lieScan
  })
  assert.ok(!f.some((x) => x.key.startsWith('nativeLie:')))
})

// ===== 10c. Intl 构造器行为保真度 =====
// 包装 Intl.DateTimeFormat 注入默认 locale，最容易丢的是静态方法与 new 约束。
// 丢了不会「露馅」，但会让页面直接坏掉——坏掉的浏览器比露馅的更显眼。
t('supportedLocalesOf 不可用 → 致命', () => {
  const f = audit((p) => {
    p.intlSupportedLocalesOk = false
  })
  const x = has(f, 'locale:supportedLocalesBroken')
  assert.ok(x && x.severity === 'fatal', '没抓到 supportedLocalesOf 缺失')
})

t('Intl.DateTimeFormat 不带 new 不抛错 → 警告', () => {
  const f = audit((p) => {
    p.intlRequiresNew = false
  })
  const x = has(f, 'locale:requiresNewBroken')
  assert.ok(x && x.severity === 'warn', '没抓到 new 约束丢失')
})

t('Intl 行为与原生一致 → 不报', () => {
  const f = audit()
  assert.ok(!f.some((x) => x.key.startsWith('locale:')))
})

// ===== 11. 熵稳定性 =====
t('canvas 两次读不一致 → 致命', () => {
  const f = audit((p) => {
    p.canvasHash2 = 'hash-xyz'
  })
  assert.ok(hasFatal(f, 'entropy:canvas'), '没抓到 canvas 熵不稳')
})

t('audio 两次读不一致 → 警告', () => {
  const f = audit((p) => {
    p.audioHash2 = 'audio-2'
  })
  const x = has(f, 'entropy:audio')
  assert.ok(x && x.severity === 'warn', '没抓到 audio 熵不稳')
})

t('熵稳定 → 不报', () => {
  const f = audit()
  assert.ok(!f.some((x) => x.key.startsWith('entropy:')))
})

// ===== 12. 平台 API / 字体 / 能力 =====
t('缺少该平台应有的 API → 警告', () => {
  const f = audit((p) => {
    p.platformApis = []
  })
  const x = has(f, 'platform:missingApi')
  assert.ok(x && x.severity === 'warn', '没抓到平台 API 缺失')
})

t('iOS 伪装下 navigator.gpu 仍存在 → 警告', () => {
  const f = audit((p, e) => {
    e.os = 'ios'
    p.uaDataPresent = false
    p.uaDataPlatform = ''
    p.uaDataBrands = []
    p.platformApis = []
    p.webGpuPresent = true
  })
  const x = has(f, 'capability:iosWebGpu')
  assert.ok(x && x.severity === 'warn', '没抓到 iOS WebGPU 残留')
})

t('iOS 伪装下该不存在的 API 仍在（用 in 判定）→ 致命', () => {
  // 关键：判据是**存在性**（`key in navigator`），不是读出来是不是 undefined。
  // 真实 iOS Safari 压根没有 navigator.userAgentData，
  // 只把 getter 改成返回 undefined 不够——属性还在原型上，in 判定仍是 true。
  const f = audit((p, e) => {
    e.os = 'ios'
    p.uaDataPresent = false
    p.uaDataPlatform = ''
    p.uaDataBrands = []
    p.platformApis = []
    p.webGpuPresent = false
    p.apiPresence.userAgentData = true
  })
  const x = has(f, 'platform:apiShouldBeAbsent')
  assert.ok(x && x.severity === 'fatal', '没抓到该不存在的 API 仍存在')
})

t('iOS 伪装下该不存在的 API 全部真删掉 → 不报', () => {
  const f = audit((p, e) => {
    e.os = 'ios'
    p.uaDataPresent = false
    p.uaDataPlatform = ''
    p.uaDataBrands = []
    p.platformApis = []
    p.webGpuPresent = false
    p.apiPresence.userAgentData = false
    p.apiPresence.gpu = false
    p.apiPresence.requestMediaKeySystemAccess = false
    p.apiPresence.webdriver = false
  })
  assert.ok(!f.some((x) => x.key === 'platform:apiShouldBeAbsent'), '误报：' + f.map((x) => x.key).join(','))
})

t('mac 伪装下 nfc 不该存在 → 仍在则致命', () => {
  const f = audit((p) => {
    p.apiPresence.nfc = true
  })
  const x = has(f, 'platform:apiShouldBeAbsent')
  assert.ok(x && x.severity === 'fatal', '没抓到 nfc 残留')
})

t('字体声称可用但测不出 → 警告', () => {
  const f = audit((p) => {
    p.fontMismatchCount = 3
    p.fontCount = 10
  })
  const x = has(f, 'font:mismatch')
  assert.ok(x && x.severity === 'warn', '没抓到字体不一致')
})

// ===== 13. 排序与汇总 =====
t('结论按致命 → 警告 → 提示排序', () => {
  const f = audit((p) => {
    p.webdriver = true          // fatal
    p.intlLocale = 'zh-CN'     // warn
    p.productSub = '20100101'  // info
  })
  const sev = f.map((x) => x.severity)
  const rank = { fatal: 0, warn: 1, info: 2 }
  for (let i = 1; i < sev.length; i++) {
    assert.ok(rank[sev[i - 1]] <= rank[sev[i]], '排序不对：' + sev.join(','))
  }
})

t('summarizeFindings 统计正确', () => {
  const f = audit((p) => {
    p.webdriver = true
    p.intlLocale = 'zh-CN'
    p.productSub = '20100101'
  })
  const s = summarizeFindings(f)
  assert.strictEqual(s.fatal, 1)
  assert.strictEqual(s.warn, 1)
  assert.strictEqual(s.info, 1)
  assert.strictEqual(s.passed, false)
})

t('无问题时 passed=true 且报告给出肯定结论', () => {
  const f = audit()
  const s = summarizeFindings(f)
  assert.strictEqual(s.passed, true)
  const r = formatStealthReport(f, s)
  assert.ok(r.includes('未发现'), '报告文案不对：' + r)
})

t('有致命时报告明确指出必须修复', () => {
  const f = audit((p) => {
    p.webdriver = true
  })
  const r = formatStealthReport(f, summarizeFindings(f))
  assert.ok(r.includes('致命'), '报告未标出致命')
  assert.ok(r.includes('必须先修复'), '报告未给出处置结论')
})

// ===== 14. 现实感：伪装「填得越认真」的场景 =====
t('典型真实事故场景：只改实例不改原型 → 全部抓到', () => {
  // 这正是修复前的状态：实例值是伪装值，原型 getter 绕过后是宿主真身
  const f = audit((p) => {
    p.protoBypass.platform = 'Win32'
    p.protoBypass.languages = ['zh-CN', 'zh-Hans-CN']
    p.protoBypass.hardwareConcurrency = 16
    p.protoBypass.deviceMemory = 32
    p.protoBypass.navigatorOwnKeys = ['userAgent', 'platform', 'languages']
    p.dateStringTzName = 'GMT+0800 (中国标准时间)'
    p.toStringSamples['window.matchMedia'] = 'function(query) { return origMql.call(window, query) }'
  })
  const keys = f.map((x) => x.key)
  for (const k of [
    'bypass:platform',
    'bypass:languages',
    'bypass:hardwareConcurrency',
    'bypass:deviceMemory',
    'bypass:navigatorOwnKeys',
    'timezone:offsetMismatch',
    'nativeLie:window.matchMedia'
  ]) {
    assert.ok(keys.includes(k), `漏抓了 ${k}`)
  }
})

console.log(`\n${passed} 项断言通过`)
if (passed < 40) {
  console.error('断言数异常偏少，检查测试是否被意外跳过')
  process.exitCode = 1
}
