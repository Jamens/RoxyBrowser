// 智能助手（Planner）后端引擎
//
// 流程：用户自然语言 → LLM 产出「计划 JSON」→ 三道闸校验（敏感拦截 / 白名单查询 / 动作映射）
// → 执行只读查询并把每行映射成可跳转深链；危险动作只产出「待确认提案」，由前端确认后调 executeAssistantAction。
//
// 所有敏感 / 权限校验都在后端硬兜底，不依赖模型自觉。

import type { DataSource } from 'typeorm'
import type { AIAgentSettings, RpaStep } from '../shared/types'
import { substituteSteps } from '../shared/rpa'
import { ollamaChat, type OllamaMessage } from './agent/ollama'
import { cloudChat } from './agent/cloud'
import { openWindow, replayRpaScript, getRunningWindowIds } from './browserManager'
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
  RpaScriptEntity
} from './entities'

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

interface PlanQuery {
  entity?: string
  fields?: string[]
  filters?: Array<{ field?: string; op?: string; value?: unknown }>
  limit?: number
  orderBy?: string
  orderDir?: 'ASC' | 'DESC'
}
interface PlanAction {
  kind?: string
  label?: string
  target?: { entity?: string; id?: number }
  params?: Record<string, unknown>
}
interface Plan {
  understanding?: string
  intent?: string
  queries?: PlanQuery[]
  actions?: PlanAction[]
  reply?: string
}

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
}
export interface AssistantResult {
  ok: boolean
  understanding: string
  reply: string
  intent: string
  sensitiveBlocked?: boolean
  queries: AssistantQueryResult[]
  actions: AssistantActionProposal[]
}

function clampLimit(n?: number): number {
  const v = Math.floor(Number(n) || 20)
  return Math.min(Math.max(v, 1), 50)
}

async function runOneQuery(ctx: PlannerCtx, q: PlanQuery): Promise<AssistantQueryResult | { blocked: true }> {
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
    const val = f.value
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

  const queries: AssistantQueryResult[] = []
  let sensitiveBlocked = false
  for (const q of plan.queries || []) {
    if (!q || !q.entity) continue
    try {
      const r = await runOneQuery(ctx, q)
      if ('blocked' in r) {
        sensitiveBlocked = true
        continue
      }
      queries.push(r)
    } catch (e: unknown) {
      const msg = e instanceof Object && 'message' in e ? (e as { message?: string }).message : String(e)
      queries.push({
        entity: (q.entity as AssistantEntity) || 'profiles',
        entityLabel: ASSISTANT_ENTITIES[q.entity as AssistantEntity]?.label || q.entity || '未知',
        columns: [],
        rows: [],
        total: 0,
        truncated: false
      })
      // 单条查询失败不阻断整体，reply 里提示
      if (!plan.reply) plan.reply = `部分查询失败：${msg}`
    }
  }

  // 动作提案（闸 3：仅保留白名单内的 kind，危险分级交由前端确认）
  const actions: AssistantActionProposal[] = []
  for (const a of plan.actions || []) {
    if (!a || !a.kind) continue
    const def = ASSISTANT_ACTIONS[a.kind]
    if (!def) continue
    const targetId = Number(a.target?.id ?? a.params?.profileId ?? a.params?.proxyId ?? a.params?.memberId ?? a.params?.scriptId ?? 0)
    actions.push({
      kind: def.kind,
      label: a.label || def.label,
      danger: def.danger,
      target: { entity: a.target?.entity || def.kind, id: targetId },
      params: a.params || {}
    })
  }

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
    actions
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
