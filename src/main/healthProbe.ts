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

    // 取值整体再包一层 try/catch：这段原本在外层 try 内（异常 -> {error}），
    // 搬进 .then() 后会脱离该保护，抛错将变成 rejected promise 而被上层误判成「窗口未运行」。
    return gpuP.then(function () {
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
        audioAvailable: audioAvailable
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
