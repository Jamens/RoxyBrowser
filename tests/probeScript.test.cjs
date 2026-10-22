// 指纹探针脚本 —— **语法守卫**
//
// ## 为什么需要这个测试
//
// PROBE_SCRIPT 是一段**要注入浏览器执行**的 JS，但它在源码里是**模板字符串**。
// 这意味着：TypeScript 不检查它、eslint 不 lint 它、tsc 不报错、
// 任何离线单测也不会碰到它 —— 整个工具链对它**完全失明**。
//
// 后果已经付出过代价：2026-09-25 的提交把 TypeScript 类型标注写进了脚本
// （`var emeInitDataTypes: string[] = []` 与 `(nav as any).xxx`），
// 在浏览器里是**语法错误** → `executeJavaScript` 抛
// "Script failed to execute" → **环境体检（伪装度评分）整个功能静默失效 27 天**，
// 而项目里没有任何一处报错。
//
// 所以必须有一道显式闸门：**把脚本抽出来做一次真实语法解析**。
// 本测试不需要 Electron，Node 的 `new Function` 就能做解析。
//
// 用法：node tests/probeScript.test.cjs
const assert = require('assert')
const fs = require('fs')
const path = require('path')

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

/**
 * 从 healthProbe.ts 里抽出 PROBE_SCRIPT 的**真实运行时字符串**。
 *
 * 不能简单地按行截取——脚本内部含转义反引号（`\``），
 * 按行找结尾会截错位置；也不能直接用正则 `[\s\S]*?` 匹配到首个反引号，
 * 同样会被内部的转义反引号带偏。
 * 正确做法是**逐字符扫描并跟踪转义**。
 */
function extractProbeScript(src) {
  const marker = 'const PROBE_SCRIPT = `'
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('源码里找不到 PROBE_SCRIPT 声明')
  let i = start + marker.length
  let raw = ''
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      raw += src[i] + src[i + 1]
      i++
      continue
    }
    if (ch === '`') break
    raw += ch
  }
  // 还原模板字面量的转义
  return raw.replace(/\\`/g, '`').replace(/\\\\/g, '\\').replace(/\\\$/g, '$')
}

const SRC = path.join(__dirname, '..', 'src', 'main', 'healthProbe.ts')
const src = fs.readFileSync(SRC, 'utf8')
const code = extractProbeScript(src)

t('能抽出探针脚本且非空', () => {
  assert.ok(code.length > 1000, `抽出的脚本只有 ${code.length} 字符，抽取逻辑可能坏了`)
  assert.ok(code.includes('navigator'), '脚本内容不含 navigator，抽取位置可能不对')
})

t('探针脚本是合法的 JavaScript（这是最重要的一条）', () => {
  // new Function 只做解析，不执行——正是我们要的：
  // 语法错误会在这里抛出来，而运行期错误要等到真实浏览器里才会暴露。
  try {
    new Function(code)
  } catch (e) {
    // 定位到具体行，方便修
    const vm = require('vm')
    let where = ''
    try {
      new vm.Script(code, { filename: 'probe.js' })
    } catch (err) {
      where = '\n' + err.stack.split('\n').slice(0, 4).join('\n')
    }
    throw new Error('探针脚本存在语法错误：' + e.message + where)
  }
})

t('脚本里不含 TypeScript 类型标注（这类东西在浏览器里是语法错误）', () => {
  const bad = []
  code.split('\n').forEach((line, idx) => {
    // 类型标注：var x: string = ...
    if (/:\s*(string|number|boolean|any|unknown|void|Record|Array)\b/.test(line)) {
      bad.push('行' + (idx + 1) + ' 类型标注: ' + line.trim().slice(0, 80))
    }
    // as 断言：(x as any).y
    if (/\bas\s+(any|unknown|string|number|boolean|[A-Z][A-Za-z]*)\b/.test(line)) {
      bad.push('行' + (idx + 1) + ' as 断言: ' + line.trim().slice(0, 80))
    }
    // 泛型：new Map<string, number>()
    if (/<[A-Za-z][A-Za-z0-9]*(\[\])?(,\s*[A-Za-z][A-Za-z0-9]*(\[\])?)?>/.test(line)) {
      bad.push('行' + (idx + 1) + ' 泛型: ' + line.trim().slice(0, 80))
    }
  })
  assert.strictEqual(bad.length, 0, '脚本里混进了 TypeScript 语法：\n      ' + bad.join('\n      '))
})

t('脚本自带 try/catch 兜底（运行期错误应返回 { error } 而不是让整个探针失败）', () => {
  assert.ok(/catch\s*\([^)]*\)\s*\{[^}]*return\s*\{\s*error\s*:/.test(code),
    '探针脚本末尾应有一层 catch 返回 { error: String(e) }')
})

t('脚本返回的对象包含体检报告依赖的字段', () => {
  // buildHealthReport 依赖这些键，缺一个就会出现"永远判不合格"或恒为 undefined
  const required = [
    'userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory',
    'webglVendor', 'webglRenderer', 'audioSampleRate', 'webdriver'
  ]
  const missing = required.filter((k) => !code.includes(k + ':'))
  assert.strictEqual(missing.length, 0, '探针未返回这些字段：' + missing.join(', '))
})

console.log(`\nprobeScript: ${passed} passed, ${process.exitCode ? '有失败' : '0 failed'}`)
