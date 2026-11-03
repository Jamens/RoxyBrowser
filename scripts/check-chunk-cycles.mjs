/**
 * 渲染层 chunk 循环依赖检测 —— **构建产物守卫**
 *
 * ## 为什么需要它
 *
 * 2026-11-04 发现：打包后主窗口**白屏**，控制台报
 *   Uncaught ReferenceError: Cannot access 'FastColor' before initialization
 * 根因是 `manualChunks` 把 `@rc-component/color-picker`（vendor 块）与
 * `@ant-design/fast-color`（antd 块）拆到了不同 chunk，而这两个 chunk 之间
 * 又存在反向依赖 → **跨块循环**。ESM 循环下先执行的 chunk 访问另一 chunk
 * 尚未初始化的导出，直接 TDZ。
 *
 * 为什么难发现：dev 模式走 esbuild 预打包（每个模块独立），**不暴露**这个问题；
 * 只有 `pnpm build` 后的 file:// 加载才会白屏，而白屏本身没有任何报错指向
 * chunk 拆分。且调整 manualChunks 是「优化首屏体积」的常规操作——**改一次就可能
 * 再踩一次**。
 *
 * 故把「产物 chunk 图无环」变成一道显式闸门：改完 manualChunks 跑一次即可。
 *
 * 用法：node scripts/check-chunk-cycles.mjs   （需先 pnpm build）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = path.join(root, 'out', 'renderer', 'assets')

if (!fs.existsSync(assetsDir)) {
  console.error('未找到构建产物：' + assetsDir + '\n请先执行 pnpm build')
  process.exit(1)
}

const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))

/**
 * chunk → 它依赖的 chunk 集合。
 * 分两张图，因为**静态循环与动态循环的危险性完全不同**：
 *   静态 import 循环 → 致命。一个 chunk 执行到一半 import 另一个，后者又 import
 *     回来访问尚未初始化的导出 → TDZ（Cannot access X before initialization），
 *     直接白屏；
 *   动态 import 循环 → 通常安全。动态 import 是异步边界，被 import 的 chunk 在
 *     触发时早已完成初始化。入口 chunk 动态 import 页面 chunk、页面 chunk 反向
 *     import 入口的共享工具，是 React Router 懒加载的正常形态。
 */
const staticGraph = new Map()
const dynamicGraph = new Map()
const STATIC_RE = /(?:from\s*|export\s*[^"']*from\s*)["']\.\/([^"']+\.js)["']/g
const DYNAMIC_RE = /import\s*\(\s*["']\.\/([^"']+\.js)["']\s*\)/g

for (const f of files) {
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  const s = new Set()
  const d = new Set()
  let m
  STATIC_RE.lastIndex = 0
  while ((m = STATIC_RE.exec(src))) {
    if (files.includes(m[1])) s.add(m[1])
  }
  DYNAMIC_RE.lastIndex = 0
  while ((m = DYNAMIC_RE.exec(src))) {
    if (files.includes(m[1])) d.add(m[1])
  }
  staticGraph.set(f, [...s])
  dynamicGraph.set(f, [...d])
}

/** DFS 找环，返回环路径（首尾同一点） */
function findCycle(graph) {
  const state = new Map() // 0 未访问 / 1 在栈中 / 2 已完成
  const stack = []
  let cycle = null

  const dfs = (node) => {
    if (cycle) return
    state.set(node, 1)
    stack.push(node)
    for (const next of graph.get(node) || []) {
      const st = state.get(next) || 0
      if (st === 1) {
        cycle = stack.slice(stack.indexOf(next)).concat(next)
        return
      }
      if (st === 0) dfs(next)
      if (cycle) return
    }
    stack.pop()
    state.set(node, 2)
  }

  for (const node of graph.keys()) {
    if (!state.get(node)) dfs(node)
    if (cycle) break
  }
  return cycle
}

const staticCycle = findCycle(staticGraph)
const dynamicCycle = findCycle(dynamicGraph)
console.log('渲染层 chunk：' + files.length + ' 个')

if (staticCycle) {
  console.error('\n❌ 检测到跨 chunk 静态循环依赖（会触发 TDZ → 打包后主窗口白屏）：')
  staticCycle.forEach((c, i) => console.error('   ' + (i === 0 ? '┌' : i === staticCycle.length - 1 ? '└' : '├') + '─ ' + c))
  console.error('\n修法：把环上的包归入同一个 chunk，或把被两边共享的那个包单独成块')
  console.error('（见 electron.vite.config.ts 的 manualChunks）。')
  process.exit(1)
}
console.log('✅ 无跨 chunk 静态循环依赖（TDZ 风险已排除）')

if (dynamicCycle) {
  console.log('\n⚠️ 存在跨 chunk 动态循环（异步边界，通常安全）：')
  dynamicCycle.forEach((c, i) => console.log('   ' + (i === 0 ? '┌' : i === dynamicCycle.length - 1 ? '└' : '├') + '─ ' + c))
  console.log('   这是懒加载页面 chunk 反向 import 入口共享工具的正常形态；')
  console.log('   若日后出现白屏且栈里指向这些 chunk，再回来查。')
}

