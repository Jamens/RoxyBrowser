// 智能助手（Planner）后端引擎
//
// 流程：用户自然语言 → LLM 产出「计划 JSON」→ 三道闸校验（敏感拦截 / 白名单查询 / 动作映射）
// → 执行只读查询并把每行映射成可跳转深链；危险动作只产出「待确认提案」，由前端确认后调 executeAssistantAction。
//
// 所有敏感 / 权限校验都在后端硬兜底，不依赖模型自觉。

import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import type { AIAgentSettings, RpaStep, Fingerprint } from '../shared/types'
import { DEFAULT_START_URL } from '../shared/types'
import { substituteSteps } from '../shared/rpa'
import { ollamaChat, type OllamaMessage } from './agent/ollama'
import { cloudChat } from './agent/cloud'
import { openWindow, replayRpaScript, getRunningWindowIds, probeFingerprint } from './browserManager'
import { randomFingerprint } from '../shared/fingerprint'
import { buildHealthReport } from '../shared/healthcheck'
import { getEnvExpiresAt, withEnvExpiresAt } from '../shared/envExpiry'
import { importProfileItems } from './exporters'
import {
  ASSISTANT_ENTITIES,
  ASSISTANT_ACTIONS,
  FORBIDDEN_ENTITIES,
  SENSITIVE_FIELD_BLOCKLIST,
  SENSITIVE_BLOCK_MESSAGE,
  ALLOWED_FILTER_OPS,
  buildAssistantSystemPrompt,
  type AssistantEntity,
  type FieldType,
  type ActionDanger
} from './assistantSchema'
import {
  ProfileEntity,
  ProxyEntity,
  AccountEntity,
  CookieEntity,
  TeamMemberEntity,
  TeamEntity,
  OperationLogEntity,
  RpaScriptEntity,
  AssistantSkillEntity
} from './entities'
import { expandActions, resolveRelTime, MAX_COLLECT_IDS, type Plan, type PlanQuery } from '../shared/assistantPlan'

/** 调用方注入的上下文（由 server 路由从已鉴权的 req 取出） */
export interface PlannerCtx {
  ds: DataSource
  uid: number
  tid: number
  role: string
  username: string
}

const isAdmin = (role?: string) => role === 'owner' || role === 'admin'

function audit(ctx: PlannerCtx, action: string, detail: string, sensitive = false) {
  const repo = ctx.ds.getRepository(OperationLogEntity)
  return repo.save(
    repo.create({
      teamId: ctx.tid,
      userId: ctx.uid,
      username: ctx.username || 'assistant',
      action,
      detail,
      sensitive
    })
  )
}

// ===================== 计划解析 =====================
// Plan / PlanQuery / PlanAction / expandActions 见 ../shared/assistantPlan（纯函数，可离线单测）

/** 从模型输出里尽量抠出 JSON（容忍 ```json 包裹或前后夹杂文字） */
function extractJson(text: string): Plan | null {
  if (!text) return null
  let t = text.trim()
  // 去掉 ```json ... ``` 包裹
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  // 截取首个 { 到末个 }
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  try {
    return JSON.parse(t) as Plan
  } catch {
    return null
  }
}

// ===================== 查询执行（闸 2：白名单）=====================

interface QueryRow {
  _id: unknown
  _deepLink: string
  _title: string
  _usedByEnvs?: Array<{ id: number; name: string; seq: number }>
  [k: string]: unknown
}
export interface AssistantQueryResult {
  entity: AssistantEntity
  entityLabel: string
  columns: Array<{ key: string; label: string; type: FieldType }>
  rows: QueryRow[]
  total: number
  truncated: boolean
}
export interface AssistantActionProposal {
  kind: string
  label: string
  danger: ActionDanger
  target: { entity: string; id: number }
  params: Record<string, unknown>
  /** 来自 forEach 展开时记录出处，供前端展示「对查询①的 N 行 · 第 k 行」 */
  batch?: { queryIndex: number; total: number; rowIndex: number }
  /**
   * 来自 collect 汇总时记录出处。bulk 与 batch **互斥**：
   * batch = N 条独立动作（逐条确认），bulk = 1 条动作内含 N 个 id（确认一次）。
   * 前端靠这个区分该渲染成列表还是单个确认卡片 —— 若两者都当普通动作处理，
   * 批量场景会退化成让用户点 N 次「确认」，正是 collect 要避免的。
   */
  bulk?: { queryIndex: number; total: number }
}
export interface AssistantResult {
  ok: boolean
  understanding: string
  reply: string
  intent: string
  sensitiveBlocked?: boolean
  queries: AssistantQueryResult[]
  actions: AssistantActionProposal[]
  /** 本次产出的结构化计划模板（queries + actions + forEach），前端可「保存为技能」复用 */
  planTemplate?: Plan
}

function clampLimit(n?: number): number {
  const v = Math.floor(Number(n) || 20)
  return Math.min(Math.max(v, 1), 50)
}

