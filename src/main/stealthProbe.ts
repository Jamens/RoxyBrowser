// 反检测审计 —— 窗口内探针（在环境窗口的 webContents 里执行）
//
// ## 为什么要单独写一个探针
//
// 现有 `healthProbe.ts` 是「自己出题自己判卷」：拿设定值对撞回读值。
// 本探针是**外部检测视角**：采集第三方检测站（BrowserLeaks / CreepJS /
// PixelScan 那类）真正会读、并且会互相交叉验证的那些向量，然后交给
// `shared/stealthAudit.ts` 判定「这个浏览器整体像不像一台真实存在的电脑」。
//
// 采集原则：**只采外部能读到的东西**。
// 凡是页面 JS 能读到的，这里都要能读到；凡是页面读不到的（内部状态、
// 主进程数据），采了也没意义，反而会让人误以为「外部能看到这个」。
//
// 用法：作为字符串注入 executeJavaScript，返回一个可 JSON 序列化的对象。
import type { BrowserWindow } from 'electron'
import type { StealthProbe } from '../shared/stealthAudit'

/**
 * 窗口内探针脚本（IIFE 字符串）。
 *
 * 设计要点：
 *   1. **自带 try/catch**：任何一项失败都不影响其余项（与 healthProbe 同思路）。
 *   2. **iframe 探测用 srcdoc**：srcdoc 的 iframe 与父页面同源，且不触发
 *      跨域限制，页面可以读到它的 navigator——这正是检测站测「跨 frame
 *      一致性」的标准手法。
 *   3. **canvas / audio 各读两次**：测熵稳定性（真实浏览器同会话内恒定）。
 *   4. **toString 取样要覆盖所有被改过的入口**：matchMedia / getParameter /
 *      getExtension / toDataURL / getImageData / fonts.check / speechSynthesis.getVoices
 *      等——凡是能改函数的地方，检测站都可能测谎。
 */
