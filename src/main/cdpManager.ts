import { app } from 'electron'
import { createServer } from 'net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  buildCdpEndpoint,
  clampPort,
  DEFAULT_CDP_PORT,
  findAvailablePort,
  pickPageTargets,
  type CdpInfo,
  type CdpTarget
} from '../shared/cdp'

/**
 * CDP（Chrome DevTools Protocol）调试端口管理器。
 *
 * ## 形态说明（与市面产品的关键差异）
 * 市面上的指纹浏览器多为「每环境一个独立 Chrome 进程 → 每环境一个调试端口」，
 * 外部工具用 `connectOverCDP('http://127.0.0.1:<该环境端口>')` 直连单个环境。
 *
 * 本项目是 Electron 应用：环境窗口是**同一个 Chromium 实例内的 BrowserWindow**，
 * 而 `remote-debugging-port` 是**进程级命令行开关**（app ready 前设置一次即全局生效），
 * 没有「每窗口一个端口」这种东西。因此本实现是：
 *
 *   1 个 CDP 端点  →  多个 target（每个环境窗口一个）  →  通过 page 内的
 *   `window.__roxyProfileId` 求值，把 target 精确映射回环境 id。
 *
 * 外部工具连一次端点即可看到全部环境窗口，按 target 的 profileId 区分。
 *
 * ## 安全
 * CDP 端点等同于**完整浏览器控制权**：可读取页面、执行脚本、注入 Cookie。
 * 因此：
 *   - **只监听 127.0.0.1**（不开 0.0.0.0），局域网内其他机器无法连接；
 *   - 默认**关闭**，需用户在设置页显式开启；
 *   - 开启状态会被写进操作日志（属敏感操作），便于审计。
 */

const CDP_INFO_FILE = 'cdp-info.json'
/**
 * CDP 开关的**本地**配置文件。
 *
 * ## 为什么开关不能存在数据库里（本功能最 tricky 的一点）
 * `app.commandLine.appendSwitch` 必须在 `app.whenReady()` **之前**调用，而
 * `whenReady` 里才连 MySQL（bootstrap）——**读到设置的那一刻数据库还连不上**。
 * 若开关存在 `app_settings` 表，启动时序就成了死结：
 *   要读设置 → 需要 DB → 需要 whenReady → 但 whenReady 之前就得设好命令行开关。
 *
 * 解法：CDP 开关读本地文件（与 `jwt-secret` / `secret-key` 同目录，同属「影响启动的本地配置」），
 * `app_settings` 里也存一份供设置页展示，但**运行时只认本地文件**。
 * 设置页保存时两处一起写，本地文件是权威来源。
 */
const CDP_CONFIG_FILE = 'cdp-config.json'
/** 外部工具拉取 target 列表时的超时；过短会在 Electron 繁忙时误报 */
const TARGET_FETCH_TIMEOUT = 5000

let enabled = false
let configuredPort = 39222
/** app.commandLine 实际生效的端口（可能被占用后顺延） */
let activePort: number | null = null

/**
 * 实际探测：bind 到 127.0.0.1，成功即认为空闲。
 *
 * 为什么放在 main 而不是 shared：设置页要 import shared/cdp 取类型与常量，
 * 而 `net` 是 Node 模块，进 renderer 会被 vite 判为浏览器不兼容而构建失败。
 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    // 只监听回环：CDP 端点等同于完整浏览器控制权，绝不能暴露到局域网
    srv.listen(port, '127.0.0.1')
  })
}

function infoDir(): string {
  return join(homedir(), '.roxy-clone')
}

export interface CdpConfig {
  enabled: boolean
  port: number
}

/** 读本地配置（app ready 之前可用：纯文件 IO，不依赖 DB） */
export function readCdpConfig(): CdpConfig {
  try {
    const file = join(infoDir(), CDP_CONFIG_FILE)
    if (!existsSync(file)) return { enabled: false, port: DEFAULT_CDP_PORT }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CdpConfig>
    return { enabled: !!parsed.enabled, port: clampPort(parsed.port) }
  } catch {
    // 配置损坏时按「关闭」处理：宁可用户用不了 CDP，也不能因一个坏文件意外开启调试端口
    return { enabled: false, port: DEFAULT_CDP_PORT }
  }
}

/** 写本地配置（设置页保存时调用） */
export function writeCdpConfig(cfg: CdpConfig): void {
  const dir = infoDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, CDP_CONFIG_FILE), JSON.stringify(cfg, null, 2), 'utf8')
}

/**
 * 在 app ready 之前调用：把 remote-debugging-port 写进命令行。
 *
 * **必须在 app.whenReady() 之前调用**，否则 Chromium 已初始化，开关不生效。
 * 这是 Electron 文档明确要求的时机约束。
 *
 * 注意：只设端口、不设 host，Chromium 默认监听 127.0.0.1。若将来有人改成
 * `--remote-debugging-address=0.0.0.0`，等于把全部环境的控制权暴露到局域网，
 * 属于严重安全问题，改动前务必三思。
 */