async function runOneQuery(ctx: PlannerCtx, q: PlanQuery, now: Date): Promise<AssistantQueryResult | { blocked: true }> {
  const entity = q.entity as AssistantEntity
  const def = ASSISTANT_ENTITIES[entity]
  if (!def) throw new Object({ code: 400, message: `不支持查询的实体：${entity}` })
  if (FORBIDDEN_ENTITIES.includes(entity)) {
    return { blocked: true }
  }
  const admin = isAdmin(ctx.role)
  const blocklist = SENSITIVE_FIELD_BLOCKLIST[entity] || []

  // 字段白名单：取交集，剔除敏感列，永远带主键
  const allowed = new Set(def.fields.map((f) => f.name))
  let wanted = Array.isArray(q.fields) && q.fields.length ? q.fields.filter((f) => allowed.has(f) && !blocklist.includes(f)) : def.defaultFields
  wanted = Array.from(new Set([def.idField, ...wanted.filter((f) => allowed.has(f) && !blocklist.includes(f))]))

  const repo = ctx.ds.getRepository(def.table as never) as ReturnType<DataSource['getRepository']>
  const qb = repo.createQueryBuilder('e')
  // 团队 + 账户隔离（admin 不加 ownerId）
  qb.where('e.teamId = :tid', { tid: ctx.tid })
  if (!admin) qb.andWhere('e.ownerId = :oid', { oid: ctx.uid })

  // 过滤条件（op 白名单 + 字段白名单 + 参数化）
  for (const f of q.filters || []) {
    const field = f.field || ''
    const op = (f.op || '=') as string
    if (!allowed.has(field) || blocklist.includes(field)) continue
    if (!ALLOWED_FILTER_OPS.includes(op)) continue
    const col = `e.${field}`
    const val = resolveRelTime(f.value, now)
    if (op === 'between' && Array.isArray(val) && val.length === 2) {
      qb.andWhere(`${col} BETWEEN :b0 AND :b1`, { b0: val[0], b1: val[1] })
    } else if (op === 'in' && Array.isArray(val)) {
      qb.andWhere(`${col} IN (:...inv)`, { inv: val })
    } else if (op === 'like') {
      qb.andWhere(`${col} LIKE :lk`, { lk: `%${String(val)}%` })
    } else if (op === '=') {
      qb.andWhere(`${col} = :eq`, { eq: val })
    } else if (op === '!=') {
      qb.andWhere(`${col} != :ne`, { ne: val })
    } else if (['>', '>=', '<', '<='].includes(op)) {
      qb.andWhere(`${col} ${op} :cmp`, { cmp: val })
    }
  }

  const limit = clampLimit(q.limit)
  qb.select(wanted.map((f) => `e.${f}`))
  if (q.orderBy && allowed.has(q.orderBy) && !blocklist.includes(q.orderBy)) {
    qb.orderBy(`e.${q.orderBy}`, (q.orderDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
  }
  qb.limit(limit)

  const raws = (await qb.getMany()) as Array<Record<string, unknown>>
  const total = raws.length
  const rows: QueryRow[] = raws.map((r) => ({
    ...r,
    _id: r[def.idField],
    _deepLink: def.deepLink(r),
    _title: def.titleOf(r)
  }))

  // 反向关联补全（如代理补出使用它的环境）
  if (def.enrich && rows.length) {
    const ids = rows.map((r) => r[def.idField] as number)
    const relRepo = ctx.ds.getRepository(def.enrich.entity as never) as ReturnType<DataSource['getRepository']>
    const relDef = ASSISTANT_ENTITIES[def.enrich.entity]
    const relQb = relRepo.createQueryBuilder('x')
    relQb.where(`x.${def.enrich.via} IN (:...ids)`, { ids })
    relQb.andWhere('x.teamId = :tid', { tid: ctx.tid })
    if (!admin) relQb.andWhere('x.ownerId = :oid', { oid: ctx.uid })
    if (relDef.fields.some((f) => f.name === 'deletedAt')) relQb.andWhere('x.deletedAt IS NULL')
    relQb.select(['x.id', 'x.name', 'x.seq', `x.${def.enrich.via}`])
    const rels = (await relQb.getMany()) as Array<Record<string, unknown>>
    const byProxy = new Map<number, Array<{ id: number; name: string; seq: number }>>()
    for (const r of rels) {
      const pid = r[def.enrich.via] as number
      const arr = byProxy.get(pid) || []
      if (arr.length < 8) arr.push({ id: r.id as number, name: (r.name as string) || '', seq: (r.seq as number) ?? 0 })
      byProxy.set(pid, arr)
    }
    for (const row of rows) {
      const list = byProxy.get(row[def.idField] as number)
      if (list && list.length) row._usedByEnvs = list
    }
  }

  const columns = def.fields.filter((f) => wanted.includes(f.name)).map((f) => ({ key: f.name, label: f.label, type: f.type }))
  return { entity, entityLabel: def.label, columns, rows, total, truncated: total >= limit }
}

// ===================== 主入口 =====================

/** 归一化对话角色：Ollama / 云端只认 system|user|assistant；前端 UI 用 'bot' 标记助手回复，
 *  这里兜底转成 'assistant'，避免多轮对话第二轮就因非法 role 被模型拒绝（已实测云端 400）。 */
function normalizeRole(r: string): 'system' | 'user' | 'assistant' {
  if (r === 'system') return 'system'
  if (r === 'assistant' || r === 'bot' || r === 'model') return 'assistant'
  return 'user'
}

export async function planAssistant(
  message: string,
  settings: AIAgentSettings,
  ctx: PlannerCtx,
  history: OllamaMessage[] = []
): Promise<AssistantResult> {
  const now = new Date()
  const system = buildAssistantSystemPrompt(now)
  // 前端历史里助手的角色可能用 'bot'（仅 UI 展示约定），Ollama / 云端都只认 'assistant'，
  // 这里统一归一化，避免多轮对话第二轮就因非法 role 被模型拒绝（已实测云端 400）。
  const messages: OllamaMessage[] = [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: normalizeRole(h.role), content: h.content })),
    { role: 'user', content: message }
  ]

  let raw = ''
  try {
    if (settings.backend === 'cloud') {
      if (!settings.cloudApiKey?.trim() || !settings.cloudModel?.trim()) {
        return errResult('云端模型未配置：请在「设置 → AI Agent」填写 API Key 与模型名')
      }
      raw = await cloudChat({
        provider: settings.cloudProvider,
        baseUrl: settings.cloudBaseUrl,
        apiKey: settings.cloudApiKey,
        model: settings.cloudModel,
        messages
      })
    } else {
      raw = await ollamaChat({ model: settings.localModel, messages })
    }
  } catch (e) {
    return errResult(`模型调用失败：${e instanceof Error ? e.message : String(e)}（请确认 AI Agent 已启用且模型可用）`)
  }

  const plan = extractJson(raw)
  if (!plan) {
    return okResult('已收到，但没能解析出可执行计划。', 'unknown', '我可以查询环境、代理、账号、Cookie、扩展、RPA 脚本、操作日志、分组、团队，例如「哪些环境快过期了」。')
  }

  const intent = plan.intent || 'unknown'
  // 敏感拦截（闸 1）：模型已识别为 blocked，或查询了禁查实体
  if (intent === 'blocked') {
    return {
      ok: true,
      understanding: plan.understanding || '识别为敏感查询',
      reply: plan.reply || SENSITIVE_BLOCK_MESSAGE,
      intent: 'blocked',
      sensitiveBlocked: true,
      queries: [],
      actions: []
    }
  }

  const { queries, actions, sensitiveBlocked } = await executePlan(plan, ctx, now)

  const reply =
    plan.reply ||
    (queries.length
      ? `已为你查询到 ${queries.reduce((s, q) => s + q.total, 0)} 条结果，点击右侧跳转可定位处理。`
      : '没有匹配到数据，换个说法试试？')

  return {
    ok: true,
    understanding: plan.understanding || '',
    reply,
    intent,
    sensitiveBlocked: sensitiveBlocked || undefined,
    queries,
    actions,
    planTemplate: plan
  }
}

