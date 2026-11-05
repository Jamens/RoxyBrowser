// 指纹注入脚本（运行于浏览器环境窗口的每一页面）
// 通过 webPreferences.additionalArguments 传入 --roxy-fp=<base64>
/* eslint-disable @typescript-eslint/no-explicit-any */
import { webGpuInfoFor, webGpuSupported, webGpuSpoofAllowed } from '../shared/webgpu'
import { audioProfileFor } from '../shared/webaudio'
import { effectiveCanvasSeed, isTinyCanvas, mulberry32, applyIdempotentNoise } from '../shared/canvasNoise'
;(() => {
  interface Fingerprint {
    os: string
    userAgent: string
    uaFullVersion: string
    platform: string
    languages: string[]
    timezone: string
    tzOffset: number
    screenWidth: number
    screenHeight: number
    hardwareConcurrency: number
    deviceMemory: number
    canvasNoise: boolean
    webglVendor: string
    webglRenderer: string
    audioNoise: boolean
    webrtc: 'disable' | 'real' | 'proxy'
    doNotTrack: string
    touch?: boolean
    devicePixelRatio?: number
    fonts?: string[]
    geoLatitude: number
    geoLongitude: number
    geoAccuracy: number
    // 是否注入 HTTP 明文连接安全警告条（仅环境窗口、http:// 且非 localhost 时生效）
    httpWarning: boolean
    // 媒体查询偏好：prefers-color-scheme / prefers-reduced-motion 的回灌值（Tier 2 #5）
    prefersColorScheme: 'light' | 'dark' | 'no-preference'
    prefersReducedMotion: boolean
  }

  // ipcRenderer 提前到最前：起始页的 window.roxy.navigate 闭包要用它
  const { ipcRenderer } = require('electron') as typeof import('electron')

  const fpArg = process.argv.find((a: string) => a.startsWith('--roxy-fp='))
  if (!fpArg) return
  const fp: Fingerprint = JSON.parse(Buffer.from(fpArg.slice('--roxy-fp='.length), 'base64').toString('utf8'))
  const profileArg = process.argv.find((a: string) => a.startsWith('--roxy-profile='))
  const seed = profileArg ? Number(profileArg.slice('--roxy-profile='.length)) * 2654435761 : 12345

  // ===== CDP 环境身份标记 =====
  // 外部自动化工具（Playwright / Puppeteer）通过 CDP 连上后拿到的只是
  // 一串 target（targetId + url + title），无法知道「哪个 target 对应哪个环境」。
  // 这里把 profileId 挂成全局变量，主进程通过 CDP 的 Runtime.evaluate 求值
  // 即可把 target 精确映射回环境，避免外部工具靠 URL 猜（同一站点多环境时必然猜错）。
  // 命名带 __roxy 前缀并设为不可枚举，尽量不干扰页面的特征检测面。
  try {
    const pid = profileArg ? Number(profileArg.slice('--roxy-profile='.length)) : null
    Object.defineProperty(window, '__roxyProfileId', {
      value: Number.isFinite(pid as number) ? pid : null,
      configurable: true,
      enumerable: false,
      writable: false
    })
    Object.defineProperty(window, '__roxyApp', { value: 'RoxyBrowserClone', configurable: true, enumerable: false })
  } catch {
    /* 注入失败不影响环境使用，仅导致外部工具无法自动识别环境归属 */
  }

  // ===== 补丁函数登记表：让被覆写的函数 toString 仍报 [native code] =====
  // 指纹站（browserscan d0 等「测谎」检查）会直接 /native/i.test(fn.toString())——
  // 覆写后的函数若原样暴露源码，一行就能判定「这个浏览器被改过」。
  // 这里把所有补丁登记在案，并覆写 Function.prototype.toString 按表返回原生形态。
  const patchedFns = new Map<Function, string>()
  const patchNative = <T extends Function>(fn: T, name: string): T => {
    patchedFns.set(fn, name)
    return fn
  }
  const origFnToString = Function.prototype.toString
  Function.prototype.toString = patchNative(function (this: any) {
    const name = patchedFns.get(this)
    if (name) return `function ${name}() { [native code] }`
    return origFnToString.call(this)
  }, 'toString')

  // 补丁挂载暗记：toString 伪装让「源码判据」（String(fn) 不含 [native code]）失效，
  // 环境体检（healthProbe）改用本表判断「注入是否真的挂上了」——逐项记录、不可枚举，
  // 与 __roxyApp 同风格（外部扫 __roxy 前缀的成本由已有标记承担，不新增暴露面）。
  // 键名即体检项：canvas / audio / fonts / webgl / webrtc / uaCh / timezone / battery。
  const patchedFlags: Record<string, boolean> = {}
  const markPatched = (key: string) => {
    patchedFlags[key] = true
  }
  try {
    Object.defineProperty(window, '__roxyPatched', {
      value: patchedFlags,
      configurable: true,
      enumerable: false,
      writable: false
    })
  } catch {
    /* ignore */
  }

  const def = (obj: any, key: string, value: any) => {
    try {
      // getter 必须过「原生测谎」：browserscan 的 sL() 会同时读原型与实例两个描述符，
      // 要求 getter.toString() 含 [native code]。裸箭头函数 toString 报 "() => value"，
      // 一行穿帮 → isUACorrect 直接被客户端门闩判死（与服务端判定无关）。
      // 因此 getter 一律走 patchNative 登记（toString 报 "function get <key>() { [native code] }"），
      // name 也对齐原生形态（原生 getter 的 name 为 "get <key>"）。
      const nativeName = `get ${key}`
      const getter = patchNative(() => value, nativeName)
      try {
        Object.defineProperty(getter, 'name', { value: nativeName, configurable: true })
      } catch {
        /* ignore */
      }
      Object.defineProperty(obj, key, { get: getter, configurable: true, enumerable: true })
    } catch {
      /* ignore */
    }
  }

  // ===== 原型级伪装（defProto）=====
  //
  // ## 为什么不能只在实例上定义
  //
  // 早期实现用 def(navigator, 'platform', ...) 在**实例**上建 own getter。
  // 页面直接读 navigator.platform 确实拿到伪装值，看起来没问题——但检测站
  // 有个标准手法能绕过去：
  //
  //   Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')
  //     .get.call(navigator)
  //
  // 即从**原型**取原生 getter 再 .call 到 navigator 上。原型上的 getter
  // 从未被改过，返回的仍是宿主真身。实测（伪装成 macOS 的环境）：
  //
  //   navigator.platform            → MacIntel   （伪装值）
  //   原型 getter .call(navigator)  → Win32      （真身露馅）
  //   navigator.languages           → ["en-GB"]  （伪装值）
  //   原型 getter .call(navigator)  → ["zh-CN"]  （真身露馅）
  //
  // platform / languages / hardwareConcurrency / deviceMemory 这几项
  // 全都是纯 JS 层伪装（UA 之所以没事，是因为 session.setUserAgent 改的是
  // Chromium 内部的 UA 字符串，原型 getter 读的是同一个源），因此这一手
  // 能把它们逐个打回原形——**伪装得越认真，露馅越彻底**。
  //
  // ## 为什么原型级还能顺带修好「自有键」问题
  //
  // 真实 Chrome 的 navigator 是**零自有键**（属性全在 Navigator.prototype 上）。
  // 而 def(navigator, ...) 会凭空造出 13 个 own property，
  // `Object.keys(navigator)` 直接把它们列出来——这本身就是一处破绽。
  // 改到原型上之后自有键数归零，与真实 Chrome 一致。
  //
  // ## 前提
  //
  // WebIDL 定义的属性都是 configurable: true（实测确认），故可安全覆写。
  // 覆写后必须保持 enumerable: true——原生 WebIDL 属性在原型上就是可枚举的，
  // 改掉反而会露馅。
  const defProto = (proto: any, key: string, value: any) => {
    try {
      if (!proto) return
      const nativeName = `get ${key}`
      const getter = patchNative(() => value, nativeName)
      try {
        Object.defineProperty(getter, 'name', { value: nativeName, configurable: true })
      } catch {
        /* ignore */
      }
      Object.defineProperty(proto, key, { get: getter, configurable: true, enumerable: true })
    } catch {
      /* ignore */
    }
  }

  /**
   * 从原型上**彻底删除**属性——用于「该平台/该浏览器里这个 API 根本不存在」。
   *
   * ## 为什么是 delete 而不是「改成返回 undefined」
   *
   * 「这个 API 在真实浏览器里不存在」有两层含义，检测站都会查：
   *   ① `navigator.userAgentData` 读出来是 undefined；
   *   ② `'userAgentData' in navigator` 是 **false**。
   *
   * 若只是把原型上的 getter 改成返回 undefined，① 成立但 **② 不成立**
   * ——属性还在原型上。真实 iOS Safari 压根没有 userAgentData，
   * 一句 `'userAgentData' in navigator` 就知道「这个 navigator 是被改过的」。
   *
   * ## delete 在这里是**安全**的
   *
   * 项目此前踩过一个坑：`delete navigator.geolocation` 什么也没删——
   * 因为那删的是**实例**上的自有属性，而目标在原型上，delete 只影响自身属性。
   * 这里删的是**原型上**的属性，而 WebIDL 属性实测均为 configurable: true，
   * 故 delete 真正生效。删完会再验一次，删不掉就退回「返回 undefined」。
   *
   * 若属性**不可配置**（WebIDL 规范下不会发生，但理论上可能）：
   * 既删不掉、也换不掉（不可配置的访问器不允许再定义另一个访问器），
   * 此时只能原样保留——这是唯一可能的结果，不抛错、不假装成功。
   */
  const delProto = (proto: any, key: string) => {
    try {
      if (!proto) return
      const d = Object.getOwnPropertyDescriptor(proto, key)
      if (!d) return
      if (d.configurable) {
        delete proto[key]
        // 验一次：真删掉了才算数
        if (!Object.getOwnPropertyDescriptor(proto, key)) return
      }
      // 删不掉（不可配置）→ 试着改成返回 undefined 的访问器；
      // 若原属性是不可配置的访问器，defineProperty 会抛（不允许再定义另一个访问器），
      // 那就只能原样保留——这是唯一可能的结果。
      const nativeName = `get ${key}`
      const getter = patchNative(() => undefined, nativeName)
      try {
        Object.defineProperty(getter, 'name', { value: nativeName, configurable: true })
      } catch {
        /* ignore */
      }
      try {
        Object.defineProperty(proto, key, { get: getter, configurable: true, enumerable: true })
      } catch {
        /* 不可配置且不可替换：原样保留 */
      }
    } catch {
      /* ignore */
    }
  }

  // ===== 应用自身起始页专供：本地 API 地址 =====
  // 只在应用自己的页面（file:// 构建产物或本地开发服务器）上暴露 window.roxy，
  // 不落到外部站点上，避免成为可检测痕迹。环境窗口渲染进程继承主进程 env，
  // ROXY_API_BASE 在主进程启动时已写入（端口被占用递增时也能拿到真实值）。
  try {
    if (
      location.protocol === 'file:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1'
    ) {
      def(window, 'roxy', {
        apiBase: process.env.ROXY_API_BASE || 'http://127.0.0.1:39100',
        /**
         * 本地 API 请求守卫的一次性 nonce。
         *
         * 与主窗口 preload 暴露的是同一个值，但**注入条件同样严格**：
         * 只在应用自己的页面（file:// 或本机地址）上给，外部站点读不到。
         * 起始页若要调本地 API，靠的就是它——`Origin: null` 的请求没有 nonce 会被拒。
         */
        apiNonce: process.env.ROXY_API_NONCE || '',
        // 起始页导航交给主进程执行：环境窗口没有地址栏/进度条，页面自己改
        // location.href 时一旦加载失败（多为代理不通）就只是停住不动，
        // 用户看到的就是「点了没反应」。走主进程才能拿到失败原因并回传。
        navigate: (url: string) => {
          try {
            ipcRenderer.send('env-navigate', url)
          } catch {
            window.location.href = url
          }
        },
        // 起始页加载遮罩上的「取消」：通知主进程停止当前加载并摘掉一次性监听
        cancel: () => {
          try {
            ipcRenderer.send('env-navigate-cancel')
          } catch {
            /* ignore */
          }
        }
      })
    }
  } catch {
    /* ignore */
  }

  // ===== window 自有键基线（在任何伪装之前采集）=====
  //
  // ## 为什么需要基线
  //
  // 审计里有一条规则要判断「window 的可枚举自有键里有没有我们凭空添的键」。
  // 但**不能**简单断言「window 自有键为空」——实测真实 Chromium 的
  // Object.keys(window) 是一份约 50 项的清单
  // （window / self / document / location / history / screen / innerWidth /
  //   devicePixelRatio / styleMedia / onpagereveal …）：
  // 这些是 Window 接口上 [LegacyUnforgeable] 的属性，按 WebIDL 规范就是
  // 全局对象**自己的可枚举属性**。写成「必须为空」是一条**基于错误前提的规则**，
  // 而基于错误前提的规则比没有规则更糟——它会一直误报，直到被人习惯性忽略。
  //
  // ## 正确做法
  //
  // 在**注入任何伪装之前**把 window 的可枚举自有键拍一张快照，
  // 审计时拿「当前键集合」与「基线」相减——多出来的才是后来添的。
  // 这样规则与 Chromium 版本无关（基线来自同一个浏览器自己），也不会误报。
  //
  // 采集点选在「起始页专供」之后、伪装之前：window.roxy 是我们自己的标记
  // （且只在应用自己的页面上存在），把它算进基线才不会把它报成「多出来的键」。
  try {
    Object.defineProperty(window, '__roxyWindowOwnKeys', {
      value: Object.keys(window),
      configurable: true,
      enumerable: false,
      writable: false
    })
  } catch {
    /* 采集失败则审计侧跳过该规则（不误报） */
  }

  // ===== navigator =====
  // 一律改**原型**（Navigator.prototype），不在实例上建 own getter。
  // 原因见 defProto 的注释：检测站会从原型取原生 getter 再 .call(navigator)
  // 来绕过实例遮罩，实例级伪装会被这一手逐个打回原形。
  // 副作用也是好的：真实 Chrome 的 navigator 零自有键，改到原型后
  // Object.keys(navigator) 恢复为空，不再凭空多出 7 个键。
  const NavProto = (window as any).Navigator && (window as any).Navigator.prototype
  defProto(NavProto, 'userAgent', fp.userAgent)
  defProto(NavProto, 'platform', fp.platform)
  defProto(NavProto, 'languages', Object.freeze([...fp.languages]))
  defProto(NavProto, 'language', fp.languages[0])
  defProto(NavProto, 'hardwareConcurrency', fp.hardwareConcurrency)
  defProto(NavProto, 'deviceMemory', fp.deviceMemory)
  defProto(NavProto, 'doNotTrack', fp.doNotTrack)

  // ===== 反自动化痕迹清除（Tier 1 #1，对标指纹浏览器标配反检测）=====
  // 检测站（Cloudflare / PerimeterX / 各平台风控）首要查的就是自动化痕迹，
  // 比再加一个 EME 向量影响大得多。真实非自动化 Chrome 的 navigator.webdriver 恒为 false；
  // iOS Safari 根本没有该属性（undefined）。CDP / ChromeDriver 还会在 window 上留下
  // cdc_ / $cdc_ 等特征变量——本仓库环境由我们自己启动的 Electron 窗口承载，正常情况下不会存在，
  // 但加一层「存在即清除」的防御，避免任何 CDP 连接意外注入后暴露。
  {
    // 1) navigator.webdriver：非 iOS 强制 false，iOS 整体隐藏（与 EME / userAgentData 同源手法）
    if (fp.os === 'ios') {
      delProto(NavProto, 'webdriver')
    } else {
      defProto(NavProto, 'webdriver', false)
    }
    // 2) 已知自动化特征全局变量：存在即删除（仅 own property，不影响原型）
    const AUTO_GLOBALS = [
      'cdc_', '$cdc_', '$chrome_asyncScriptInfo',
      '__nightmare', 'callPhantom', '_phantom', '__phantomas',
      'selenium', '__webdriver_evaluate', '__driver_evaluate',
      '__webdriver_script_function', '__webdriver_script_func', '__webdriver_script_fn',
      '__driver_unwrapped', '__webdriver_unwrapped', '__selenium_unwrapped',
      '__fxdriver_unwrapped', '__selenium_evaluate', '__fxdriver_evaluate'
    ]
    for (const g of AUTO_GLOBALS) {
      try { if (Object.prototype.hasOwnProperty.call(window, g)) delete (window as any)[g] } catch (e) { /* ignore */ }
    }
    // document 上也偶有 $cdc_ 残留
    try { if (Object.prototype.hasOwnProperty.call(document, '$cdc_')) delete (document as any).$cdc_ } catch (e) { /* ignore */ }
  }

  // ===== 平台 API 一致性（Tier 2 #4，避免「iOS 伪装却暴露桌面 Web API」矛盾信号）=====
  // 真实支持矩阵（Chromium 各平台 vs iOS WebKit）：
  //   bluetooth(Web Bluetooth)：Chrome 全平台(含 Android) 有；iOS Safari 无
  //   usb(WebUSB)：Chrome 桌面 + Android 有；iOS Safari 无
  //   serial(Web Serial)：仅 Chrome 桌面；Android / iOS 无
  //   hid(WebHID)：仅 Chrome 桌面；Android / iOS 无
  //   nfc(Web NFC)：仅 Android Chrome；桌面 / iOS 无
  // 不伪造原则（规则 #22/#30）：宿主本来就没有的 API 绝不主动新增，因此「应有的缺失」不处理；
  // 只把「该 OS 不该有、但宿主原生却暴露」的 API 用 hide 遮蔽（own getter 返回 undefined，遮蔽原型属性）。
  {
    const PLATFORM_APIS: { key: string; allowed: string[] }[] = [
      { key: 'bluetooth', allowed: ['windows', 'mac', 'android'] },
      { key: 'usb', allowed: ['windows', 'mac', 'android'] },
      { key: 'serial', allowed: ['windows', 'mac'] },
      { key: 'hid', allowed: ['windows', 'mac'] },
      { key: 'nfc', allowed: ['android'] }
    ]
    for (const { key, allowed } of PLATFORM_APIS) {
      if (allowed.indexOf(fp.os) >= 0) continue
      // 仅当宿主原生就有该 API 时才隐藏（不凭空新增，否则 'key' in navigator 会误报存在）
      if ((navigator as any)[key] !== undefined) delProto(NavProto, key)
    }
  }

  // ===== 媒体查询偏好（Tier 2 #5，prefers-color-scheme / prefers-reduced-motion 稳定可伪装）=====
  // 这两个媒体查询反映 OS 级偏好，是平台级指纹向量之一。统一由 fp 驱动，
  // 避免「同环境每次读到不同值」或「泄漏宿主真实偏好」的矛盾信号。仅在宿主原生有 matchMedia 时才覆写，
  // 其余媒体查询（响应式断点等）一律透传原生，CSS @media 也不受影响。
  {
    const origMql = (window as any).matchMedia
    if (typeof origMql === 'function') {
      const scheme = fp.prefersColorScheme || 'light'
      const reduced = !!fp.prefersReducedMotion
      const spoofed = (q: string): boolean | null => {
        const s = String(q)
        if (/prefers-color-scheme:\s*dark/.test(s)) return scheme === 'dark'
        if (/prefers-color-scheme:\s*light/.test(s)) return scheme === 'light'
        if (/prefers-color-scheme:\s*no-preference/.test(s)) return scheme === 'no-preference'
        if (/prefers-reduced-motion:\s*reduce/.test(s)) return reduced
        if (/prefers-reduced-motion:\s*no-preference/.test(s)) return !reduced
        return null
      }
      const fakeMql = (matches: boolean, media: string) => ({
        matches,
        media,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false }
      })
      ;(window as any).matchMedia = patchNative(function (query: string) {
        const m = spoofed(query)
        if (m !== null) return fakeMql(m, query)
        return origMql.call(window, query)
      }, 'matchMedia')
    }
  }

  // ===== 移动端：触摸能力 + 像素比 =====
  // 桌面（非触摸）统一归 0，避免真实宿主机是触摸屏时把 maxTouchPoints 漏成 10 等；
  // 移动端固定 5。这是反检测最稳妥的默认值。
  // maxTouchPoints 在 Navigator.prototype 上（可配置），改原型以防 getter 绕过。
  defProto(NavProto, 'maxTouchPoints', fp.touch ? 5 : 0)
  if (fp.touch) {
    // 'ontouchstart' in window 是常见触摸检测手段
    //
    // 注意：**必须留在 window 实例上**，不能挪到 Window.prototype。
    // 实测 Chromium 的 Window 成员（matchMedia / devicePixelRatio /
    // fetch / setTimeout / 各类 on* 事件处理器）全都是 **window 自己的属性**
    // （window 有 237 个自有可枚举键），Window.prototype 上一个都没有。
    // 非触摸宿主上 `ontouchstart` 不存在（真实移动设备上它是 window 的自有属性），
    // 故这里在 window 上补一个，与真实触摸设备一致。
    def(window, 'ontouchstart', null)
  }
  if (typeof fp.devicePixelRatio === 'number' && fp.devicePixelRatio > 0) {
    // devicePixelRatio 同上：**是 window 自己的可访问器属性**
    // （实测 accessor / configurable / enumerable，不在 Window.prototype 上）。
    // 所以这里必须在 window 实例上覆写——挪到 Window.prototype 有两个害处：
    // ① 真实 Chrome 的 Window.prototype 上并没有这个属性，多出来就是破绽；
    // ② window 自有属性会把它**完全遮蔽**掉，伪装直接失效。
    def(window, 'devicePixelRatio', fp.devicePixelRatio)
  }

  // ===== userAgentData（UA-CH）=====
  // 关键：不能只在原生 userAgentData 实例上 redefine 子字段——Chromium 每次访问
  // navigator.userAgentData 都返回一个新对象（或只读原型属性），子字段改写不会落到
  // 真正被读取的实例上，导致宿主 platform（如 Windows）原样泄漏。必须整体替换 getter。
  const isMobile = fp.os === 'android' || fp.os === 'ios'
  if (fp.os === 'ios') {
    // iOS Safari 不支持 userAgentData，伪装时必须整个移除，否则一查就穿帮。
    // 改 Navigator.prototype 上的 getter 返回 undefined（而非在实例上建 own getter）：
    // 后者会让 Object.keys(navigator) 多出一个键，真实 Chrome 的 navigator 是零自有键。
    delProto(NavProto, 'userAgentData')
  } else {
    const uadPlatform = fp.os === 'mac' ? 'macOS' : fp.os === 'android' ? 'Android' : 'Windows'
    const major = fp.uaFullVersion.split('.')[0]
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not A;Brand', version: '99' }
    ]
    const uad: any = {
      brands,
      mobile: isMobile,
      platform: uadPlatform,
      // getHighEntropyValues 也走 patchNative：它是本对象里唯一的函数，
      // 裸箭头函数的 toString 会暴露源码，检测站一测谎就判定浏览器被改过。
      getHighEntropyValues: patchNative(
        (_hints: string[]) =>
          Promise.resolve({
            brands,
            mobile: isMobile,
            platform: uadPlatform,
            platformVersion: fp.os === 'mac' ? '14.6.1' : fp.os === 'android' ? '14.0.0' : '15.0.0',
            uaFullVersion: fp.uaFullVersion,
            architecture: fp.os === 'mac' ? 'arm' : fp.os === 'android' ? 'arm' : 'x86',
            bitness: '64',
            model: '',
            wow64: false
          }),
        'getHighEntropyValues'
      )
    }
    // 改原型上的 getter，实例遮蔽同样会被 getter 绕过手法打回原形。
    defProto(NavProto, 'userAgentData', uad)
  }
  markPatched('uaCh')

  // ===== WebCrypto 新算法：按**伪装版本**门控 =====
  //
  // 背景（升级 Electron 45 / Chromium 156 时实测发现）：
  // Chromium **154 起默认**在 WebCrypto 里提供 ML-KEM-768/1024、ML-DSA-44/65/87、
  // X-Wing 与 ChaCha20-Poly1305（Chrome 151–153 期间是原始试验，154 起默认开启）。
  // 而本项目的 UA 最高只伪装到 Chrome 154，默认预设甚至在伪装 151/153。
  //
  // 于是产生一个**可被一行代码识破的矛盾**：
  //   try { crypto.subtle.generateKey({name:'ML-KEM-768'}, false, [...]); /* 你不是 151 */ } catch {}
  // 「声称自己是 Chrome 151，却能用 Chrome 154 才有的算法」——
  // 这比 UA 版本落后本身更致命（真实用户的浏览器滞后很常见，但**特性超前**不可能）。
  //
  // 做法：把 crypto.subtle 的**算法入口**按伪装版本拦住。低于门槛的算法名一律按
  // 「不支持」抛错（与浏览器对未知算法的行为一致），而不是静默不做事——
  // 静默返回 undefined 的 Promise 反而更可疑。
  //
  // 门槛取 154：与 Chrome 官方时间线一致（154 起默认开启）。
  const NEW_WEBCRYPTO_ALGO_MIN_CHROME = 154
  // ML-KEM / ML-DSA / X-Wing 是后量子算法；ChaCha20-Poly1305 是同批进入 WebCrypto
  // 的对称算法（同一份 WICG 草案）——一并门控，理由相同：**它们在旧版 Chrome 里不存在**。
  const NEW_WEBCRYPTO_ALGOS = [
    'ML-KEM-512', 'ML-KEM-768', 'ML-KEM-1024',
    'ML-DSA-44', 'ML-DSA-65', 'ML-DSA-87',
    'X-Wing', 'ChaCha20-Poly1305'
  ]
  {
    const spoofMajor = Number(String(fp.uaFullVersion || '').split('.')[0] || 0)
    const allowed = spoofMajor >= NEW_WEBCRYPTO_ALGO_MIN_CHROME
    const subtle: any = (globalThis as any).crypto?.subtle
    if (subtle && !allowed) {
      const rejectBlocked = (algo: unknown): void => {
        // 算法名可能直接是字符串，也可能是 { name: '...' } 对象
        const name = typeof algo === 'string' ? algo : String((algo as any)?.name || '')
        if (NEW_WEBCRYPTO_ALGOS.indexOf(name) < 0) return
        // 与浏览器对"不支持的算法"保持同样的错误形态：DOMException NotSupportedError
        throw new DOMException(`Unrecognized algorithm name: ${name}`, 'NotSupportedError')
      }
      const patch = (fnName: string) => {
        const orig = subtle[fnName]
        if (typeof orig !== 'function') return
        try {
          Object.defineProperty(subtle, fnName, {
            value: patchNative(function (this: any, ...args: any[]) {
              // generateKey(algorithm, ...) / importKey(format, keyData, algorithm, ...)
              // / deriveBits(algorithm, baseKey, ...) —— 算法参数位置不统一，逐个探测。
              for (const a of args) {
                if (a && typeof a === 'object' && !Array.isArray(a)) rejectBlocked(a)
              }
              return orig.apply(this, args)
            }, fnName),
            configurable: true,
            writable: true
          })
        } catch {
          /* ignore */
        }
      }
      ;['generateKey', 'importKey', 'deriveKey', 'deriveBits', 'encrypt', 'decrypt', 'sign', 'verify'].forEach(patch)
    }
  }

  // ===== screen =====
  // 改 Screen.prototype 而非 screen 实例：检测站同样能用
  // Object.getOwnPropertyDescriptor(Screen.prototype,'width').get.call(screen) 绕过实例遮罩。
  // 附带好处：screen 不再凭空多出 4 个自有键（真实 Chrome 的 screen 自有键为空）。
  const ScreenProto = (window as any).Screen && (window as any).Screen.prototype
  defProto(ScreenProto, 'width', fp.screenWidth)
  defProto(ScreenProto, 'height', fp.screenHeight)
  defProto(ScreenProto, 'availWidth', fp.screenWidth)
  defProto(ScreenProto, 'availHeight', fp.screenHeight - (fp.touch ? 24 : fp.os === 'mac' ? 25 : 40))

  // ===== 时区 =====
  //
  // getTimezoneOffset 必须**按时刻动态计算**，不能返回固定值：
  // 目标时区有夏令时（Europe/London 冬季 0 / 夏季 -60）。
  // 若返回生成指纹那一刻的固定偏移，则夏令时期间页面会读到
  // 「声称 London 但偏移是 GMT+0000」——与 Date.toString() 显示的 BST 矛盾。
  //
  // 偏移算法放在下面（targetOffsetAt），此处先声明一个可变引用，
  // 由后面赋值后填充，避免前向依赖导致的大量代码搬移。
  let tzOffsetAt: (date: Date) => number = () => fp.tzOffset
  Date.prototype.getTimezoneOffset = patchNative(function (this: any) {
    try {
      const d = this instanceof Date ? this : new Date(Number(this))
      if (Number.isNaN(d.getTime())) return fp.tzOffset
      return tzOffsetAt(d)
    } catch {
      return fp.tzOffset
    }
  }, 'getTimezoneOffset')
  const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions
  Intl.DateTimeFormat.prototype.resolvedOptions = patchNative(function (this: any, ...args: any[]) {
    const options = realResolved.apply(this, args as [])
    options.timeZone = fp.timezone
    return options
  }, 'resolvedOptions')

  // ---- Date.prototype.toString / toLocaleString：按目标时区渲染 ----
  //
  // ## 为什么必须改
  //
  // getTimezoneOffset 被改写了，但 Date.prototype.toString() 仍按**宿主真实时区**
  // 渲染。实测（宿主机 UTC+8、伪装 Europe/London）：
  //
  //   getTimezoneOffset()            → 0        （伪装值）
  //   new Date().toString()          → "... GMT+0800 (中国标准时间)"  ← 真身露馅
  //
  // 检测站读一次 new Date().toString() 就拿到宿主所在城市与时区，
  // 与声称的 London 矛盾——伪装得越干净，这一处越刺眼。
  //
  // ## 实现要点
  //
  // 1. **偏移必须按目标日期动态算**：目标时区有夏令时（London 冬 0 / 夏 -60）。
  //    用 fp.tzOffset（生成指纹那一刻的值）会把夏令时期间说错。
  //    故每次调用都按「该时刻在目标时区的实际偏移」重算。
  // 2. **时区名取自 Intl**：`Intl.DateTimeFormat(..., {timeZoneName:'long'})`
  //    在目标时区上给出的名字自带 DST 正确性（Greenwich Mean Time / British Summer Time）。
  // 3. **Date.prototype.toString 的格式**必须与 Chrome 一致：
  //    "Fri Nov 06 2026 08:51:16 GMT+0000 (Greenwich Mean Time)"
  //    即 `周 月 日 年 时:分:秒 GMT±HHMM (时区名)`。
  // 4. **toLocaleString 系列**同样按目标时区渲染（它们内部走宿主时区）。
  const TZ_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: fp.timezone,
    hour12: false,
    year: 'numeric',
    // 月份用 short（"Nov"）而不是 2-digit（"11"）：
    // Date.prototype.toString 的格式是 "Fri Nov 06 2026 ..."，
    // 月份必须是英文缩写名。数值月（day/hour 等）仍用 2-digit。
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  })
  const TZ_NAME_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: fp.timezone,
    timeZoneName: 'long'
  })
  /**
   * 取 Intl formatToParts 里的 weekday 文本。
   *
   * 注意：weekday 在 parts 里是**本地化字符串**（en-US 下形如 "Fri"），
   * 不是数字——按数字去数组里索引会拿到 undefined，
   * 于是 Date.toString() 变成 " Nov 06 2026 ..."（星期几凭空消失）。
   * 这类「看起来只是少个词」的破绽恰恰致命：真实 Chrome 一定有星期几。
   */
  const weekdayText = (parts: Intl.DateTimeFormatPart[]): string => {
    const p = parts.find((x) => x.type === 'weekday')
    return p ? p.value : ''
  }

  /** 取 Intl formatToParts 里的月份文本（同样是本地化字符串，如 "Nov"） */
  const monthText = (parts: Intl.DateTimeFormatPart[]): string => {
    const p = parts.find((x) => x.type === 'month')
    return p ? p.value : ''
  }

  /**
   * 数值化的时区部件（month 为数字）。
   *
   * 与 TZ_PARTS_FMT 分开是因为两者的 month 形态不同：
   * toString 需要英文缩写（"Nov"），而算偏移需要数字（11）。
   * 一个格式化器只能给一种形态，故分两个。
   */
  const TZ_NUM_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: fp.timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  /**
   * 目标时区在该时刻的实际偏移（分钟，UTC−本地，JS 语义）
   *
   * 由 targetOffsetAt 填充给 getTimezoneOffset 使用——
   * 后者必须与 toString 显示的偏移、DST 状态三者一致，
   * 所以两者必须走**同一个**计算函数，不能各算各的。
   */
  const targetOffsetAt = (date: Date): number => {
    try {
      const parts = TZ_NUM_FMT.formatToParts(date)
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
      // hour 可能是 "24"（午夜），需归一到 0
      const asUTC = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour') % 24,
        get('minute'),
        get('second')
      )
      // asUTC 是「目标时区墙上时间」当成 UTC 得到的毫秒数；
      // 真实 UTC 毫秒减去它，就是 UTC−本地 的偏移分钟数（取整到分钟）。
      return Math.round((date.getTime() - asUTC) / 60000)
    } catch {
      return fp.tzOffset
    }
  }
  // 回填：让 getTimezoneOffset 与 toString 用同一套偏移计算（含 DST）
  tzOffsetAt = targetOffsetAt

  /** 目标时区在该时刻的显示名（自带 DST 正确性） */
  const targetTzName = (date: Date): string => {
    try {
      const p = TZ_NAME_FMT.formatToParts(date).find((x) => x.type === 'timeZoneName')
      return p ? p.value : ''
    } catch {
      return ''
    }
  }

  const realToString = Date.prototype.toString
  Date.prototype.toString = patchNative(function (this: any) {
    try {
      const d = this instanceof Date ? this : new Date(Number(this))
      if (Number.isNaN(d.getTime())) return realToString.call(this)
      const parts = TZ_PARTS_FMT.formatToParts(d)
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
      const wd = weekdayText(parts)
      const mo = monthText(parts)
      const day = String(get('day')).padStart(2, '0')
      const hh = String(get('hour') % 24).padStart(2, '0')
      const mi = String(get('minute')).padStart(2, '0')
      const ss = String(get('second')).padStart(2, '0')
      const off = targetOffsetAt(d)
      const name = targetTzName(d)
      // 真实 Chrome 的 toString 形如：
      //   "Fri Nov 06 2026 08:51:16 GMT+0000 (Greenwich Mean Time)"
      // 注意 GMT 偏移是 4 位无冒号（Date.toString 用 "GMT+0000"，
      // 而 Intl 风格带冒号——这里必须跟 Chrome 一致，否则格式本身就是破绽）
      const sign = off > 0 ? '-' : '+'
      const abs = Math.abs(off)
      const rawOff = `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
      return `${wd} ${mo} ${day} ${get('year')} ${hh}:${mi}:${ss} ${rawOff}${name ? ` (${name})` : ''}`
    } catch {
      return realToString.call(this)
    }
  }, 'toString')

  // toDateString / toTimeString：Chrome 里它们也按本地时区渲染，同样要改。
  const realToDateString = Date.prototype.toDateString
  Date.prototype.toDateString = patchNative(function (this: any) {
    try {
      const d = this instanceof Date ? this : new Date(Number(this))
      if (Number.isNaN(d.getTime())) return realToDateString.call(this)
      const parts = TZ_PARTS_FMT.formatToParts(d)
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
      const wd = weekdayText(parts)
      const mo = monthText(parts)
      const day = String(get('day')).padStart(2, '0')
      return `${wd} ${mo} ${day} ${get('year')}`
    } catch {
      return realToDateString.call(this)
    }
  }, 'toDateString')

  const realToTimeString = Date.prototype.toTimeString
  Date.prototype.toTimeString = patchNative(function (this: any) {
    try {
      const d = this instanceof Date ? this : new Date(Number(this))
      if (Number.isNaN(d.getTime())) return realToTimeString.call(this)
      const parts = TZ_PARTS_FMT.formatToParts(d)
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
      const hh = String(get('hour') % 24).padStart(2, '0')
      const mi = String(get('minute')).padStart(2, '0')
      const ss = String(get('second')).padStart(2, '0')
      const off = targetOffsetAt(d)
      const name = targetTzName(d)
      const sign = off > 0 ? '-' : '+'
      const abs = Math.abs(off)
      const rawOff = `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
      return `${hh}:${mi}:${ss} ${rawOff}${name ? ` (${name})` : ''}`
    } catch {
      return realToTimeString.call(this)
    }
  }, 'toTimeString')

  // toLocaleString 系列：内部走宿主时区，同样要按目标时区渲染。
  // 做法是给 Intl 补上 timeZone 选项后再委托回去——不能直接改 Intl 构造器
  // （那会影响页面自己的 Intl 调用），故只在这几个 Date 方法上做定向委托。
  const LOCALE_TZ_METHODS = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const
  for (const m of LOCALE_TZ_METHODS) {
    const orig = Date.prototype[m] as any
    if (typeof orig !== 'function') continue
    Date.prototype[m] = patchNative(function (this: any, ...args: any[]) {
      try {
        const d = this instanceof Date ? this : new Date(Number(this))
        if (Number.isNaN(d.getTime())) return orig.apply(this, args)
        // 页面若自己传了 locales / options，就只补 timeZone，不动其余语义。
        const opt = args[1] && typeof args[1] === 'object' ? { ...args[1] } : {}
        if (!opt.timeZone) opt.timeZone = fp.timezone
        return orig.call(d, args[0], opt)
      } catch {
        return orig.apply(this, args)
      }
    }, m)
  }

  markPatched('timezone')

  // ===== Intl 默认 locale 与语言自洽 =====
  //
  // ## 问题
  //
  // navigator.languages 被伪装成 ['en-GB','en']，但 Intl 的默认 locale 来自
  // **操作系统语言**（宿主是中文系统就是 zh-CN），与前者无关。
  // 实测：Intl.DateTimeFormat().resolvedOptions().locale → 'zh-CN'，
  // 而 navigator.language → 'en-GB'。检测站把这两个一比就知道语言维度是拼的。
  //
  // ## 为什么只代理 DateTimeFormat
  //
  // Intl 下有 6 个构造器（DateTimeFormat / NumberFormat / Collator /
  // RelativeTimeFormat / ListFormat / Segmenter），它们的默认 locale 都来自系统。
  // 但**检测站实际会读 locale 的只有 DateTimeFormat**（其余的
  // resolvedOptions().locale 极少被采集）。
  // 全改会扩大风险面（要处理每个构造器的 arguments 形态、静态方法
  // supportedLocalesOf 等），收益却不匹配——故只处理 DateTimeFormat，
  // 其余保持原生。
  //
  // ## 为什么要包一层而不是直接改 prototype
  //
  // 改 prototype.resolvedOptions 只能改「读出来的那一项」，
  // 改不了构造器内部实际使用的 locale（格式化结果的语言仍会是宿主语言）。
  // 包一层构造器，在**未显式传 locales** 时注入目标语言，才是真正自洽。
  // 包装函数保持 prototype 引用不变（Intl.DateTimeFormat.prototype 仍是同一个对象），
  // 并走 patchNative 登记，避免 toString 测谎穿帮。
  {
    const targetLocale = fp.languages[0]
    if (targetLocale) {
      try {
        const OrigDTF = Intl.DateTimeFormat
        const WrappedDTF = patchNative(function (this: any, locales?: any, options?: any) {
          // 原生构造器必须用 new 调用，缺 new 会抛 TypeError。
          // 包装后若不还原这个行为，检测站一句
          // `Intl.DateTimeFormat()` 就能发现「这个构造器被换过」。
          if (!new.target) {
            throw new TypeError("Constructor Intl.DateTimeFormat requires 'new'")
          }
          // 页面显式传了 locales 就尊重页面的选择（那是页面自己的业务语义）
          const loc = locales === undefined ? targetLocale : locales
          return new (OrigDTF as any)(loc, options)
        }, 'DateTimeFormat') as any
        // prototype 必须与原构造器一致：否则 Intl.DateTimeFormat.prototype.resolvedOptions
        // 这个补丁会挂到一个页面看不到的对象上（页面拿到的是包装函数的 prototype）。
        WrappedDTF.prototype = OrigDTF.prototype
        try {
          Object.defineProperty(WrappedDTF, 'name', { value: 'DateTimeFormat', configurable: true })
          // 原生长度是 0（参数走 arguments），包装函数默认是 2，一并对齐。
          Object.defineProperty(WrappedDTF, 'length', { value: 0, configurable: true })
        } catch {
          /* ignore */
        }
        // 静态方法必须一并搬过来：Intl.DateTimeFormat.supportedLocalesOf 是标准 API，
        // 丢了它，页面或检测站一调用就是 TypeError——「浏览器坏了」本身就是破绽。
        // 这里也走 patchNative，否则它的 toString 会暴露绑定后的源码。
        try {
          const slo = (OrigDTF as any).supportedLocalesOf
          if (typeof slo === 'function') {
            Object.defineProperty(WrappedDTF, 'supportedLocalesOf', {
              value: patchNative(slo.bind(OrigDTF), 'supportedLocalesOf'),
              configurable: true,
              writable: true
            })
          }
        } catch {
          /* ignore */
        }
        ;(Intl as any).DateTimeFormat = WrappedDTF
      } catch {
        /* ignore */
      }
    }
  }

  // ===== 地理位置（navigator.geolocation）=====
  // 必须与时区自洽：页面拿到坐标后会与时区 / 语言交叉验证，
  // 「东京时区 + 纽约坐标」这种矛盾比干脆不伪装更可疑。
  // 做法上整体替换 geolocation 对象而不是只改方法——原生实现会走 Chromium 的
  // 定位权限流程（弹窗 / 被拒），替换后直接回灌指纹坐标，不再触发权限。
  const geoLat = typeof fp.geoLatitude === 'number' ? fp.geoLatitude : 40.7128
  const geoLon = typeof fp.geoLongitude === 'number' ? fp.geoLongitude : -74.006
  const geoAcc = typeof fp.geoAccuracy === 'number' ? fp.geoAccuracy : 50
  // 原生 Position / Coordinates 的属性是原型上的只读 getter，这里用普通对象冒充：
  // 页面只读 latitude / longitude / accuracy 等字段，不会做 instanceof 校验。
  const makePosition = (): any => ({
    coords: {
      latitude: geoLat,
      longitude: geoLon,
      altitude: null,
      accuracy: geoAcc,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    },
    timestamp: Date.now()
  })
  try {
    let geoWatchId = 1
    const geoTimers = new Map<number, ReturnType<typeof setInterval>>()
    const geolocation: any = {
      // 异步回调，贴近真实定位的耗时表现（同步回调会被部分站点判定为可疑）
      //
      // 三个方法都必须走 patchNative：它们是**整体替换** geolocation 对象带来的
      // 新函数，不在 def / defProto / delProto 那一族的自动登记范围内。
      // 裸箭头函数的 toString 会暴露源码，检测站一测谎就判定浏览器被改过
      // （与 2026-10-25 browserscan 事故同根因，只是当时漏了这一族）。
      getCurrentPosition: patchNative(
        (success?: (p: unknown) => void, _error?: (e: unknown) => void) => {
          if (typeof success === 'function') setTimeout(() => success(makePosition()), 10)
        },
        'getCurrentPosition'
      ),
      watchPosition: patchNative(
        (success?: (p: unknown) => void) => {
          const id = geoWatchId++
          if (typeof success === 'function') {
            setTimeout(() => success(makePosition()), 10)
            geoTimers.set(
              id,
              setInterval(() => success(makePosition()), 30000)
            )
          }
          return id
        },
        'watchPosition'
      ),
      clearWatch: patchNative(
        (id?: number) => {
          if (typeof id !== 'number') return
          const t = geoTimers.get(id)
          if (t) {
            clearInterval(t)
            geoTimers.delete(id)
          }
        },
        'clearWatch'
      )
    }
    // 改原型上的 getter：实例级遮蔽会被
    // Object.getOwnPropertyDescriptor(Navigator.prototype,'geolocation').get.call(navigator)
    // 绕过，拿回宿主真身（会触发真实定位权限流程，直接露馅）。
    defProto(NavProto, 'geolocation', geolocation)
  } catch {
    /* ignore */
  }

  // ===== Battery Status API（navigator.getBattery）=====
  // 真实桌面 Chrome 仍暴露该 API，且 CreepJS 等检测站会采集 battery 维度
  // （charging / level）。完全不定义会与「真实 Chrome 有该 API」矛盾，但返回宿主机
  // 真实电池又是独立指纹。这里按 seed 派生一个**稳定且自洽**的状态：未满则充电中、
  // chargingTime 为正数；满电则不充电、dischargingTime=Infinity。仅在宿主本身有该 API
  // 时才覆写——若宿主已移除（部分环境），绝不凭空新增（避免制造非默认信号）。
  try {
    if (typeof (navigator as any).getBattery === 'function') {
      const batLevel = 0.5 + ((seed % 1000) / 1000) * 0.5 // 0.5~1.0，按环境稳定
      const batCharging = batLevel >= 0.999
      const batManager: any = Object.assign(new EventTarget(), {
        level: batLevel,
        charging: batCharging,
        chargingTime: batCharging ? 0 : Math.round((1 - batLevel) * 7200),
        dischargingTime: batCharging ? 0 : Infinity
      })
      // getBattery 在 Navigator.prototype 上是**数据属性**（不是 accessor），
      // 故这里直接覆写原型上的函数值；函数本身必须走 patchNative，否则
      // navigator.getBattery.toString() 会露出补丁源码。
      const patchedGetBattery = patchNative(() => Promise.resolve(batManager), 'getBattery')
      try {
        Object.defineProperty(NavProto, 'getBattery', {
          value: patchedGetBattery,
          configurable: true,
          enumerable: true,
          writable: true
        })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  // ===== navigator.plugins / mimeTypes =====
  // 真实 Chrome 至少带一个 PDF 插件（navigator.plugins.length >= 1），而 Electron 默认
  // 暴露为空——「plugins 为空」是明显的自动化信号。这里按 Chrome 默认形态补一套最小但
  // 结构正确的 Plugin / PluginArray / MimeType / MimeTypeArray，并设置对应原型使
  // instanceof / toString 与真实 Chrome 一致；多余内部槽位用自有方法兜底。
  try {
    if (navigator.plugins) {
      const PluginArrayProto = (window as any).PluginArray?.prototype
      const MimeTypeArrayProto = (window as any).MimeTypeArray?.prototype
      const PluginProto = (window as any).Plugin?.prototype
      const MimeTypeProto = (window as any).MimeType?.prototype
      const pdfMime: any = { type: 'application/pdf', description: 'Portable Document Format', suffixes: 'pdf' }
      const pdfPlugin: any = { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 }
      const mimeObj: any = { ...pdfMime }
      if (MimeTypeProto) Object.setPrototypeOf(mimeObj, MimeTypeProto)
      const pluginObj: any = { ...pdfPlugin, mimeTypes: [] as any[] }
      if (PluginProto) Object.setPrototypeOf(pluginObj, PluginProto)
      mimeObj.enabledPlugin = pluginObj
      pluginObj.mimeTypes = [mimeObj]
      pluginObj.item = patchNative((i: number) => (i === 0 ? mimeObj : null), 'item')
      pluginObj.namedItem = patchNative((n: string) => (n === 'application/pdf' ? mimeObj : null), 'namedItem')
      const mimeArr: any = { length: 1 }
      Object.defineProperty(mimeArr, 0, {
        get: patchNative(() => mimeObj, 'get 0'), enumerable: false, configurable: true
      })
      mimeArr.item = patchNative((i: number) => (i === 0 ? mimeObj : null), 'item')
      mimeArr.namedItem = patchNative((n: string) => (n === 'application/pdf' ? mimeObj : null), 'namedItem')
      Object.defineProperty(mimeArr, Symbol.iterator, {
        value: patchNative(function* () { yield mimeObj }, 'values'), enumerable: false, configurable: true
      })
      if (MimeTypeArrayProto) Object.setPrototypeOf(mimeArr, MimeTypeArrayProto)
      const pluginArr: any = { length: 1 }
      Object.defineProperty(pluginArr, 0, {
        get: patchNative(() => pluginObj, 'get 0'), enumerable: false, configurable: true
      })
      pluginArr.item = patchNative((i: number) => (i === 0 ? pluginObj : null), 'item')
      pluginArr.namedItem = patchNative((n: string) => (n === 'Chrome PDF Plugin' ? pluginObj : null), 'namedItem')
      Object.defineProperty(pluginArr, Symbol.iterator, {
        value: patchNative(function* () { yield pluginObj }, 'values'), enumerable: false, configurable: true
      })
      if (PluginArrayProto) Object.setPrototypeOf(pluginArr, PluginArrayProto)
      // 改原型而非实例：实例遮蔽会被 getter 绕过手法打回原形（宿主 plugins 为空）。
      defProto(NavProto, 'plugins', pluginArr)
      defProto(NavProto, 'mimeTypes', mimeArr)
    }
  } catch {
    /* ignore */
  }

  // ===== SpeechSynthesis 语音列表对齐 =====
  // getVoices() 返回的 TTS 语音反映宿主机已安装语言；若与 fp.languages 不符，会泄漏真实
  // 系统语言（如中文系统却声称 en-US）。过滤为仅保留与 fp.languages 匹配的语音，让「语言」
  // 这一维度自洽。宿主无该 API 时不处理。
  try {
    const ss = (window as any).speechSynthesis
    if (ss && typeof ss.getVoices === 'function') {
      const orig = ss.getVoices.bind(ss)
      // SpeechSynthesis.prototype.getVoices 是**数据属性**（实测 data/conf=true），
      // 故直接覆写原型上的函数值。函数本身走 patchNative：
      // 裸箭头函数的 toString 会暴露补丁源码，检测站一测谎就穿帮。
      const patchedGetVoices = patchNative(
        () => {
          const all = orig()
          const matched = all.filter((v: any) =>
            fp.languages.some((l: string) => v.lang && v.lang.toLowerCase().startsWith(l.split('-')[0].toLowerCase()))
          )
          return matched.length ? matched : all
        },
        'getVoices'
      )
      try {
        const ssProto = Object.getPrototypeOf(ss)
        Object.defineProperty(ssProto, 'getVoices', {
          value: patchedGetVoices,
          configurable: true,
          enumerable: true,
          writable: true
        })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  // ===== Canvas 噪声（幂等烘焙 + 全读路径一致）=====
  // 架构（2026-10-25 重构，动因：browserscan 检测百分百无法通过）：
  //
  // 旧实现在「读取时」叠加噪声，且 toDataURL 与 getImageData 用**两套互不相干**的
  // 扰动机制（前者 alpha 混色 2 像素、后者 2% 像素 ±1），OffscreenCanvas 完全没覆盖。
  // browserscan 的三个一致性检查因此全部挂：
  //   e0  图像回环：toDataURL 输出解码后画到另一块画布读回，与直读原画布逐像素比对
  //       —— 两套噪声让回环结果必然不一致（且 e0 与 Q 同时失败即硬判「伪造」）；
  //   Q   OffscreenCanvas.convertToBlob 与 HTMLCanvas.toDataURL 同图案输出必须逐字节一致
  //       —— OffscreenCanvas 未打补丁，一路干净一路带噪；
  //   n0  文字渲染测谎：把上述不一致的像素 diff 上报服务端裁决。
  //
  // 新架构把噪声下沉到「画布后备存储」，三个性质同时成立：
  //   1) 幂等：applyIdempotentNoise 是投影变换（N(N(x))===N(x)），回环几遍读取都一致；
  //   2) 全读路径同源：toDataURL / toBlob / getImageData（HTML 与 Offscreen 两套上下文）/
  //      convertToBlob / transferToImageBitmap / createImageBitmap 全部先烘焙再读，
  //      任何路径拿到的是同一份噪声像素；
  //   3) 确定性：噪声只由 (环境种子, 宽, 高) 派生，与画布身份、读取次数无关，
  //      双绘一致性（s0/x0）天然成立。
  // 实测前提（Electron 45 / Chromium）：getImageData→putImageData 往返无损（0 差异），
  // toDataURL 与 convertToBlob 对相同像素输出逐字节相同——见 .tmp_probe 基线探针。
  if (fp.canvasNoise) {
    const effSeed = effectiveCanvasSeed(seed, fp.webglVendor || fp.os || 'roxy')

    // 脏标记：绘制操作改过内容的画布才需要重新烘焙（读路径幂等，重复烘焙无害但省掉是白赚）
    const dirtyCanvases = new WeakSet<object>()
    const markDirty = (c: any) => {
      if (c && typeof c === 'object') dirtyCanvases.add(c)
    }

    // 两套上下文的原始读/写（必须在任何补丁之前捕获）
    const origCtxGetImageData = CanvasRenderingContext2D.prototype.getImageData
    const origCtxPutImageData = CanvasRenderingContext2D.prototype.putImageData
    const OffCtx: any = typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D : null
    const origOffGetImageData = OffCtx ? OffCtx.prototype.getImageData : null
    const origOffPutImageData = OffCtx ? OffCtx.prototype.putImageData : null

    // 烘焙：把幂等噪声写进画布后备存储。
    // 只被「已知持有 2d 上下文」的路径调用（绘制补丁标记过 = 一定有 2d 上下文），
    // 因此这里的 getContext('2d') 只会取回现有上下文，不会凭空创建。
    const bakeCanvas = (canvas: any) => {
      const w = canvas.width | 0
      const h = canvas.height | 0
      if (!(w > 0 && h > 0) || isTinyCanvas(w, h)) {
        // 极小画布（参考探针常用 1×N 纯色条）不注入噪声：对纯色 1px 条扰动会立即被
        // 「反篡改」探针识别，且极小画布本就不是指纹采集对象。
        dirtyCanvases.delete(canvas)
        return
      }
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const isOff = typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas
        const og = isOff ? origOffGetImageData : origCtxGetImageData
        const op = isOff ? origOffPutImageData : origCtxPutImageData
        if (!og || !op) return
        const img = og.call(ctx, 0, 0, w, h)
        applyIdempotentNoise(img.data, effSeed, w, h)
        op.call(ctx, img, 0, 0)
      } catch {
        /* 跨域污染的画布读不了像素：放弃噪声，读路径会自然抛出同样的错 */
      }
      dirtyCanvases.delete(canvas)
    }
    const bakeIfDirty = (canvas: any) => {
      if (canvas && typeof canvas === 'object' && dirtyCanvases.has(canvas)) bakeCanvas(canvas)
    }

    // 绘制操作 → 标记脏。fill/stroke 系列改像素，drawImage/putImageData 直接写像素。
    const DRAW_METHODS = ['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData']
    const patchDrawMark = (proto: any) => {
      if (!proto) return
      for (const m of DRAW_METHODS) {
        const orig = proto[m]
        if (typeof orig !== 'function') continue
        proto[m] = patchNative(function (this: any, ...args: any[]) {
          try {
            markDirty(this && this.canvas)
          } catch {
            /* ignore */
          }
          return orig.apply(this, args)
        }, m)
      }
    }
    patchDrawMark(CanvasRenderingContext2D.prototype)
    if (OffCtx) patchDrawMark(OffCtx.prototype)

    // 编码路径（toDataURL / toBlob）：优先直接烘焙本体（省一次整画布拷贝），
    // 上下文类型未知（可能是 WebGL）或从未绘制时走拷贝路径——绝不碰本体的 getContext，
    // 避免给「之后想拿 webgl 上下文」的画布凭空创建 2d 上下文（同画布混用上下文类型
    // 会让后一个 getContext 返回 null，直接搞坏站点）。
    const encodeCanvas = (canvas: any, encode: (c: any) => any): any => {
      const w = canvas.width | 0
      const h = canvas.height | 0
      if (!(w > 0 && h > 0) || isTinyCanvas(w, h)) return encode(canvas)
      if (dirtyCanvases.has(canvas)) {
        try {
          bakeCanvas(canvas)
          return encode(canvas)
        } catch {
          /* fall through to copy path */
        }
      }
      try {
        const copy = document.createElement('canvas')
        copy.width = w
        copy.height = h
        const cx = copy.getContext('2d')
        if (cx) {
          cx.drawImage(canvas, 0, 0)
          markDirty(copy)
          bakeCanvas(copy)
          return encode(copy)
        }
      } catch {
        /* ignore */
      }
      return encode(canvas)
    }

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = patchNative(function (this: any, ...args: any[]) {
      return encodeCanvas(this, (c) => origToDataURL.apply(c, args as [string?, number?]))
    }, 'toDataURL')

    const origToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = patchNative(function (this: any, cb: any, ...args: any[]) {
      return encodeCanvas(this, (c) => origToBlob.call(c, cb, ...args))
    }, 'toBlob')

    const origGetImageDataPatch = origCtxGetImageData
    CanvasRenderingContext2D.prototype.getImageData = patchNative(function (this: any, ...args: any[]) {
      try {
        bakeIfDirty(this && this.canvas)
      } catch {
        /* ignore */
      }
      return origGetImageDataPatch.apply(this, args as [number, number, number, number])
    }, 'getImageData')

    if (OffCtx && origOffGetImageData) {
      OffCtx.prototype.getImageData = patchNative(function (this: any, ...args: any[]) {
        try {
          bakeIfDirty(this && this.canvas)
        } catch {
          /* ignore */
        }
        return origOffGetImageData.apply(this, args as [number, number, number, number])
      }, 'getImageData')
    }

    // OffscreenCanvas 的读出路径：convertToBlob / transferToImageBitmap
    if (typeof OffscreenCanvas !== 'undefined') {
      const origConvertToBlob = (OffscreenCanvas.prototype as any).convertToBlob
      if (typeof origConvertToBlob === 'function') {
        ;(OffscreenCanvas.prototype as any).convertToBlob = patchNative(function (this: any, ...args: any[]) {
          try {
            bakeIfDirty(this)
          } catch {
            /* ignore */
          }
          return origConvertToBlob.apply(this, args)
        }, 'convertToBlob')
      }
      const origTransfer = (OffscreenCanvas.prototype as any).transferToImageBitmap
      if (typeof origTransfer === 'function') {
        ;(OffscreenCanvas.prototype as any).transferToImageBitmap = patchNative(function (this: any, ...args: any[]) {
          try {
            bakeIfDirty(this)
          } catch {
            /* ignore */
          }
          return origTransfer.apply(this, args)
        }, 'transferToImageBitmap')
      }
    }

    // createImageBitmap(canvas) 也是读路径：先烘焙再取位图，保证与 getImageData 一致
    const origCreateImageBitmap = (window as any).createImageBitmap
    if (typeof origCreateImageBitmap === 'function') {
      ;(window as any).createImageBitmap = patchNative(function (this: any, ...args: any[]) {
        try {
          const src = args[0]
          if (src && typeof src === 'object' && typeof (src as any).getContext === 'function') {
            bakeIfDirty(src)
          }
        } catch {
          /* ignore */
        }
        return origCreateImageBitmap.apply(this, args)
      }, 'createImageBitmap')
    }
    markPatched('canvas')
  }

  // ===== WebGL =====
  const patchGetParam = (proto: any) => {
    const orig = proto.getParameter
    proto.getParameter = patchNative(function (this: any, param: number) {
      // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
      if (param === 37445) return fp.webglVendor
      if (param === 37446) return fp.webglRenderer
      return orig.call(this, param)
    }, 'getParameter')
    const origGetExt = proto.getExtension
    proto.getExtension = patchNative(function (this: any, name: string) {
      const ext = origGetExt.call(this, name)
      if (name === 'WEBGL_debug_renderer_info') return ext || {}
      return ext
    }, 'getExtension')
  }
  if (typeof WebGLRenderingContext !== 'undefined') patchGetParam(WebGLRenderingContext.prototype)
  if (typeof WebGL2RenderingContext !== 'undefined') patchGetParam(WebGL2RenderingContext.prototype)
  markPatched('webgl')

  // ===== EME / Widevine（DRM 模块伪装 + 能力检测，对标 RoxyChrome 152「加密媒体能力检测」）=====
  // 检测站（BrowserLeaks / CreepJS）用 navigator.requestMediaKeySystemAccess 探测已装 DRM 模块与能力。
  // Chrome/Edge 原生支持 com.widevine.alpha 与 org.w3.clearkey；PlayReady 是 Edge/IE 专有、
  // FairPlay 是 Safari 专有——Chrome 原生就不支持，交给 origRmkSA 自然 reject，绝不伪造出 Chrome 不该有的信号。
  // iOS Safari 根本没有 EME（走 webkit 前缀的 FairPlay），伪装成 iOS 时必须整体隐藏该 API，
  // 否则「iOS UA 却报出 Widevine」是矛盾的暴露信号。
  // 仅在宿主原生有该 API 时才覆写（不凭空新增非默认信号，与第 22 条同源）。
  {
    const origRmkSA: any =
      typeof (navigator as any).requestMediaKeySystemAccess === 'function'
        ? (navigator as any).requestMediaKeySystemAccess.bind(navigator)
        : null
    if (origRmkSA) {
      if (fp.os === 'ios') {
        delProto(NavProto, 'requestMediaKeySystemAccess')
      } else {
        // 真实 Chrome + Widevine 报出的能力集：initDataTypes 支持 cenc 与 cbcs，
        // 视频覆盖 avc/hevc/vp9/av1（含多档 robustness），音频覆盖 aac/opus/flac。
        // 我们的环境没有真实 CDM，无法委托原生协商，故手工构造一份与真实 Widevine 一致的配置返回，
        // 让检测站能看到「CENC / CBCS 格式兼容性」，避免「只能 resolve 却拿不到真实能力列表」的破绽。
        const WIDEVINE_PROFILE: any = {
          initDataTypes: ['cenc', 'cbcs'],
          videoCapabilities: [
            { contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'SW_SECURE_CRYPTO' },
            { contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'SW_SECURE_DECODE' },
            { contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'HW_SECURE_CRYPTO' },
            { contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'HW_SECURE_DECODE' },
            { contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'HW_SECURE_ALL' },
            { contentType: 'video/mp4; codecs="avc3.640028"' },
            { contentType: 'video/webm; codecs="vp9"' },
            { contentType: 'video/mp4; codecs="hev1.1.6.L93.B0"' },
            { contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
            { contentType: 'video/mp4; codecs="av01.0.08M.08"' }
          ],
          audioCapabilities: [
            { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' },
            { contentType: 'audio/webm; codecs="opus"' },
            { contentType: 'audio/flac' }
          ],
          distinctiveIdentifier: 'optional',
          persistentState: 'optional'
        }
        // 真实协商：浏览器在传入候选里挑第一个可用的，getConfiguration() 回返该配置（可能补 robustness）。
        // 我们没有真实 CDM 无法逐项校验，按「Widevine 已知支持集」做最小合规筛选后回显，命中即返回，否则回退全量能力集。
        const negotiateEmeConfig = (requested: any[] | undefined): any => {
          if (Array.isArray(requested)) {
            for (const cfg of requested) {
              if (!cfg || typeof cfg !== 'object') continue
              const idt = (cfg as any).initDataTypes
              const ok = !idt || (Array.isArray(idt) && (idt as any[]).every((t: any) => t === 'cenc' || t === 'cbcs'))
              if (!ok) continue
              const norm: any = { ...(cfg as any) }
              if (!norm.initDataTypes) norm.initDataTypes = ['cenc', 'cbcs']
              return norm
            }
          }
          return WIDEVINE_PROFILE
        }
        const fakeAccess = (keySystem: string, requested?: any[]) => ({
          keySystem,
          getConfiguration: () => negotiateEmeConfig(requested),
          createMediaKeys: () => Promise.resolve({})
        })
        const wrapped = patchNative((keySystem: string, ...rest: any[]) => {
          if (keySystem === 'com.widevine.alpha' || keySystem === 'org.w3.clearkey') {
            // 第二个参数为候选配置数组（可空）
            const req = rest[0]
            return Promise.resolve(fakeAccess(keySystem, Array.isArray(req) ? req : undefined))
          }
          return origRmkSA(keySystem, ...rest)
        }, 'requestMediaKeySystemAccess')
        // 改原型（Navigator.prototype 上确实有这个属性，实测是**方法**/数据属性）。
        //
        // 这里必须保持「数据属性」形态：原生它是 method（值是函数），
        // 若用 defProto 把它改成访问器（getter 返回函数），
        // 检测站读 Object.getOwnPropertyDescriptor(Navigator.prototype,
        // 'requestMediaKeySystemAccess').get 就会发现「原生没有 getter，这里有」——
        // 形态本身就是破绽。故直接覆写原型上的函数值。
        try {
          Object.defineProperty(NavProto, 'requestMediaKeySystemAccess', {
            value: wrapped,
            configurable: true,
            enumerable: true,
            writable: true
          })
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ===== HTTP 安全警告（对标 RoxyChrome 154 的 HTTP Security Warnings）=====
  // 环境窗口导航到明文 http:// 站点时，在页面顶部注入红色警告条，提示连接未加密、存在被窃听 / 篡改风险。
  // localhost / 127.0.0.1 / file:// 不触发（本地调试与 App 自身页面）。
  // 仅当宿主原生有 document 时才注入（不凭空新增非默认信号，与第 22 条同源）。
  if (fp.httpWarning && typeof document !== 'undefined') {
    const isExcluded = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
    const showBanner = () => {
      try {
        const existing = document.getElementById('__roxy_http_warn')
        if (location.protocol !== 'http:' || isExcluded(location.hostname)) {
          if (existing) existing.remove()
          if (document.body) document.body.style.paddingTop = ''
          return
        }
        if (existing) return
        const bar = document.createElement('div')
        bar.id = '__roxy_http_warn'
        bar.textContent = '⚠ 此页面使用 HTTP 明文传输，存在被窃听 / 篡改风险，请勿在此输入账号、密码等敏感信息'
        bar.setAttribute(
          'style',
          'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b3261e;color:#fff;font:13px/1.6 system-ui,-apple-system,sans-serif;padding:6px 12px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35)'
        )
        if (document.body) {
          document.body.style.paddingTop = '32px'
          document.body.prepend(bar)
        } else if (document.documentElement) {
          document.documentElement.appendChild(bar)
        }
      } catch (e) {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showBanner)
    } else {
      showBanner()
    }
    // SPA 路由变化（pushState/popstate/hashchange）后重新评估
    window.addEventListener('popstate', showBanner)
    window.addEventListener('hashchange', showBanner)
    // 点击指向 http:// 的链接时，确保警告条就位（多数情况已随页面加载出现）
    document.addEventListener('click', (e: any) => {
      try {
        const a = e.target && e.target.closest ? e.target.closest('a') : null
        if (a && a.protocol === 'http:') setTimeout(showBanner, 0)
      } catch (e2) {}
    })
  }

  // ===== WebGPU =====
  // 真实 Chrome 经 navigator.gpu.requestAdapter() 暴露 GPUAdapterInfo（vendor / architecture），
  // creepjs / pixelscan 等检测站已普遍采集。这里让它与上面伪造的 WebGL 保持一致，
  // 否则「WebGL 说 RTX 4090、WebGPU 说宿主机集显」是自相矛盾信号——矛盾比不伪装更可疑。
  if (!webGpuSupported(fp.os)) {
    // iOS WebKit 至今不支持 WebGPU，伪装成 iOS 时必须整体移除（与 UA-CH 在 iOS 下的处理同理）
    delProto(NavProto, 'gpu')
  } else if (typeof (navigator as any).gpu !== 'undefined') {
    const gpuInfo = webGpuInfoFor(fp.os, fp.webglVendor, fp.webglRenderer)
    const gpu = (navigator as any).gpu
    // 补丁打到 GPU.prototype 而非 navigator.gpu 实例：真实 navigator.gpu 没有任何
    // own property，在实例上挂 requestAdapter 会留下可检测痕迹
    // （Object.getOwnPropertyNames(navigator.gpu) 由 [] 变成 ['requestAdapter']）。
    const gpuProto = (window as any).GPU ? (window as any).GPU.prototype : Object.getPrototypeOf(gpu)
    const origReq = gpuProto ? gpuProto.requestAdapter : gpu.requestAdapter
    if (typeof origReq === 'function') {
      const patchedReq = async function (this: any, ...args: any[]) {
        const adapter = await origReq.apply(this, args)
        // 真实不可用（无 GPU / 被禁用）时保持返回 null：那是真实用户也存在的分布，不应强行伪造；
        // 且 isFallbackAdapter 为 true 时说明跑在 SwiftShader / llvmpipe 软件渲染上，
        // 此时硬伪造「离散独显」只会制造「WebGL 说独显、WebGPU 说软件渲染」的内部矛盾（见 webGpuSpoofAllowed）。
        if (!adapter) return adapter
        // 软件渲染回退（SwiftShader / llvmpipe）：isFallbackAdapter === true 时按 webGpuSpoofAllowed 不伪装，
        // 避免「WebGL 独显 / WebGPU 软件渲染」的内部矛盾暴露注入（规则 #22 不伪造原则）。
        if (!webGpuSpoofAllowed(!!adapter.isFallbackAdapter)) return adapter
        try {
          const real = adapter.info
          if (real) {
            // 改 **GPUAdapterInfo.prototype** 而非真实实例：
            // vendor / architecture 在 Chrome 里是原型上的访问器，
            // 实例级遮蔽会被
            // Object.getOwnPropertyDescriptor(GPUAdapterInfo.prototype,'vendor').get.call(real)
            // 绕过、拿回宿主真实显卡名。改原型同时也让实例保持零自有键
            // （实例级 cover 会给 getOwnPropertyNames(real) 添上两个键）。
            //
            // 这样 instanceof GPUAdapterInfo 依然成立，subgroupMinSize / subgroupMaxSize /
            // isFallbackAdapter 等其余字段继续由原生提供。
            // 早先塞一个自制普通对象的做法会让这些维度变成 undefined、且 instanceof 判 false，
            // 等于制造出「真实浏览器不可能出现的值」——比不伪装更可疑。
            const gaiProto = Object.getPrototypeOf(real)
            if (gaiProto) {
              defProto(gaiProto, 'vendor', gpuInfo.vendor)
              defProto(gaiProto, 'architecture', gpuInfo.architecture)
            }
          } else {
            def(adapter, 'info', gpuInfo)
          }
        } catch {
          /* ignore */
        }
        return adapter
      }
      if (gpuProto) def(gpuProto, 'requestAdapter', patchedReq)
      else gpu.requestAdapter = patchedReq
    }
  }

  // ===== WebAudio 指纹（完整特征向量 + 噪声） =====
  // 此前只给 AudioBuffer.getChannelData 加了噪声（1 个维度），而检测站更常采集
  // sampleRate / baseLatency / outputLatency / maxChannelCount / compressor.reduction——
  // 这些直接反映宿主机声卡与驱动特性，此前全部裸奔。
  if (fp.audioNoise) {
    const ap = audioProfileFor(seed, fp.os)
    // sampleRate 定义在 BaseAudioContext.prototype 上（**不是** AudioContext.prototype）。
    // 若直接 def(AudioContext.prototype, 'sampleRate')，会凭空多出一个 own property——
    // 真实 AudioContext.prototype 没有它，检测方用 getOwnPropertyNames 即可识别。
    // 这里在正确的原型上覆盖，并用 instanceof 放过 OfflineAudioContext：
    // 后者的采样率必须等于构造参数，改了会让渲染结果长度与预期不符（比不改更糟）。
    if (typeof BaseAudioContext !== 'undefined' && typeof OfflineAudioContext !== 'undefined') {
      const d = Object.getOwnPropertyDescriptor((BaseAudioContext as any).prototype, 'sampleRate')
      // 提前取出 getter 存为局部常量：直接在闭包里用 d.get 会因 narrowing 丢失而被判为可能 undefined
      const origGet = d && d.get
      if (d && origGet && d.configurable) {
        Object.defineProperty((BaseAudioContext as any).prototype, 'sampleRate', {
          get: patchNative(function (this: any) {
            return this instanceof OfflineAudioContext ? origGet.call(this) : ap.sampleRate
          }, 'get sampleRate'),
          configurable: true,
          enumerable: true
        })
      }
    }
    // baseLatency 本就是 AudioContext.prototype 的 own property，直接覆盖不会新增痕迹
    if (typeof AudioContext !== 'undefined') {
      def(AudioContext.prototype, 'baseLatency', ap.baseLatency)
    }
    if (typeof AudioDestinationNode !== 'undefined') {
      def(AudioDestinationNode.prototype, 'maxChannelCount', ap.maxChannelCount)
    }
    if (typeof DynamicsCompressorNode !== 'undefined') {
      def(DynamicsCompressorNode.prototype, 'reduction', ap.compressorReduction)
    }

    // 取样值微扰：让 OfflineAudioContext 渲染出的音频哈希带上本环境的确定性噪声。
    // 旧实现是「跨调用共享一个随调用推进的 rng + 叠加 ±5e-8」——getChannelData 返回的是
    // buffer 的**活视图**（原地修改），于是同一 buffer 读第二次会在第一次的基础上继续加，
    // 双读一致性检查直接暴露「被改过」；且不同 buffer 拿到同一条推进中的序列，互相撞车。
    // 新实现与 Canvas 同源：只把**选中位置**的浮点最低位清零（幂等投影，重复读取不再变化），
    // 位置由 (环境种子, 采样数) 派生——同环境同长度的 buffer 每次读取结果一致。
    // 不清零成另一个值而是清 LSB：保证 0 仍是 0（browserscan 的「全静音」探针据此判定
    // 音频栈是否真实存在，把静音样点改成非零等于伪造不该有的信号）。
    if (typeof AudioBuffer !== 'undefined') {
      const origGetChannelData = AudioBuffer.prototype.getChannelData
      AudioBuffer.prototype.getChannelData = patchNative(function (this: any, ...args: any[]) {
        const data = origGetChannelData.apply(this, args as [number])
        try {
          const len = data.length | 0
          if (len > 0) {
            const rng = mulberry32((seed ^ 0x5e6f7a8b ^ Math.imul(len, 19349663)) >>> 0)
            const u32 = new Uint32Array(data.buffer, data.byteOffset, len)
            const count = Math.max(1, Math.floor(len / 5000))
            for (let i = 0; i < count; i++) {
              const idx = Math.floor(rng() * len)
              u32[idx] = u32[idx] & 0xfffffffe
            }
          }
        } catch {
          /* ignore */
        }
        return data
      }, 'getChannelData')
    }
    markPatched('audio')
  }

  // ===== WebRTC =====
  if (fp.webrtc === 'disable') {
    ;(window as any).RTCPeerConnection = undefined
    ;(window as any).webkitRTCPeerConnection = undefined
    if (navigator.mediaDevices) {
      // enumerateDevices 走 patchNative：裸箭头函数的 toString 会暴露补丁源码，
      // 检测站一测谎就判定浏览器被改过（与 2026-10-25 browserscan 事故同根因）。
      //
      // 改 MediaDevices.prototype 而非 navigator.mediaDevices 实例：
      // 实例级遮蔽会被
      // Object.getOwnPropertyDescriptor(MediaDevices.prototype,'enumerateDevices').get.call(...)
      // 绕过，拿回宿主的真实设备列表。enumerateDevices 在原型上是**数据属性**
      // （WebIDL 操作，非访问器），故直接覆写原型上的函数值。
      const patchedEnumerate = patchNative(() => Promise.resolve([]), 'enumerateDevices')
      try {
        const mdProto = Object.getPrototypeOf(navigator.mediaDevices)
        if (mdProto) {
          Object.defineProperty(mdProto, 'enumerateDevices', {
            value: patchedEnumerate,
            configurable: true,
            enumerable: true,
            writable: true
          })
        }
      } catch {
        /* ignore */
      }
    }
    markPatched('webrtc')
  } else if (fp.webrtc === 'proxy') {
    // 代理模式：保留 WebRTC 功能（站点仍需通话 / 数据通道），但强制 iceCandidatePolicy='public'，
    // 丢弃本地私有 IP 的 host 候选，只保留经环境代理出去的 srflx/relay 候选——
    // 外部看到的是代理公网 IP 而非宿主机局域网 IP，与代理身份自洽。
    // 不拦 enumerateDevices：媒体设备标签不涉及 IP 泄漏，保留原生行为更自然。
    const wrapRtc = (OrigCtor: any) => {
      if (!OrigCtor) return OrigCtor
      const W: any = function (this: any, config?: any, ...rest: any[]) {
        const cfg = Object.assign({}, config, { iceCandidatePolicy: 'public' })
        return Reflect.construct(OrigCtor, [cfg, ...rest])
      }
      // 让 new 出的实例 instanceof 仍成立（Reflect.construct 用的是真实构造器）
      W.prototype = OrigCtor.prototype
      return W
    }
    try {
      const Orig = (window as any).RTCPeerConnection
      if (Orig) {
        const W = wrapRtc(Orig)
        def(window, 'RTCPeerConnection', W)
        if ((window as any).webkitRTCPeerConnection) {
          def(window, 'webkitRTCPeerConnection', wrapRtc((window as any).webkitRTCPeerConnection))
        }
      }
    } catch {
      /* ignore */
    }
    markPatched('webrtc')
  }

  // ===== 字体指纹防护 =====
  // 真实浏览器通过 document.fonts.check / load 与 Canvas measureText 的字体宽度差异来枚举已安装字体，
  // 从而泄漏宿主机自身字体。这里把「已安装字体」收敛为伪造列表 fp.fonts：
  // 1) check / load 只对列表内字体（或通用族）返回可用；
  // 2) measureText 遇到列表外字体时把 family 回落到 sans-serif，使其宽度与基线一致，宽度对照法无法分辨「装了 / 没装」。
  const FALLBACK_FONTS = ['Arial', 'Arial Black', 'Courier New', 'Georgia', 'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Segoe UI', 'Tahoma', 'Microsoft YaHei', 'SimSun']
  const fakeFonts = Array.isArray(fp.fonts) && fp.fonts.length ? fp.fonts : FALLBACK_FONTS
  const fontSet = new Set(fakeFonts.map((f) => f.toLowerCase()))
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'])
  const isFontAvailable = (name: string): boolean => {
    const n = name.trim().replace(/^["']|["']$/g, '').toLowerCase()
    if (!n || GENERIC.has(n)) return true
    return fontSet.has(n)
  }
  // 从 CSS font 简写里取出 family 段（size 之后的全部），拆成候选族
  const SIZE_RE = /([-+]?\d*\.?\d+(?:px|pt|em|rem|%|ex|ch|vw|vh|cm|mm|in)?)\s*(?:\/\s*[-+]?\d*\.?\d+(?:px|pt|em|rem|%|ex|ch|vw|vh|cm|mm|in)?)?\s+(.+)$/
  const familyOf = (fontSpec: string): string => {
    const m = String(fontSpec).match(SIZE_RE)
    return m ? m[2] : fontSpec
  }
  // 把 font 简写里的 family 过滤为「仅保留可用族」：去掉列表外的字体，全部不可用时回落 sans-serif。
  // 过滤（而非「任一可用即原样保留」）才能让 measureText 对列表外字体统一返回基线宽度，杜绝宽度枚举。
  const mapFontFamily = (fontSpec: string): string => {
    const fam = familyOf(fontSpec)
    const kept = fam.split(',').map((s) => s.trim()).filter(Boolean).filter(isFontAvailable)
    const newFam = kept.length ? kept.join(', ') : 'sans-serif'
    if (newFam === fam) return fontSpec
    return fontSpec.slice(0, fontSpec.length - fam.length) + newFam
  }
  try {
    const df = (document as any).fonts
    if (df && typeof df.check === 'function') {
      const origCheck = df.check.bind(df)
      df.check = patchNative((spec: string, text?: string) => {
        // 任一候选族可用即视为可用（与真实浏览器多候选回退语义一致）
        if (familyOf(spec).split(',').map((s) => s.trim()).filter(Boolean).some(isFontAvailable)) return true
        return origCheck(spec, text)
      }, 'check')
      const origLoad = typeof df.load === 'function' ? df.load.bind(df) : null
      if (origLoad) {
        df.load = patchNative((spec: string, text?: string) => {
          if (familyOf(spec).split(',').map((s) => s.trim()).filter(Boolean).some(isFontAvailable)) return origLoad(spec, text)
          // 不在列表内：解析为空数组（不抛错，也不会让脚本误以为字体可用）
          return Promise.resolve([])
        }, 'load')
      }
    }
  } catch {
    /* ignore */
  }
  if (typeof CanvasRenderingContext2D !== 'undefined') {
    const origMeasure = CanvasRenderingContext2D.prototype.measureText
    CanvasRenderingContext2D.prototype.measureText = patchNative(function (this: any, text: string) {
      try {
        const mapped = mapFontFamily(this.font || '10px sans-serif')
        if (mapped !== this.font) this.font = mapped
      } catch {
        /* ignore */
      }
      return origMeasure.call(this, text)
    }, 'measureText')
  }

  // DOM 宽度枚举防护：站点通过给元素设 style.fontFamily 再读 offsetWidth 来枚举已安装字体，
  // 上面的 document.fonts.check / Canvas measureText 补丁覆盖不到这条路径。这里覆写
  // CSSStyleDeclaration 的 font-family 写入（直接赋值与 setProperty 两条），把列表外字体过滤掉、
  // 回落到 sans-serif，使 DOM 宽度对照法同样无法分辨「装了 / 没装」。
  try {
    const CSSProto = (window as any).CSSStyleDeclaration && (window as any).CSSStyleDeclaration.prototype
    if (CSSProto) {
      const famDesc = Object.getOwnPropertyDescriptor(CSSProto, 'fontFamily')
      if (famDesc && typeof famDesc.set === 'function') {
        const origFamSet = famDesc.set
        Object.defineProperty(CSSProto, 'fontFamily', {
          configurable: true,
          enumerable: famDesc.enumerable,
          get: famDesc.get,
          set: patchNative(function (this: any, v: string) {
            try {
              const mapped = mapFontFamily('10px ' + (v == null ? '' : String(v)))
              origFamSet.call(this, familyOf(mapped))
            } catch {
              origFamSet.call(this, v)
            }
          }, 'set fontFamily')
        })
      }
      const origSetProperty = CSSProto.setProperty
      if (typeof origSetProperty === 'function') {
        CSSProto.setProperty = patchNative(function (this: any, prop: string, value: string, priority?: string) {
          try {
            if (typeof prop === 'string' && prop.toLowerCase() === 'font-family') {
              const mapped = mapFontFamily('10px ' + (value == null ? '' : String(value)))
              return origSetProperty.call(this, prop, familyOf(mapped), priority)
            }
          } catch {
            /* fall through to original */
          }
          return origSetProperty.call(this, prop, value, priority)
        }, 'setProperty')
      }
    }
  } catch {
    /* ignore */
  }
  markPatched('fonts')

  // ===== 多窗口同步（键鼠轨迹级） =====
  // 设计要点：
  // 1) 定位不靠裸坐标（各窗口尺寸/布局可能不同），而是「稳定 selector + 元素内相对坐标」
  // 2) 应用端不是一次性 .click()，而是按缓动插值逐点派发真实 Pointer/Mouse 事件，产生拟人移动轨迹
  // 3) 回环抑制用时间窗（不是布尔量），否则动画派发期间会被自己的监听器二次采集

  let suppressUntil = 0
  const suppress = (ms: number) => {
    suppressUntil = Math.max(suppressUntil, Date.now() + ms)
  }
  const isSuppressed = () => Date.now() < suppressUntil

  const throttle = <A extends unknown[]>(fn: (...args: A) => void, ms: number) => {
    let last = 0
    return (...args: A) => {
      const now = Date.now()
      if (now - last > ms) {
        last = now
        fn(...args)
      }
    }
  }

  const sendSync = (payload: Record<string, unknown>) => {
    if (isSuppressed()) return
    try {
      ipcRenderer.send('sync-event', payload)
    } catch {
      /* ignore */
    }
  }

  // ---- 元素定位：优先稳定属性，其次结构化路径 ----
  const STABLE_ATTRS = ['data-testid', 'data-id', 'data-qa', 'aria-label', 'name', 'placeholder', 'title', 'alt', 'href']

  function selectorOf(el: Element | null): string {
    if (!el || el === document.body || el === document.documentElement) return ''
    const id = (el as HTMLElement).id
    if (id && !/^\d/.test(id) && id.length < 64) return '#' + CSS.escape(id)

    for (const attr of STABLE_ATTRS) {
      const v = el.getAttribute(attr)
      // href 可能很长且带随机 token，只取短的相对路径
      if (!v || v.length > 96) continue
      if (attr === 'href' && !v.startsWith('/') && !v.startsWith('#')) continue
      return `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(v)}]`
    }

    const parts: string[] = []
    let cur: Element | null = el
    let depth = 0
    while (cur && cur !== document.body && depth < 8) {
      let seg = cur.tagName.toLowerCase()
      const cls = (cur.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2)
      if (cls.length) seg += '.' + cls.map((c) => CSS.escape(c)).join('.')
      const parent = cur.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
      }
      parts.unshift(seg)
      cur = cur.parentElement
      depth++
    }
    return parts.join(' > ')
  }

  function resolveSelector(sel: string): Element | null {
    if (!sel) return null
    try {
      return document.querySelector(sel)
    } catch {
      return null
    }
  }

  /** 把鼠标位置编码成「元素 + 元素内相对坐标」，容忍窗口尺寸差异 */
  function encodePoint(x: number, y: number) {
    const el = document.elementFromPoint(x, y)
    const sel = selectorOf(el)
    const vw = Math.max(1, window.innerWidth)
    const vh = Math.max(1, window.innerHeight)
    if (el && sel) {
      const r = el.getBoundingClientRect()
      // 命中元素比视口还大（整页容器 / 长列表）时，相对坐标会被放大失真，
      // 这时退化为视口相对坐标更稳
      const anchorable = r.width > 0 && r.height > 0 && r.width <= vw * 1.2 && r.height <= vh * 1.2
      if (anchorable) return { sel, rx: (x - r.left) / r.width, ry: (y - r.top) / r.height, x, y }
    }
    // 兜底：视口相对坐标
    return { sel: '', rx: x / vw, ry: y / vh, x, y }
  }

  /** 落点必须落在视口内，否则 elementFromPoint 会返回 null，事件打空 */
  function clampToViewport(x: number, y: number) {
    return {
      x: Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - 1)),
      y: Math.min(Math.max(y, 0), Math.max(0, window.innerHeight - 1))
    }
  }

  /** 还原成目标窗口里的绝对视口坐标 */
  function decodePoint(d: Record<string, unknown>) {
    const sel = (d.sel as string) || ''
    const rx = typeof d.rx === 'number' ? d.rx : 0.5
    const ry = typeof d.ry === 'number' ? d.ry : 0.5
    const el = resolveSelector(sel)
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        return { x: r.left + rx * r.width, y: r.top + ry * r.height, el, rx, ry }
      }
      return { x: (d.x as number) ?? 0, y: (d.y as number) ?? 0, el, rx, ry }
    }
    return { x: rx * window.innerWidth, y: ry * window.innerHeight, el: null as Element | null, rx, ry }
  }

  /**
   * 目标元素不在视口内时坐标会落到 body 上导致点空，
   * 先把它滚进视口，再按同样的相对坐标重新计算落点。
   */
  function ensureVisible(p: { x: number; y: number; el: Element | null; rx: number; ry: number }) {
    if (!p.el) return { ...p, ...clampToViewport(p.x, p.y) }
    const r = p.el.getBoundingClientRect()
    // 元素比视口还高时 scrollIntoView 只会让 rect.top 变负，反而算出错落点，直接跳过
    const scrollable = r.height > 0 && r.height <= window.innerHeight
    if (scrollable && (r.top < 0 || r.bottom > window.innerHeight)) {
      p.el.scrollIntoView({ block: 'center', inline: 'nearest' })
      const r2 = p.el.getBoundingClientRect()
      if (r2.width > 0 && r2.height > 0) {
        return {
          ...clampToViewport(r2.left + p.rx * r2.width, r2.top + p.ry * r2.height),
          el: p.el,
          rx: p.rx,
          ry: p.ry
        }
      }
    }
    return { ...p, ...clampToViewport(p.x, p.y) }
  }

  // ---- 拟人化鼠标轨迹 ----
  let cursor = { x: window.innerWidth / 2, y: window.innerHeight / 2 }

  function dispatchMove(x: number, y: number) {
    cursor = { x, y }
    const target = document.elementFromPoint(x, y) || document.body
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      view: window,
      button: 0,
      buttons: 0
    }
    target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    target.dispatchEvent(new MouseEvent('mousemove', init))
  }

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

  /**
   * 沿带随机控制点的二次贝塞尔曲线移动，模拟真人手抖与弧线。
   * 返回总耗时，便于调用方设置抑制窗口。
   */
  function animateMouse(toX: number, toY: number, onDone?: () => void): number {
    const fromX = cursor.x
    const fromY = cursor.y
    const dist = Math.hypot(toX - fromX, toY - fromY)
    if (dist < 2) {
      dispatchMove(toX, toY)
      onDone?.()
      return 0
    }
    const steps = Math.max(6, Math.min(28, Math.round(dist / 18)))
    const duration = Math.max(60, Math.min(420, Math.round(dist * 0.55)))
    // 控制点：垂直于连线方向偏移一段，幅度随距离增长但设上限
    const midX = (fromX + toX) / 2
    const midY = (fromY + toY) / 2
    const nx = -(toY - fromY) / (dist || 1)
    const ny = (toX - fromX) / (dist || 1)
    // 弧度要小：每条同步事件都会起一段新曲线，幅度大了轨迹会来回摆动
    const bow = (Math.random() - 0.5) * Math.min(22, dist * 0.12)
    const cx = midX + nx * bow
    const cy = midY + ny * bow

    let i = 0
    const tick = () => {
      i++
      const t = easeOutCubic(i / steps)
      // 二次贝塞尔
      const mt = 1 - t
      const x = mt * mt * fromX + 2 * mt * t * cx + t * t * toX
      const y = mt * mt * fromY + 2 * mt * t * cy + t * t * toY
      // 收尾几帧去掉抖动，精确落到目标点
      if (i >= steps) dispatchMove(toX, toY)
      else dispatchMove(x + (Math.random() - 0.5) * 1.2, y + (Math.random() - 0.5) * 1.2)
      if (i < steps) setTimeout(tick, Math.max(8, Math.round(duration / steps)))
      else onDone?.()
    }
    tick()
    return duration
  }

  // 真实浏览器里 click 是「mousedown 与 mouseup 落在同一元素」时由内核生成的。
  // 我们重放的是合成事件，内核不会自动生成 click，所以自己配对补发；
  // 但如果来源已经单独发来 click（键盘触发的点击等），要避免重复点两次。
  let lastDownTarget: Element | null = null
  let lastSyntheticClickAt = 0

  function mouseEventAt(type: string, x: number, y: number, button: number, buttons: number) {
    const target = document.elementFromPoint(x, y) || document.body
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      view: window,
      button,
      buttons,
      detail: 1
    }
    // 只有 down/up 有对应的 pointer 事件类型；click 没有独立的 PointerEvent 类型，
    // 若也派发一份 PointerEvent('click')，页面会收到两次 type 相同的 click
    if (type === 'mousedown') {
      target.dispatchEvent(
        new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      )
    } else if (type === 'mouseup') {
      target.dispatchEvent(
        new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      )
    }
    target.dispatchEvent(new MouseEvent(type, init))
  }

  // ---- 采集：鼠标 ----
  document.addEventListener(
    'mousemove',
    throttle((e: Event) => {
      const me = e as MouseEvent
      sendSync({ type: 'mousemove', ...encodePoint(me.clientX, me.clientY) })
    }, 45),
    true
  )

  document.addEventListener(
    'mousedown',
    (e: Event) => {
      const me = e as MouseEvent
      sendSync({ type: 'mousedown', ...encodePoint(me.clientX, me.clientY), button: me.button })
    },
    true
  )

  document.addEventListener(
    'mouseup',
    (e: Event) => {
      const me = e as MouseEvent
      sendSync({ type: 'mouseup', ...encodePoint(me.clientX, me.clientY), button: me.button })
    },
    true
  )

  document.addEventListener(
    'click',
    (e: Event) => {
      const me = e as MouseEvent
      sendSync({ type: 'click', ...encodePoint(me.clientX, me.clientY), button: me.button })
    },
    true
  )

  document.addEventListener(
    'wheel',
    throttle((e: Event) => {
      const we = e as WheelEvent
      sendSync({ type: 'wheel', ...encodePoint(we.clientX, we.clientY), deltaX: we.deltaX, deltaY: we.deltaY })
    }, 90),
    true
  )

  // ---- 采集：键盘 ----
  const EDITABLE = ['INPUT', 'TEXTAREA', 'SELECT']

  document.addEventListener(
    'keydown',
    (e: Event) => {
      const ke = e as KeyboardEvent
      const t = ke.target as HTMLElement | null
      sendSync({
        type: 'keydown',
        key: ke.key,
        code: ke.code,
        keyCode: ke.keyCode || 0,
        ctrl: ke.ctrlKey,
        alt: ke.altKey,
        shift: ke.shiftKey,
        meta: ke.metaKey,
        sel: t && t !== document.body ? selectorOf(t) : ''
      })
    },
    true
  )

  document.addEventListener(
    'keyup',
    (e: Event) => {
      const ke = e as KeyboardEvent
      const t = ke.target as HTMLElement | null
      sendSync({
        type: 'keyup',
        key: ke.key,
        code: ke.code,
        keyCode: ke.keyCode || 0,
        ctrl: ke.ctrlKey,
        alt: ke.altKey,
        shift: ke.shiftKey,
        meta: ke.metaKey,
        sel: t && t !== document.body ? selectorOf(t) : ''
      })
    },
    true
  )

  // ---- 采集：输入与滚动 ----
  document.addEventListener(
    'input',
    (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || !EDITABLE.includes(t.tagName)) return
      sendSync({ type: 'input', sel: selectorOf(t), value: (t as HTMLInputElement).value })
    },
    true
  )

  document.addEventListener(
    'change',
    (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || t.tagName !== 'SELECT') return
      sendSync({ type: 'change', sel: selectorOf(t), value: (t as HTMLSelectElement).value })
    },
    true
  )

  document.addEventListener(
    'focus',
    (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || !EDITABLE.includes(t.tagName)) return
      sendSync({ type: 'focus', sel: selectorOf(t) })
    },
    true
  )

  window.addEventListener(
    'scroll',
    throttle(() => {
      sendSync({ type: 'scroll', x: window.scrollX, y: window.scrollY })
    }, 120),
    true
  )

  // ---- 应用：把远端事件重放成本窗口的真实输入序列 ----
  function setNativeValue(el: HTMLElement, value: string) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    // React/Vue 受控组件会缓存 value，直接赋值不触发更新，必须走原生 setter
    if (desc && desc.set) desc.set.call(el, value)
    else (el as HTMLInputElement).value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  ipcRenderer.on('sync-apply', (_e, payload: Record<string, unknown>) => {
    applySync(payload)
  })
  window.addEventListener('message', (e) => {
    const data = e.data
    if (!data || !data.__roxySync) return
    applySync(data)
  })

  function applySync(d: Record<string, unknown>) {
    suppress(120)
    try {
      switch (d.type) {
        case 'mousemove': {
          const p = ensureVisible(decodePoint(d))
          suppress(animateMouse(p.x, p.y) + 40)
          break
        }
        case 'mousedown': {
          const p = ensureVisible(decodePoint(d))
          const button = (d.button as number) ?? 0
          animateMouse(p.x, p.y, () => {
            lastDownTarget = document.elementFromPoint(p.x, p.y)
            mouseEventAt('mousedown', p.x, p.y, button, 1)
          })
          suppress(500)
          break
        }
        case 'mouseup': {
          const p = ensureVisible(decodePoint(d))
          const button = (d.button as number) ?? 0
          animateMouse(p.x, p.y, () => {
            mouseEventAt('mouseup', p.x, p.y, button, 0)
            const upTarget = document.elementFromPoint(p.x, p.y)
            // 按下与抬起落在同一元素 → 补发 click（模拟内核行为）
            if (upTarget && upTarget === lastDownTarget) {
              // 标记必须同步打上：来源的 click 事件紧随 mouseup 到达，
              // 等 setTimeout 里再打就已经来不及去重了
              lastSyntheticClickAt = Date.now()
              setTimeout(() => {
                mouseEventAt('click', p.x, p.y, button, 0)
              }, 30 + Math.round(Math.random() * 50))
              suppress(200)
            }
          })
          suppress(500)
          break
        }
        case 'click': {
          // 鼠标点击已由 mouseup 配对补发，这里跳过，否则目标窗口会被点两次；
          // 只有在没有配对记录时（键盘 Enter / JS 触发的点击）才重放完整序列
          if (Date.now() - lastSyntheticClickAt > 1500) {
            const p = ensureVisible(decodePoint(d))
            const button = (d.button as number) ?? 0
            animateMouse(p.x, p.y, () => {
              mouseEventAt('mousedown', p.x, p.y, button, 1)
              setTimeout(() => {
                mouseEventAt('mouseup', p.x, p.y, button, 0)
                mouseEventAt('click', p.x, p.y, button, 0)
              }, 45 + Math.round(Math.random() * 55))
            })
            suppress(700)
          }
          break
        }
        case 'wheel': {
          const p = ensureVisible(decodePoint(d))
          const target = document.elementFromPoint(p.x, p.y) || document.body
          const evt = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: p.x,
            clientY: p.y,
            deltaX: (d.deltaX as number) || 0,
            deltaY: (d.deltaY as number) || 0,
            deltaMode: 0
          })
          const notPrevented = target.dispatchEvent(evt)
          if (notPrevented) window.scrollBy({ left: (d.deltaX as number) || 0, top: (d.deltaY as number) || 0 })
          suppress(150)
          break
        }
        case 'keydown':
        case 'keyup': {
          const target =
            resolveSelector((d.sel as string) || '') ||
            (document.activeElement as Element | null) ||
            document.body
          target.dispatchEvent(
            new KeyboardEvent(d.type as string, {
              bubbles: true,
              cancelable: true,
              composed: true,
              key: (d.key as string) || '',
              code: (d.code as string) || '',
              keyCode: (d.keyCode as number) || 0,
              ctrlKey: !!d.ctrl,
              altKey: !!d.alt,
              shiftKey: !!d.shift,
              metaKey: !!d.meta
            })
          )
          suppress(120)
          break
        }
        case 'input': {
          const el = resolveSelector((d.sel as string) || '')
          if (el) setNativeValue(el as HTMLElement, String(d.value ?? ''))
          suppress(150)
          break
        }
        case 'change': {
          const el = resolveSelector((d.sel as string) || '')
          if (el && (el as HTMLElement).tagName === 'SELECT') {
            setNativeValue(el as HTMLElement, String(d.value ?? ''))
          }
          suppress(150)
          break
        }
        case 'focus': {
          const el = resolveSelector((d.sel as string) || '') as HTMLElement | null
          if (el && typeof el.focus === 'function') el.focus()
          suppress(120)
          break
        }
        case 'scroll': {
          window.scrollTo(d.x as number, d.y as number)
          suppress(150)
          break
        }
        default:
          break
      }
    } catch {
      /* 单条事件失败不影响后续同步 */
    }
  }

  // ===== RPA 脚本录制 =====
  // 主进程通过 rpa-recording 通道开关采集；步骤用与窗口同步相同的「稳定 selector +
  // 元素内相对坐标」编码，回放时直接走 sync-apply 通道，两套体系共用一套解码。
  // 注意：同步重放 / 回放产生的事件带抑制窗（suppressUntil），期间不采集，避免录到回声。
  let rpaOn = false
  ipcRenderer.on('rpa-recording', (_e, state: { enabled?: boolean }) => {
    rpaOn = !!state?.enabled
  })

  const sendRpa = (step: Record<string, unknown>) => {
    if (!rpaOn || isSuppressed()) return
    try {
      ipcRenderer.send('rpa-event', step)
    } catch {
      /* ignore */
    }
  }

  document.addEventListener(
    'click',
    (e: Event) => {
      const me = e as MouseEvent
      const p = encodePoint(me.clientX, me.clientY)
      sendRpa({ type: 'click', sel: p.sel, rx: p.rx, ry: p.ry })
    },
    true
  )

  document.addEventListener(
    'input',
    (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || !EDITABLE.includes(t.tagName)) return
      const sel = selectorOf(t)
      if (!sel) return
      sendRpa({ type: 'input', sel, value: (t as HTMLInputElement).value })
    },
    true
  )

  document.addEventListener(
    'change',
    (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || t.tagName !== 'SELECT') return
      const sel = selectorOf(t)
      if (!sel) return
      sendRpa({ type: 'change', sel, value: (t as HTMLSelectElement).value })
    },
    true
  )

  window.addEventListener(
    'scroll',
    throttle(() => {
      sendRpa({ type: 'scroll', x: window.scrollX, y: window.scrollY })
    }, 400),
    true
  )
})()
