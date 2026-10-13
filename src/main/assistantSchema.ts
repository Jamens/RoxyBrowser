// 智能助手（Planner）可查询实体的白名单 + Planner 系统提示构建器
//
// 设计目标：让本地 LLM 把用户自然语言转成「结构化查询计划」，后端在白名单内执行，
// 敏感实体/字段在后端硬拦截（绝不依赖模型自觉），并把结果映射成可跳转深链。
//
// 三道闸（见 assistantPlanner.ts）：
//   1) 敏感拦截：api_tokens / users 整体禁查；password/value/username 等敏感字段后端直接剔除。
//   2) 只读白名单：query 的 entity / field / filter 必须落在下方白名单内，否则降级或拒绝。
//   3) 动作映射：action.kind 必须落在 ASSISTANT_ACTIONS 内，按危险分级决定直执行 / 确认 / 强确认。

import type { AIAgentSettings } from '../shared/types'

/** 可被助手查询的实体（与 entities.ts 的 @Entity 表名对齐） */
export type AssistantEntity =
  | 'profiles'
  | 'proxies'
  | 'accounts'
  | 'cookies'
  | 'extensions'
  | 'rpa_scripts'
  | 'operation_logs'
  | 'groups'
  | 'teams'

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'json'

export interface EntityField {
  name: string
  label: string
  type: FieldType
}

export interface AssistantEntityDef {
  entity: AssistantEntity
  /** 中文展示名 */
  label: string
  /** 真实表名（与 @Entity 一致，用于 QueryBuilder） */
  table: string
  /** 主键字段名 */
  idField: string
  /** 允许查询/展示的非敏感字段（敏感列已剔除） */
  fields: EntityField[]
  /** 结果卡片默认展示的字段子集（避免一屏全是列） */
  defaultFields: string[]
  /** 根据一行记录拼出前端 hash 路由 + focus 参数（点击跳转定位） */
  deepLink: (row: Record<string, unknown>) => string
  /** 行内标题（结果卡片首行展示） */
  titleOf: (row: Record<string, unknown>) => string
  /** 反向关联：执行后追加的「关联对象」实体（用于「环境快过期」补出使用它的环境） */
  enrich?: { entity: AssistantEntity; via: string }
}

/** 整体禁查实体：含令牌/凭据/2FA 等，一律返回「该数据敏感，暂不提供查询」 */
export const FORBIDDEN_ENTITIES: string[] = ['api_tokens', 'users']

/** 敏感字段禁查表（即使模型要查，后端也直接剔除，绝不回传） */
export const SENSITIVE_FIELD_BLOCKLIST: Record<string, string[]> = {
  proxies: ['username', 'password'],
  accounts: ['password'],
  cookies: ['value'],
  api_tokens: ['token'],
  users: ['passwordHash', 'twoFactorSecret']
}

/** 敏感数据统一提示语（前端直接展示） */
export const SENSITIVE_BLOCK_MESSAGE = '该数据属于敏感凭据（令牌 / 密码 / 密钥等），暂不提供查询，请到设置页或对应模块手动操作。'

const q = (id: number | string) => `#/${id}`

