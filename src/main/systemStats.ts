// 系统资源采集（顶栏 CPU / 内存占用展示用）
//
// CPU：os.cpus() 返回每个核心累计的时间片，取两次采样的差值算占用率。
// 这套在 Windows / macOS / Linux 上行为一致，无需分支。
//
// 内存：各平台口径不一样，不能一概用 os.freemem() ——
// - Windows：os.freemem() 来自 GlobalMemoryStatusEx，就是「可用物理内存」，准确。
// - Linux：  os.freemem() 近似 MemAvailable，误差可接受。
// - macOS：  os.freemem() 返回「真正空闲」的页，而 macOS 会把大量内存拿去做
//            文件缓存，free 几乎常年只剩几百 MB —— 直接算会常年显示 90%+，
//            和活动监视器对不上。必须用 vm_stat 的 available 口径：
//            可用 = (free + inactive + speculative) × 页大小，used = total - 可用。
//            注意 Apple Silicon 的页大小是 16384 不是 4096，要从 vm_stat 输出里解析。
import os from 'os'
import { execFile } from 'child_process'

// 采样间隔：太短读数抖动，太长反应迟钝。2s 与前端轮询节奏一致。
const SAMPLE_MS = 2000

function readCpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

let prevCpu = readCpuTimes()
let lastCpuPct = 0
let sampler: NodeJS.Timeout | null = null

/** 惰性启动常驻采样器：没人问就不空转，问过一次后保持 2s 一采 */
function ensureSampler() {
  if (sampler) return
  sampler = setInterval(() => {
    const cur = readCpuTimes()
    const dTotal = cur.total - prevCpu.total
    const dIdle = cur.idle - prevCpu.idle
    if (dTotal > 0) {
      lastCpuPct = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))
    }
    prevCpu = cur
  }, SAMPLE_MS)
  // 不因这个定时器阻止进程退出
  sampler.unref()
}

// ---- macOS：vm_stat 结果缓存几秒，避免每次轮询都 spawn 子进程 ----
const DARWIN_TTL = 4000
let darwinCache: { at: number; used: number } | null = null

/**
 * 解析 vm_stat 输出，返回已用内存。抽成纯函数是为了可单测 ——
 * 本项目没有 mac 环境，正则写错只有上线到 Mac 才会暴露。
 */
export function parseVmStat(stdout: string, total: number): number | null {
  // 首行形如 "Mach Virtual Memory Statistics: (page size of 16384 bytes)"；
  // Apple Silicon 页大小是 16384，Intel 是 4096，不能写死
  const sizeMatch = stdout.match(/page size of (\d+)/i)
  const pageSize = sizeMatch ? Number(sizeMatch[1]) : 4096
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const pages = (label: string) => {
    const m = stdout.match(new RegExp(label + ':\\s+(\\d+)'))
    return m ? Number(m[1]) : 0
  }
  // 输出里根本没有这些行（macOS 版本差异 / 输出被截断）时判定为解析失败，
  // 让调用方退回 os.freemem()，避免算出 used=total 的假 100%
  if (!/Pages free:/.test(stdout)) return null
  const availPages =
    pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')
  return Math.max(0, total - availPages * pageSize)
}

function darwinMemory(): Promise<number | null> {
  if (darwinCache && Date.now() - darwinCache.at < DARWIN_TTL) {
    return Promise.resolve(darwinCache.used)
  }
  return new Promise((resolve) => {
    execFile('vm_stat', { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null)
      const used = parseVmStat(String(stdout), os.totalmem())
      if (used === null) return resolve(null)
      darwinCache = { at: Date.now(), used }
      resolve(used)
    })
  })
}

export interface SystemStats {
  /** 全核 CPU 占用率 0-100（取整） */
  cpu: number
  /** 已用内存（字节） */
  memUsed: number
  /** 物理内存总量（字节） */
  memTotal: number
  /** 内存占用率 0-100（取整） */
  memPct: number
}

export async function getSystemStats(): Promise<SystemStats> {
  ensureSampler()
  const memTotal = os.totalmem()
  let memUsed: number
  if (process.platform === 'darwin') {
    const d = await darwinMemory()
    // vm_stat 解析失败才退回 os.freemem()（读数会偏高，但好过显示 0）
    memUsed = d ?? memTotal - os.freemem()
  } else {
    memUsed = memTotal - os.freemem()
  }
  return {
    cpu: Math.round(lastCpuPct),
    memUsed,
    memTotal,
    memPct: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
  }
}
