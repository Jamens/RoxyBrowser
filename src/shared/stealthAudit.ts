/**
 * 反检测审计（stealth audit）—— **外部检测视角**的破绽判定
 *
 * ## 这个模块解决什么问题
 *
 * `shared/healthcheck.ts` 是「自己出题自己判卷」：拿用户设定的指纹值去对撞
 * 窗口内回读的值，两边一致就算通过。它能证明**注入生效了**，
 * 但证明不了**外部检测站看不出来**——而后者才是这个产品的价值所在。
 *
 * 两者盯的东西不一样：
 *
 *   - 体检盯「设定值 == 回读值」：填了 en-GB、窗口里读到 en-GB → 通过。
 *   - 审计盯「这个浏览器像不像一台真实存在的电脑」：UA 说 macOS，
 *     但 `navigator.appVersion` 露着宿主机的 Windows 字符串 → 一个真实用户
 *     不可能出现这种组合，检测站一眼就看出是改过的。
 *
 * 体检是**一致性检查**（自己跟自己比）；审计是**合理性检查**
 * （这个整体像不像真的）。本模块只做后者。
 *
 * ## 为什么判定逻辑要拆成纯函数
 *
 * 破绽的形态是「两处值互相矛盾」，而矛盾必须**同时**看到两处才能判。
 * 这类判定天生适合写成纯函数：给定（预设指纹 + 窗口实测值）→ 给出破绽清单。
 * 好处有三：
 *
 *   1. 可离线单测——不需要起窗口、不需要 GPU、不需要网络；
 *   2. 判定口径只有一处——UI 展示、脚本报告、CI 守卫共用同一套结论，
 *      不会出现「界面说通过、脚本说不通过」；
 *   3. 新增破绽只需加一条规则，不必碰窗口操控逻辑。
 *
 * ## 分级口径
 *
 *   fatal  致命：单个向量就能让检测站判定「非真实浏览器」。必须修。
 *   warn   警告：单项不致命，但组合起来会拉低信任分/ 命中某条风控规则。
 *   info   提示：当前环境不构成矛盾，但值得知道（例如宿主没 GPU 测不了）。
 *
 * 之所以要分级而不是一律判失败：审计要能**排序**。修的时候先修 fatal，
 * warn 逐步清。否则一次报 30 条红，用户无从下手。
 */

/** 审计结论的严重级别 */
export type StealthSeverity = 'fatal' | 'warn' | 'info'

/** 单条审计结论 */
export interface StealthFinding {
  /** 稳定标识（用于回归守卫与文档引用） */
  key: string
  severity: StealthSeverity
  /** 人类可读标题 */
  title: string
  /** 为什么这构成破绽 / 为什么值得知道 */
  detail: string
  /** 实测到的具体值（便于复现） */
  actual?: string
  /** 与之矛盾 / 期望的参照值 */
  expected?: string
}

/**
 * 窗口内实测到的「外部检测站会看的那些值」。
 *
 * 字段刻意只收**检测站真正会读的**向量，不做体检那样的全量采集：
 * 审计的价值在于聚焦，不是把体检表再抄一遍。
 */
export interface StealthProbe {
  // ---- 身份三元组：UA / appVersion / platform 必须互相自洽 ----
  userAgent: string
  /** navigator.appVersion（真实 Chrome 里是 UA 去掉 "Mozilla/" 的部分） */
  appVersion: string
  /** navigator.vendor */
  vendor: string
  /** navigator.platform */
  platform: string
  /** navigator.oscpu（Firefox 专有，Chrome 上恒为 undefined） */
  oscpu: string
  /** navigator.productSub */
  productSub: string
  /** navigator.buildID（Firefox 专有） */
  buildId: string

  // ---- UA-CH ----
  uaDataPresent: boolean
  uaDataPlatform: string
  uaDataBrands: string[]
  uaDataMobile: boolean | null
  uaDataFullVersion: string

  // ---- 语言 / 时区 ----
  language: string
  languages: string[]
  /** Intl.DateTimeFormat().resolvedOptions().timeZone */
  intlTimeZone: string
  /** Date.prototype.getTimezoneOffset() 的值（分钟，UTC+8 为 -480） */
  tzOffset: number
  /** new Date().toString() 里的时区名（如 "China Standard Time"） */
  dateStringTzName: string
  /** Intl.DateTimeFormat().resolvedOptions().locale */
  intlLocale: string
  /**
   * `Intl.DateTimeFormat.supportedLocalesOf` 是否可用（返回数组）。
   *
   * 我们为了注入默认 locale 包了一层构造器，包装器最容易丢的就是这个静态方法——
   * 丢了的话页面一调用就是 TypeError，**浏览器直接坏掉**，比任何指纹破绽都致命。
   */
  intlSupportedLocalesOk?: boolean
  /**
   * `Intl.DateTimeFormat()` 不带 new 调用时是否抛 TypeError（原生行为为 true）。
   *
   * 包装器若不还原这个约束，检测站一句 `Intl.DateTimeFormat()` 就能发现构造器被换过。
   */
  intlRequiresNew?: boolean

  // ---- 屏幕 / 视口 ----
  screenWidth: number
  screenHeight: number
  availWidth: number
  availHeight: number
  /** window.outerWidth / outerHeight */
  outerWidth: number
  outerHeight: number
  /** window.innerWidth / innerHeight */
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number

  // ---- 硬件 ----
  hardwareConcurrency: number
  deviceMemory: number
  maxTouchPoints: number
  /** 'ontouchstart' in window */
  ontouchstart: boolean

  // ---- 自动化痕迹 ----
  webdriver: boolean
  /** window 上是否存在 cdc_ / $cdc_ / selenium 等特征全局变量 */
  automationGlobals: string[]
  /** window.chrome 是否存在（真实 Chrome 恒有，含 runtime / loadTimes 等） */
  chromeObjectPresent: boolean

  // ---- 原生性测谎：把「被改过的函数」的 toString 原样带回来 ----
  /**
   * 各被改函数的 `Function.prototype.toString()` 输出。
   * 真实原生函数必须含 `[native code]`；一旦露出源码即穿帮。
   */
  toStringSamples: Record<string, string>

