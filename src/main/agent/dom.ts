// DOM/无障碍树提取（Route A 感知层之一）
// 在环境窗口的 webContents 里执行一段提取脚本，返回「可交互元素 + 中心坐标」，
// 坐标与 capturePage 截图像素 1:1，供 VLM 直接给出可点击坐标。
import type { BrowserWindow } from 'electron'
import type { DomSnapshot } from './types'

// 用字符串函数注入，避免依赖外部作用域；脚本自身带 try/catch 兜底
const DOM_SCRIPT = `(function(){
  try {
    // 生成稳定 CSS 选择器：优先 id / name / placeholder / role，否则回退到 nth-of-type 路径。
    // 用于把 Agent 的视口像素点击归一化为 RPA 步骤（replay 时走 document.querySelector）。
    function getSel(el){
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + el.id;
      var segs = [];
      var node = el;
      for (var depth=0; depth<4 && node && node.nodeType===1; depth++){
        var tag = node.tagName.toLowerCase();
        var attr = '';
        if (node.getAttribute){
          var nm = node.getAttribute('name');
          var tp = node.getAttribute('type');
          var ph = node.getAttribute('placeholder');
          var role = node.getAttribute('role');
          if (nm) attr = '[name="'+nm+'"]';
          else if (tag==='input' && tp) attr = '[type="'+tp+'"]';
          else if (ph) attr = '[placeholder="'+ph+'"]';
          else if (role) attr = '[role="'+role+'"]';
        }
        var parent = node.parentNode;
        var nth = 1;
        if (parent && parent.children){
          var same = 0;
          for (var i=0;i<parent.children.length;i++){
            var c = parent.children[i];
            if (c.tagName && c.tagName.toLowerCase()===tag) same++;
            if (c===node) nth = same;
          }
        }
        segs.unshift(tag + attr + ':nth-of-type(' + nth + ')');
        node = parent;
      }
      return segs.join(' > ');
    }
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
      out.push({ tag: el.tagName.toLowerCase(), text: text, x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), sel: getSel(el) });
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
