/**
 * CDP 调试端口的**纯逻辑**（主进程 / 渲染进程共用）。
 *
 * ⚠️ 本文件必须保持**零 Node 依赖**：设置页（renderer）会 import 它的类型与常量，
 * 一旦引入 `net` / `fs` 等 Node 模块，vite 会把 renderer 构建打挂
 * （"Module net has been externalized for browser compatibility"）。
 * 因此端口探测（`probePort`，依赖 Node 的 `net`）放在 `main/cdpManager.ts` 里。
 */

export const DEFAULT_CDP_PORT = 39222

/** 端口上限：留出足够扫描空间，又不至于扫到高位端口区 */
export const MAX_CDP_PORT = 40000

/**
 * 找出一个可用的端口：从 preferred 起递增，最多试 maxAttempts 次。
 *
 * 端口探测必须**真正 bind 一次再释放**，不能只看「这个端口号没人提过」——
 * 探测与实际 bind 之间存在 TOCTOU 窗口，可能被别的进程抢占。
 * 但我们只能缩小这个窗口，无法根除（这是所有「自动选端口」方案的共同限制）；
 * 真正的兜底是 Electron 启动失败时的错误提示。
 */
export function findAvailablePort(preferred: number, isPortFree: (port: number) => Promise<boolean>): Promise<number> {
  return (async () => {
    const start = clampPort(preferred)
    for (let port = start; port < Math.min(start + 100, MAX_CDP_PORT); port++) {
      // eslint-disable-next-line no-await-in-loop
      if (await isPortFree(port)) return port
    }
    // 首选段扫完还没空位：再回到默认端口起点试一轮（避免用户填了高位端口时无处可用）
    for (let port = DEFAULT_CDP_PORT; port < Math.min(DEFAULT_CDP_PORT + 100, MAX_CDP_PORT); port++) {
      // eslint-disable-next-line no-await-in-loop
      if (await isPortFree(port)) return port
    }
    throw new Error(`未找到可用端口（已扫描到 ${MAX_CDP_PORT}）`)
  })()
}

/** 把任意输入规整到合法端口：整数、去掉 Windows 保留的 0 号（表示随机） */
export function clampPort(input: unknown): number {
  const n = Number(input)
  if (!Number.isFinite(n)) return DEFAULT_CDP_PORT
  const int = Math.trunc(n)
  if (int < 1 || int > MAX_CDP_PORT) return DEFAULT_CDP_PORT
  return int
}

/**
 * CDP 返回的 target 类型。`page` 是有独立 URL 的标签页/窗口，
 * `background_page` / `service_worker` 等对用户无意义，过滤掉。
 */
export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  /** 由 CDP 侧求值得到的环境 id；未能识别时为 null */
  profileId: number | null
}

/** 外部工具连接所需的信息 */
export interface CdpInfo {
  enabled: boolean
  /** 形如 http://127.0.0.1:39222 —— Playwright 的 connectOverCDP / Puppeteer 的 browserURL 直接用它 */
  endpoint: string
  port: number
  /** 实际生效的端口（可能被占用后自动顺延，与用户设置值不一定相同） */
  targets: CdpTarget[]
  targetsError?: string
  usage: {
    playwright: string
    puppeteer: string
  }
}

export function buildCdpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** 过滤出可交互的 page target */
export function pickPageTargets(targets: CdpTarget[]): CdpTarget[] {
  return targets.filter((t) => t.type === 'page')
}
