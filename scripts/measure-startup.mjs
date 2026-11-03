/**
 * 启动耗时实测：多次冷启动应用，收集主进程打点，输出各阶段中位数。
 *
 * 为什么必须多次取中位数：单次启动受磁盘缓存、MySQL 连接抖动、杀软扫描影响极大，
 * 拿单次数��当结论等于没测。默认 5 次取中位数，同时给出最小/最大以暴露抖动幅度。
 *
 * 用法：node scripts/measure-startup.mjs [--runs=5]
 *
 * 前置：先 pnpm build（打点代码在主进程产物里）。
 * 注意：Electron 宿主若设了 ELECTRON_RUN_AS_NODE=1，必须清掉——否则 Electron 会
 * 退化成纯 Node，主进程在 ipcMain 处直接崩（本仓库 VERIFY.md 有记录）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'out', 'main', 'index.js')
const electronBin = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

const runs = Number(
  process.argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) || 5
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(entry)) {
  console.error('未找到构建产物：' + entry + '\n请先执行 pnpm build')
  process.exit(1)
}

async function measureOnce(i) {
  const out = path.join(os.tmpdir(), `roxy-startup-measure-${process.pid}-${i}.json`)
  if (fs.existsSync(out)) fs.unlinkSync(out)

  const env = { ...process.env, ROXY_MEASURE_STARTUP: '1', ROXY_MEASURE_OUT: out }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(electronBin, [entry], { env, stdio: 'ignore' })
  const deadline = Date.now() + 90_000
  let data = null
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(out)) {
        await sleep(200)
        try {
          data = JSON.parse(fs.readFileSync(out, 'utf8'))
          // 主进程在 ready-to-show 后 3s 会写一份兜底快照，可能早于「首屏有内容」
          // 标记落盘；读到兜底版本时继续等，避免把不完整的数据当成结论。
          const m = data.marks || {}
          if (m.firstContent || m.firstContentTimeout) break
        } catch {
          /* 文件可能还在写，继续等 */
        }
      }
      await sleep(100)
    }
  } finally {
    child.kill()
    // 等进程真正退出再进下一轮：单实例锁未释放时，第二个实例会直接 quit
    await new Promise((r) => {
      child.on('exit', r)
      setTimeout(r, 5000)
    })
    await sleep(800)
  }
  if (!data) throw new Error('第 ' + (i + 1) + ' 次测量超时（90s 未产出 trace）')
  try { fs.unlinkSync(out) } catch { /* ignore */ }
  return data
}

const STAGES = [
  ['appReady', 'Electron 就绪'],
  ['apiReady', '本地 API + MySQL 就绪'],
  ['windowCreate', '主窗口创建'],
  ['readyToShow', '窗口 ready-to-show'],
  ['windowShown', '窗口显示'],
  ['rendererLoaded', '渲染层 load 完成'],
  ['firstContent', '首屏有内容']
]

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

console.log(`启动耗时实测（${runs} 次冷启动，取中位数）\n`)
const results = []
for (let i = 0; i < runs; i++) {
  process.stdout.write(`  第 ${i + 1} 次…`)
  const d = await measureOnce(i)
  results.push(d)
  console.log(` appReady=${d.marks.appReady}ms apiReady=${d.marks.apiReady}ms firstContent=${d.marks.firstContent}ms`)
}

const last = results[results.length - 1]
console.log('\n环境：Electron ' + last.electron + ' · Chromium ' + last.chrome + ' · Node ' + last.node)
console.log('\n阶段'.padEnd(26) + '中位数'.padStart(8) + '最小'.padStart(8) + '最大'.padStart(8) + '   （毫秒，相对进程启动）')
console.log('─'.repeat(58))
for (const [key, label] of STAGES) {
  const vals = results.map((r) => r.marks[key]).filter((v) => typeof v === 'number')
  if (!vals.length) {
    console.log(label.padEnd(24) + '   （未采集）')
    continue
  }
  console.log(
    label.padEnd(24) +
    String(median(vals)).padStart(8) +
    String(Math.min(...vals)).padStart(8) +
    String(Math.max(...vals)).padStart(8)
  )
}

console.log('\n说明：')
console.log('  · appReady      —— Node/Electron 初始化完成（此前的耗时是进程自身启动开销）')
console.log('  · apiReady      —— 本地 API 监听就绪 + MySQL 连接建立（环境变量/服务已就绪）')
console.log('  · firstContent  —— 主窗口首屏渲染出内容（用户真正看到界面的时刻）')
console.log('  · 测量含 MySQL 连接时间，与生产环境同路径；换机器复测需在同条件下对比')
