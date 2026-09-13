// DOM/无障碍树提取（Route A 感知层之一）
// 在环境窗口的 webContents 里执行一段提取脚本，返回「可交互元素 + 中心坐标」，
// 坐标与 capturePage 截图像素 1:1，供 VLM 直接给出可点击坐标。
import type { BrowserWindow } from 'electron'
import type { DomSnapshot } from './types'

// 用字符串函数注入，避免依赖外部作用域；脚本自身带 try/catch 兜底
const DOM_SCRIPT = `(function(){
  try {
    var sel = 'a,button,input,textarea,select,[role=button],[contenteditable=true],label';
    var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    var out = [];
    var vw = window.innerWidth, vh = window.innerHeight;
    for (var i=0;i<nodes.length;i++){
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width===0 && r.height===0) continue;
      // 视口外的元素跳过，避免坐标越界误导 VLM
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      var text = (el.textContent||el.value||el.getAttribute('placeholder')||el.getAttribute('aria-label')||'').trim().slice(0,60);
      out.push({ tag: el.tagName.toLowerCase(), text: text, x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height) });
    }
    out.sort(function(a,b){ return (b.w*b.h)-(a.w*a.h); });
    return { url: location.href, title: document.title, vw: vw, vh: vh, els: out.slice(0,80) };
  } catch(e){
    return { url: location.href, title: document.title, vw: window.innerWidth, vh: window.innerHeight, els: [], error: String(e) };
  }
})()`

export async function extractDom(win: BrowserWindow): Promise<DomSnapshot> {
  try {
    const result = (await win.webContents.executeJavaScript(DOM_SCRIPT)) as DomSnapshot
    return result
  } catch {
    return { url: '', title: '', vw: 0, vh: 0, els: [], error: 'DOM 提取失败' }
  }
}