export const ASSISTANT_ENTITIES: Record<AssistantEntity, AssistantEntityDef> = {
  profiles: {
    entity: 'profiles',
    label: '环境',
    table: 'profiles',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'seq', label: '序号', type: 'number' },
      { name: 'remark', label: '备注', type: 'string' },
      { name: 'platform', label: '平台', type: 'string' },
      { name: 'startUrl', label: '起始页', type: 'string' },
      { name: 'proxyId', label: '代理ID', type: 'number' },
      { name: 'isTemplate', label: '是否模板', type: 'boolean' },
      { name: 'status', label: '状态', type: 'string' },
      { name: 'lastOpenedAt', label: '最后打开', type: 'date' },
      { name: 'createdAt', label: '创建时间', type: 'date' },
      { name: 'updatedAt', label: '更新时间', type: 'date' },
      { name: 'deletedAt', label: '回收站', type: 'date' }
    ],
    defaultFields: ['id', 'name', 'seq', 'platform', 'status', 'proxyId', 'lastOpenedAt'],
    deepLink: (r) => `#/envs?focus=${r.id}`,
    titleOf: (r) => `${r.name ?? '环境'} #${r.seq ?? r.id}`
  },
  proxies: {
    entity: 'proxies',
    label: '代理',
    table: 'proxies',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'type', label: '类型', type: 'string' },
      { name: 'host', label: '主机', type: 'string' },
      { name: 'port', label: '端口', type: 'number' },
      { name: 'remark', label: '备注', type: 'string' },
      { name: 'country', label: '国家', type: 'string' },
      { name: 'region', label: '州省', type: 'string' },
      { name: 'city', label: '城市', type: 'string' },
      { name: 'isp', label: '运营商', type: 'string' },
      { name: 'status', label: '状态', type: 'string' },
      { name: 'latency', label: '延迟', type: 'number' },
      { name: 'anonymity', label: '匿名度', type: 'string' },
      { name: 'exitIp', label: '出口IP', type: 'string' },
      { name: 'expiresAt', label: '到期时间', type: 'date' },
      { name: 'lastCheckAt', label: '最近检测', type: 'date' },
      { name: 'createdAt', label: '创建时间', type: 'date' }
    ],
    defaultFields: ['id', 'name', 'type', 'host', 'port', 'country', 'status', 'expiresAt', 'anonymity'],
    deepLink: (r) => `#/proxies?focus=${r.id}`,
    titleOf: (r) => `${r.name ?? '代理'} ${r.host ?? ''}:${r.port ?? ''}`,
    // 「环境快过期」本质是绑定该代理的环境要到期——补出使用它的环境，结果更贴近用户意图
    enrich: { entity: 'profiles', via: 'proxyId' }
  },
  accounts: {
    entity: 'accounts',
    label: '账号',
    table: 'accounts',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'profileId', label: '环境ID', type: 'number' },
      { name: 'platform', label: '平台', type: 'string' },
      { name: 'username', label: '账号', type: 'string' },
      { name: 'remark', label: '备注', type: 'string' },
      { name: 'createdAt', label: '创建时间', type: 'date' }
    ],
    defaultFields: ['id', 'platform', 'username', 'profileId', 'remark'],
    deepLink: (r) => `#/accounts?focus=${r.id}`,
    titleOf: (r) => `${r.platform ?? '账号'}:${r.username ?? ''}`
  },
  cookies: {
    entity: 'cookies',
    label: 'Cookie',
    table: 'cookies',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'profileId', label: '环境ID', type: 'number' },
      { name: 'domain', label: '域名', type: 'string' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'path', label: '路径', type: 'string' },
      { name: 'secure', label: 'Secure', type: 'boolean' },
      { name: 'httpOnly', label: 'HttpOnly', type: 'boolean' },
      { name: 'sameSite', label: 'SameSite', type: 'string' },
      { name: 'expirationDate', label: '过期时间', type: 'date' },
      { name: 'hostOnly', label: '仅主机', type: 'boolean' },
      { name: 'createdAt', label: '创建时间', type: 'date' }
    ],
    defaultFields: ['id', 'domain', 'name', 'profileId', 'expirationDate'],
    // Cookie 属于某个环境：跳转到该环境方便处理
    deepLink: (r) => `#/envs?focus=${r.profileId}`,
    titleOf: (r) => `${r.domain ?? ''} / ${r.name ?? ''}`
  },
  extensions: {
    entity: 'extensions',
    label: '扩展',
    table: 'extensions',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'version', label: '版本', type: 'string' },
      { name: 'description', label: '描述', type: 'string' },
      { name: 'createdAt', label: '创建时间', type: 'date' }
    ],
    defaultFields: ['id', 'name', 'version'],
    deepLink: (r) => `#/extensions?focus=${r.id}`,
    titleOf: (r) => `${r.name ?? '扩展'} ${r.version ?? ''}`
  },
  rpa_scripts: {
    entity: 'rpa_scripts',
    label: 'RPA脚本',
    table: 'rpa_scripts',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'remark', label: '备注', type: 'string' },
      { name: 'scheduleEnabled', label: '定时', type: 'boolean' },
      { name: 'scheduleIntervalMin', label: '间隔(分)', type: 'number' },
      { name: 'scheduleProfileId', label: '目标环境', type: 'number' },
      { name: 'lastScheduledRunAt', label: '上次运行', type: 'date' },
      { name: 'createdAt', label: '创建时间', type: 'date' },
      { name: 'updatedAt', label: '更新时间', type: 'date' }
    ],
    defaultFields: ['id', 'name', 'remark', 'scheduleEnabled', 'scheduleProfileId', 'updatedAt'],
    deepLink: (r) => `#/rpa?focus=${r.id}`,
    titleOf: (r) => `${r.name ?? '脚本'}`
  },
  operation_logs: {
    entity: 'operation_logs',
    label: '操作日志',
    table: 'operation_logs',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'username', label: '操作人', type: 'string' },
      { name: 'action', label: '动作', type: 'string' },
      { name: 'detail', label: '详情', type: 'string' },
      { name: 'sensitive', label: '敏感', type: 'boolean' },
      { name: 'createdAt', label: '时间', type: 'date' }
    ],
    defaultFields: ['id', 'username', 'action', 'detail', 'sensitive', 'createdAt'],
    deepLink: (r) => `#/logs?focus=${r.id}`,
    titleOf: (r) => `${r.action ?? '日志'} · ${r.username ?? ''}`
  },
  groups: {
    entity: 'groups',
    label: '分组',
    table: 'groups',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'sort', label: '排序', type: 'number' },
      { name: 'createdAt', label: '创建时间', type: 'date' }
    ],
    defaultFields: ['id', 'name', 'sort'],
    deepLink: (r) => `#/envs?group=${r.id}`,
    titleOf: (r) => `${r.name ?? '分组'}`
  },
  teams: {
    entity: 'teams',
    label: '团队',
    table: 'teams',
    idField: 'id',
    fields: [
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: '名称', type: 'string' },
      { name: 'createdAt', label: '创建时间', type: 'date' }
    ],
    defaultFields: ['id', 'name'],
    deepLink: (r) => `#/team?focus=${r.id}`,
    titleOf: (r) => `${r.name ?? '团队'}`
  }
}