export function applyCdpCommandLine(enabledFlag: boolean, preferredPort: number): void {
  if (!enabledFlag) return
  app.commandLine.appendSwitch('remote-debugging-port', String(clampPort(preferredPort)))
}

export function setCdpEnabled(flag: boolean): void {
  enabled = flag
}

export function setCdpPort(port: number): void {
  configuredPort = clampPort(port)
}

/**
 * 在 app ready 后确定实际端口并落盘。
 *
 * 为什么需要「确定实际端口」：Chromium 自己也会在被占用时**静默顺延**或直接不启动，
 * 我们无法从命令行开关的设置值推断出它最终用了哪个。做法是自己先 bind 探测，
 * 抢到一个确定空闲的端口再告诉 Chromium —— 这让「设置值」与「实际值」始终一致，
 * 外部工具读取 `cdp-info.json` 拿到的就是可信值。
 */
export async function finalizeCdpPort(): Promise<void> {
  if (!enabled || activePort !== null) return
  try {
    const port = await findAvailablePort(configuredPort, probePort)
    activePort = port
    // 若探测结果与命令行里写的不同（探测时被别人抢占），此时改写还来得及
    if (port !== configuredPort) {
      app.commandLine.appendSwitch('remote-debugging-port', String(port))
    }
    const dir = infoDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, CDP_INFO_FILE),
      JSON.stringify({ endpoint: buildCdpEndpoint(port), port }, null, 2),
      'utf8'
    )
    console.log(`[roxy] CDP 调试端口已开启：${buildCdpEndpoint(port)}（外部自动化工具连接此地址）`)
  } catch (e) {
    console.error('[roxy] CDP 端口初始化失败，本次不开启调试端口:', (e as Error).message)
  }
}

/** CDP HTTP 端点的 target 列表（Chromium 的 /json/list 协议格式） */
interface RawTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/** 用 WebSocket 发一条 CDP 命令并等回复 */
function cdpEvaluate(wsUrl: string, expression: string): Promise<{ result?: { value?: unknown }; error?: unknown }> {
  return new Promise((resolve, reject) => {
    // Node 20+ 内置 WebSocket；Electron 主进程即 Node 环境，无需额外依赖
    const WS = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocket }).WebSocket
    if (!WS) {
      reject(new Error('当前运行环境不支持 WebSocket'))
      return
    }
    const ws = new WS(wsUrl)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error('CDP 求值超时'))
    }, TARGET_FETCH_TIMEOUT)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败'))
    }
    ws.onmessage = (ev) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(String(ev.data)))
      } catch (e) {
        reject(e as Error)
      } finally {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }
  })
}

/**
 * 枚举当前所有环境窗口对应的 target，并把 targetId 映射回 profileId。
 *
 * 映射靠 page 内的 `window.__roxyProfileId`（由 browser-preload 注入）。
 * 逐个 target 建 WebSocket 求值——target 数量等于用户打开的环境数（通常个位数），
 * 开销可接受；求值失败只标记 profileId 为 null，不影响其他 target。
 */
export async function listCdpTargets(): Promise<{ targets: CdpTarget[]; error?: string }> {
  if (!enabled || activePort === null) return { targets: [], error: 'CDP 未启用' }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TARGET_FETCH_TIMEOUT)
    const res = await fetch(`${buildCdpEndpoint(activePort)}/json/list`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { targets: [], error: `CDP 返回 ${res.status}` }
    const raw = (await res.json()) as RawTarget[]
    const pages = raw.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)

    const resolved = await Promise.all(
      pages.map(async (t): Promise<CdpTarget> => {
        const base: CdpTarget = { id: t.id, type: t.type, title: t.title || '', url: t.url || '', profileId: null }
        try {
          const r = await cdpEvaluate(t.webSocketDebuggerUrl!, 'window.__roxyProfileId ?? null')
          const v = (r as { result?: { value?: unknown } })?.result?.value
          base.profileId = typeof v === 'number' ? v : null
        } catch {
          /* 求值失败：该 target 未能归属到环境，保留 null */
        }
        return base
      })
    )
    return { targets: pickPageTargets(resolved) }
  } catch (e) {
    return { targets: [], error: (e as Error).message }
  }
}

/** 组装对外的连接信息（供自动化 API 返回） */
export async function getCdpInfo(): Promise<CdpInfo> {
  const port = activePort ?? configuredPort
  const base = {
    enabled,
    endpoint: enabled && activePort !== null ? buildCdpEndpoint(activePort) : '',
    port,
    usage: {
      playwright: `const browser = await chromium.connectOverCDP('${buildCdpEndpoint(port)}')`,
      puppeteer: `const browser = await puppeteer.connect({ browserURL: '${buildCdpEndpoint(port)}' })`
    }
  }
  if (!enabled) return { ...base, targets: [], targetsError: 'CDP 未启用（设置 → 调试端口 可开启）' }
  const { targets, error } = await listCdpTargets()
  return { ...base, targets, ...(error ? { targetsError: error } : {}) }
}
