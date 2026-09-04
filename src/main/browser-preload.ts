// 指纹注入脚本（运行于浏览器环境窗口的每一页面）
// 通过 webPreferences.additionalArguments 传入 --roxy-fp=<base64>
/* eslint-disable @typescript-eslint/no-explicit-any */
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
    webrtc: 'disable' | 'real'
    doNotTrack: string
  }

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

  // ===== navigator =====
  def(navigator, 'userAgent', fp.userAgent)
  def(navigator, 'platform', fp.platform)
  def(navigator, 'languages', Object.freeze([...fp.languages]))
  def(navigator, 'language', fp.languages[0])
  def(navigator, 'hardwareConcurrency', fp.hardwareConcurrency)
  def(navigator, 'deviceMemory', fp.deviceMemory)
  def(navigator, 'doNotTrack', fp.doNotTrack)
  if ((navigator as any).userAgentData) {
    const major = fp.uaFullVersion.split('.')[0]
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not A;Brand', version: '99' }
    ]
    const uad = (navigator as any).userAgentData
    try {
      Object.defineProperty(uad, 'brands', { get: () => brands, configurable: true })
      Object.defineProperty(uad, 'platform', { get: () => (fp.os === 'mac' ? 'macOS' : 'Windows'), configurable: true })
      if (uad.getHighEntropyValues) {
        const origGet = uad.getHighEntropyValues.bind(uad)
        uad.getHighEntropyValues = (hints: string[]) =>
          origGet(hints).then((r: any) => {
            r.platform = fp.os === 'mac' ? 'macOS' : 'Windows'
            r.platformVersion = fp.os === 'mac' ? '14.6.1' : '15.0.0'
            r.uaFullVersion = fp.uaFullVersion
            r.architecture = fp.os === 'mac' ? 'arm' : 'x86'
            r.model = ''
            return r
          })
      }
    } catch {
      /* ignore */
    }
  }

  // ===== screen =====
  def(window.screen, 'width', fp.screenWidth)
  def(window.screen, 'height', fp.screenHeight)
  def(window.screen, 'availWidth', fp.screenWidth)
  def(window.screen, 'availHeight', fp.screenHeight - (fp.os === 'mac' ? 25 : 40))

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

  // ===== AudioContext 噪声 =====
  if (fp.audioNoise && typeof AudioBuffer !== 'undefined') {
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

  // ===== WebRTC =====
  if (fp.webrtc === 'disable') {
    ;(window as any).RTCPeerConnection = undefined
    ;(window as any).webkitRTCPeerConnection = undefined
    if (navigator.mediaDevices) {
      def(navigator.mediaDevices, 'enumerateDevices', () => Promise.resolve([]))
    }
  }

  // ===== 多窗口同步操作 =====
  let syncing = false
  const throttle = (fn: () => void, ms: number) => {
    let last = 0
    return () => {
      const now = Date.now()
      if (now - last > ms) {
        last = now
        fn()
      }
    }
  }

  // 由主进程转发到其它窗口
  const { ipcRenderer } = require('electron') as typeof import('electron')

  const sendSync = (payload: Record<string, unknown>) => {
    if (syncing) return
    try {
      ipcRenderer.send('sync-event', payload)
    } catch {
      /* ignore */
    }
  }

  window.addEventListener(
    'scroll',
    throttle(() => {
      sendSync({ type: 'scroll', x: window.scrollX, y: window.scrollY })
    }, 120),
    true
  )
  document.addEventListener(
    'click',
    (e) => {
      sendSync({ type: 'click', x: e.clientX, y: e.clientY })
    },
    true
  )
  document.addEventListener(
    'input',
    (e) => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        sendSync({ type: 'input', value: (target as HTMLInputElement).value })
      }
    },
    true
  )

  // 接收主进程转发的其它窗口事件，投递到页面
  ipcRenderer.on('sync-apply', (_e, payload: Record<string, unknown>) => {
    window.postMessage({ __roxySync: true, ...payload }, '*')
    syncing = true
    setTimeout(() => (syncing = false), 60)
  })

  window.addEventListener('message', (e) => {
    const data = e.data
    if (!data || !data.__roxySync) return
    syncing = true
    try {
      if (data.type === 'scroll') window.scrollTo(data.x, data.y)
      else if (data.type === 'click') {
        const el = document.elementFromPoint(data.x, data.y) as HTMLElement | null
        el?.click()
      } else if (data.type === 'input') {
        const active = document.activeElement as HTMLInputElement | null
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.value = data.value
      }
    } finally {
      setTimeout(() => (syncing = false), 50)
    }
  })
})()