/**
 * 执行一个结构化计划：先跑查询（闸 2 白名单 + 团队/账户隔离），
 * 再把动作按 forEach 多步展开并经动作白名单解析危险分级（闸 3）。
 * 供 planAssistant（LLM 产出计划）与 runSkillPlan（复用已存模板）共用。
 */
async function executePlan(
  plan: Plan,
  ctx: PlannerCtx,
  now: Date = new Date()
): Promise<{ queries: AssistantQueryResult[]; actions: AssistantActionProposal[]; sensitiveBlocked: boolean }> {
  // 与 plan.queries 等长的数组，被禁查 / 跳过的查询位保留 null，
  // 以保证 forEach.fromQuery 引用的下标始终对齐原始计划（修复重跑时前置查询被跳过导致索引错位、静默 0 动作的 bug）。
  const queries: (AssistantQueryResult | null)[] = new Array(plan.queries?.length || 0).fill(null)
  let sensitiveBlocked = false
  let qi = 0
  for (const q of plan.queries || []) {
    if (qi >= queries.length) break
    if (!q || !q.entity) {
      qi++
      continue
    }
    try {
      const r = await runOneQuery(ctx, q, now)
      if ('blocked' in r) {
        sensitiveBlocked = true
        // 保留 null：索引不偏移，forEach 仍指向正确位置（该位为空 → 自然产出 0 条动作）
      } else {
        queries[qi] = r
      }
    } catch (e: unknown) {
      const msg = e instanceof Object && 'message' in e ? (e as { message?: string }).message : String(e)
      queries[qi] = {
        entity: (q.entity as AssistantEntity) || 'profiles',
        entityLabel: ASSISTANT_ENTITIES[q.entity as AssistantEntity]?.label || q.entity || '未知',
        columns: [],
        rows: [],
        total: 0,
        truncated: false
      }
      // 单条查询失败不阻断整体，reply 里提示
      if (!plan.reply) plan.reply = `部分查询失败：${msg}`
    }
    qi++
  }

  // 多步编排：把动作按 forEach 展开成可执行序列；不带 forEach 的动作原样保留（向后兼容）。
  // 被禁查 / 跳过的查询位以「空 rows」参与展开，天然产出 0 条动作，不会误执行。
  const expanded = expandActions(plan, queries.map((q) => ({ rows: q ? (q.rows as Array<Record<string, unknown>>) : [] })))
  const actions: AssistantActionProposal[] = []
  for (const e of expanded) {
    const def = ASSISTANT_ACTIONS[e.kind]
    if (!def) continue
    actions.push({
      kind: def.kind,
      label: e.label || def.label,
      danger: def.danger,
      target: { entity: e.target.entity || e.kind, id: e.target.id },
      params: e.params,
      batch: e.batch,
      bulk: e.bulk
    })
  }

  // 返回给前端的结果过滤掉被禁查的 null 位（敏感拦截已在 sensitiveBlocked 体现）
  return { queries: queries.filter((q): q is AssistantQueryResult => q != null), actions, sensitiveBlocked }
}

