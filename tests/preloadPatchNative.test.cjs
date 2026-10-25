// preload getter 原生性 —— **回归守卫**
//
// ## 为什么需要这个测试
//
// 2026-10-25，外部反馈 browserscan.net 检测「UserAgent 不同」固定扣 10%。
// 逆向其客户端脚本（DsSMVnXV.js）后确认根因在**我们自己的补丁**上：
// def / cover / hide 三个帮助函数用裸箭头函数做属性 getter
// （`{ get: () => value }`），toString() 报 "() => value"。
// browserscan 的门闩 Vr() 会同时读原型与实例两个属性描述符，
// 要求 getter.toString() 含 `[native code]`——一行穿帮，
// isUACorrect 恒假，服务端怎么判都救不回来（与服务端判定无关的纯客户端硬伤）。
//
// 修复：getter 一律走 patchNative 登记（toString 报
// `function get <key>() { [native code] }`）+ name 对齐原生形态。
// 这个不变量**没有任何工具能自动发现**：tsc 不检查 getter 的 toString 形态，
// eslint 不管运行时语义，浏览器外也没人能肉眼看出两串 toString 的区别意味着什么。
// 必须有一道显式闸门。
//
// 本测试双管齐下：
//   1) 行为级：从源码抽出 patchNative / def / cover / hide 四件套，
//      esbuild 转译后在 vm 沙箱真实执行，断言 toString 形态与描述符属性
//      （防回归到裸函数——这是 2026-10-25 事故的精确复现路径）；
//   2) 源码级：静态断言同族补丁（sampleRate getter / fontFamily setter /
//      plugins / mimeTypes 的 item / namedItem / 索引 / 迭代器）全部走
//      patchNative，且全文件不存在裸 descriptor getter/setter。
//
// 用法：node tests/preloadPatchNative.test.cjs
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✅', name)
  } catch (e) {
    console.error('  ❌', name)
    console.error('     ', e.message)
    process.exitCode = 1
  }
}

const SRC = path.join(__dirname, '..', 'src', 'main', 'browser-preload.ts')
const src = fs.readFileSync(SRC, 'utf8')

/**
 * 从 browser-preload.ts 抽出「补丁四件套」：patchedFns / patchNative /
 * origFnToString / patchedFlags / markPatched / def / hide / cover。
 * 这段代码自包含（只用 Object / Function / Map 与模板字符串），
 * 唯一的外部依赖是 window（__roxyPatched 暗记挂载点）——沙箱里给一个假的即可。
 *
 * 抽取边界用两个源码标记钉死：
 *   起点：patchedFns 登记表声明
 *   终点：起始页专供段落（其后的代码依赖 location / 指纹上下文，抽不出来）
 */
function extractPatchKit(source) {
  const startMarker = 'const patchedFns = new Map<Function, string>()'
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error('源码里找不到 patchedFns 声明（起点标记失效）')
  const endMarker = '// ===== 应用自身起始页专供'
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error('源码里找不到起始页专供注释（终点标记失效）')
  return source.slice(start, end)
}

t('能抽出补丁四件套代码块且非空', () => {
  const kit = extractPatchKit(src)
  assert.ok(kit.length > 800, `抽出的代码块只有 ${kit.length} 字符，抽取逻辑可能坏了`)
  assert.ok(kit.includes('const def ='), '代码块不含 def，抽取边界可能错了')
  assert.ok(kit.includes('const hide ='), '代码块不含 hide，抽取边界可能错了')
  assert.ok(kit.includes('const cover ='), '代码块不含 cover，抽取边界可能错了')
})

// esbuild 把 TS 片段转成可执行 JS（vite/electron-vite 的传递依赖，dev 环境必有）
const esbuild = require('esbuild')
const kitJs = esbuild.transformSync(extractPatchKit(src), { loader: 'ts' }).code

// 在独立上下文里执行：Function.prototype.toString 的覆写只作用于沙箱，
// 不会污染测试进程自身的 Function.prototype。
// makeFn 在沙箱内造函数——**必须在 vm 领域内创建**：测试进程里 new 的函数
// 原型链指向测试进程的 Function.prototype（未伪装），String() 会拿到真实源码。
const sandbox = { window: {} }
const kit = vm.runInNewContext(
  kitJs + '\n;({ def, cover, hide, patchNative, markPatched, patchedFlags, makeFn: (body) => new Function("return " + body)() })',
  sandbox
)