  /**
   * **穷尽**原生性扫描结果：遍历所有关键原型的全部函数，逐个 toString 检查。
   *
   * 为什么要穷尽而不是只查手写列表：手写列表永远会漏。
   * 2026-10-25 的 browserscan 事故与本次发现的 matchMedia /
   * speechSynthesis / geolocation 三处漏网，全都是「列表里没有」。
   * 穷尽扫描能保证「新增补丁忘了 patchNative」必然被抓到。
   */
  lieScan?: {
    /** 扫描过的函数数 */
    scanned: number
    /** 露馅的函数（路径 + 源码片段） */
    leaked: string[]
  }

  // ---- 跨上下文一致性 ----
  /**
   * 子 frame（iframe）里读到的 UA。
   * 真实浏览器里 iframe 与主 frame 同源时读到的是**同一个** UA；
   * 若 preload 只注入了主 frame，iframe 会读到宿主真身 → 一眼穿帮。
   */
  iframeUserAgent: string
  iframeWebdriver: boolean
  /** iframe 是否存在（探测失败时为 false，不算破绽） */
  iframePresent: boolean

  // ---- 原型 getter 绕过（检测站最常用的一手）----
  /**
   * 从**原型**取原生 getter 再 `.call(navigator)` 读到的值。
   *
   * 这是外部检测站的标准手法，也是本项目此前最大的漏洞：
   * 早期实现在 navigator **实例**上建 own getter，页面直接读确实拿到伪装值，
   * 但原型上的原生 getter 从未被改过——检测站一 call 就拿回宿主真身。
   * 实测（伪装 macOS，宿主 Windows）：
   *
   *   navigator.platform                     → MacIntel   （实例遮蔽，伪装值）
   *   Navigator.prototype.platform.get.call() → Win32     （真身露馅）
   *
   * 这里采的是「绕过后」的值，与实例值对比即可发现。
   */
  protoBypass: {
    platform: string
    languages: string[]
    hardwareConcurrency: number
    deviceMemory: number
    /** devicePixelRatio：Chrome 里是 Window.prototype 上的访问器，同样可被绕过 */
    devicePixelRatio?: number
    /** navigator 自身的自有键（真实 Chrome 恒为空数组） */
    navigatorOwnKeys: string[]
    /** screen 自身的自有键（真实 Chrome 恒为空数组） */
    screenOwnKeys: string[]
    /** window 自身的可枚举自有键（真实 Chromium 是一份约 50 项的清单，并非空） */
    windowOwnKeys?: string[]
    /**
     * window 自身的可枚举自有键里，**比注入前基线多出来**的那些。
     *
     * 基线由 preload 在伪装前拍下（`window.__roxyWindowOwnKeys`）。
     * 没有基线时该字段缺失，审计跳过这条规则（不误报）。
     */
    windowOwnKeysExtra?: string[]
  }

  // ---- 熵：同一环境两次读到的 canvas 指纹是否一致 ----
  canvasHash1: string
  canvasHash2: string
  /** audio 指纹两次读是否一致 */
  audioHash1: string
  audioHash2: string

  // ---- 能力矩阵 ----
  /** 存在 navigator.bluetooth 等平台 API 的列表 */
  platformApis: string[]
  /** navigator.gpu 是否存在 */
  webGpuPresent: boolean
  /** EME（Widevine 等 DRM）是否可用 */
  emePresent: boolean
  /** 字体探测：document.fonts.check 声称可用但 measureText 测不出宽度的字体数 */
  fontMismatchCount: number
  /** 声称可用的字体总数 */
  fontCount: number
  /**
   * 各 API 的**存在性**（`key in navigator`），而不是读出来的值。
   *
   * 真实 iOS Safari 里根本没有 `navigator.userAgentData`。
   * 检测站查的不只是「读出来是不是 undefined」，还有
   * `'userAgentData' in navigator` 是不是 false——
   * 只把原型上的 getter 改成返回 undefined，`in` 判定仍是 true，一样露馅。
   */
  apiPresence?: Record<string, boolean>
}

/**
 * 审计输入：预设指纹（用户设定的目标形象）+ 窗口实测值。
 */
export interface StealthAuditInput {
  /** 用户设定的目标指纹（判定「声称是什么」） */
  expected: {
    os: string
    userAgent: string
    platform: string
    languages: string[]
    timezone: string
    screenWidth: number
    screenHeight: number
    hardwareConcurrency: number
    deviceMemory: number
    touch?: boolean
    /**
     * 设备像素比。
     *
     * 指纹里没设时不比较——Chromium 的 `window.devicePixelRatio` 是 **window 自有的
     * 访问器属性**（实测 configurable / enumerable，不在 Window.prototype 上），
     * 伪装只能落在 window 实例上，没有「原型绕过」这条路，故直接比对实测值即可。
     */
    devicePixelRatio?: number
  }
  /** 窗口内实测（判定「实际是什么」） */
  probe: StealthProbe
}

/** 已知「真 Chrome 恒为真 / 恒为假」的原生特征，作为参照基准 */
const CHROME_ALWAYS = {
  /** Chrome 恒有 window.chrome */
  chromeObject: true,
  /** Chrome 恒无 oscpu（Firefox 专有） */
  oscpu: '',
  /** Chrome 恒无 buildID（Firefox 专有） */
  buildId: '',
  /** Chrome 的 productSub 恒为 20030107 */
  productSub: '20030107'
}

/** 从 UA 里取操作系统段（括号内的平台标识） */
function osToken(ua: string): string {
  const m = String(ua || '').match(/\(([^)]*)\)/)
  return m ? m[1] : ''
}

/**
 * appVersion 与 userAgent 是否自洽。
 *
 * 真实 Chrome 里 `navigator.appVersion` 就是 UA 去掉 "Mozilla/" 前缀：
 *   UA        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ..."
 *   appVersion "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ..."
 * 所以只要 UA 换了系统，appVersion 必须同步换——否则页面拿 UA 的系统段
 * 和 appVersion 的系统段一比就知道是拼装的。
 */