export const STEALTH_PROBE_SCRIPT = `(function(){
  function safe(fn, dflt) {
    try { var v = fn(); return (v === undefined || v === null) ? dflt : v; }
    catch (e) { return dflt; }
  }
  function safeStr(fn) { var v = safe(fn, ''); return v === undefined ? '' : String(v); }
  function safeBool(fn) { try { return !!fn(); } catch (e) { return false; } }
  function safeNum(fn) { try { var v = fn(); return typeof v === 'number' && isFinite(v) ? v : 0; } catch (e) { return 0; } }

  var nav = navigator, win = window, doc = document;
  var out = {};

  // ---------- 身份三元组 ----------
  out.userAgent = safeStr(function(){ return nav.userAgent; });
  out.appVersion = safeStr(function(){ return nav.appVersion; });
  out.vendor = safeStr(function(){ return nav.vendor; });
  out.platform = safeStr(function(){ return nav.platform; });
  out.oscpu = safeStr(function(){ return nav.oscpu; });
  out.productSub = safeStr(function(){ return nav.productSub; });
  out.buildId = safeStr(function(){ return nav.buildID; });

  // ---------- UA-CH ----------
  try {
    var uad = nav.userAgentData;
    out.uaDataPresent = !!uad;
    if (uad) {
      out.uaDataPlatform = safeStr(function(){ return uad.platform; });
      out.uaDataMobile = uad.mobile === undefined ? null : !!uad.mobile;
      out.uaDataBrands = [];
      try {
        var bs = uad.brands || [];
        for (var i = 0; i < bs.length; i++) {
          out.uaDataBrands.push(String(bs[i].brand || '') + '/' + String(bs[i].version || ''));
        }
      } catch (e2) { out.uaDataBrands = []; }
      out.uaDataFullVersion = '';
      // getHighEntropyValues 是异步的，这里不取——UA 串的大版本已够做交叉验证，
      // 异步取会把这个同步探针变成异步，徒增失败面。
    } else {
      out.uaDataPlatform = '';
      out.uaDataMobile = null;
      out.uaDataBrands = [];
    }
  } catch (e) {
    out.uaDataPresent = false;
    out.uaDataPlatform = '';
    out.uaDataMobile = null;
    out.uaDataBrands = [];
  }

  // ---------- 语言 / 时区 ----------
  out.language = safeStr(function(){ return nav.language; });
  out.languages = [];
  try {
    var ls = nav.languages || [];
    for (var j = 0; j < ls.length; j++) out.languages.push(String(ls[j]));
  } catch (e3) { out.languages = []; }

  out.intlTimeZone = '';
  out.intlLocale = '';
  try {
    var ro = new Intl.DateTimeFormat().resolvedOptions();
    out.intlTimeZone = String(ro.timeZone || '');
    out.intlLocale = String(ro.locale || '');
  } catch (e4) { /* ignore */ }

  // Intl 构造器本身的「行为保真度」：
  // 我们为了注入默认 locale 包了一层 Intl.DateTimeFormat，包装器最容易丢的是
  // ① 静态方法 supportedLocalesOf（丢了 → 页面一调用就是 TypeError，浏览器直接坏掉）；
  // ② 「必须用 new 调用」这个约束（不还原 → 检测站一句 Intl.DateTimeFormat() 就看穿）。
  // 这两项与「伪装得像不像」无关，但**坏了就是破绽**，故一并采集。
  out.intlSupportedLocalesOk = false;
  try {
    var slo = Intl.DateTimeFormat.supportedLocalesOf;
    out.intlSupportedLocalesOk = typeof slo === 'function' && Array.isArray(slo.call(Intl.DateTimeFormat, ['en-GB']));
  } catch (e6) { out.intlSupportedLocalesOk = false; }
  out.intlRequiresNew = false;
  try {
    // @ts-ignore 故意不带 new 调用
    Intl.DateTimeFormat();
    out.intlRequiresNew = false;   // 没抛 → 约束没还原
  } catch (e7) {
    out.intlRequiresNew = true;    // 抛了 → 与原生一致
  }

  out.tzOffset = safeNum(function(){ return new Date().getTimezoneOffset(); });
  // Date.prototype.toString() 里的时区名：形如 "... GMT+0800 (China Standard Time)"
  out.dateStringTzName = '';
  try {
    var ds = new Date().toString();
    var m = ds.match(/GMT[+-]\\d{1,2}(?::?\\d{2})?\\s*\\([^)]*\\)/);
    out.dateStringTzName = m ? m[0] : '';
    if (!out.dateStringTzName) {
      // 有的实现不带括号，只取 GMT 偏移段
      var m2 = ds.match(/GMT[+-]\\d{1,2}(?::?\\d{2})?/);
      out.dateStringTzName = m2 ? m2[0] : '';
    }
  } catch (e5) { /* ignore */ }

  // ---------- 屏幕 / 视口 ----------
  out.screenWidth = safeNum(function(){ return win.screen.width; });
  out.screenHeight = safeNum(function(){ return win.screen.height; });
  out.availWidth = safeNum(function(){ return win.screen.availWidth; });
  out.availHeight = safeNum(function(){ return win.screen.availHeight; });
  out.outerWidth = safeNum(function(){ return win.outerWidth; });
  out.outerHeight = safeNum(function(){ return win.outerHeight; });
  out.innerWidth = safeNum(function(){ return win.innerWidth; });
  out.innerHeight = safeNum(function(){ return win.innerHeight; });
  out.devicePixelRatio = safeNum(function(){ return win.devicePixelRatio; });

  // ---------- 硬件 ----------
  out.hardwareConcurrency = safeNum(function(){ return nav.hardwareConcurrency; });
  out.deviceMemory = safeNum(function(){ return nav.deviceMemory; });
  out.maxTouchPoints = safeNum(function(){ return nav.maxTouchPoints; });
  out.ontouchstart = safeBool(function(){ return 'ontouchstart' in win; });

  // ---------- 自动化痕迹 ----------
  out.webdriver = safeBool(function(){ return nav.webdriver; });
  out.automationGlobals = [];
  try {
    var AUTO = ['cdc_','$cdc_','$chrome_asyncScriptInfo','__nightmare','callPhantom','_phantom',
      '__phantomas','selenium','__webdriver_evaluate','__driver_evaluate','__webdriver_script_function',
      '__webdriver_script_func','__webdriver_script_fn','__driver_unwrapped','__webdriver_unwrapped',
      '__selenium_unwrapped','__fxdriver_unwrapped','__selenium_evaluate','__fxdriver_evaluate',
      '__playwright','__pw_manual','__PW_inspect','_WEBDRIVER_ELEM_CACHE','__driver_evaluate',
      'calledSelenium','__nightmare_electron','$wdc_'];
    for (var k = 0; k < AUTO.length; k++) {
      if (Object.prototype.hasOwnProperty.call(win, AUTO[k])) out.automationGlobals.push(AUTO[k]);
    }
    if (Object.prototype.hasOwnProperty.call(doc, '$cdc_')) out.automationGlobals.push('document.$cdc_');
  } catch (e6) { /* ignore */ }
  out.chromeObjectPresent = safeBool(function(){ return !!win.chrome; });

  // ---------- 原生性测谎：取各被改入口的 toString ----------
  out.toStringSamples = {};
  function ts(key, fn) {
    try {
      if (typeof fn !== 'function') { out.toStringSamples[key] = ''; return; }
      out.toStringSamples[key] = Function.prototype.toString.call(fn);
    } catch (e7) {
      out.toStringSamples[key] = '';
    }
  }
  ts('window.matchMedia', win.matchMedia);
  ts('Function.prototype.toString', Function.prototype.toString);
  ts('navigator.permissions.query', nav.permissions && nav.permissions.query);
  ts('HTMLCanvasElement.toDataURL', win.HTMLCanvasElement && win.HTMLCanvasElement.prototype.toDataURL);
  ts('CanvasRenderingContext2D.getImageData', win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype.getImageData);
  ts('WebGLRenderingContext.getParameter', win.WebGLRenderingContext && win.WebGLRenderingContext.prototype.getParameter);
  ts('WebGLRenderingContext.getExtension', win.WebGLRenderingContext && win.WebGLRenderingContext.prototype.getExtension);
  ts('document.fonts.check', doc.fonts && doc.fonts.check);
  ts('speechSynthesis.getVoices', win.speechSynthesis && win.speechSynthesis.getVoices);
  ts('Date.prototype.getTimezoneOffset', Date.prototype.getTimezoneOffset);
  ts('Intl.DateTimeFormat.resolvedOptions', win.Intl && win.Intl.DateTimeFormat && win.Intl.DateTimeFormat.prototype.resolvedOptions);
  ts('navigator.geolocation.getCurrentPosition', nav.geolocation && nav.geolocation.getCurrentPosition);
  ts('RTCPeerConnection', win.RTCPeerConnection);
  ts('navigator.mediaDevices.enumerateDevices', nav.mediaDevices && nav.mediaDevices.enumerateDevices);

  // ---------- 原生性测谎：穷尽扫描（比手写取样列表更抗退化）----------
  //
  // 手写取样列表永远会漏——2026-10-25 的 browserscan 事故与本次发现的
  // matchMedia / speechSynthesis / geolocation 三处漏网，都是「列表里没有」。
  // 故这里遍历**所有**关键原型的全部函数，逐个 toString 检查。
  // 将来新增任何补丁，只要忘了 patchNative，这里必然报出来。
  //
  // 代价是每次审计多扫约 150 个函数（毫秒级），完全可接受。
  out.lieScan = { scanned: 0, leaked: [] };
  try {
    var seenProtos = {};
    function scanProto(label, obj) {
      var proto = null;
      try { proto = obj ? Object.getPrototypeOf(obj) : null; } catch (e) { return; }
      if (!proto || seenProtos[label]) return;
      seenProtos[label] = true;
      var keys = [];
      try { keys = Object.getOwnPropertyNames(proto); } catch (e) { return; }
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        var d = null;
        try { d = Object.getOwnPropertyDescriptor(proto, k); } catch (e) { continue; }
        if (!d) continue;
        var fn = d.get || (typeof d.value === 'function' ? d.value : null);
        if (typeof fn !== 'function') continue;
        var src = '';
        try { src = Function.prototype.toString.call(fn); } catch (e) { continue; }
        out.lieScan.scanned++;
        // 我们装的 getter 形态是 "function get xxx() { [native code] }"，
        // 同样含 [native code]，故统一用 native 判据即可。
        if (!/\\[native code\\]/i.test(src)) {
          if (out.lieScan.leaked.length < 30) {
            out.lieScan.leaked.push(label + '.' + k + ' → ' + src.replace(/\\s+/g, ' ').slice(0, 110));
          }
        }
      }
    }
    scanProto('Navigator', nav);
    scanProto('Screen', win.screen);
    scanProto('Window', win);
    scanProto('Date', Date);
    scanProto('Intl.DateTimeFormat', win.Intl && win.Intl.DateTimeFormat);
    scanProto('HTMLCanvasElement', win.HTMLCanvasElement);
    scanProto('CanvasRenderingContext2D', win.CanvasRenderingContext2D);
    scanProto('WebGLRenderingContext', win.WebGLRenderingContext);
    scanProto('Geolocation', nav.geolocation);
    scanProto('SpeechSynthesis', win.speechSynthesis);
    scanProto('MediaDevices', nav.mediaDevices);
    scanProto('FontFaceSet', doc.fonts);
    scanProto('Function', Function);
  } catch (e23) { /* ignore */ }

  // ---------- 跨 frame 一致性（srcdoc iframe，与父同源）----------
  out.iframePresent = false;
  out.iframeUserAgent = '';
  out.iframeWebdriver = false;
  try {
    var ifr = doc.createElement('iframe');
    ifr.setAttribute('srcdoc', '<!doctype html><meta charset="utf-8"><title>probe</title>');
    // 挂到文档上才会真正加载
    (doc.body || doc.documentElement).appendChild(ifr);
    out.iframePresent = true;
    var cw = ifr.contentWindow;
    if (cw) {
      try { out.iframeUserAgent = String(cw.navigator.userAgent || ''); } catch (e8) { /* ignore */ }
      try { out.iframeWebdriver = !!cw.navigator.webdriver; } catch (e9) { /* ignore */ }
    }
    try { ifr.parentNode.removeChild(ifr); } catch (e10) { /* ignore */ }
  } catch (e11) { /* ignore */ }

  // ---------- 原型 getter 绕过（检测站最常用的一手）----------
  // 从 Navigator.prototype 取原生 getter 再 .call(navigator)，
  // 绕开实例上的 own getter 遮罩。若伪装只做在实例上，这里会拿到宿主真身。
  out.protoBypass = {
    platform: '',
    languages: [],
    hardwareConcurrency: 0,
    deviceMemory: 0,
    navigatorOwnKeys: [],
    screenOwnKeys: [],
    windowOwnKeys: [],
    windowOwnKeysExtra: []
  };
  try {
    var NavProto2 = win.Navigator && win.Navigator.prototype;
    if (NavProto2) {
      var dPlat = Object.getOwnPropertyDescriptor(NavProto2, 'platform');
      if (dPlat && typeof dPlat.get === 'function') {
        out.protoBypass.platform = String(dPlat.get.call(nav) || '');
      }
      var dLangs = Object.getOwnPropertyDescriptor(NavProto2, 'languages');
      if (dLangs && typeof dLangs.get === 'function') {
        var pl = dLangs.get.call(nav) || [];
        for (var pi = 0; pi < pl.length; pi++) out.protoBypass.languages.push(String(pl[pi]));
      }
      var dCores = Object.getOwnPropertyDescriptor(NavProto2, 'hardwareConcurrency');
      if (dCores && typeof dCores.get === 'function') {
        out.protoBypass.hardwareConcurrency = Number(dCores.get.call(nav)) || 0;
      }
      var dMem = Object.getOwnPropertyDescriptor(NavProto2, 'deviceMemory');
      if (dMem && typeof dMem.get === 'function') {
        out.protoBypass.deviceMemory = Number(dMem.get.call(nav)) || 0;
      }
    }
  } catch (e20) { /* ignore */ }
  try {
    // 真实 Chrome 的 navigator / screen 自有键均为空
    out.protoBypass.navigatorOwnKeys = Object.keys(nav).slice(0, 50);
  } catch (e21) { /* ignore */ }
  try {
    out.protoBypass.screenOwnKeys = Object.keys(win.screen).slice(0, 30);
  } catch (e22) { /* ignore */ }
  try {
    // window 的可枚举自有键：真实 Chromium 有一份约 50 项的清单
    // （Window 接口上 [LegacyUnforgeable] 的属性，按 WebIDL 就是全局对象自己的
    //  可枚举属性），**不是空的**。所以不能断言「必须为空」——
    // 基于错误前提的规则比没有规则更糟：它会一直误报，直到被人习惯性忽略。
    //
    // 正确判据是「比注入前的基线多了什么」——基线由 preload 在伪装前拍下，
    // 放在 window.__roxyWindowOwnKeys（不可枚举，不进 Object.keys）。
    // 这样规则与 Chromium 版本无关（基线来自同一个浏览器自己），也不会误报。
    var baseline = null;
    try {
      var b = win.__roxyWindowOwnKeys;
      if (b && typeof b.length === 'number') baseline = Array.prototype.slice.call(b);
    } catch (e25) { baseline = null; }
    var cur = Object.keys(win);
    out.protoBypass.windowOwnKeys = cur.slice(0, 50);
    if (baseline) {
      var baseSet = {};
      for (var bi = 0; bi < baseline.length; bi++) baseSet[baseline[bi]] = true;
      var extra = [];
      for (var ci = 0; ci < cur.length; ci++) {
        if (!baseSet[cur[ci]]) extra.push(cur[ci]);
      }
      out.protoBypass.windowOwnKeysExtra = extra.slice(0, 30);
    }
  } catch (e26) { /* ignore */ }

  // ---------- 熵：canvas / audio 各读两次 ----------
  function canvasHash() {
    try {
      var c = doc.createElement('canvas');
      c.width = 240; c.height = 60;
      var g = c.getContext('2d');
      if (!g) return '';
      g.textBaseline = 'top';
      g.font = "16px 'Arial'";
      g.fillStyle = '#f60'; g.fillRect(10, 5, 120, 30);
      g.fillStyle = '#069'; g.fillText('fingerprint-probe \\u4e2d\\u6587', 12, 20);
      g.beginPath(); g.arc(60, 40, 18, 0, Math.PI * 2); g.fill();
      var d = c.toDataURL();
      // 取中段做摘要：完整 dataURL 太长，且尾部 PNG 块对指纹无意义
      return d.slice(24, 120) + '|' + String(d.length);
    } catch (e12) { return ''; }
  }
  function audioHash() {
    try {
      var AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return '';
      var ctx = new AC();
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      var comp = ctx.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ctx.destination);
      osc.start(0);
      var outp = [ctx.sampleRate, ctx.destination.maxChannelCount];
      try { outp.push(comp.reduction); } catch (e13) {}
      try { ctx.close(); } catch (e14) {}
      return outp.join(',');
    } catch (e15) { return ''; }
  }
  out.canvasHash1 = canvasHash();
  out.canvasHash2 = canvasHash();
  out.audioHash1 = audioHash();
  out.audioHash2 = audioHash();

  // ---------- 平台 API 矩阵 ----------
  out.platformApis = [];
  try {
    if (nav.bluetooth) out.platformApis.push('bluetooth');
    if (nav.usb) out.platformApis.push('usb');
    if (nav.serial) out.platformApis.push('serial');
    if (nav.hid) out.platformApis.push('hid');
    if (nav.nfc) out.platformApis.push('nfc');
  } catch (e16) { /* ignore */ }

  // ---------- 能力 ----------
  out.webGpuPresent = safeBool(function(){ return !!nav.gpu; });
  out.emePresent = safeBool(function(){ return typeof nav.requestMediaKeySystemAccess === 'function'; });

  // ---------- 「这个 API 存在吗」：用 in 判定，而不是读值 ----------
  //
  // 关键区别：真实 iOS Safari 里**根本没有** navigator.userAgentData。
  // 检测站查的不只是「读出来是不是 undefined」，还有
  // 「'userAgentData' in navigator」是不是 false。
  // 若只是把原型上的 getter 改成返回 undefined，in 判定仍是 true —— 一样露馅。
  // 故这里必须用 in 判定，把「存在」与「读出 undefined」分开记。
  out.apiPresence = {};
  try {
    var CHECK = ['userAgentData', 'gpu', 'requestMediaKeySystemAccess', 'webdriver',
                 'bluetooth', 'usb', 'serial', 'hid', 'nfc', 'deviceMemory'];
    for (var ai = 0; ai < CHECK.length; ai++) {
      out.apiPresence[CHECK[ai]] = (CHECK[ai] in nav);
    }
  } catch (e17) { /* ignore */ }

  // ---------- 字体：声称可用但测不出宽度差 = 只报不真屏蔽 ----------
  out.fontCount = 0;
  out.fontMismatchCount = 0;
  try {
    var probeFonts = ['Arial','Times New Roman','Courier New','Verdana','Tahoma','Georgia',
      'Helvetica','Comic Sans MS','Impact','Trebuchet MS','SimSun','SimHei','Microsoft YaHei',
      'PingFang SC','Helvetica Neue','Segoe UI','Calibri','Cambria','Consolas','Menlo','Monaco'];
    var measureCtx = doc.createElement('canvas').getContext('2d');
    for (var fi = 0; fi < probeFonts.length; fi++) {
      var fname = probeFonts[fi];
      var claimed = false;
      try { claimed = !!(doc.fonts && doc.fonts.check && doc.fonts.check('12px "' + fname + '"')); } catch (e17) {}
      if (!claimed) continue;
      out.fontCount++;
      if (measureCtx) {
        try {
          measureCtx.font = '12px "' + fname + '"';
          var w1 = measureCtx.measureText('mmmmmmmmmmlli').width;
          measureCtx.font = '12px monospace';
          var w2 = measureCtx.measureText('mmmmmmmmmmlli').width;
          measureCtx.font = '12px "' + fname + '"';
          var w3 = measureCtx.measureText('mmmmmmmmmmlli').width;
          // 与通用等宽完全一致 → 极可能该字体并不存在（回退到了 monospace）
          if (Math.abs(w1 - w2) < 0.01 && Math.abs(w3 - w1) < 0.01) out.fontMismatchCount++;
        } catch (e18) {}
      }
    }
  } catch (e19) { /* ignore */ }

  return out;
})()`

/**
 * 在指定环境窗口采集反检测审计向量；窗口不可用或脚本抛错时返回 null。
 *
 * 与 `healthProbe.collectProbe` 同样的错误处理口径：
 * 失败时把原始错误带回来（而不是静默吞成 null），
 * 否则路由只能报「窗口未运行」，真实原因（渲染进程崩了 / 页面正在导航）全被掩盖。
 */
export async function collectStealthProbe(win: BrowserWindow): Promise<StealthProbe | null> {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
    const r = (await win.webContents.executeJavaScript(STEALTH_PROBE_SCRIPT)) as StealthProbe
    if (!r || typeof r !== 'object') return null
    return r
  } catch (e) {
    const msg = (e as Error)?.message || String(e)
    console.error('[roxy] 反检测探针执行失败:', msg)
    return null
  }
}
