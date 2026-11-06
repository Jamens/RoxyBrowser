import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { AssistantSkillEntity } from '../entities'
import type { AuthedRequest } from '../authScope'
import {
  checkOllamaStatus,
  ollamaChat,
  listOllamaModels,
  getCapabilitiesOfInstalled,
  listModelsWithCapability,
  type OllamaMessage
} from '../agent/ollama'
import { cloudChat, checkCloudStatus } from '../agent/cloud'
import { buildSupportSystemPrompt } from '../agent/knowledge'
import { planAssistant, executeAssistantAction, runSkillPlan, type PlannerCtx } from '../assistantPlanner'
import type { Plan } from '../../shared/assistantPlan'
import { DEFAULT_SETTINGS, type AppSettings, type AIAgentSettings } from '../../shared/types'
import {
  findSameBaseModel,
  supportsVision,
  supportsChat,
  describeModalityMismatch
} from '../../shared/ollamaModels'

export interface AssistantRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  getSettings: () => Promise<AppSettings>
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
  /** 取用户的实时角色（Planner 的动作权限判定依赖它，不能用 JWT 里的旧角色） */
  freshRole: (req: AuthedRequest) => Promise<string>
}

// AI Agent Dispatcher（P0 关键词版）：判定一条消息走 Chat（通用对话）还是 Support（产品客服）。
// 规则来自设计文档 §3.5：问「XX 功能是什么 / 怎么用 / 怎么做」→ Support；其余 → Chat。
// Agent 执行模式（操作动词 + @窗口）属 P1，届时在此扩展第三个分支。
const AI_PRODUCT_TERMS = [
  '环境', '窗口', '指纹', '代理', 'proxy', 'ip', '账号', 'cookie', '扩展', '插件',
  'rpa', '模板', '分组', '团队', '日志', '设置', '看板', 'api', '自动化', '登录', '注册',
  '起始页', '搜索引擎', '任务栏', '网络', '同步', '迁移', '导入', '导出', '检测', '巡检'
]
export function aiAgentDispatch(question: string): 'chat' | 'support' {
  const q = question.toLowerCase()
  // 命中产品相关词 → 产品客服；纯闲聊 / 通用问题 → 通用对话。
  // 疑问句式（怎么/是什么…）不单独触发路由，避免「怎么写 Python」这类通用问题被误路由。
  return AI_PRODUCT_TERMS.some((term) => q.includes(term)) ? 'support' : 'chat'
}

/**
 * AI Agent 与智能助手路由。
 *
 * ## 三个接口的分工（别混淆）
 * - `POST /ai-agent/status` 连通性探针。**不要求 enabled** —— 用户要先探活才决定要不要开。
 * - `POST /ai-agent/chat`纯对话（Chat / Support 两套 system prompt）。
 * - `POST /assistant/*` Planner：自然语言 → 查数据（只读）/ 提动作（需前端确认后调 action 执行）。
 *
 * ## 探活为什么同时校验视觉模型
 * Agent 的执行闭环要「看屏」才能点对按钮。只探文本模型的话，界面显示「已连接」，
 * 用户真正跑Agent 时才报视觉模型缺失——那时已经浪费了一轮对话和一个任务。
 * 与 runner.ts 的 agent:start 预检保持同一口径。
 *
 * ## 探活优先用前端未保存的表单
 * 用户可能选了「云端」但没点保存就点检测。若此时读后端已保存配置（还是本地），
 * 会误报「本地已连接」，用户以为云端可用。
 */
