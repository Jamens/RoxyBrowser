import { Router, type Response, type NextFunction, type Request } from 'express'
import crypto from 'crypto'
import type { DataSource } from 'typeorm'
import { ApiTokenEntity, AppSettingsEntity } from '../entities'
import { testWebhook, setCachedWebhooks } from '../webhook'
import { clampPort } from '../../shared/cdp'
import { getCdpInfo, readCdpConfig, writeCdpConfig, type CdpConfig } from '../cdpManager'
import { normalizeCountry } from '../../shared/countries'
import { normalizeLocale } from '../../shared/locales'
import type { AppSettings, SearchEngine, WebhookConfig } from '../../shared/types'
// 仅类型导入：编译期完全擦除，不会与 server.ts 形成运行时循环依赖
import type { AuthedRequest } from '../authScope'
import { ownerScope } from '../authScope'

/**
 * 设置域路由（API 令牌 / 全局设置 / CDP 调试端口 / Webhook 测试）。
 *
 * 从 server.ts 抽离。这几个域放在一起是因为它们共享同一条约束：
 * 都写 `app_settings` 单例行、都要走凭据加解密收口、都要触发「设置变更后
 * 重启各类调度器」的副作用——拆开反而会让这条副作用散落。
 */

export interface SettingsRouteDeps {
  /** 取 DataSource 的**函数**：`AppDataSource` 是运行时赋值的 export let */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /** 读取合并后的全局设置（内部已做凭据解密） */
  getSettings: () => Promise<AppSettings>
  /** 落库前加密设置内的凭据字段（JSON 列用不了 ORM Transformer，只能在写入点收口） */
  encryptSettingsSecrets: <T extends Record<string, unknown>>(settings: T) => T
  /** 设置保存后重启代理巡检 / 调度器 */
  restartSchedulers: () => void
  defaultSettings: AppSettings
  /** 搜索引擎白名单归一化；非法值返回 undefined，调用方回落默认 */
  normalizeSearchEngine: (v: unknown) => SearchEngine | undefined
}

export function registerSettingsRoutes(router: Router, deps: SettingsRouteDeps): void {
  const {
    getDs,
    authMiddleware,
    writeLog,
    getSettings,
    encryptSettingsSecrets,
    restartSchedulers,
    defaultSettings,
    normalizeSearchEngine
  } = deps

  // ===== API 令牌 =====
  router.get('/tokens', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ApiTokenEntity)
    res.json(await repo.find({ where: ownerScope(req) }))
  })

  router.post('/tokens', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ApiTokenEntity)
    const token = 'rb_' + crypto.randomBytes(24).toString('hex')
    const t = await repo.save(repo.create({ teamId: req.tid!, ownerId: req.uid!, name: req.body?.name || '默认令牌', token }))
    await writeLog(req, 'create_token', `创建 API 令牌「${t.name}」`)
    res.json(t)
  })

  router.delete('/tokens/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ApiTokenEntity)
    const t = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (t) await repo.remove(t)
    res.json({ ok: true })
  })

  // ===== 全局设置（单例，key='global'）=====
  router.get('/settings', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    // 复用 getSettings 走同一条解密路径，避免「读接口与内部调用解密行为不一致」
    res.json(await getSettings())
  })

  router.put('/settings', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(AppSettingsEntity)
    const merged = { ...defaultSettings, ...(req.body || {}) } as Record<string, unknown>
    // 国家 / 语言走白名单：非法值直接回落默认，避免把脏数据写进 JSON 列
    // （theme.ts 与 i18n 都按这些值取时区与词典，脏值会导致界面/主题取不到而崩溃）
    const country = normalizeCountry(merged.country as string) || defaultSettings.country
    const language = normalizeLocale(merged.language as string) || defaultSettings.language
    merged.country = country
    merged.language = language
    // 搜索引擎同样走白名单：脏值会让起始页拼出错误的搜索 URL
    merged.searchEngine = normalizeSearchEngine(merged.searchEngine) || defaultSettings.searchEngine
    // AI Agent 子对象深合并默认值：UI 仅暴露部分字段，避免未展示字段被覆盖成 undefined
    if (merged.aiAgent && typeof merged.aiAgent === 'object') {
      merged.aiAgent = { ...defaultSettings.aiAgent, ...(merged.aiAgent as Record<string, unknown>) }
    }
    let row = await repo.findOne({ where: { key: 'global' } })
    // 落库前加密凭据字段（JSON 列无 Transformer，只能在此收口）
    const toPersist = encryptSettingsSecrets(merged)
    if (!row) row = repo.create({ key: 'global', settings: toPersist })
    else row.settings = toPersist
    await repo.save(row)
    // 设置变更后刷新 webhook 内存缓存（避免每次事件查库）并重启各类调度器
    setCachedWebhooks(Array.isArray(merged.webhooks) ? (merged.webhooks as WebhookConfig[]) : [])
    restartSchedulers()
    res.json({ ok: true, settings: merged })
  })

  // ===== CDP 调试端口设置 =====
  // 读：与本地配置文件（权威来源）合并返回，让设置页展示真实生效值
  router.get('/cdp', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    const cfg = readCdpConfig()
    res.json({ ok: true, enabled: cfg.enabled, port: cfg.port, info: await getCdpInfo() })
  })

  // 写：同时落「本地文件 + app_settings」。
  // 本地文件是运行时权威来源（app ready 前读不到 DB），app_settings 只是让设置页能回显。
  // **需重启应用生效**：Chromium 的命令行开关无法在运行时更改。
  router.put('/cdp', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const cfg: CdpConfig = {
      enabled: !!req.body?.enabled,
      port: clampPort(req.body?.port)
    }
    writeCdpConfig(cfg)
    // 同步一份到 app_settings，供设置页下次进入时读取（与本地文件可能因外部手改而不一致，
    // 故读取接口以本地文件为准，这里只是冗余留档）
    const repo = getDs().getRepository(AppSettingsEntity)
    const row = (await repo.findOne({ where: { key: 'global' } })) || repo.create({ key: 'global', settings: {} })
    row.settings = { ...(row.settings as Record<string, unknown>), cdpEnabled: cfg.enabled, cdpPort: cfg.port }
    await repo.save(row)
    // 开启 CDP 属敏感操作：端点等同于完整浏览器控制权，必须留痕
    await writeLog(
      req,
      cfg.enabled ? 'enable_cdp' : 'disable_cdp',
      `${cfg.enabled ? '开启' : '关闭'} CDP 调试端口（端口 ${cfg.port}，仅 127.0.0.1 可访问）${cfg.enabled ? '，需重启应用生效' : ''}`
    )
    res.json({ ok: true, enabled: cfg.enabled, port: cfg.port, restartRequired: true })
  })

  // Webhook 发送测试：用前端传入的配置单发一次，返回投递结果（不写入持久化）
  router.post('/webhooks/test', authMiddleware, async (req: Request, res: Response) => {
    const wh = (req.body && (req.body as { webhook?: WebhookConfig }).webhook) || null
    if (!wh || !wh.url) {
      res.status(400).json({ message: '缺少 webhook 配置或 url' })
      return
    }
    // 测试时不强制要求 enabled（便于在未启用状态下验证地址/密钥）
    const result = await testWebhook(wh)
    res.json({ ok: result.ok, status: result.status, error: result.error })
  })
}