/** 查询计划里允许的比较运算符 */
export const ALLOWED_FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'between']

/** 危险分级：safe=直执行；medium=确认条；destructive=强确认弹窗+写审计 */
export type ActionDanger = 'safe' | 'medium' | 'destructive'

export interface AssistantActionDef {
  kind: string
  label: string
  danger: ActionDanger
  /** 参数说明（仅用于提示，实际由 LLM 填 params） */
  params: string[]
  /**
   * 批量动作：params 里是 id 数组而非单个 id。
   *
   * 标注这个字段不只是为了文档——执行器需要它决定**归属校验的写法**：
   * 单个动作是 `where: { id }`，批量是 `where: { id: In(ids) }`。
   * 漏了 `In()` 而逐条循环，则中途任何一条失败都会留下半改状态。
   */
  bulk?: boolean
}

/**
 * 可被助手执行的动作白名单（危险分级决定确认强度）。
 *
 * 分级的判据不是「看起来严不严重」，而是**出错后的可恢复性**：
 * - safe：只读或纯派生（打开窗口、跑脚本）。错了重来一次，无残留。
 * - medium：写库但**可逆**（改名、分配代理、重随机指纹、创建环境）。
 *   环境/代理是软删除进回收站，误操作能捞回来。
 * - destructive：改写归属或批量写，且**没有逐条撤销路径**。
 *
 * `closeEnv` 没进白名单是有意的：助手关掉用户正在用的窗口，
 * 可能打断他正在做的操作，而这类现场状态模型无从得知。
 */