// ===== 行为级：2026-10-25 事故的精确复现路径 =====

t('def：getter toString 报原生形态（browserscan Vr() 门闩的核心判据）', () => {
  const obj = {}
  kit.def(obj, 'userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0')
  const d = Object.getOwnPropertyDescriptor(obj, 'userAgent')
  assert.ok(d && typeof d.get === 'function', 'def 应定义 get 访问器')
  assert.strictEqual(d.get.toString(), 'function get userAgent() { [native code] }',
    'getter.toString() 不是原生形态——裸函数回归了，browserscan 会判「改过」')
  assert.strictEqual(d.get.name, 'get userAgent', 'name 应对齐原生 getter 形态')
  assert.strictEqual(obj.userAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0')
  assert.strictEqual(d.enumerable, true)
  assert.strictEqual(d.configurable, true)
})

t('def：模拟 browserscan sL() 测谎——own 描述符 getter 必须含 [native code]', () => {
  // DsSMVnXV.js 的 sL(o,k)：读 own 描述符，getter.toString() 不含 [native code] 即判「改过」
  const sL = (o, k) => {
    const d = Object.getOwnPropertyDescriptor(o, k)
    return !!d && typeof d.get === 'function' && /\[native code\]/.test(d.get.toString())
  }
  const nav = {}
  kit.def(nav, 'userAgent', 'x')
  kit.def(nav, 'platform', 'Win32')
  assert.ok(sL(nav, 'userAgent'), 'own getter 的 toString 不含 [native code]，Vr() 会直接判死')
  assert.ok(sL(nav, 'platform'), 'own getter 的 toString 不含 [native code]，Vr() 会直接判死')
})

t('cover：不可枚举 + toString 原生形态 + 取值正确', () => {
  const obj = { existing: 1 }
  kit.cover(obj, 'vendor', 'NVIDIA')
  const d = Object.getOwnPropertyDescriptor(obj, 'vendor')
  assert.strictEqual(d.enumerable, false, 'cover 必须不可枚举（原生实例的 keys 通常为空）')
  assert.strictEqual(d.get.toString(), 'function get vendor() { [native code] }')
  assert.strictEqual(obj.vendor, 'NVIDIA')
  assert.deepStrictEqual(Object.keys(obj), ['existing'], 'cover 不得引入可枚举键')
})

t('hide：遮蔽原型原生属性 + toString 原生形态 + 读取得 undefined', () => {
  const proto = {}
  Object.defineProperty(proto, 'gpu', { get() { return { real: true } }, configurable: true })
  const inst = Object.create(proto)
  kit.hide(inst, 'gpu')
  const d = Object.getOwnPropertyDescriptor(inst, 'gpu')
  assert.ok(d && typeof d.get === 'function', 'hide 应定义 own get 访问器')
  assert.strictEqual(d.enumerable, false)
  assert.strictEqual(d.get.toString(), 'function get gpu() { [native code] }')
  assert.strictEqual(inst.gpu, undefined, 'hide 后读取应得 undefined')
})

t('patchNative：登记函数 toString 报原生形态，未登记函数原样返回', () => {
  const fn = kit.patchNative(kit.makeFn('function item() { return 1 }'), 'item')
  assert.strictEqual(String(fn), 'function item() { [native code] }')
  const fn2 = kit.patchNative(kit.makeFn('function namedItem() { return 2 }'), 'namedItem')
  assert.strictEqual(String(fn2), 'function namedItem() { [native code] }')
  const bare = kit.makeFn('function untouched() { return 3 }')
  assert.ok(String(bare).includes('return 3'), '未登记函数不应被伪装')
})

t('__roxyPatched 暗记：markPatched 生效且挂载点不可枚举', () => {
  kit.markPatched('canvas')
  kit.markPatched('uaCh')
  const d = Object.getOwnPropertyDescriptor(sandbox.window, '__roxyPatched')
  assert.ok(d && d.value, '__roxyPatched 暗记未挂载')
  assert.strictEqual(d.value.canvas, true)
  assert.strictEqual(d.value.uaCh, true)
  assert.strictEqual(d.enumerable, false, '暗记必须不可枚举，否则新增暴露面')
})

// ===== 源码级：同族补丁必须全部走 patchNative =====

/** 取锚点之后 span 字符内的源码窗口，在窗口内断言 pattern 命中 */
function windowAround(anchor, span = 700) {
  const idx = src.indexOf(anchor)
  assert.ok(idx >= 0, `源码中找不到锚点：${anchor}（相关补丁被删了或改名的？）`)
  return src.slice(idx, idx + span)
}

t('源码级：sampleRate getter 走 patchNative', () => {
  const win = windowAround("(BaseAudioContext as any).prototype, 'sampleRate', {")
  assert.ok(/get:\s*patchNative\(/.test(win),
    'sampleRate 的 getter 未走 patchNative——裸 getter 会被测谎直接读出')
})

t('源码级：fontFamily setter 走 patchNative', () => {
  const win = windowAround('get: famDesc.get,')
  assert.ok(/set:\s*patchNative\(/.test(win),
    'fontFamily 的 setter 未走 patchNative')
})

t('源码级：mimeTypes 伪造数组的 item / namedItem / 索引 / 迭代器全部走 patchNative', () => {
  const win = windowAround('const mimeArr')
  assert.ok(/mimeArr\.item\s*=\s*patchNative\(/.test(win), 'mimeArr.item 未走 patchNative')
  assert.ok(/mimeArr\.namedItem\s*=\s*patchNative\(/.test(win), 'mimeArr.namedItem 未走 patchNative')
  assert.ok(/get:\s*patchNative\(\(\)\s*=>\s*mimeObj/.test(win), 'mimeArr 索引 getter 未走 patchNative')
  assert.ok(/patchNative\(function\*\s*\(\)\s*\{\s*yield mimeObj/.test(win), 'mimeArr 迭代器未走 patchNative')
})

t('源码级：plugins 伪造数组的 item / namedItem / 索引 / 迭代器全部走 patchNative', () => {
  const win = windowAround('const pluginArr')
  assert.ok(/pluginArr\.item\s*=\s*patchNative\(/.test(win), 'pluginArr.item 未走 patchNative')
  assert.ok(/pluginArr\.namedItem\s*=\s*patchNative\(/.test(win), 'pluginArr.namedItem 未走 patchNative')
  assert.ok(/get:\s*patchNative\(\(\)\s*=>\s*pluginObj/.test(win), 'pluginArr 索引 getter 未走 patchNative')
  assert.ok(/patchNative\(function\*\s*\(\)\s*\{\s*yield pluginObj/.test(win), 'pluginArr 迭代器未走 patchNative')
})

t('源码级：pluginObj 的 item / namedItem 走 patchNative', () => {
  const win = windowAround('pluginObj.mimeTypes = [mimeObj]')
  assert.ok(/pluginObj\.item\s*=\s*patchNative\(/.test(win), 'pluginObj.item 未走 patchNative')
  assert.ok(/pluginObj\.namedItem\s*=\s*patchNative\(/.test(win), 'pluginObj.namedItem 未走 patchNative')
})

t('源码级：全文件不存在裸 descriptor getter/setter（新增补丁的兜底闸门）', () => {
  const bad = []
  src.split('\n').forEach((line, idx) => {
    const n = idx + 1
    const trimmed = line.trim()
    if (/get:\s*\(\)\s*=>/.test(line)) bad.push(`行${n} 裸箭头 getter: ${trimmed.slice(0, 80)}`)
    if (/get:\s*function\b/.test(line)) bad.push(`行${n} 裸函数 getter: ${trimmed.slice(0, 80)}`)
    if (/set:\s*function\b/.test(line)) bad.push(`行${n} 裸函数 setter: ${trimmed.slice(0, 80)}`)
    if (/^get\s*\(/.test(trimmed)) bad.push(`行${n} 方法简写 getter: ${trimmed.slice(0, 80)}`)
    if (/^set\s*\(/.test(trimmed)) bad.push(`行${n} 方法简写 setter: ${trimmed.slice(0, 80)}`)
  })
  assert.strictEqual(bad.length, 0, '发现未走 patchNative 的属性访问器：\n      ' + bad.join('\n      '))
})

console.log(`\npreloadPatchNative: ${passed} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
