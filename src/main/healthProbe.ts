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
      fontsGuarded: fontsGuarded
    };
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
