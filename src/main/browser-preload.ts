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
    touch?: boolean
    devicePixelRatio?: number
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
    // iOS Safari 不支持 userAgentData，伪装时必须整个移除，否则一查就穿帮
    try {
      delete (navigator as any).userAgentData
    } catch {
      /* ignore */
    }
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
    try {
      delete (navigator as any).userAgentData
    } catch {
      /* ignore */
    }
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

  // ===== 多窗口同步（键鼠轨迹级） =====
  // 设计要点：
  // 1) 定位不靠裸坐标（各窗口尺寸/布局可能不同），而是「稳定 selector + 元素内相对坐标」
  // 2) 应用端不是一次性 .click()，而是按缓动插值逐点派发真实 Pointer/Mouse 事件，产生拟人移动轨迹
  // 3) 回环抑制用时间窗（不是布尔量），否则动画派发期间会被自己的监听器二次采集

  const { ipcRenderer } = require('electron') as typeof import('electron')

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