export const ASSISTANT_ACTIONS: Record<string, AssistantActionDef> = {
  openEnv: { kind: 'openEnv', label: '打开环境', danger: 'safe', params: ['profileId'] },
  runRpa: { kind: 'runRpa', label: '运行RPA脚本', danger: 'safe', params: ['scriptId', 'profileId'] },
  healthcheckEnv: { kind: 'healthcheckEnv', label: '环境指纹体检', danger: 'safe', params: ['profileId'] },
  assignProxy: { kind: 'assignProxy', label: '为环境分配代理', danger: 'medium', params: ['profileId', 'proxyId'] },
  renameProfile: { kind: 'renameProfile', label: '重命名环境', danger: 'medium', params: ['profileId', 'name'] },
  createEnv: { kind: 'createEnv', label: '创建环境', danger: 'medium', params: ['name', 'count', 'platform', 'startUrl'] },
  importEnvs: { kind: 'importEnvs', label: '导入环境（JSON）', danger: 'medium', params: ['items'] },
  randomizeFingerprints: { kind: 'randomizeFingerprints', label: '批量重随机指纹', danger: 'medium', params: ['profileIds'], bulk: true },
  batchAssignProxy: { kind: 'batchAssignProxy', label: '批量绑定代理', danger: 'medium', params: ['profileIds', 'proxyId'], bulk: true },
  deleteEnv: { kind: 'deleteEnv', label: '删除环境', danger: 'destructive', params: ['profileId'] },
  batchDeleteEnvs: { kind: 'batchDeleteEnvs', label: '批量删除环境', danger: 'destructive', params: ['profileIds'], bulk: true },
  batchExtendExpiry: {
    kind: 'batchExtendExpiry',
    label: '批量改到期时间',
    danger: 'medium',
    params: ['profileIds', 'days', 'mode'],
    bulk: true
  },
  deleteProxy: { kind: 'deleteProxy', label: '删除代理', danger: 'destructive', params: ['proxyId'] },
  removeMember: { kind: 'removeMember', label: '移除团队成员', danger: 'destructive', params: ['memberId'] },
  transferEnv: { kind: 'transferEnv', label: '转移环境到其他团队', danger: 'destructive', params: ['profileId', 'targetTeamId'] }
}

/**
 * 构建 Planner 系统提示（含当前时间，便于模型生成「快过期」的 between 过滤值）。
 * 模型只负责产出结构化 JSON；所有敏感/白名单校验由后端兜底。
 */
