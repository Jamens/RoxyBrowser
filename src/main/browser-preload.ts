// 指纹注入脚本（运行于浏览器环境窗口的每一页面）
// 通过 webPreferences.additionalArguments 传入 --roxy-fp=<base64>
/* eslint-disable @typescript-eslint/no-explicit-any */
import { webGpuInfoFor, webGpuSupported } from '../shared/webgpu'
import { audioProfileFor } from '../shared/webaudio'
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
  }

  // ipcRenderer 提前到最前：起始页的 window.roxy.navigate 闭包要用它
  const { ipcRenderer } = require('electron') as typeof import('electron')

  const fpArg = process.argv.find((a: string) => a.startsWith('--roxy-fp='))
  if (!fpArg) return
  const fp: Fingerprint = JSON.parse(Buffer.from(fpArg.slice('--roxy-fp='.length), 'base64').toString('utf8'))
  const profileArg = process.argv.find((a: string) => a.startsWith('--roxy-profile='))
  const seed = profileArg ? Number(profileArg.slice('--roxy-profile='.length)) * 2654435761 : 12345

  // 确定性随机（同一环境的 Canvas/音频噪声保持稳定，不同环境之间互不相同）
  function mulberry32(a: number) {
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const def = (obj: any, key: string, value: any) => {
    try {
      Object.defineProperty(obj, key, { get: () => value, configurable: true, enumerable: true })
    } catch {
      /* ignore */
    }
  }

  // 隐藏属性：用不可枚举的 own getter 遮蔽原型上的原生 getter。
  // 不能用 delete —— WebIDL 定义的属性（navigator.gpu / userAgentData / geolocation）
  // 都在原型（如 Navigator.prototype）上，而 delete **只能删除自身属性**：
  // 对原型属性执行 delete 会返回 true 却什么也不删，是彻底的静默失效。
  // 这里改为在实例上定义一个返回 undefined 的 own getter，读取即得到 undefined。
  const hide = (obj: any, key: string) => {
    try {
      Object.defineProperty(obj, key, { get: () => undefined, configurable: true, enumerable: false })
    } catch {
      /* ignore */
    }
  }

  // 覆盖属性但保持**不可枚举**：用于「在原生实例上改写个别字段」的场景。
  // 原生对象（如 GPUAdapterInfo）的 Object.keys() 通常是空的，
  // 若用 def（enumerable: true）改写，keys 会凭空多出键，一行检测即暴露。
  const cover = (obj: any, key: string, value: any) => {
    try {
      Object.defineProperty(obj, key, { get: () => value, configurable: true, enumerable: false })
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

  // ===== navigator =====
  def(navigator, 'userAgent', fp.userAgent)
  def(navigator, 'platform', fp.platform)
  def(navigator, 'languages', Object.freeze([...fp.languages]))
  def(navigator, 'language', fp.languages[0])
  def(navigator, 'hardwareConcurrency', fp.hardwareConcurrency)
  def(navigator, 'deviceMemory', fp.deviceMemory)
  def(navigator, 'doNotTrack', fp.doNotTrack)

  // ===== 反自动化痕迹清除（Tier 1 #1，对标指纹浏览器标配反检测）=====
  // 检测站（Cloudflare / PerimeterX / 各平台风控）首要查的就是自动化痕迹，
  // 比再加一个 EME 向量影响大得多。真实非自动化 Chrome 的 navigator.webdriver 恒为 false；
  // iOS Safari 根本没有该属性（undefined）。CDP / ChromeDriver 还会在 window 上留下
  // cdc_ / $cdc_ 等特征变量——本仓库环境由我们自己启动的 Electron 窗口承载，正常情况下不会存在，
  // 但加一层「存在即清除」的防御，避免任何 CDP 连接意外注入后暴露。
  {
    // 1) navigator.webdriver：非 iOS 强制 false，iOS 整体隐藏（与 EME / userAgentData 同源手法）
    if (fp.os === 'ios') {
      hide(navigator, 'webdriver')
    } else {
      def(navigator, 'webdriver', false)
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
      // 仅当宿主原生就有该 API 时才隐藏（不凭空制造 own undefined 属性，否则 'key' in navigator 会误报存在）
      if ((navigator as any)[key] !== undefined) hide(navigator, key)
    }
  }

  // ===== 移动端：触摸能力 + 像素比 =====
  // 桌面（非触摸）统一归 0，避免真实宿主机是触摸屏时把 maxTouchPoints 漏成 10 等；
  // 移动端固定 5。这是反检测最稳妥的默认值。
  def(navigator, 'maxTouchPoints', fp.touch ? 5 : 0)
  if (fp.touch) {
    // 'ontouchstart' in window 是常见触摸检测手段
    def(window, 'ontouchstart', null)
  }
  if (typeof fp.devicePixelRatio === 'number' && fp.devicePixelRatio > 0) {
    def(window, 'devicePixelRatio', fp.devicePixelRatio)
  }

  // ===== userAgentData（UA-CH）=====
  // 关键：不能只在原生 userAgentData 实例上 redefine 子字段——Chromium 每次访问
  // navigator.userAgentData 都返回一个新对象（或只读原型属性），子字段改写不会落到
  // 真正被读取的实例上，导致宿主 platform（如 Windows）原样泄漏。必须整体替换 getter。
  const isMobile = fp.os === 'android' || fp.os === 'ios'
  if (fp.os === 'ios') {
    // iOS Safari 不支持 userAgentData，伪装时必须整个移除，否则一查就穿帮。
    // 用 hide 而非 delete：该属性定义在 Navigator.prototype 上，
    // delete 只删自身属性、对原型属性静默无效（本项目此前正是踩了这个坑）。
    hide(navigator, 'userAgentData')
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
      getHighEntropyValues: (_hints: string[]) =>
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
        })
    }
    // 不需要先 delete：def 在实例上建立 own property，天然遮蔽原型上的原生 getter
    def(navigator, 'userAgentData', uad)
  }

  // ===== screen =====
  def(window.screen, 'width', fp.screenWidth)
  def(window.screen, 'height', fp.screenHeight)
  def(window.screen, 'availWidth', fp.screenWidth)
  def(window.screen, 'availHeight', fp.screenHeight - (fp.touch ? 24 : fp.os === 'mac' ? 25 : 40))

  // ===== 时区 =====
  const realGetTimezoneOffset = Date.prototype.getTimezoneOffset
  Date.prototype.getTimezoneOffset = function () {
    return fp.tzOffset
  }
  const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions
  Intl.DateTimeFormat.prototype.resolvedOptions = function (...args: any[]) {
    const options = realResolved.apply(this, args as [])
    options.timeZone = fp.timezone
    return options
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
      getCurrentPosition: (success?: (p: unknown) => void, _error?: (e: unknown) => void) => {
        if (typeof success === 'function') setTimeout(() => success(makePosition()), 10)
      },
      watchPosition: (success?: (p: unknown) => void) => {
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
      clearWatch: (id?: number) => {
        if (typeof id !== 'number') return
        const t = geoTimers.get(id)
        if (t) {
          clearInterval(t)
          geoTimers.delete(id)
        }
      }
    }
    try {
      delete (navigator as any).geolocation
    } catch {
      /* ignore */
    }
    def(navigator, 'geolocation', geolocation)
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
      def(navigator, 'getBattery', () => Promise.resolve(batManager))
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
      pluginObj.item = (i: number) => (i === 0 ? mimeObj : null)
      pluginObj.namedItem = (n: string) => (n === 'application/pdf' ? mimeObj : null)
      const mimeArr: any = { length: 1 }
      Object.defineProperty(mimeArr, 0, { get: () => mimeObj, enumerable: false, configurable: true })
      mimeArr.item = (i: number) => (i === 0 ? mimeObj : null)
      mimeArr.namedItem = (n: string) => (n === 'application/pdf' ? mimeObj : null)
      Object.defineProperty(mimeArr, Symbol.iterator, { value: function* () { yield mimeObj }, enumerable: false, configurable: true })
      if (MimeTypeArrayProto) Object.setPrototypeOf(mimeArr, MimeTypeArrayProto)
      const pluginArr: any = { length: 1 }
      Object.defineProperty(pluginArr, 0, { get: () => pluginObj, enumerable: false, configurable: true })
      pluginArr.item = (i: number) => (i === 0 ? pluginObj : null)
      pluginArr.namedItem = (n: string) => (n === 'Chrome PDF Plugin' ? pluginObj : null)
      Object.defineProperty(pluginArr, Symbol.iterator, { value: function* () { yield pluginObj }, enumerable: false, configurable: true })
      if (PluginArrayProto) Object.setPrototypeOf(pluginArr, PluginArrayProto)
      def(navigator, 'plugins', pluginArr)
      def(navigator, 'mimeTypes', mimeArr)
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
      def(ss, 'getVoices', () => {
        const all = orig()
        const matched = all.filter((v: any) =>
          fp.languages.some((l: string) => v.lang && v.lang.toLowerCase().startsWith(l.split('-')[0].toLowerCase()))
        )
        return matched.length ? matched : all
      })
    }
  } catch {
    /* ignore */
  }

  // ===== Canvas 噪声 =====
  if (fp.canvasNoise) {
    const rng = mulberry32(seed ^ 0x1a2b3c4d)
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (...args: any[]) {
      try {
        const copy = document.createElement('canvas')
        copy.width = this.width
        copy.height = this.height
        const cx = copy.getContext('2d')
        if (cx && this.width > 0 && this.height > 0) {
          cx.drawImage(this, 0, 0)
          const noisePixels = Math.max(1, Math.floor((this.width * this.height) / 5000))
          for (let i = 0; i < noisePixels; i++) {
            const r = Math.floor(rng() * 256)
            const g = Math.floor(rng() * 256)
            const b = Math.floor(rng() * 256)
            cx.fillStyle = `rgba(${r},${g},${b},0.012)`
            cx.fillRect(Math.floor(rng() * this.width), Math.floor(rng() * this.height), 1, 1)
          }
          return origToDataURL.apply(copy, args as [string?, number?])
        }
      } catch {
        /* ignore */
      }
      return origToDataURL.apply(this, args as [string?, number?])
    }

    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData
    CanvasRenderingContext2D.prototype.getImageData = function (...args: any[]) {
      const data = origGetImageData.apply(this, args as [number, number, number, number])
      try {
        for (let i = 0; i < data.data.length; i += 4) {
          if (rng() < 0.02) {
            data.data[i] = (data.data[i] + (rng() < 0.5 ? 1 : -1)) & 0xff
          }
        }
      } catch {
        /* ignore */
      }
      return data
    }
  }

  // ===== WebGL =====
  const patchGetParam = (proto: any) => {
    const orig = proto.getParameter
    proto.getParameter = function (param: number) {
      // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
      if (param === 37445) return fp.webglVendor
      if (param === 37446) return fp.webglRenderer
      return orig.call(this, param)
    }
    const origGetExt = proto.getExtension
    proto.getExtension = function (name: string) {
      const ext = origGetExt.call(this, name)
      if (name === 'WEBGL_debug_renderer_info') return ext || {}
      return ext
    }
  }
  if (typeof WebGLRenderingContext !== 'undefined') patchGetParam(WebGLRenderingContext.prototype)
  if (typeof WebGL2RenderingContext !== 'undefined') patchGetParam(WebGL2RenderingContext.prototype)

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
        hide(navigator, 'requestMediaKeySystemAccess')
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
        const wrapped = (keySystem: string, ...rest: any[]) => {
          if (keySystem === 'com.widevine.alpha' || keySystem === 'org.w3.clearkey') {
            // 第二个参数为候选配置数组（可空）
            const req = rest[0]
            return Promise.resolve(fakeAccess(keySystem, Array.isArray(req) ? req : undefined))
          }
          return origRmkSA(keySystem, ...rest)
        }
        def(navigator, 'requestMediaKeySystemAccess', wrapped)
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
    hide(navigator, 'gpu')
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
        // 且 isFallbackAdapter 为 true 时说明跑在 SwiftShader 上，硬伪造显卡名只会自相矛盾。
        if (!adapter) return adapter
        try {
          const real = adapter.info
          if (real) {
            // 只在**真实 GPUAdapterInfo 实例**上盖两个 getter：
            // 这样 instanceof GPUAdapterInfo 依然成立，subgroupMinSize / subgroupMaxSize /
            // isFallbackAdapter 等其余字段继续由原生提供，Object.keys 也不变。
            // 早先塞一个自制普通对象的做法会让这些维度变成 undefined、且 instanceof 判 false，
            // 等于制造出「真实浏览器不可能出现的值」——比不伪装更可疑。
            cover(real, 'vendor', gpuInfo.vendor)
            cover(real, 'architecture', gpuInfo.architecture)
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
          get(this: any) {
            return this instanceof OfflineAudioContext ? origGet.call(this) : ap.sampleRate
          },
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

    // 取样值微扰：让 OfflineAudioContext 渲染出的音频哈希带上本环境的确定性噪声
    if (typeof AudioBuffer !== 'undefined') {
      const rng = mulberry32(seed ^ 0x5e6f7a8b)
      const origGetChannelData = AudioBuffer.prototype.getChannelData
      AudioBuffer.prototype.getChannelData = function (...args: any[]) {
        const data = origGetChannelData.apply(this, args as [number])
        try {
          for (let i = 0; i < data.length; i++) {
            data[i] += (rng() - 0.5) * 1e-7
          }
        } catch {
          /* ignore */
        }
        return data
      }
    }
  }

  // ===== WebRTC =====
  if (fp.webrtc === 'disable') {
    ;(window as any).RTCPeerConnection = undefined
    ;(window as any).webkitRTCPeerConnection = undefined
    if (navigator.mediaDevices) {
      def(navigator.mediaDevices, 'enumerateDevices', () => Promise.resolve([]))
    }
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
  // 把 font 简写里的 family 替换成第一个可用族；全部不可用时回落 sans-serif，
  // 让 measureText 对列表外字体统一返回基线宽度，杜绝宽度枚举。
  const mapFontFamily = (fontSpec: string): string => {
    const fam = familyOf(fontSpec)
    if (fam.split(',').map((s) => s.trim()).filter(Boolean).some(isFontAvailable)) return fontSpec
    return fontSpec.slice(0, fontSpec.length - fam.length) + 'sans-serif'
  }
  try {
    const df = (document as any).fonts
    if (df && typeof df.check === 'function') {
      const origCheck = df.check.bind(df)
      df.check = (spec: string, text?: string) => {
        // 任一候选族可用即视为可用（与真实浏览器多候选回退语义一致）
        if (familyOf(spec).split(',').map((s) => s.trim()).filter(Boolean).some(isFontAvailable)) return true
        return origCheck(spec, text)
      }
      const origLoad = typeof df.load === 'function' ? df.load.bind(df) : null
      if (origLoad) {
        df.load = (spec: string, text?: string) => {
          if (familyOf(spec).split(',').map((s) => s.trim()).filter(Boolean).some(isFontAvailable)) return origLoad(spec, text)
          // 不在列表内：解析为空数组（不抛错，也不会让脚本误以为字体可用）
          return Promise.resolve([])
        }
      }
    }
  } catch {
    /* ignore */
  }
  if (typeof CanvasRenderingContext2D !== 'undefined') {
    const origMeasure = CanvasRenderingContext2D.prototype.measureText
    CanvasRenderingContext2D.prototype.measureText = function (this: any, text: string) {
      try {
        const mapped = mapFontFamily(this.font || '10px sans-serif')
        if (mapped !== this.font) this.font = mapped
      } catch {
        /* ignore */
      }
      return origMeasure.call(this, text)
    }
  }

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
