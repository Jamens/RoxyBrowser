import type { FingerprintProbe } from '../shared/healthcheck'
import type { ScanResult } from './fingerprintScan'

/**
 * 浏览器窗口桥：由 main 进程在启动后注入到 server。
 *
 * 抽成独立模块的原因：v1 自动化 API 拆到routes/v1.ts 后需要引用这个类型，
 * 而 `BrowserBridge` 原本定义在 server.ts —— routes 反向 import server
 * 会形成运行时循环依赖（server → routes/v1 → server）。
 * 接口无运行时副作用，纯类型 + 零依赖，两边都能安全 import。
 *
 * 实际实例仍是 server.ts 里的 `browserBridge`（`let`，由 setBrowserBridge 赋值）。
 */
export interface BrowserBridge {
  openWindow(profileId: number): Promise<void>
  closeWindow(profileId: number): Promise<void>
  /** 环境体检：在目标窗口内采集实际生效的指纹值，窗口未运行返回 null */
  probeFingerprint(profileId: number): Promise<FingerprintProbe | null>
  /** 环境截图：截取运行中环境窗口当前视口，返回 PNG Buffer，窗口未运行抛错 */
  captureScreenshot(profileId: number): Promise<Buffer>
  /** 在线检测站实战验证：导航到第三方检测站并抓回文本与截图，窗口未运行抛错 */
  scanSite(profileId: number, siteId: string): Promise<ScanResult>
}
