// 环境体检采集端：在环境窗口的 webContents 里执行一段自包含脚本，
// 读回「真实生效」的浏览器特征值，交给 shared/healthcheck 与设定值对撞。
//
// 与 DOM 提取（agent/dom.ts）同一套路：字符串 IIFE + executeJavaScript，
// 脚本自带 try/catch，任何一项失败都不影响其余项。
import type { BrowserWindow } from 'electron'
import type { FingerprintProbe } from '../shared/healthcheck'

const PROBE_SCRIPT = `(function(){
  try {
    var nav = navigator;
    var uad = nav.userAgentData;
    var vendor = '', renderer = '', glAvailable = false;
    try {
      var c0 = document.createElement('canvas');
      var gl = c0.getContext('webgl') || c0.getContext('experimental-webgl');
      if (gl) {
        glAvailable = true;
        // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
        vendor = gl.getParameter(37445) || '';
        renderer = gl.getParameter(37446) || '';
      }
    } catch (e) {}

    // 判断原型方法是否被我们的 preload 改写：
    // 原生方法的 toString() 含 [native code]，被 JS 覆盖后是普通函数源码。
    function patched(fn) {
      try { return typeof fn === 'function' && String(fn).indexOf('[native code]') === -1; }
      catch (e) { return false; }
    }

    var fontsGuarded = false;
    try { fontsGuarded = !!(document.fonts && typeof document.fonts.check === 'function' && patched(document.fonts.check)); }
    catch (e) {}

    var langs = [];
    try { langs = Array.prototype.slice.call(nav.languages || []); } catch (e) {}

    // ---- WebGPU：requestAdapter() 异步，先起 Promise，最后再合并进结果 ----
    var gpuPresent = false, gpuVendor = '', gpuArch = '', gpuAdapter = false;
    var gpuP = Promise.resolve();
    try {
      gpuPresent = !!nav.gpu;
      if (gpuPresent && typeof nav.gpu.requestAdapter === 'function') {
        gpuP = Promise.race([
          nav.gpu.requestAdapter().then(function (ad) {
            if (!ad) return;
            gpuAdapter = true;
            var info = ad.info;
            var p2 = info
              ? Promise.resolve(info)
              : (typeof ad.requestAdapterInfo === 'function' ? ad.requestAdapterInfo() : Promise.resolve(null));
            return p2.then(function (i2) {
              if (i2) { gpuVendor = String(i2.vendor || ''); gpuArch = String(i2.architecture || ''); }
            });
          }),
          // 超时保护：GPU 进程初始化卡住时，不能让这次 executeJavaScript（进而整个体检请求）悬挂
          new Promise(function (r) { setTimeout(r, 3000); })
        ]).catch(function () {});
      }
    } catch (e) {}

    // ---- WebAudio 完整特征：sampleRate / baseLatency / maxChannelCount / compressor.reduction ----
    // audioAvailable 标记 AudioContext 是否真的建得起来；建不起来时要让体检项「不适用」，
    // 否则哨兵值 0/-1/0 会与期望值不等，把环境限制误报成「指纹注入失败」。
    var audioAvailable = false;
    var aRate = 0, aBase = -1, aMax = 0, aRed = 0;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        var ctx = new AC();
        try {
          audioAvailable = true;
          aRate = ctx.sampleRate == null ? 0 : ctx.sampleRate;
          aBase = ctx.baseLatency == null ? -1 : ctx.baseLatency;
          aMax = ctx.destination ? ctx.destination.maxChannelCount : 0;
          var comp = ctx.createDynamicsCompressor();
          aRed = comp.reduction == null ? 0 : comp.reduction;
        } finally {
          // 立刻释放，避免体检动作残留音频上下文
          try { ctx.close(); } catch (e2) {}
        }
      }
    } catch (e) {}

    // ---- EME / Widevine：DRM 模块可用性（平台级指纹向量）----
    // 与 WebGPU 同理：异步探测须带超时，且 .then() 内要补回 try/catch，
    // 否则脱离外层保护后异常会被上层误判成「窗口未运行」。
    var emeApiPresent = false, emeWidevine = false, emeClearKey = false, emePlayReady = false
    var emeInitDataTypes: string[] = [], emeVideoCaps = 0, emeAudioCaps = 0
    var emeP = Promise.resolve()
    try {
      var rEme = (nav as any).requestMediaKeySystemAccess
      if (typeof rEme === 'function') {
        emeApiPresent = true
        var emeCfg = [{ initDataTypes: ['cenc'] }]
        var probeKs = function (ks) {
          try { return rEme.call(nav, ks, emeCfg) } catch (e) { return Promise.reject(e) }
        }
        emeP = Promise.all([
          // widevine 解析成功时回传 access 对象，用于读取 getConfiguration() 能力集
          probeKs('com.widevine.alpha').then(function (a) { return a || true }, function () { return null }),
          probeKs('org.w3.clearkey').then(function (a) { return a || true }, function () { return null }),
          probeKs('com.microsoft.playready').then(function () { return true }, function () { return false })
        ]).then(function (res) {
          emeWidevine = !!res[0]; emeClearKey = !!res[1]; emePlayReady = !!res[2]
          var access = res[0]
          if (access && typeof access.getConfiguration === 'function') {
            try {
              var cfg = access.getConfiguration()
              emeInitDataTypes = Array.isArray(cfg.initDataTypes) ? cfg.initDataTypes : []
              emeVideoCaps = Array.isArray(cfg.videoCapabilities) ? cfg.videoCapabilities.length : 0
              emeAudioCaps = Array.isArray(cfg.audioCapabilities) ? cfg.audioCapabilities.length : 0
            } catch (e2) {}
          }
        }).catch(function () {})
        // 超时保护：BrowserLeaks 式探测可能挂起，不能让体检请求悬挂
        emeP = Promise.race([emeP, new Promise(function (r2) { setTimeout(r2, 3000) })])
      }
    } catch (e) {}

    // ---- 反自动化痕迹（Tier 1 #1）----
    // navigator.webdriver 在非自动化浏览器恒为 false（iOS Safari 甚至无该属性 → !!undefined=false）；
    // cdc_ / $cdc_ 等是 CDP / ChromeDriver 注入的特征全局变量，正常环境不应存在。
    var webdriver = false, automationTraces = false
    try {
      webdriver = !!nav.webdriver
      var AUTO_GLOBALS = ['cdc_', '$cdc_', '$chrome_asyncScriptInfo', '__nightmare', 'callPhantom', '_phantom', '__phantomas', 'selenium', '__webdriver_evaluate', '__driver_evaluate', '__webdriver_script_function', '__webdriver_script_func', '__webdriver_script_fn', '__driver_unwrapped', '__webdriver_unwrapped', '__selenium_unwrapped', '__fxdriver_unwrapped', '__selenium_evaluate', '__fxdriver_evaluate']
      for (var gi = 0; gi < AUTO_GLOBALS.length; gi++) {
        if (Object.prototype.hasOwnProperty.call(window, AUTO_GLOBALS[gi])) { automationTraces = true; break }
      }
      if (!automationTraces && Object.prototype.hasOwnProperty.call(document, '$cdc_')) automationTraces = true
    } catch (e2) {}

    // 取值整体再包一层 try/catch：这段原本在外层 try 内（异常 -> {error}），
    // 搬进 .then() 后会脱离该保护，抛错将变成 rejected promise 而被上层误判成「窗口未运行」。
    return Promise.all([gpuP, emeP]).then(function () {
      try {
        return {
        userAgent: String(nav.userAgent || ''),
        platform: String(nav.platform || ''),
        language: String(nav.language || ''),
        languages: langs,
        hardwareConcurrency: nav.hardwareConcurrency == null ? 0 : nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory == null ? 0 : nav.deviceMemory,
        doNotTrack: nav.doNotTrack == null ? 'unspecified' : String(nav.doNotTrack),
        maxTouchPoints: nav.maxTouchPoints == null ? 0 : nav.maxTouchPoints,
        ontouchstart: ('ontouchstart' in window),
        devicePixelRatio: window.devicePixelRatio || 0,
        uaDataPresent: !!uad,
        uaDataPlatform: uad ? String(uad.platform || '') : '',
        uaDataMobile: uad ? !!uad.mobile : null,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        tzOffset: new Date().getTimezoneOffset(),
        timezone: String((Intl.DateTimeFormat().resolvedOptions().timeZone) || ''),
        webglVendor: String(vendor),
        webglRenderer: String(renderer),
        webglAvailable: glAvailable,
        canvasPatched: patched(HTMLCanvasElement.prototype.toDataURL),
        audioPatched: typeof AudioBuffer !== 'undefined' ? patched(AudioBuffer.prototype.getChannelData) : false,
        webrtcDisabled: (typeof window.RTCPeerConnection === 'undefined'),
        fontsGuarded: fontsGuarded,
        webGpuPresent: gpuPresent,
        webGpuAdapterAvailable: gpuAdapter,
        webGpuVendor: gpuVendor,
        webGpuArchitecture: gpuArch,
        audioSampleRate: aRate,
        audioBaseLatency: aBase,
        audioMaxChannelCount: aMax,
        audioReduction: aRed,
        audioAvailable: audioAvailable,
        emeApiPresent: emeApiPresent,
        emeWidevine: emeWidevine,
        emeClearKey: emeClearKey,
        emePlayReady: emePlayReady,
        emeInitDataTypes: emeInitDataTypes,
        emeVideoCaps: emeVideoCaps,
        emeAudioCaps: emeAudioCaps,
        webdriver: webdriver,
        automationTraces: automationTraces
      };
      } catch (e) {
        return { error: String(e) };
      }
    });
  } catch (e) {
    return { error: String(e) };
  }
})()`

/** 在指定环境窗口采集实际指纹；窗口不可用或脚本抛错时返回 null */
export async function collectProbe(win: BrowserWindow): Promise<FingerprintProbe | null> {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
    const r = (await win.webContents.executeJavaScript(PROBE_SCRIPT)) as FingerprintProbe
    if (!r || typeof r !== 'object') return null
    return r
  } catch {
    return null
  }
}