/**
 * 运行一个已保存的「技能」模板（不调用 LLM，直接用模板重跑查询并展开动作）。
 * 与 planAssistant 走同一套 executePlan，因此白名单 / 隔离 / 危险分级完全一致。
 */
export async function runSkillPlan(template: Plan, ctx: PlannerCtx): Promise<AssistantResult> {
  const now = new Date()
  // 复用 executePlan（同一套白名单 / 隔离 / 危险分级），但技能模板可能在保存很久后重跑，
  // 需再次校验 intent：模板若被标记 blocked（敏感），重跑同样拒绝，避免被绕过（闸 1）。
  if (template.intent === 'blocked') {
    return {
      ok: true,
      understanding: template.understanding || '识别为敏感查询',
      reply: template.reply || SENSITIVE_BLOCK_MESSAGE,
      intent: 'blocked',
      sensitiveBlocked: true,
      queries: [],
      actions: []
    }
  }
  const { queries, actions, sensitiveBlocked } = await executePlan(template, ctx, now)
  const reply = `已按技能模板执行：查询到 ${queries.reduce((s, q) => s + q.total, 0)} 条结果，可执行 ${actions.length} 个操作。`
  return {
    ok: true,
    understanding: template.understanding || '技能执行',
    reply,
    intent: template.intent || 'mixed',
    sensitiveBlocked: sensitiveBlocked || undefined,
    queries,
    actions,
    planTemplate: template
  }
}

function okResult(understanding: string, intent: string, reply: string): AssistantResult {
  return { ok: true, understanding, reply, intent, queries: [], actions: [] }
}
function errResult(reply: string): AssistantResult {
  return { ok: false, understanding: '', reply, intent: 'error', queries: [], actions: [] }
}

// ===================== 动作执行（前端确认后调用）=====================

export interface ActionExecResult {
  ok: boolean
  message: string
  detail?: unknown
}

function num(v: unknown): number {
  return Number(v)
}

/** 单个创建动作的环境数量上限。50 是 UI 批量创建的同一量级；
 *  更高就该走「导入 JSON」或去 UI 里做，不该由一句话触发几千次写库。 */
const MAX_CREATE_COUNT = 50

/**
 * 解析批量动作的 id 数组。
 *
 * 三个坑都在这里挡掉：
 * 1. 模型可能传单个 id（`profileIds: 12`）而非数组 —— 兼容成 [12]；
 * 2. 可能混进非整数 / 负数 / 0 —— 直接丢弃，否则 `In([0, -1])` 会静默匹配不到任何行，
 *    动作「成功执行了 0 条」，用户却以为改掉了。
 * 3. 数量超上限 —— 截断并如实回报，不静默丢。
 */