export function buildAssistantSystemPrompt(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const catalog = Object.values(ASSISTANT_ENTITIES)
    .map((e) => `- ${e.entity}（${e.label}）：可查字段 ${e.fields.map((f) => f.name).join(', ')}`)
    .join('\n')

  return `你是一个本地指纹浏览器的「智能助手 / AI 客服」。你可以查询本机数据库来回答用户关于环境、代理、账号、Cookie、扩展、RPA 脚本、操作日志、分组、团队的问题，并可以提议一些操作（打开环境、跑脚本、创建/批量操作环境、分配代理、删除等）。

# 当前时间
CURRENT_TIME = ${iso(now)}

# 可查询实体白名单
${catalog}

# 硬性禁查（必须拒绝，改用标准提示语）
- api_tokens（令牌）整体禁查
- users（用户/2FA/密钥）整体禁查
- 任何涉及 password / token / secret / 密钥 / 2FA 的查询，一律不要执行，回复固定句：「${SENSITIVE_BLOCK_MESSAGE}」
  例如用户问「哪个账号密码是 admin」「我的 API 令牌是什么」，都按此处理。

# 输出契约（必须且仅输出一个 JSON 对象，不要任何 markdown 代码块、不要解释文字）
{
  "understanding": "一句话复述用户意图（中文）",
  "intent": "query" | "action" | "mixed" | "blocked" | "unknown",
  "queries": [
    {
      "entity": "proxies",               // 必须是上方白名单之一
      "fields": ["name","expiresAt"],    // 想展示的字段；留空 [] 则用默认展示字段
      "filters": [                       // 可空；op 仅限 = != > >= < <= like in between
        { "field": "expiresAt", "op": "between", "value": ["@rel:now", "@rel:now+7d"] }
      ],
      "limit": 20,                       // 默认 20，最大 50
      "orderBy": "expiresAt",
      "orderDir": "ASC"                  // ASC | DESC
    }
  ],
  "actions": [                           // 仅在用户明确要求做某事时填；否则 []
    { "kind": "openEnv", "label": "打开环境 A", "target": { "entity": "profiles", "id": 12 }, "params": { "profileId": 12 } }
  ],
  "reply": "对用户的自然语言回复（中文，说明查到什么 / 将要做什么 / 或敏感拒绝原因）"
}

# 动作白名单（actions[].kind 仅限以下，危险分级决定前端确认强度）
- openEnv(safe) / runRpa(safe) / healthcheckEnv(safe)
- assignProxy(medium) / renameProfile(medium) / createEnv(medium) / importEnvs(medium)
- randomizeFingerprints(medium, 批量) / batchAssignProxy(medium, 批量) / batchExtendExpiry(medium, 批量)
- deleteEnv(destructive) / batchDeleteEnvs(destructive, 批量) /
  deleteProxy(destructive) / removeMember(destructive) / transferEnv(destructive)

# 批量动作：两种写法，必须分清
批量动作（randomizeFingerprints / batchAssignProxy / batchDeleteEnvs / batchExtendExpiry）的参数
profileIds 是**数组**。你有两种方式填它，**优先用 collect**：

1) 已有查询结果可用时，用 collect 汇总成一条动作（推荐）：
   {
     "kind": "batchAssignProxy",
     "collect": { "fromQuery": 0, "collect": "profileIds" },
     "params": { "proxyId": 7 }
   }
   这样用户只确认一次，而不是 N 次。

2) 用户明确给了 id 列表时，直接写数组：
   { "kind": "randomizeFingerprints", "params": { "profileIds": [3, 7, 12] } }

- **不要**用 forEach 来做批量动作。forEach 是「N 行 → N 条独立动作」
  （适合「把这 3 个过期代理逐个删掉」），用于批量改同一件事会让用户确认 N 次。
- 永远不要自己枚举查询结果里的 id：查询最多 50 行，且你无法确认哪个该被选中。
  需要「对查出来的这些做 X」时，一律用 collect。

# 关键语义
- 「环境快过期 / 哪些环境即将到期」：本系统环境本身没有过期时间，到期的是它所绑定代理的 expiresAt。
  因此应查询 proxies 表，过滤 expiresAt BETWEEN @rel:now 与 @rel:now+7d（用户说「3天内」则用 @rel:now+3d），按 expiresAt ASC 排序。
  reply 中说明「这些环境所绑定代理将在 X 天内到期」，并提示点击跳转查看对应代理与环境。
- 「最近删了哪些环境」：查询 profiles 表，过滤 deletedAt != null（回收站）。
- 「哪些代理快到期」：查询 proxies 表，过滤 expiresAt BETWEEN @rel:now 与 @rel:now+7d。
- 「创建 N 个环境」：createEnv，params 填 { "count": N }；name 省略则自动编号（环境 1001、1002…）。
- 「给这些环境批量换代理」：先查 environments，再用 batchAssignProxy + collect 汇总。
- 「体检一下环境 A」：healthcheckEnv（safe）。该动作需要环境处于运行中，
  若未运行会返回明确提示，你应在 reply 里说明「需要先打开环境」而不是反复重试。
- 「给这些号续 30 天」：batchExtendExpiry，params 填 { "mode": "add", "days": 30 }，profileIds 用 collect 汇总。
  · mode 三选一：add 各自加 N 天（可负数表示提前）/ set 统一设为指定日期（还需填 expiresAt）/ clear 转为长期有效。
  · 原本就没有到期时间（长期有效）的环境，add 模式下会被跳过；要说清这一点，别让用户以为全部续上了。
  · 延长后**仍在过去**的（过期很久的号 +30 天大概率还是过期）也会如实回报，照实转述给用户。
- 批量动作中的运行中环境会被**自动跳过**（改指纹/绑代理/删除都不动正在跑的窗口），
  执行结果里的 skipped 数量要如实写进 reply，不要谎称全部完成。

# 规则
1. 只读查询：不要试图修改数据，修改走 actions。
2. 字段必须是该实体白名单字段；不知道的字段不要写。
3. filters 的 value 用字符串/数字/字符串数组；between 用长度为 2 的数组 [起,止]。
4. 【相对时间】凡是「相对于现在」的时间条件，一律用相对标记而非绝对日期：
   - 格式为 "@rel:now±N[d|h|m]"，例如 "@rel:now"（此刻）、"@rel:now+7d"（7 天后）、"@rel:now-3d"（3 天前）、"@rel:now+12h"（12 小时后）。
   - 也可写成对象 {"__rel":"now+7d"}。数组里每个元素单独解析，如 ["@rel:now", "@rel:now+7d"]。
   - 这样生成计划被「保存为技能」后在很久以后重跑，日期仍会自动跟随当前时间，不会被写死的绝对日期冻结。
   - 不要输出 CURRENT_TIME 做字符串拼接；直接用上述 @rel: 标记。
5. 如果用户问的是禁查内容，intent 设为 "blocked"，queries/actions 留空，reply 用标准提示语。
6. 如果无法理解或超出能力，intent 设为 "unknown"，reply 说明你能查什么。
7. 只能输出 JSON，不要输出 \`\`\`json 包裹。`
}
