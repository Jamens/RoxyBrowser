/**
 * 清理 out/ 陈旧构建产物。
 *
 * 背景：electron.vite.config.ts 刻意设了 `emptyOutDir: false`——
 * 「避免批量删除（CI / 受限环境下可能无删除权限）」。代价是每次构建都留下新的
 * hash 文件、旧的永不清理：实测 out/renderer/assets 累积到 1155 个文件 / 302MB，
 * 其中 140 个是废弃的 index-*.js chunk。
 *
 * 因此这里**不粗暴翻 emptyOutDir**（会破坏受限环境假设），而是做精确回收：
 * 从当前构建产物（index.html / main 入口）出发，递归解析可达的 chunk 引用，
 * 只删除**证明不可达**的文件。默认 dry-run，必须显式 --apply 才真删。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'out')
const apply = process.argv.includes('--apply')

/** 当前构建的入口文件（这些一定不能删） */
const ENTRIES = [
  path.join(outDir, 'renderer', 'index.html'),
  path.join(outDir, 'main', 'index.js'),
  path.join(outDir, 'main', 'browser-preload.js'),
  path.join(outDir, 'preload', 'index.js')
]

// 匹配产物里的资源引用："./assets/x.js" / "./chunks/x.js" / "assets/x.css" 等。
// 注意：扩展名必须包含在捕获组内，否则解析出的路径缺 .js，existsSync 全部失败
// → 可达集只剩入口文件，会把所有合法路由 chunk 误判为陈旧并删除。
const REF_RE =
  /["'`]((?:\.{1,2}\/|(?:assets|chunks)\/)[^"'`\s)]+\.(?:js|mjs|cjs|css|json|map|woff2?|ttf|eot|png|jpe?g|gif|svg|ico))["'`]/g

const reachable = new Set()
const queue = []
const unresolved = []

function addFile(abs) {
  if (!abs.startsWith(outDir)) return
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return
  if (reachable.has(abs)) return
  reachable.add(abs)
  queue.push(abs)
}

function scan(abs) {
  let content
  try {
    content = fs.readFileSync(abs, 'utf8')
  } catch {
    return
  }
  const base = path.dirname(abs)
  let m
  REF_RE.lastIndex = 0
  while ((m = REF_RE.exec(content)) !== null) {
    const ref = m[1] // 含扩展名，如 ./assets/index-DAt3AIey.js
    // index.html 里可能是 "./assets/x.js"，JS 里可能是 "assets/x.js" 或 "/assets/x.js"
    const candidates = [
      path.resolve(base, ref),
      path.resolve(base, ref.replace(/^\//, '')),
      path.join(outDir, 'renderer', ref.replace(/^\//, ''))
    ]
    const hit = candidates.find((c) => c.startsWith(outDir) && fs.existsSync(c) && fs.statSync(c).isFile())
    if (hit) addFile(hit)
    // 形如 ../../resources/tray.png 的引用指向 app 资源目录（在 out/ 之外），
    // 本来就不该在 out/ 里找到，不算异常，排除以免误报
    else if (!ref.startsWith('..')) unresolved.push({ from: path.relative(root, abs), ref })
  }
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

if (!fs.existsSync(outDir)) {
  console.log('out/ 不存在，无需清理')
  process.exit(0)
}

for (const e of ENTRIES) addFile(e)
while (queue.length) scan(queue.shift())

// 兜底：可达集异常小说明解析失败（例如正则漏掉扩展名会导致只剩入口文件），绝不删除。
// 一次真实构建至少包含 入口 + preload + 若干路由 chunk + vendor 等，阈值取 20。
const MIN_REACHABLE = 20
if (unresolved.length) {
  console.log(`未能解析的引用 ${unresolved.length} 条，示例：`)
  for (const u of unresolved.slice(0, 5)) console.log(`  ${u.from} → ${u.ref}`)
}
if (reachable.size < MIN_REACHABLE) {
  console.error(
    `\n可达文件仅 ${reachable.size} 个（阈值 ${MIN_REACHABLE}），疑似引用解析失败，已中止（未删除任何文件）`
  )
  process.exit(1)
}

const all = walk(outDir)
const stale = all.filter((f) => !reachable.has(f))
// reachable 是 Set，all/stale 是数组，统一展开
const bytes = (files) => [...files].reduce((s, f) => s + fs.statSync(f).size, 0)
const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB'

console.log(`out/ 总文件 ${all.length}（${mb(bytes(all))}）`)
console.log(`当前构建可达 ${reachable.size}（${mb(bytes(reachable))}）`)
console.log(`可清理陈旧 ${stale.length}（${mb(bytes(stale))}）`)
console.log(`模式：${apply ? '--apply 真删' : 'dry-run（加 --apply 才会删除）'}`)

if (stale.length === 0) {
  console.log('\n没有陈旧产物')
  process.exit(0)
}

console.log('\n前 15 个待清理示例：')
for (const f of stale.slice(0, 15)) console.log('  ' + path.relative(root, f))

if (!apply) {
  console.log('\n（dry-run，未删除）')
  process.exit(0)
}

let ok = 0
let err = 0
for (const f of stale) {
  try {
    fs.unlinkSync(f)
    ok++
  } catch (e) {
    err++
    console.warn('  删除失败：' + path.relative(root, f) + ' → ' + e.message)
  }
}
console.log(`\n已删除 ${ok} 个（失败 ${err}）`)
const after = walk(outDir)
console.log(`清理后：${after.length} 个文件，${mb(bytes(after))}`)