function appVersionMismatch(p: StealthProbe): string | null {
  const ua = String(p.userAgent || '')
  const av = String(p.appVersion || '')
  if (!ua || !av) return null
  const expect = ua.replace(/^Mozilla\//, '')
  if (av === expect) return null
  // 退化：至少要比对操作系统段——两处系统不同就是硬破绽
  const uaOs = osToken(ua)
  const avOs = osToken(av)
  if (uaOs && avOs && uaOs !== avOs) {
    return `UA 的系统段「${uaOs}」与 appVersion 的系统段「${avOs}」不一致`
  }
  return null
}

/**
 * 时区三件套是否自洽：getTimezoneOffset / Intl.timeZone / Date.toString 的时区名。
 *
 * 只改了 getTimezoneOffset 而没改 Date.prototype.toString 是常见漏网：
 * 页面读 `new Date().toString()` 里的时区名（"China Standard Time"），
 * 就能看出真实时区，与声明的时区矛盾。
 */
function timezoneMismatch(p: StealthProbe): string | null {
  const tz = String(p.intlTimeZone || '')
  const tzName = String(p.dateStringTzName || '')
  if (!tz || !tzName) return null
  // Date.toString 里的时区名与 IANA 名不是同一套词汇，无法逐字比对。
  // 改为比对**偏移量**：Date.toString 结尾的 "GMT+0800" 就是真实偏移。
  const m = tzName.match(/GMT([+-])(\d{1,2}):?(\d{2})?/)
  if (!m) return null
  const sign = m[1] === '-' ? 1 : -1 // JS 偏移量符号相反
  const hh = Number(m[2])
  const mm = m[3] ? Number(m[3]) : 0
  const dateStrOffset = sign * (hh * 60 + mm)
  if (dateStrOffset !== p.tzOffset) {
    return `Date.toString() 显示 GMT 偏移 ${dateStrOffset} 分钟，而 getTimezoneOffset() 是 ${p.tzOffset} 分钟`
  }
  return null
}

/**
 * 主 frame 与 iframe 的 UA 是否一致。
 *
 * 真实浏览器同源 iframe 与主 frame 读到同一个 UA。
 * preload 只注入主 frame 时（Electron 的 preload 默认对子 frame 也注入，
 * 但 srcdoc / data: 协议的 frame 有各自的注入时机差异），
 * iframe 会读到宿主真身 UA——这是最典型的「一眼穿帮」。
 */
function iframeMismatch(p: StealthProbe): string | null {
  if (!p.iframePresent) return null
  const main = String(p.userAgent || '')
  const sub = String(p.iframeUserAgent || '')
  if (!main || !sub) return null
  if (main !== sub) {
    return `主 frame 的 UA 与 iframe 的 UA 不同（iframe 读到的是未注入的真身）`
  }
  return null
}

/**
 * 被改函数的 toString 是否露馅。
 *
 * 这是 2026-10-25 browserscan 事故的根因家族：
 * 补丁函数若原样暴露源码，`/native/i.test(fn.toString())` 一行穿帮。
 */
function nativeLieFindings(p: StealthProbe): StealthFinding[] {
  const out: StealthFinding[] = []
  for (const [name, src] of Object.entries(p.toStringSamples || {})) {
    const s = String(src ?? '')
    if (!s) continue
    if (!/\[native code\]/i.test(s)) {
      out.push({
        key: `nativeLie:${name}`,
        severity: 'fatal',
        title: `被改写的 ${name} 暴露了补丁源码`,
        detail:
          '检测站对函数做 /\\[native code\\]/ 测谎，一旦看到真实源码就判定浏览器被改过。' +
          '修法：所有补丁函数必须走 patchNative 登记，toString 统一返回原生形态。',
        actual: s.slice(0, 120),
        expected: 'function xxx() { [native code] }'
      })
    }
  }

  // 穷尽扫描：手写取样列表之外的**所有**原型函数。
  //
  // toStringSamples 是手写列表，永远会漏——2026-10-25 的 browserscan 事故、
  // 本次发现的 matchMedia / speechSynthesis / geolocation 三处漏网，
  // 全都是「列表里没有」。穷尽扫描把这道缺口堵死：
  // 只要新增补丁忘了 patchNative，就一定会被抓到。
  const scan = p.lieScan
  if (scan && Array.isArray(scan.leaked) && scan.leaked.length > 0) {
    out.push({
      key: 'nativeLie:exhaustive',
      severity: 'fatal',
      title: `穷尽原生性扫描发现 ${scan.leaked.length} 个函数暴露补丁源码`,
      detail:
        '这些函数不在手写取样列表里，是穷尽遍历关键原型才发现的漏网之鱼。' +
        '任何新增补丁都必须走 patchNative 登记，否则检测站遍历原型时一眼穿帮。',
      actual: scan.leaked.slice(0, 8).join(' | '),
      expected: '扫描到的每个函数都含 [native code]'
    })
  }

  // 扫描本身没跑起来，等于没查——必须与「扫描过但没露馅」区分开。
  if (scan && typeof scan.scanned === 'number' && scan.scanned === 0) {
    out.push({
      key: 'nativeLie:scanNotRun',
      severity: 'warn',
      title: '穷尽原生性扫描未执行（扫描函数数为 0）',
      detail:
        '探针没能遍历到任何原型函数，说明扫描环节本身失效了——' +
        '此时「没有露馅」不能当作通过。检查探针是否在 preload 注入之前执行。',
      actual: 'scanned=0',
      expected: 'scanned > 0（真实环境下应为数百个）'
    })
  }

  return out
}

/**
 * 熵稳定性：同一环境内两次读取必须一致。
 *
 * 真实浏览器的 canvas / audio 指纹在同一次会话内是稳定的。
 * 若每次读都不同，检测站会判定「有人在实时改写指纹」——
 * 这是伪装浏览器最容易被抓的一类破绽（比某个具体值错更致命）。
 */
function entropyFindings(p: StealthProbe): StealthFinding[] {
  const out: StealthFinding[] = []
  if (p.canvasHash1 && p.canvasHash2 && p.canvasHash1 !== p.canvasHash2) {
    out.push({
      key: 'entropy:canvas',
      severity: 'fatal',
      title: 'canvas 指纹在同一环境内两次读取不一致',
      detail:
        '真实浏览器的 canvas 指纹在同一会话内恒定。每次读都不同，等于告诉检测站' +
        '「这个指纹是实时生成的」——比某个具体值写错更致命。',
      actual: `${p.canvasHash1} ≠ ${p.canvasHash2}`,
      expected: '两次读取相同'
    })
  }
  if (p.audioHash1 && p.audioHash2 && p.audioHash1 !== p.audioHash2) {
    out.push({
      key: 'entropy:audio',
      severity: 'warn',
      title: 'audio 指纹在同一环境内两次读取不一致',
      detail: '音频指纹应当同 canvas 一样稳定。不稳定说明噪声种子没有正确按环境派生。',
      actual: `${p.audioHash1} ≠ ${p.audioHash2}`,
      expected: '两次读取相同'
    })
  }
  return out
}

/**
 * 主流程：跑完全部审计规则，返回破绽清单。
 *
 * 顺序即优先级：fatal 在前，方便直接照着修。
 */
export function auditStealth(input: StealthAuditInput): StealthFinding[] {
  const { expected, probe: p } = input
  const findings: StealthFinding[] = []

  // ---------- 1. 自动化痕迹（最致命：一眼就能判定不是真人） ----------
  if (p.webdriver) {
    findings.push({
      key: 'automation:webdriver',
      severity: 'fatal',
      title: 'navigator.webdriver 为 true',
      detail:
        'webdriver 是自动化环境最显眼的标志。真实 Chrome 恒为 false，' +
        '检测站第一件事就是读它。',
      actual: String(p.webdriver),
      expected: 'false'
    })
  }
  if (p.automationGlobals.length > 0) {
    findings.push({
      key: 'automation:globals',
      severity: 'fatal',
      title: 'window 上存在自动化特征全局变量',
      detail:
        'cdc_ / $cdc_ / selenium / _phantom 等是 CDP 与自动化框架注入的特征变量。' +
        '真实浏览器不可能有——检测站扫一遍 window 就暴露了。',
      actual: p.automationGlobals.join(', '),
      expected: '（无）'
    })
  }
  if (!p.chromeObjectPresent) {
    findings.push({
      key: 'automation:noChromeObject',
      severity: 'warn',
      title: 'window.chrome 不存在',
      detail:
        '真实 Chrome 恒有 window.chrome（含 runtime / app / csi 等子对象）。' +
        '缺了它说明这不是 Chrome 内核，或内核被改得过头了。',
      actual: 'undefined',
      expected: 'object'
    })
  }

  // ---------- 2. 身份三元组自洽 ----------
  const avm = appVersionMismatch(p)
  if (avm) {
    findings.push({
      key: 'identity:appVersion',
      severity: 'fatal',
      title: 'appVersion 与 userAgent 的系统段不一致',
      detail:
        '真实 Chrome 的 appVersion 就是 UA 去掉 "Mozilla/"。只改 UA 不改 appVersion，' +
        '页面把两处的系统段一比就知道浏览器是被拼装出来的。',
      actual: p.appVersion,
      expected: p.userAgent.replace(/^Mozilla\//, '')
    })
  }
  if (expected.os === 'windows' && p.oscpu) {
    findings.push({
      key: 'identity:oscpu',
      severity: 'warn',
      title: 'navigator.oscpu 有值',
      detail: 'oscpu 是 Firefox 专有属性，Chrome 上恒为 undefined。有值说明暴露了非 Chrome 特征。',
      actual: p.oscpu,
      expected: 'undefined'
    })
  }
  if (expected.os === 'windows' && p.buildId) {
    findings.push({
      key: 'identity:buildID',
      severity: 'warn',
      title: 'navigator.buildID 有值',
      detail: 'buildID 同为 Firefox 专有，Chrome 上恒为 undefined。',
      actual: p.buildId,
      expected: 'undefined'
    })
  }
  if (p.productSub && p.productSub !== CHROME_ALWAYS.productSub) {
    findings.push({
      key: 'identity:productSub',
      severity: 'info',
      title: 'navigator.productSub 与真实 Chrome 不符',
      detail: '真实 Chrome 的 productSub 恒为 20030107。',
      actual: p.productSub,
      expected: CHROME_ALWAYS.productSub
    })
  }

  // ---------- 3. UA-CH 与 UA 自洽 ----------
  if (expected.os === 'ios') {
    if (p.uaDataPresent) {
      findings.push({
        key: 'uach:iosHasUaData',
        severity: 'fatal',
        title: 'iOS 伪装下 userAgentData 仍然存在',
        detail:
          'iOS Safari 根本没有 UA-CH API。伪装 iOS 却留着 userAgentData，' +
          '检测站一查就知道不是 Safari。',
        actual: 'present',
        expected: 'absent'
      })
    }
  } else {
    if (!p.uaDataPresent) {
      findings.push({
        key: 'uach:missing',
        severity: 'fatal',
        title: 'UA-CH（userAgentData）缺失',
        detail: '桌面 Chrome 恒有 userAgentData。缺失会被直接判为非 Chrome。',
        actual: 'absent',
        expected: 'present'
      })
    } else {
      // UA 里的系统段与 UA-CH 的 platform 必须指向同一个系统
      const uaOs = osToken(p.userAgent).toLowerCase()
      const chPlatform = String(p.uaDataPlatform || '').toLowerCase()
      const uaSaysWindows = uaOs.includes('windows')
      const uaSaysMac = uaOs.includes('mac os') || uaOs.includes('macintosh')
      const chSaysWindows = chPlatform.includes('windows')
      const chSaysMac = chPlatform.includes('mac')
      if ((uaSaysWindows && chSaysMac) || (uaSaysMac && chSaysWindows)) {
        findings.push({
          key: 'uach:platformMismatch',
          severity: 'fatal',
          title: 'UA 与 UA-CH 的平台互相矛盾',
          detail:
            'UA 串里的系统与 userAgentData.platform 说的不是同一个系统。' +
            '这两个值页面都能直接读到，一比就穿帮。',
          actual: `UA=「${p.userAgent}」 vs UA-CH.platform=「${p.uaDataPlatform}」`,
          expected: '两者一致'
        })
      }
      // UA 的 Chrome 大版本必须与 UA-CH brands 里的版本一致
      const uaMajor = String(p.userAgent || '').match(/Chrome\/(\d+)/)?.[1]
      if (uaMajor) {
        const brandVersions = p.uaDataBrands.map((b) => {
          const m = b.match(/(\d+)/)
          return m ? m[1] : ''
        })
        if (brandVersions.length && !brandVersions.includes(uaMajor)) {
          findings.push({
            key: 'uach:versionMismatch',
            severity: 'fatal',
            title: 'UA 的 Chrome 版本与 UA-CH brands 不一致',
            detail:
              'UA 串说 Chrome/某个版本，UA-CH 的 brands 却报另一个版本。' +
              '两者都是直接可读的属性，版本对不上即刻暴露。',
            actual: `UA=Chrome/${uaMajor} vs brands=${p.uaDataBrands.join(' | ')}`,
            expected: `brands 版本含 ${uaMajor}`
          })
        }
      }
    }
  }

  // ---------- 4. 语言 / 时区自洽 ----------
  if (p.language && p.languages.length && p.language !== p.languages[0]) {
    findings.push({
      key: 'locale:languageVsList',
      severity: 'fatal',
      title: 'navigator.language 与 languages[0] 不一致',
      detail: '真实浏览器里 language 恒等于 languages[0]。不等就是手工拼装的痕迹。',
      actual: `language=「${p.language}」 languages[0]=「${p.languages[0]}」`,
      expected: '两者相同'
    })
  }
  if (expected.languages.length && p.languages.length) {
    const declared = expected.languages[0]
    if (p.languages[0] !== declared) {
      findings.push({
        key: 'locale:expectedMismatch',
        severity: 'fatal',
        title: '窗口内首选语言与设定的目标语言不一致',
        detail: '设定的首选语言没有真正注入，页面读到的还是宿主默认。',
        actual: p.languages[0],
        expected: declared
      })
    }
  }
  const tzm = timezoneMismatch(p)
  if (tzm) {
    findings.push({
      key: 'timezone:offsetMismatch',
      severity: 'fatal',
      title: '时区偏移与 Date.toString() 暴露的真实时区矛盾',
      detail:
        'getTimezoneOffset 被改写了，但 Date.prototype.toString() 仍按宿主真实时区渲染。' +
        '检测站读一次 new Date().toString() 就能拿到真实时区。',
      actual: tzm,
      expected: '两处偏移一致'
    })
  }
  if (expected.timezone && p.intlTimeZone && p.intlTimeZone !== expected.timezone) {
    findings.push({
      key: 'timezone:notInjected',
      severity: 'fatal',
      title: 'Intl 读到的时区与设定不一致',
      detail: '时区没有真正注入成功。',
      actual: p.intlTimeZone,
      expected: expected.timezone
    })
  }
  // Intl 的默认 locale 跟随系统语言，与 navigator.languages 的关系
  // 是「同源但可不同」（Chrome 里 en-US 系统的 Intl locale 就是 en-US）。
  // 若 Intl locale 的地区码与首选语言的地区码打架，是一处矛盾信号。
  if (p.intlLocale && p.language) {
    const intlRegion = p.intlLocale.split('-')[1]?.toUpperCase()
    const langRegion = p.language.split('-')[1]?.toUpperCase()
    if (intlRegion && langRegion && intlRegion !== langRegion) {
      findings.push({
        key: 'locale:intlVsNavigator',
        severity: 'warn',
        title: 'Intl 默认 locale 与 navigator.language 的地区码不一致',
        detail:
          '真实浏览器里 Intl.DateTimeFormat().resolvedOptions().locale 通常与' +
          'navigator.language 同源。地区码打架说明有一处是宿主漏出来的。',
        actual: `Intl=「${p.intlLocale}」 navigator.language=「${p.language}」`,
        expected: '同源'
      })
    }
  }

  // Intl 构造器的「行为保真度」。
  //
  // 这一组与「伪装得像不像」无关，判的是「**浏览器还是不是那个浏览器**」：
  // 我们为了注入默认 locale 包了一层 Intl.DateTimeFormat，包装器一旦丢了
  // 静态方法或丢了「必须 new」的约束，页面就会报错 / 行为与原生不同——
  // 而**坏掉的浏览器比露馅的浏览器更显眼**。
  if (p.intlSupportedLocalesOk === false) {
    findings.push({
      key: 'locale:supportedLocalesBroken',
      severity: 'fatal',
      title: 'Intl.DateTimeFormat.supportedLocalesOf 不可用',
      detail:
        '为注入默认 locale 包装 Intl.DateTimeFormat 时漏搬了静态方法。' +
        '页面或检测站一调用就是 TypeError——浏览器直接坏掉，比任何指纹破绽都致命。',
      actual: 'supportedLocalesOf 缺失或抛错',
      expected: '存在且返回数组'
    })
  }
  if (p.intlRequiresNew === false) {
    findings.push({
      key: 'locale:requiresNewBroken',
      severity: 'warn',
      title: 'Intl.DateTimeFormat 不带 new 调用时未抛错',
      detail:
        '原生构造器必须用 new 调用，缺 new 会抛 TypeError。' +
        '包装器没还原这个约束，检测站一句 Intl.DateTimeFormat() 就能看穿构造器被换过。',
      actual: '未抛错',
      expected: '抛 TypeError（与原生一致）'
    })
  }

  // ---------- 5. 屏幕 / 视口合理性 ----------
  if (expected.screenWidth && p.screenWidth && p.screenWidth !== expected.screenWidth) {
    findings.push({
      key: 'screen:width',
      severity: 'fatal',
      title: '屏幕宽度与设定不一致',
      detail: '分辨率是最容易被交叉验证的向量（屏幕宽高 ↔ 窗口内外尺寸 ↔ DPR）。',
      actual: String(p.screenWidth),
      expected: String(expected.screenWidth)
    })
  }
  if (expected.screenHeight && p.screenHeight && p.screenHeight !== expected.screenHeight) {
    findings.push({
      key: 'screen:height',
      severity: 'fatal',
      title: '屏幕高度与设定不一致',
      detail: '同上。',
      actual: String(p.screenHeight),
      expected: String(expected.screenHeight)
    })
  }
  // devicePixelRatio：分辨率的「另一半」，检测站常把两者一起交叉验证
  //（如「2560×1440 的屏却报 DPR=1」本身就不自洽）。
  if (expected.devicePixelRatio && p.devicePixelRatio && p.devicePixelRatio !== expected.devicePixelRatio) {
    findings.push({
      key: 'screen:devicePixelRatio',
      severity: 'fatal',
      title: '设备像素比与设定不一致',
      detail:
        'devicePixelRatio 常与屏幕分辨率一起被交叉验证，' +
        '数值对不上说明有一处是宿主漏出来的。',
      actual: String(p.devicePixelRatio),
      expected: String(expected.devicePixelRatio)
    })
  }
  // availWidth 必须等于 width（真实 Chrome 的 availWidth 与 width 同值，
  // 差别只在 availHeight——要减去任务栏高度）
  if (p.availWidth && p.screenWidth && p.availWidth !== p.screenWidth) {
    findings.push({
      key: 'screen:availWidth',
      severity: 'warn',
      title: 'screen.availWidth 与 screen.width 不相等',
      detail:
        '真实 Chrome 的 availWidth 恒等于 width（只有 availHeight 会减去任务栏）。' +
        '两者不等说明 availWidth 是被单独伪造的。',
      actual: `availWidth=${p.availWidth} width=${p.screenWidth}`,
      expected: '两者相等'
    })
  }
  // availHeight 必须小于等于 height
  if (p.availHeight && p.screenHeight && p.availHeight > p.screenHeight) {
    findings.push({
      key: 'screen:availHeight',
      severity: 'warn',
      title: 'screen.availHeight 大于 screen.height',
      detail: '可用高度不可能超过屏幕总高。这种数值关系真实浏览器不会出现。',
      actual: `availHeight=${p.availHeight} height=${p.screenHeight}`,
      expected: 'availHeight < height'
    })
  }
  // 窗口外框必须小于等于可用屏幕
  if (p.outerWidth && p.availWidth && p.outerWidth > p.availWidth) {
    findings.push({
      key: 'screen:outerVsAvail',
      severity: 'warn',
      title: '窗口外框宽度大于可用屏幕宽度',
      detail: '真实浏览器的窗口宽度不会超过屏幕可用宽度。',
      actual: `outerWidth=${p.outerWidth} availWidth=${p.availWidth}`,
      expected: 'outerWidth <= availWidth'
    })
  }
  // 内框必须小于等于外框
  if (p.innerWidth && p.outerWidth && p.innerWidth > p.outerWidth) {
    findings.push({
      key: 'screen:innerVsOuter',
      severity: 'warn',
      title: '窗口内框宽度大于外框宽度',
      detail: 'innerWidth 恒小于等于 outerWidth。',
      actual: `innerWidth=${p.innerWidth} outerWidth=${p.outerWidth}`,
      expected: 'innerWidth <= outerWidth'
    })
  }

  // ---------- 6. 硬件合理性 ----------
  if (expected.hardwareConcurrency && p.hardwareConcurrency !== expected.hardwareConcurrency) {
    findings.push({
      key: 'hw:concurrency',
      severity: 'fatal',
      title: 'CPU 核心数与设定不一致',
      detail: 'navigator.hardwareConcurrency 是硬件级向量，检测站会拿它与 UA 的平台段做合理性校验。',
      actual: String(p.hardwareConcurrency),
      expected: String(expected.hardwareConcurrency)
    })
  }
  if (expected.deviceMemory && p.deviceMemory !== expected.deviceMemory) {
    findings.push({
      key: 'hw:deviceMemory',
      severity: 'fatal',
      title: '内存大小与设定不一致',
      detail: 'navigator.deviceMemory 同为硬件级向量。',
      actual: String(p.deviceMemory),
      expected: String(expected.deviceMemory)
    })
  }
  // 触摸能力：声称桌面却报告多点触摸，或声称移动却报告 0 触摸点
  const expectTouch = !!expected.touch
  if (expectTouch && p.maxTouchPoints === 0) {
    findings.push({
      key: 'hw:touchMissing',
      severity: 'fatal',
      title: '声称移动端但 maxTouchPoints 为 0',
      detail: '移动端 Chrome 的 maxTouchPoints 恒大于 0。为 0 说明触摸特征没注入。',
      actual: '0',
      expected: '> 0'
    })
  }
  if (!expectTouch && p.maxTouchPoints > 0) {
    findings.push({
      key: 'hw:touchLeaked',
      severity: 'fatal',
      title: '声称桌面端但 maxTouchPoints 大于 0',
      detail:
        '桌面 Chrome 的 maxTouchPoints 恒为 0。宿主是触摸屏机器而未归零时，' +
        '页面一读就知道「这是台触摸屏电脑，却声称不是」。',
      actual: String(p.maxTouchPoints),
      expected: '0'
    })
  }
  // ontouchstart 与 maxTouchPoints 必须同时存在或同时不存在
  if (!!p.ontouchstart !== p.maxTouchPoints > 0) {
    findings.push({
      key: 'hw:touchInconsistent',
      severity: 'warn',
      title: 'ontouchstart 与 maxTouchPoints 互相矛盾',
      detail:
        '真实浏览器里「触屏事件 API 存在」与「maxTouchPoints > 0」必然同时成立。' +
        '两者不一致说明只改了一半。',
      actual: `ontouchstart=${p.ontouchstart} maxTouchPoints=${p.maxTouchPoints}`,
      expected: '两者同时成立'
    })
  }

  // ---------- 7. 跨上下文一致性 ----------
  const ifm = iframeMismatch(p)
  if (ifm) {
    findings.push({
      key: 'crossframe:iframeUA',
      severity: 'fatal',
      title: 'iframe 里的 UA 与主 frame 不同',
      detail:
        '真实浏览器里同源 iframe 与主 frame 读到同一个 UA。' +
        'iframe 读到真身 UA 是最典型的「一眼穿帮」——检测站只要建一个 iframe 就能测出来。',
      actual: ifm,
      expected: '与主 frame 一致'
    })
  }
  if (p.iframePresent && p.iframeWebdriver) {
    findings.push({
      key: 'crossframe:iframeWebdriver',
      severity: 'fatal',
      title: 'iframe 里的 webdriver 为 true',
      detail: 'iframe 未被注入伪装，主 frame 的清理没覆盖到子 frame。',
      actual: 'true',
      expected: 'false'
    })
  }

  // ---------- 7b. 原型 getter 绕过 ----------
  //
  // 页面直接读 navigator.platform 拿到伪装值就以为没事了——但检测站会从
  // 原型取原生 getter 再 .call(navigator)，那一手能绕回宿主真身。
  // 这是「伪装得越认真、露馅越彻底」的典型：填得越像，越经不起交叉验证。
  {
    const pb = p.protoBypass
    if (pb) {
      if (pb.platform && pb.platform !== p.platform) {
        findings.push({
          key: 'bypass:platform',
          severity: 'fatal',
          title: '原型 getter 绕过可读出真实 platform',
          detail:
            '检测站会用 Object.getOwnPropertyDescriptor(Navigator.prototype, "platform")' +
            '.get.call(navigator) 读值——原型上的原生 getter 没被改，返回的是宿主真身。' +
            '页面直接读 navigator.platform 是伪装值，但这一手拿回真身，两者一比即穿帮。',
          actual: pb.platform,
          expected: p.platform
        })
      }
      if (pb.languages.length && JSON.stringify(pb.languages) !== JSON.stringify(p.languages)) {
        findings.push({
          key: 'bypass:languages',
          severity: 'fatal',
          title: '原型 getter 绕过可读出真实语言列表',
          detail:
            '同 platform：Navigator.prototype.languages 的原生 getter 未被改，' +
            '.call(navigator) 返回宿主真实语言（如 ["zh-CN","zh-Hans-CN"]），' +
            '与声称的 ["en-GB","en"] 直接矛盾。',
          actual: JSON.stringify(pb.languages),
          expected: JSON.stringify(p.languages)
        })
      }
      if (pb.hardwareConcurrency && pb.hardwareConcurrency !== p.hardwareConcurrency) {
        findings.push({
          key: 'bypass:hardwareConcurrency',
          severity: 'fatal',
          title: '原型 getter 绕过可读出真实 CPU 核心数',
          detail: 'Navigator.prototype.hardwareConcurrency 的原生 getter 未被改，绕过后返回宿主真实核心数。',
          actual: String(pb.hardwareConcurrency),
          expected: String(p.hardwareConcurrency)
        })
      }
      if (pb.deviceMemory && pb.deviceMemory !== p.deviceMemory) {
        findings.push({
          key: 'bypass:deviceMemory',
          severity: 'fatal',
          title: '原型 getter 绕过可读出真实内存大小',
          detail: 'Navigator.prototype.deviceMemory 的原生 getter 未被改，绕过后返回宿主真实内存。',
          actual: String(pb.deviceMemory),
          expected: String(p.deviceMemory)
        })
      }
      // devicePixelRatio 在 Chrome 里是 Window.prototype 上的访问器，
      // 同样是「实例级遮蔽可被原型绕过」的典型。且 DPR 常与分辨率交叉验证
      //（如「2560×1440 的屏配 DPR=1」本身就不自洽），是采集面很广的向量。
      if (pb.devicePixelRatio && pb.devicePixelRatio !== p.devicePixelRatio) {
        findings.push({
          key: 'bypass:devicePixelRatio',
          severity: 'fatal',
          title: '原型 getter 绕过可读出真实 devicePixelRatio',
          detail:
            'Window.prototype.devicePixelRatio 的原生 getter 未被改，' +
            '绕过后返回宿主真实 DPR。页面直接读 window.devicePixelRatio 是伪装值，' +
            '但检测站一 call 就拿回真身，两者一比即穿帮。',
          actual: String(pb.devicePixelRatio),
          expected: String(p.devicePixelRatio)
        })
      }
      // 自有键结构：真实 Chrome 的 navigator / screen 都是零自有键
      // （属性全在原型上）。若伪装时在实例上建了 own getter，
      // Object.keys(navigator) 会凭空多出一串键——本身就是一处破绽。
      if (pb.navigatorOwnKeys.length) {
        findings.push({
          key: 'bypass:navigatorOwnKeys',
          severity: 'warn',
          title: 'navigator 存在自有键（真实 Chrome 为零）',
          detail:
            '真实 Chrome 的 navigator 自有键为空（属性都在 Navigator.prototype 上）。' +
            '实例级伪装会凭空造出这些键，Object.keys(navigator) 直接把它们列出来。' +
            '修法：把伪装改到原型上。',
          actual: pb.navigatorOwnKeys.join(', '),
          expected: '（空）'
        })
      }
      if (pb.screenOwnKeys.length) {
        findings.push({
          key: 'bypass:screenOwnKeys',
          severity: 'warn',
          title: 'screen 存在自有键（真实 Chrome 为零）',
          detail: '同 navigator：真实 Chrome 的 screen 自有键为空。',
          actual: pb.screenOwnKeys.join(', '),
          expected: '（空）'
        })
      }
      // window 的可枚举自有键：**不能**断言「必须为空」——
      // 实测真实 Chromium 的 Object.keys(window) 是一份约 50 项的清单
      // （window / self / document / location / screen / innerWidth /
      //   devicePixelRatio / styleMedia / onpagereveal …），
      // 因为 Window 接口上 [LegacyUnforgeable] 的属性按 WebIDL 就是
      // 全局对象自己的可枚举属性。
      //
      // 正确判据是「比注入前的基线多了什么」——基线由 preload 在伪装前拍下。
      // 没有基线（老构建 / 探针没采到）就跳过该规则，绝不误报。
      //
      // 严重级别定「提示」而非「警告」：这条规则量到的是「基线之后新增的键」，
      // 而在**应用自己的起始页**上，页面脚本（如 React Router 的
      // `window.__reactRouterVersion`）本来就会新增键——那是页面自己的东西，
      // 不是伪装留下的破绽。真正防「实例级伪装」的闸门是
      // tests/preloadPatchNative.test.cjs 里的**源码级**守卫：
      // 它确定性、不依赖运行时环境、不会误报。
      const winExtra = pb.windowOwnKeysExtra || []
      if (winExtra.length) {
        findings.push({
          key: 'bypass:windowOwnKeys',
          severity: 'info',
          title: 'window 比基线多出了可枚举自有键',
          detail:
            '这些键在注入前的基线里不存在。在应用自己的起始页上通常来自页面脚本' +
            '（如 React Router 的 __reactRouterVersion），不一定是伪装留下的；' +
            '但在外部站点上出现就说明有实例级伪装添了键。' +
            '确定性闸门见 tests/preloadPatchNative.test.cjs 的源码级守卫。',
          actual: winExtra.join(', '),
          expected: '（无新增键）'
        })
      }
    }
  }

  // ---------- 8. 原生性测谎 ----------
  findings.push(...nativeLieFindings(p))

  // ---------- 9. 熵稳定性 ----------
  findings.push(...entropyFindings(p))

  // ---------- 10. 平台 API 矩阵 ----------
  // 声称 iOS 却有桌面 API（反之亦然）——体检的 platformApis 项查的是
  // 「该 OS 不该有的 API 是否被遮蔽」，这里补一条「该有的反而缺了」的视角。
  const expectApis: Record<string, string[]> = {
    windows: ['bluetooth', 'usb', 'serial', 'hid'],
    mac: ['bluetooth', 'usb', 'serial', 'hid'],
    android: ['bluetooth', 'usb'],
    ios: []
  }
  const want = expectApis[expected.os] ?? []
  const missing = want.filter((a) => !p.platformApis.includes(a))
  if (missing.length) {
    findings.push({
      key: 'platform:missingApi',
      severity: 'warn',
      title: '缺少该平台本应存在的 API',
      detail:
        '伪装成该平台时，本应存在的平台 API 反而不见了——' +
        '这同样是不自洽的信号（检测站会做「能力矩阵」检查）。',
      actual: `缺 ${missing.join(', ')}`,
      expected: `有 ${want.join(', ')}`
    })
  }

  // ---------- 10b. 「不该存在的 API」是否真的不存在 ----------
  //
  // 上一条查的是「该有的却缺了」，这条查反面：「**该没有的却还在**」。
  //
  // 关键在于判据是**存在性**而不是读值：
  // 真实 iOS Safari 里压根没有 navigator.userAgentData，
  // 检测站查的是 `'userAgentData' in navigator` —— 是不是 false。
  // 若只是把原型上的 getter 改成返回 undefined，in 判定仍是 true，一样露馅。
  const absentApis: Record<string, string[]> = {
    ios: ['userAgentData', 'gpu', 'requestMediaKeySystemAccess', 'webdriver'],
    android: ['serial', 'hid'],
    mac: ['nfc'],
    windows: ['nfc']
  }
  const shouldBeAbsent = absentApis[expected.os] ?? []
  const ap = p.apiPresence || {}
  const stillThere = shouldBeAbsent.filter((a) => ap[a] === true)
  if (stillThere.length) {
    findings.push({
      key: 'platform:apiShouldBeAbsent',
      severity: 'fatal',
      title: '该平台没有的 API 却仍然存在',
      detail:
        '真实浏览器里这些 API 根本不存在（检测站用 `key in navigator` 判定，' +
        '不是看读出来是不是 undefined）。只把 getter 改成返回 undefined 不够——' +
        '属性还在原型上，`in` 判定仍是 true。修法：把它从原型上真正删掉。',
      actual: stillThere.join(', '),
      expected: '（这些 API 都不存在）'
    })
  }

  // ---------- 11. 字体 ----------
  if (p.fontCount > 0 && p.fontMismatchCount > 0) {
    findings.push({
      key: 'font:mismatch',
      severity: 'warn',
      title: '声称可用的字体实际测不出差异',
      detail:
        'document.fonts.check 说字体可用，但 measureText 测不出宽度差——' +
        '说明字体只是被「报出来」了，并没有真正屏蔽宿主的真实字体集。',
      actual: `${p.fontMismatchCount}/${p.fontCount} 个字体不可用`,
      expected: '0 个不一致'
    })
  }

  // ---------- 12. 能力矩阵 ----------
  if (expected.os === 'ios' && p.webGpuPresent) {
    findings.push({
      key: 'capability:iosWebGpu',
      severity: 'warn',
      title: 'iOS 伪装下 navigator.gpu 仍存在',
      detail: 'iOS Safari 没有 WebGPU。留着会暴露内核不对。',
      actual: 'present',
      expected: 'absent'
    })
  }

  // 按严重级别排序：fatal → warn → info
  const order: Record<StealthSeverity, number> = { fatal: 0, warn: 1, info: 2 }
  return findings.sort((a, b) => order[a.severity] - order[b.severity])
}

/** 审计结论的汇总计数 */
export interface StealthSummary {
  fatal: number
  warn: number
  info: number
  /** 是否可以认为「能瞒过浏览器」——没有 fatal 才算过 */
  passed: boolean
}

/** 统计审计结论 */
export function summarizeFindings(findings: StealthFinding[]): StealthSummary {
  const s: StealthSummary = { fatal: 0, warn: 0, info: 0, passed: true }
  for (const f of findings) {
    if (f.severity === 'fatal') s.fatal++
    else if (f.severity === 'warn') s.warn++
    else s.info++
  }
  s.passed = s.fatal === 0
  return s
}

/**
 * 生成人类可读的审计报告（纯文本）。
 *
 * 与 CLI / 文档共用同一份格式，避免「脚本说一套、界面说另一套」。
 */
export function formatStealthReport(findings: StealthFinding[], summary: StealthSummary): string {
  const lines: string[] = []
  const mark = (s: StealthSeverity) => (s === 'fatal' ? '【致命】' : s === 'warn' ? '【警告】' : '【提示】')
  if (!findings.length) {
    lines.push('✅ 未发现反检测破绽（无致命、无警告）')
    return lines.join('\n')
  }
  // 只有「提示」时不报「发现 N 处问题」——提示是背景信息，不是问题。
  // 把提示说成问题会让人养成忽略结论的习惯，那比多报一条更糟。
  if (summary.fatal === 0 && summary.warn === 0) {
    lines.push(`✅ 未发现反检测破绽（无致命、无警告；另有 ${summary.info} 条提示）`)
  } else {
    lines.push(
      `发现 ${summary.fatal + summary.warn} 处问题：致命 ${summary.fatal} · 警告 ${summary.warn} · 提示 ${summary.info}`
    )
  }
  lines.push('')
  for (const f of findings) {
    lines.push(`${mark(f.severity)} ${f.title}`)
    lines.push(`    ${f.detail}`)
    if (f.actual !== undefined) lines.push(`    实测：${f.actual}`)
    if (f.expected !== undefined) lines.push(`    期望：${f.expected}`)
    lines.push('')
  }
  lines.push(
    summary.passed
      ? '结论：无致命破绽，可以认为「瞒过浏览器」这一关是过的（警告项建议逐步清理）。'
      : `结论：存在 ${summary.fatal} 处致命破绽，外部检测站可据此判定此环境非真实浏览器，必须先修复。`
  )
  return lines.join('\n')
}