export function registerAssistantRoutes(router: Router, deps: AssistantRouteDeps): void {
  const { getDs, getSettings, authMiddleware, writeLog, freshRole } = deps

  const plannerCtx = async (req: AuthedRequest): Promise<PlannerCtx> => ({
    ds: getDs(),
    uid: req.uid!,
    tid: req.tid!,
    role: await freshRole(req),
    username: req.username || 'assistant'
  })

  // ===== AI Agent：连通性探针（本地 Ollama 或云端 BYOK）=====
  router.post('/ai-agent/status', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const settings = await getSettings()
    // 优先用前端表单（可能尚未保存）传入的 aiAgent 配置做检测：避免「选了云端、没保存就点检测」
    // 却用旧的已保存后端配置（本地）探活，误报为「本地已连接」。
    const override = (req.body && (req.body as { aiAgent?: Partial<AIAgentSettings> }).aiAgent) || null
    const a = override
      ? { ...(settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings)), ...override }
      : (settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings))
    // 探活需同时校验「文本模型（对话用）」与「视觉模型（Agent 执行闭环看屏用）」，
    // 与 runner.ts 的 agent:start 预检保持一致：避免出现「状态显示正常、真正执行才报错」。
    if (a.backend === 'cloud') {
      const text = await checkCloudStatus({
        provider: a.cloudProvider, baseUrl: a.cloudBaseUrl, apiKey: a.cloudApiKey, model: a.cloudModel
      })
      // 视觉探活必须带图（vision: true）——云端没有 /api/show 那样的 capabilities 接口，
      // 只能实际发一张 1x1 图片验证模型是否接受图像输入。
      // 否则纯文本模型（如 deepseek-v4-pro）当视觉模型会「探活通过、执行报 400」。
      const vision = await checkCloudStatus({
        provider: a.cloudProvider, baseUrl: a.cloudBaseUrl, apiKey: a.cloudApiKey,
        model: a.cloudVisionModel, vision: true
      })
      const reachable = text.reachable && vision.reachable
      const error = !text.reachable
        ? `文本模型自检失败（${text.model || '未配置'}）：${text.error || '未知错误'}`
        : !vision.reachable
          ? `视觉模型自检失败（${vision.model || '未配置'}）：${vision.error || '未知错误'}`
          : undefined
      res.json({
        backend: 'cloud',
        reachable,
        baseUrl: text.baseUrl,
        model: text.model,
        modelPulled: text.reachable,
        models: [],
        error,
        // 错误分类透给前端，便于前端区分「Key 错了」与「模型填错模态」并给出不同引导
        errorKind: !text.reachable ? text.errorKind : !vision.reachable ? vision.errorKind : undefined,
        visionModel: vision.model,
        visionReachable: vision.reachable,
        visionError: !vision.reachable ? vision.error : undefined,
        visionErrorKind: !vision.reachable ? vision.errorKind : undefined,
        visionSupports: vision.supportsVision
      })
      return
    }
    // 本地：文本模型与视觉模型都走本机 Ollama，需各自确认已拉取
    const visionModel = a.localVisionModel || 'minicpm-v:latest'
    const text = await checkOllamaStatus({ model: a.localModel })
    const vision = await checkOllamaStatus({ model: visionModel })
    const reachable = text.reachable
    const modelPulled = text.modelPulled && vision.modelPulled
    // 未安装时给出「本机已装了哪些」+「你是不是想用同 base 的另一个 tag」——
    // 用户最常见的踩坑是写了同 base 但不同 tag 的名字（qwen2.5:7b vs qwen2.5:3b），
    // 光说「未安装」会让人以为是 Ollama 没启动。
    const describeMissing = (label: string, model: string, models: string[]): string => {
      const installed = models.length ? models.join('、') : '无'
      const sameBase = findSameBaseModel(model, models)
      const hint = sameBase
        ? `。本机已安装同系列的「${sameBase}」，可直接改用该模型`
        : ''
      return `${label}「${model}」未安装（本机已安装：${installed}）${hint}`
    }

    /**
     * 模态校验：装了 ≠ 支持视觉。
     *
     * 视觉模型位误填纯文本模型（如 qwen2.5-coder:7b）时，「是否已安装」这一关过得去，
     * 但该模型 capabilities 里没有 vision → 真正让 Agent 看屏时 Ollama 报
     * 400 `model does not support multimodal requests`。这里在**探活阶段**就拦下来。
     *
     * 只在「已安装」之后才查能力：没装的模型查能力必然失败，先给「未安装」的提示更准。
     */
    const visionCaps = vision.modelPulled
      ? await getCapabilitiesOfInstalled(visionModel, vision.models)
      : undefined
    const textCaps = text.modelPulled
      ? await getCapabilitiesOfInstalled(a.localModel, text.models)
      : undefined
    // 三态：true=支持 / false=明确不支持 / undefined=能力未知（老版本 Ollama 无此字段）
    const visionOk = supportsVision(visionCaps)
    const textOk = supportsChat(textCaps)

    // 给出可用的替代模型建议：只在本机确实装了支持该能力的模型时才提示
    const visionAlternatives =
      visionOk === false
        ? await listModelsWithCapability('vision', vision.models.filter((m) => m !== visionModel))
        : []
    const textAlternatives =
      textOk === false
        ? await listModelsWithCapability('completion', text.models.filter((m) => m !== a.localModel))
        : []

    const error = !text.reachable
      ? text.error
      : !text.modelPulled
        ? describeMissing('文本模型', a.localModel, text.models)
        : textOk === false
          ? describeModalityMismatch({
              label: '文本模型',
              model: a.localModel,
              capabilities: textCaps,
              alternatives: textAlternatives
            })
          : !vision.modelPulled
            ? describeMissing('视觉模型', visionModel, vision.models)
            : visionOk === false
              ? describeModalityMismatch({
                  label: '视觉模型',
                  model: visionModel,
                  capabilities: visionCaps,
                  alternatives: visionAlternatives
                })
              : undefined
    res.json({
      backend: 'local',
      reachable,
      baseUrl: text.baseUrl,
      model: text.model,
      modelPulled,
      models: text.models,
      error,
      visionModel,
      visionReachable: vision.reachable,
      visionError: !vision.reachable
        ? vision.error
        : !vision.modelPulled
          ? '视觉模型未安装'
          : visionOk === false
            ? describeModalityMismatch({
                label: '视觉模型',
                model: visionModel,
                capabilities: visionCaps,
                alternatives: visionAlternatives
              })
            : undefined
    })
  })

  // ===== AI Agent：列出本机已安装的 Ollama 模型 =====
  // 设置页的模型输入框是「可下拉选 + 可自由输入」的组合（AutoComplete）：
  // 用户手打模型名容易打错（写了没装的 tag 就白忙一场），下拉能直接列出本机已装的。
  // 这个接口只读不写，与 /ai-agent/status 的区别是：后者是「探活」，会带上
  // 文本/视觉两个模型的匹配判定；这里单纯是「本机装了什么」。
  router.get('/ai-agent/models', authMiddleware, async (_req: AuthedRequest, res: Response) => {
    try {
      const models = await listOllamaModels()
      res.json({ ok: true, models })
    } catch (e) {
      // Ollama 没启动不是错误：前端据此把下拉提示成「未连接 Ollama」即可
      res.json({ ok: false, models: [], error: e instanceof Error ? e.message : String(e) })
    }
  })

  // ===== AI Agent：Chat/Support 对话（本地 Ollama，零 token）=====
  // body: { messages: [{role,content}], mode?: 'chat' | 'support' | 'auto' }
  // mode=auto 时由 Dispatcher 做轻量意图路由（P0 用关键词规则，见 aiAgentDispatch）
  router.post('/ai-agent/chat', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const settings = await getSettings()
    const a = settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings)
    if (!a.enabled) {
      res.status(400).json({ message: 'AI Agent 未启用，请先在「设置 → AI Agent」开启' })
      return
    }
    // 白名单校验消息结构，最多带最近 20 条历史（本地模型上下文有限，防撑爆）
    const raw = Array.isArray((req.body || {}).messages) ? req.body.messages : []
    const msgs: OllamaMessage[] = []
    for (const m of raw.slice(-20)) {
      const role = (m && m.role) as string
      const content = typeof (m && m.content) === 'string' ? m.content : ''
      if ((role === 'user' || role === 'assistant' || role === 'system') && content.trim()) {
        msgs.push({ role, content })
      }
    }
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
      res.status(400).json({ message: '消息列表为空或最后一条不是用户消息' })
      return
    }
    // 模式路由：显式指定优先；auto 走 Dispatcher 关键词规则
    const reqMode = (req.body || {}).mode
    const lastQuestion = msgs[msgs.length - 1].content
    const mode: 'chat' | 'support' =
      reqMode === 'support' || reqMode === 'chat' ? reqMode : aiAgentDispatch(lastQuestion)
    // Support 模式：检索产品文档片段，作为 system 消息注入（不透传历史里的旧 system）
    const finalMsgs: OllamaMessage[] =
      mode === 'support'
        ? [{ role: 'system', content: buildSupportSystemPrompt(lastQuestion) }, ...msgs.filter((m) => m.role !== 'system')]
        : msgs
    // 云端 BYOK：OpenAI 兼容 chat/completions，用户自带 Key（会产生 token 费用）
    if (a.backend === 'cloud') {
      if (!a.cloudApiKey?.trim() || !a.cloudModel?.trim()) {
        res.status(400).json({ message: '云端模型未配置：请在「设置 → AI Agent」填写 API Key 与模型名' })
        return
      }
      try {
        const reply = await cloudChat({
          provider: a.cloudProvider,
          baseUrl: a.cloudBaseUrl,
          apiKey: a.cloudApiKey,
          model: a.cloudModel,
          messages: finalMsgs
        })
        res.json({ reply, mode })
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        res.status(502).json({ message: `云端模型调用失败：${detail}` })
      }
      return
    }
    try {
      const reply = await ollamaChat({ model: a.localModel, messages: finalMsgs })
      res.json({ reply, mode })
    } catch (e) {
      // Ollama 未启动 / 模型未拉取等场景给可操作的提示。
      // 404 model not found 是最常见的一种（写了同 base 但不同 tag 的名字，
      // 或模型压根没 pull）—— 这时把**本机实际装了哪些**列出来，
      // 用户不用猜、不用反复试，直接照着改。
      const detail = e instanceof Error ? e.message : String(e)
      const message404 = /404/.test(detail) && /not found/i.test(detail)
      if (message404) {
        let installed: string[] = []
        try {
          installed = await listOllamaModels()
        } catch {
          /* Ollama 没起来，列表拿不到，下面用兜底文案 */
        }
        const sameBase = findSameBaseModel(a.localModel, installed)
        const list = installed.length ? installed.join('、') : '无'
        const hint = sameBase
          ? `。本机已安装同系列的「${sameBase}」，可直接改用该模型`
          : installed.length
            ? ''
            : '。未检测到本机已安装的模型'
        res.status(502).json({
          message: `本地模型调用失败：模型「${a.localModel}」未安装（本机已安装：${list}）${hint}。可在「设置 → AI Agent → 本地模型名」的下拉中选择，或先执行 ollama pull ${a.localModel}`
        })
        return
      }
      res.status(502).json({ message: `本地模型调用失败：${detail}（请确认 Ollama 已启动且已 pull 模型 ${a.localModel}）` })
    }
  })

  // ===== 智能助手（Planner）：自然语言查询全项目 + 危险动作提案 + 确认后执行 =====
  // body: { message: string, history?: [{role,content}] }
  // 返回 AssistantResult：understanding / reply / queries(带深链) / actions(待确认提案)
  router.post('/assistant/chat', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const settings = await getSettings()
    const a = settings.aiAgent || (DEFAULT_SETTINGS.aiAgent as AIAgentSettings)
    if (!a.enabled) {
      res.status(400).json({ message: '智能助手未启用，请先在「设置 → AI Agent」开启' })
      return
    }
    const message = typeof (req.body || {}).message === 'string' ? (req.body as { message: string }).message.trim() : ''
    if (!message) {
      res.status(400).json({ message: '请输入要查询的内容' })
      return
    }
    const history: OllamaMessage[] = Array.isArray((req.body || {}).history)
      ? (req.body as { history: OllamaMessage[] }).history.filter((m) => m && m.role && m.content).slice(-12)
      : []
    const ctx = await plannerCtx(req)
    try {
      const result = await planAssistant(message, a, ctx, history)
      res.json(result)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      res.status(500).json({ message: `助手处理失败：${detail}` })
    }
  })

  // 执行已确认的动作（前端分级确认后调用）。body: { kind, params }
  router.post('/assistant/action', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const kind = (req.body || {}).kind
    const params = (req.body || {}).params || {}
    if (!kind || typeof kind !== 'string') {
      res.status(400).json({ message: '缺少动作 kind' })
      return
    }
    const ctx = await plannerCtx(req)
    try {
      const r = await executeAssistantAction(kind, params, ctx)
      if (!r.ok) {
        res.status(400).json({ message: r.message })
        return
      }
      res.json(r)
    } catch (e) {
      res.status(500).json({ message: `动作执行失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // 智能助手「技能库」：把一条结构化计划模板固化复用（运行时不调 LLM，直接按模板重跑）
  router.get('/assistant/skills', authMiddleware, async (req: AuthedRequest, res: Response) => {
    try {
      const repo = getDs().getRepository(AssistantSkillEntity)
      const list = await repo.find({ where: { teamId: req.tid! }, order: { id: 'DESC' } })
      res.json(list.map((s) => ({ id: s.id, name: s.name, trigger: s.trigger, createdAt: s.createdAt })))
    } catch (e) {
      res.status(500).json({ message: `读取技能库失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  router.post('/assistant/skills', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const name = String((req.body || {}).name || '').trim()
    const trigger = String((req.body || {}).trigger || '').trim()
    const template = (req.body || {}).template
    if (!name) {
      res.status(400).json({ message: '请填写技能名称' })
      return
    }
    if (!template || typeof template !== 'object') {
      res.status(400).json({ message: '缺少计划模板' })
      return
    }
    try {
      const repo = getDs().getRepository(AssistantSkillEntity)
      const entity = repo.create({
        teamId: req.tid!,
        ownerId: req.uid!,
        name,
        trigger,
        steps: JSON.stringify(template)
      })
      const saved = await repo.save(entity)
      res.json({ id: saved.id, name: saved.name, trigger: saved.trigger, createdAt: saved.createdAt })
    } catch (e) {
      res.status(500).json({ message: `保存技能失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  router.delete('/assistant/skills/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id)
    if (!id) {
      res.status(400).json({ message: '缺少技能 ID' })
      return
    }
    try {
      const repo = getDs().getRepository(AssistantSkillEntity)
      const s = await repo.findOne({ where: { id, teamId: req.tid! } })
      if (!s) {
        res.status(404).json({ message: '技能不存在' })
        return
      }
      await repo.remove(s)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ message: `删除技能失败：${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // 运行已保存的技能（复用 executePlan，不调 LLM）
  router.post('/assistant/skills/:id/run', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id)
    if (!id) {
      res.status(400).json({ message: '缺少技能 ID' })
      return
    }
    const repo = getDs().getRepository(AssistantSkillEntity)
    const s = await repo.findOne({ where: { id, teamId: req.tid! } })
    if (!s) {
      res.status(404).json({ message: '技能不存在' })
      return
    }
    let template: Plan
    try {
      template = JSON.parse(s.steps) as Plan
    } catch {
      res.status(400).json({ message: '技能模板损坏，无法解析' })
      return
    }
    const ctx = await plannerCtx(req)
    try {
      const result = await runSkillPlan(template, ctx)
      await writeLog(req, 'assistant_skill_run', `运行技能「${s.name}」(#${s.id})`)
      res.json(result)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      res.status(500).json({ message: `技能运行失败：${detail}` })
    }
  })
}