function idList(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
  const out: number[] = []
  const seen = new Set<number>()
  for (const x of arr) {
    const n = Number(x)
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * 批量动作的公共前置：按归属取环境、剔除不该动的。
 *
 * @param skipRunning 是否跳过运行中的环境。改指纹/绑代理必须跳过
 *   （窗口正在用这套指纹运行，改了下一次采集就与库里对不上）；
 *   删除也跳过（运行中的窗口关不掉，软删后状态会自相矛盾）。
 */
async function loadTargets(
  ctx: PlannerCtx,
  admin: boolean,
  ids: number[],
  opts: { skipRunning: boolean; includeDeleted?: boolean }
): Promise<{ targets: ProfileEntity[]; skipped: number; notFound: number }> {
  if (!ids.length) return { targets: [], skipped: 0, notFound: 0 }
  const repo = ctx.ds.getRepository(ProfileEntity)
  const rows = await repo.find({
    where: { id: In(ids), teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) }
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const targets: ProfileEntity[] = []
  let skipped = 0
  let notFound = 0
  for (const id of ids) {
    const p = byId.get(id)
    if (!p) { notFound++; continue }
    if (!opts.includeDeleted && p.deletedAt) { skipped++; continue }
    if (opts.skipRunning && p.status === 'running') { skipped++; continue }
    targets.push(p)
  }
  return { targets, skipped, notFound }
}

/** 批量结果里「共 N 条，其中跳过 X 条」的统一措辞。
 *  刻意不隐瞒跳过数：只报成功数的话，用户会以为运行中的窗口也改了。 */
function bulkMessage(done: number, extra: string): string {
  return `已处理 ${done} 个环境${extra}`
}

export async function executeAssistantAction(kind: string, params: Record<string, unknown>, ctx: PlannerCtx): Promise<ActionExecResult> {
  const def = ASSISTANT_ACTIONS[kind]
  if (!def) return { ok: false, message: `不支持的动作：${kind}` }
  const admin = isAdmin(ctx.role)

  switch (kind) {
    case 'openEnv': {
      const profileId = num(params.profileId)
      const p = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!p) return { ok: false, message: '环境不存在' }
      if (p.deletedAt) return { ok: false, message: '该环境已删除，请先从回收站恢复' }
      if (p.status === 'running') return { ok: false, message: '窗口已在运行中' }
      await openWindow(profileId)
      p.status = 'running'
      p.lastOpenedAt = new Date()
      await ctx.ds.getRepository(ProfileEntity).save(p)
      await audit(ctx, 'open_profile', `（助手）打开环境「${p.name}」(#${p.id})`)
      return { ok: true, message: `已打开环境「${p.name}」` }
    }
    case 'runRpa': {
      const scriptId = num(params.scriptId)
      const profileId = num(params.profileId)
      const s = await ctx.ds.getRepository(RpaScriptEntity).findOne({ where: { id: scriptId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!s) return { ok: false, message: '脚本不存在' }
      const profile = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!profile) return { ok: false, message: '环境不存在' }
      const running = getRunningWindowIds()
      if (!running.includes(profileId)) return { ok: false, message: '环境未运行，请先打开环境再回放' }
      const vars = (s.variables || {}) as Record<string, string>
      const steps = substituteSteps(s.steps as unknown as RpaStep[], vars)
      try {
        const executed = await replayRpaScript(profileId, steps)
        await audit(ctx, 'rpa_run', `（助手）回放脚本「${s.name}」完成（环境「${profile.name}」#${profileId}，执行 ${executed}/${steps.length} 步）`)
        return { ok: true, message: `脚本「${s.name}」已执行 ${executed}/${steps.length} 步` }
      } catch (e) {
        return { ok: false, message: `回放失败：${e instanceof Error ? e.message : String(e)}` }
      }
    }
    case 'assignProxy': {
      const profileId = num(params.profileId)
      const proxyId = num(params.proxyId)
      const p = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!p) return { ok: false, message: '环境不存在' }
      const px = await ctx.ds.getRepository(ProxyEntity).findOne({ where: { id: proxyId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!px) return { ok: false, message: '代理不存在' }
      p.proxyId = proxyId
      await ctx.ds.getRepository(ProfileEntity).save(p)
      await audit(ctx, 'assign_proxy', `（助手）为环境「${p.name}」(#${p.id}) 分配代理「${px.name}」(#${px.id})`, true)
      return { ok: true, message: `已为环境「${p.name}」分配代理「${px.name}」` }
    }
    case 'healthcheckEnv': {
      const profileId = num(params.profileId)
      const p = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!p) return { ok: false, message: '环境不存在' }
      if (p.deletedAt) return { ok: false, message: '该环境已删除，请先从回收站恢复' }
      // 体检必须在真实窗口内采集实际生效的指纹，静态比对库里配置没有意义
      if (p.status !== 'running' || !getRunningWindowIds().includes(profileId)) {
        return { ok: false, message: `环境「${p.name}」未运行，请先打开窗口再体检` }
      }
      const actual = await probeFingerprint(profileId)
      if (!actual) return { ok: false, message: '环境窗口未运行，请打开后再体检' }
      if (actual.error) return { ok: false, message: `指纹采集失败：${actual.error}` }
      let proxyCountry = ''
      if (p.proxyId) {
        const px = await ctx.ds.getRepository(ProxyEntity).findOne({ where: { id: p.proxyId } })
        proxyCountry = px?.country || ''
      }
      // audioSeed 必须与 preload 注入端同源（profileId * 2654435761），
      // 否则算出的音频期望值与窗口内实际注入值对不上，会永远判不合格
      const report = buildHealthReport(p.fingerprint as unknown as Partial<Fingerprint>, actual, {
        proxyCountry,
        audioSeed: p.id * 2654435761
      })
      await audit(ctx, 'healthcheck_profile', `（助手）体检环境「${p.name}」(#${p.id})：伪装度 ${report.score}`)
      // weight=0 的项表示「不适用」（如没绑代理时的出口国家比对），
      // 不算作不合格——否则每个无代理环境都会被报「有 N 项不合格」
      const bad = report.items.filter((i) => !i.ok && i.weight > 0).length
      const badCons = report.consistency.filter((i) => !i.ok && !i.skipped).length
      const total = bad + badCons
      return {
        ok: true,
        message: `环境「${p.name}」体检：伪装度 ${report.score} 分（${total ? `${total} 项不合格` : '全部合格'}）`,
        detail: report
      }
    }
    case 'createEnv': {
      const count = Math.max(1, Math.min(MAX_CREATE_COUNT, Math.floor(Number(params.count)) || 1))
      const name = String(params.name || '').trim()
      const platform = String(params.platform || '').trim()
      const startUrl = String(params.startUrl || '').trim() || DEFAULT_START_URL
      const repo = ctx.ds.getRepository(ProfileEntity)
      // seq 在团队内递增，与 UI 的「快速创建」取相同起点（1001）
      const max = await repo
        .createQueryBuilder('p')
        .select('MAX(p.seq)', 'm')
        .where('p.teamId = :tid', { tid: ctx.tid })
        .andWhere('p.ownerId = :oid', { oid: ctx.uid })
        .getRawOne<{ m: number | null }>()
      let seq = (max?.m || 1000) + 1
      const created: Array<{ id: number; name: string }> = []
      for (let i = 0; i < count; i++) {
        const p = await repo.save(
          repo.create({
            teamId: ctx.tid,
            ownerId: ctx.uid,
            name: name || `环境 ${seq}`,
            seq,
            remark: '',
            platform,
            startUrl,
            proxyId: null,
            fingerprint: randomFingerprint() as unknown as Record<string, unknown>,
            isTemplate: false,
            createdBy: ctx.uid
          })
        )
        seq += 1
        created.push({ id: p.id, name: p.name })
      }
      await audit(ctx, 'create_profile', `（助手）创建 ${created.length} 个环境${name ? `（名称前缀「${name}」）` : ''}`)
      return { ok: true, message: `已创建 ${created.length} 个环境`, detail: { created } }
    }
    case 'importEnvs': {
      const raw = params.items
      const items = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>
      if (!items.length) return { ok: false, message: '没有可导入的环境数据（items 为空）' }
      if (items.length > MAX_CREATE_COUNT) {
        return { ok: false, message: `一次最多导入 ${MAX_CREATE_COUNT} 个环境，当前 ${items.length} 个；请分批导入` }
      }
      // 复用导出器里的导入实现：与 UI 的「导入环境」和全空间快照导入同源，
      // 分组/代理/账号/Cookie 的复用与落库规则不会在这里长出第二套
      const summary = await importProfileItems(items, { tid: ctx.tid, uid: ctx.uid, role: ctx.role })
      if (summary.created === 0) return { ok: false, message: '没有有效的环境可导入（每项需含 name 与 fingerprint）' }
      await audit(
        ctx,
        'import_profiles',
        `（助手）导入 ${summary.created} 个环境（分组 ${summary.groupsCreated}、代理 ${summary.proxiesCreated}、账号 ${summary.accountsCreated}、Cookie ${summary.cookiesCreated}）`
      )
      return {
        ok: true,
        message: `已导入 ${summary.created} 个环境（新建分组 ${summary.groupsCreated} 个、代理 ${summary.proxiesCreated} 条、账号 ${summary.accountsCreated} 条）`,
        detail: summary
      }
    }
    case 'randomizeFingerprints': {
      const ids = idList(params.profileIds).slice(0, MAX_COLLECT_IDS)
      if (!ids.length) return { ok: false, message: '未指定有效的环境（profileIds 为空或全是非法 id）' }
      const { targets, skipped, notFound } = await loadTargets(ctx, admin, ids, { skipRunning: true })
      if (!targets.length) {
        return { ok: false, message: `没有可改动的环境（跳过 ${skipped} 个，其中运行中或已删除；未找到 ${notFound} 个）` }
      }
      for (const p of targets) {
        p.fingerprint = randomFingerprint() as unknown as Record<string, unknown>
        await ctx.ds.getRepository(ProfileEntity).save(p)
      }
      await audit(ctx, 'batch_randomize', `（助手）批量重随机 ${targets.length} 个环境的指纹（跳过 ${skipped} 个）`, true)
      return {
        ok: true,
        message: bulkMessage(targets.length, skipped || notFound ? `，跳过 ${skipped + notFound} 个（运行中/已删除/不存在）` : ''),
        detail: { updated: targets.length, skipped: skipped + notFound }
      }
    }
    case 'batchAssignProxy': {
      const ids = idList(params.profileIds).slice(0, MAX_COLLECT_IDS)
      if (!ids.length) return { ok: false, message: '未指定有效的环境（profileIds 为空或全是非法 id）' }
      const rawProxy = params.proxyId
      // proxyId 允许显式传 null：用户说「批量解绑代理」时这是唯一正确表达。
      // 用 undefined 判断而非真值判断，否则 null 会被误当成「没传」。
      const unbind = rawProxy === null || rawProxy === ''
      const proxyId = unbind ? null : Number(rawProxy)
      let proxyName = '无（解绑）'
      if (!unbind) {
        if (!proxyId) return { ok: false, message: 'proxyId 非法' }
        const px = await ctx.ds.getRepository(ProxyEntity).findOne({ where: { id: proxyId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
        if (!px) return { ok: false, message: '代理不存在' }
        proxyName = px.name
      }
      const { targets, skipped, notFound } = await loadTargets(ctx, admin, ids, { skipRunning: true })
      if (!targets.length) {
        return { ok: false, message: `没有可绑定的环境（跳过 ${skipped} 个，其中运行中或已删除；未找到 ${notFound} 个）` }
      }
      for (const p of targets) {
        p.proxyId = proxyId
        await ctx.ds.getRepository(ProfileEntity).save(p)
      }
      await audit(ctx, 'batch_bind_proxy', `（助手）批量绑定 ${targets.length} 个环境到代理「${proxyName}」`, true)
      return {
        ok: true,
        message: bulkMessage(targets.length, skipped || notFound ? `，跳过 ${skipped + notFound} 个（运行中/已删除/不存在）` : '') + `，代理：${proxyName}`,
        detail: { updated: targets.length, skipped: skipped + notFound, proxyId }
      }
    }
    case 'batchExtendExpiry': {
      const ids = idList(params.profileIds).slice(0, MAX_COLLECT_IDS)
      if (!ids.length) return { ok: false, message: '未指定有效的环境（profileIds 为空或全是非法 id）' }
      // 三种模式与 UI 的批量改到期时间一致：add 各自加 N 天 / set 统一设日期 / clear 转长期有效
      const mode = String(params.mode || 'add')
      if (!['add', 'set', 'clear'].includes(mode)) {
        return { ok: false, message: `mode 只能是 add / set / clear，收到「${mode}」` }
      }
      if (mode === 'clear') {
        const { targets } = await loadTargets(ctx, admin, ids, { skipRunning: false })
        let cleared = 0
        for (const p of targets) {
          const fp = (p.fingerprint || {}) as Record<string, unknown>
          if (!getEnvExpiresAt(fp)) continue
          p.fingerprint = withEnvExpiresAt(fp, null) as never
          await ctx.ds.getRepository(ProfileEntity).save(p)
          cleared++
        }
        await audit(ctx, 'batch_clear_expiry', `（助手）清除 ${cleared} 个环境的到期时间（转为长期有效）`, true)
        return { ok: true, message: `已清除 ${cleared} 个环境的到期时间（转为长期有效）` }
      }
      if (mode === 'set') {
        const raw = params.expiresAt
        const t = typeof raw === 'string' ? new Date(raw).getTime() : NaN
        if (!Number.isFinite(t)) return { ok: false, message: 'expiresAt 不是合法日期' }
        const { targets, skipped } = await loadTargets(ctx, admin, ids, { skipRunning: false })
        if (!targets.length) return { ok: false, message: '未找到可操作的环境' }
        for (const p of targets) {
          const fp = (p.fingerprint || {}) as Record<string, unknown>
          p.fingerprint = withEnvExpiresAt(fp, new Date(t).toISOString()) as never
          await ctx.ds.getRepository(ProfileEntity).save(p)
        }
        await audit(
          ctx,
          'batch_extend_expiry',
          `（助手）设置 ${targets.length} 个环境的到期时间为 ${new Date(t).toISOString().slice(0, 10)}`,
          true
        )
        return {
          ok: true,
          message: `已把 ${targets.length} 个环境的到期时间统一设为 ${new Date(t).toISOString().slice(0, 10)}${skipped ? `，跳过 ${skipped} 个` : ''}`
        }
      }
      // add
      const days = Number(params.days)
      if (!Number.isFinite(days)) return { ok: false, message: 'days 必须是数字' }
      const abs = Math.abs(Math.round(days))
      if (abs === 0 || abs > 3650) return { ok: false, message: '天数需在 1 ~ 3650 之间（或用 mode:"set" 直接指定日期）' }
      const { targets, skipped } = await loadTargets(ctx, admin, ids, { skipRunning: false })
      if (!targets.length) return { ok: false, message: '未找到可操作的环境' }
      let updated = 0
      let skippedNoExpiry = 0
      let stillExpired = 0
      for (const p of targets) {
        const fp = (p.fingerprint || {}) as Record<string, unknown>
        const cur = getEnvExpiresAt(fp)
        // 原本长期有效的顺带加上天数，等于替用户做了一个他没要求的决定
        if (!cur) { skippedNoExpiry++; continue }
        const next = new Date(cur).getTime() + days * 86400000
        // 延长后仍在过去：必须如实回报，否则用户以为「续上了」但环境照样打不开
        if (next < Date.now()) stillExpired++
        p.fingerprint = withEnvExpiresAt(fp, new Date(next).toISOString()) as never
        await ctx.ds.getRepository(ProfileEntity).save(p)
        updated++
      }
      await audit(
        ctx,
        'batch_extend_expiry',
        `（助手）延长 ${updated} 个环境的到期时间 ${days > 0 ? '+' : ''}${days} 天${skippedNoExpiry ? `，跳过 ${skippedNoExpiry} 个长期有效的` : ''}`,
        true
      )
      const notes: string[] = []
      if (skippedNoExpiry) notes.push(`跳过 ${skippedNoExpiry} 个长期有效的`)
      if (stillExpired) notes.push(`${stillExpired} 个延长后仍是过期状态`)
      return {
        ok: true,
        message: `已延长 ${updated} 个环境 ${days > 0 ? '+' : ''}${days} 天${notes.length ? `（${notes.join('；')}）` : ''}`,
        detail: { updated, skippedNoExpiry, stillExpired, skipped }
      }
    }
    case 'batchDeleteEnvs': {
      const ids = idList(params.profileIds).slice(0, MAX_COLLECT_IDS)
      if (!ids.length) return { ok: false, message: '未指定有效的环境（profileIds 为空或全是非法 id）' }
      const { targets, skipped, notFound } = await loadTargets(ctx, admin, ids, { skipRunning: true })
      if (!targets.length) {
        return { ok: false, message: `没有可删除的环境（跳过 ${skipped} 个，其中运行中或已删除；未找到 ${notFound} 个）` }
      }
      const now = new Date()
      for (const p of targets) {
        p.deletedAt = now
        await ctx.ds.getRepository(ProfileEntity).save(p)
      }
      await audit(ctx, 'batch_delete_profile', `（助手）批量删除 ${targets.length} 个环境（进回收站，可还原）`, true)
      return {
        ok: true,
        message: bulkMessage(targets.length, `（已进回收站，可还原）${skipped || notFound ? `，跳过 ${skipped + notFound} 个` : ''}`),
        detail: { updated: targets.length, skipped: skipped + notFound }
      }
    }
    case 'renameProfile': {
      const profileId = num(params.profileId)
      const name = String(params.name || '').trim()
      if (!name) return { ok: false, message: '名称不能为空' }
      const p = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!p) return { ok: false, message: '环境不存在' }
      const old = p.name
      p.name = name
      await ctx.ds.getRepository(ProfileEntity).save(p)
      await audit(ctx, 'rename_profile', `（助手）环境「${old}」(#${p.id}) 重命名为「${name}」`, true)
      return { ok: true, message: `已重命名为「${name}」` }
    }
    case 'deleteEnv': {
      const profileId = num(params.profileId)
      const p = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!p) return { ok: false, message: '环境不存在' }
      if (p.status === 'running') return { ok: false, message: '请先关闭正在运行的窗口' }
      p.deletedAt = new Date()
      await ctx.ds.getRepository(ProfileEntity).save(p)
      await audit(ctx, 'delete_profile', `（助手）删除环境「${p.name}」(#${p.id})（已进回收站）`, true)
      return { ok: true, message: `环境「${p.name}」已删除（进回收站）` }
    }
    case 'deleteProxy': {
      const proxyId = num(params.proxyId)
      const px = await ctx.ds.getRepository(ProxyEntity).findOne({ where: { id: proxyId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!px) return { ok: false, message: '代理不存在' }
      // 解除引用该代理的环境，避免孤儿外键
      await ctx.ds.getRepository(ProfileEntity).update({ proxyId, teamId: ctx.tid }, { proxyId: null } as never)
      await ctx.ds.getRepository(ProxyEntity).delete({ id: proxyId, teamId: ctx.tid })
      await audit(ctx, 'delete_proxy', `（助手）删除代理「${px.name}」(#${px.id})`, true)
      return { ok: true, message: `代理「${px.name}」已删除` }
    }
    case 'removeMember': {
      const memberId = num(params.memberId)
      const m = await ctx.ds.getRepository(TeamMemberEntity).findOne({ where: { id: memberId, teamId: ctx.tid } })
      if (!m) return { ok: false, message: '成员不存在' }
      await ctx.ds.getRepository(TeamMemberEntity).delete({ id: memberId, teamId: ctx.tid })
      await audit(ctx, 'remove_member', `（助手）移除团队成员 #${memberId}`, true)
      return { ok: true, message: '成员已移除' }
    }
    case 'transferEnv': {
      const profileId = num(params.profileId)
      const targetTeamId = num(params.targetTeamId)
      if (!targetTeamId || targetTeamId === ctx.tid) return { ok: false, message: '请选择不同的目标团队' }
      const p = await ctx.ds.getRepository(ProfileEntity).findOne({ where: { id: profileId, teamId: ctx.tid, ...(admin ? {} : { ownerId: ctx.uid }) } })
      if (!p) return { ok: false, message: '环境不存在' }
      if (p.status === 'running') return { ok: false, message: '请先关闭正在运行的窗口，再转移' }
      const targetMember = await ctx.ds.getRepository(TeamMemberEntity).findOne({ where: { userId: ctx.uid, teamId: targetTeamId } })
      if (!targetMember) return { ok: false, message: '你不是目标团队成员，无法转移' }
      const targetTeam = await ctx.ds.getRepository(TeamEntity).findOne({ where: { id: targetTeamId } })
      p.teamId = targetTeamId
      p.ownerId = ctx.uid
      await ctx.ds.getRepository(ProfileEntity).save(p)
      await ctx.ds.getRepository(CookieEntity).update({ profileId: p.id }, { teamId: targetTeamId, ownerId: ctx.uid })
      await ctx.ds.getRepository(AccountEntity).update({ profileId: p.id }, { ownerId: ctx.uid })
      await audit(ctx, 'transfer_profile', `（助手）将环境「${p.name}」(#${p.id}) 转移到团队「${targetTeam?.name || targetTeamId}」`, true)
      return { ok: true, message: `已转移到团队「${targetTeam?.name || targetTeamId}」` }
    }
    default:
      return { ok: false, message: `未实现的动作：${kind}` }
  }
}
