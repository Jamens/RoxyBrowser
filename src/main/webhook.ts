import { createHmac, randomUUID } from 'node:crypto'
import type { WebhookConfig } from '../shared/types'

// ===== Webhook 通知引擎（纯逻辑，无 express 依赖，便于离线单测） =====

export interface WebhookActor {
  uid: number
  username: string
  role: string
}

export interface WebhookPayload {
  /** 事件名（对应操作日志的 action，如 create_profile） */
  event: string
  /** 本次投递唯一 ID，便于接收端去重 */
  eventId: string
  /** ISO8601 时间戳 */
  timestamp: string
  /** 所属团队 ID（无则 null） */
  teamId: number | null
  /** 操作者（无则 null，如定时任务 / agent 触发的日志） */
  actor: WebhookActor | null
  /** 事件详情（即操作日志的 detail） */
  detail: unknown
}

export interface WebhookDeliveryResult {
  ok: boolean
  status: number
  error?: string
}

/** 可注入的 fetch 类型（精简，便于 mock） */
type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
) => Promise<{ ok: boolean; status: number }>

let activeFetch: FetchLike = globalThis.fetch as unknown as FetchLike

/** 测试用：注入 mock fetch（离线单测时替换真实网络请求） */
export function setWebhookFetch(fn: FetchLike): void {
  activeFetch = fn
}

// 内存缓存的 webhook 配置：启动加载 + PUT /settings 时刷新，避免每次事件查库
let cachedWebhooks: WebhookConfig[] = []

export function setCachedWebhooks(list: WebhookConfig[]): void {
  cachedWebhooks = Array.isArray(list) ? list : []
}

export function getCachedWebhooks(): WebhookConfig[] {
  return cachedWebhooks
}

/** HMAC-SHA256 签名，返回十六进制摘要（与接收端 X-Roxy-Signature: sha256=... 对应） */
export function signWebhookBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * 事件是否命中某条 webhook 订阅：
 * - 未启用 → false
 * - events 为空或含 '*' → 全部命中
 * - 精确字符串命中（如 'open_profile'）
 * - 含 '*' 的通配（glob，如 '*profile*' 匹配任意含 profile 的事件名）
 * - 关键词命中：事件名按 '_' 分词后包含该关键词（如 'profile' 命中 create_profile / batch_delete_profile）
 */
export function webhookShouldFire(wh: WebhookConfig, event: string): boolean {
  if (!wh.enabled) return false
  const evs = wh.events
  if (!evs || evs.length === 0) return true
  if (evs.includes('*')) return true
  const segs = event.split('_')
  return evs.some((e) => {
    if (e === event) return true
    if (e === '*') return true
    if (e.includes('*')) {
      // 通配：把 * 当作 .* 做正则匹配（转义其余正则元字符）
      const re = new RegExp(
        '^' +
          e
            .split('*')
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*') +
          '$'
      )
      return re.test(event)
    }
    // 关键词：事件名按 _ 分词后包含该关键词
    return segs.includes(e)
  })
}

/** 构造标准 payload */
export function buildWebhookPayload(input: {
  event: string
  eventId?: string
  teamId: number | null
  actor: WebhookActor | null
  detail: unknown
  timestamp?: string
}): WebhookPayload {
  return {
    event: input.event,
    eventId: input.eventId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    teamId: input.teamId,
    actor: input.actor,
    detail: input.detail
  }
}

/** 单次投递（真实网络），返回投递结果；绝不抛错（网络异常转为 error 字段） */
export async function dispatchWebhookEvent(
  wh: WebhookConfig,
  payload: WebhookPayload,
  fetchFn: FetchLike = activeFetch
): Promise<WebhookDeliveryResult> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'RoxyBrowser-Webhook/1.0',
    'X-Roxy-Event': payload.event,
    'X-Roxy-Delivery': payload.eventId
  }
  if (wh.secret) {
    headers['X-Roxy-Signature'] = `sha256=${signWebhookBody(wh.secret, body)}`
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetchFn(wh.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * fire-and-forget：遍历所有「启用且命中事件」的 webhook 投递。
 * 绝不 await、绝不抛错阻塞主业务流程。
 */
export function dispatchWebhook(
  event: string,
  ctx: {
    teamId: number | null
    actor: WebhookActor | null
    detail: unknown
  }
): void {
  const hooks = getCachedWebhooks().filter((wh) => webhookShouldFire(wh, event))
  if (hooks.length === 0) return
  for (const wh of hooks) {
    const payload = buildWebhookPayload({
      event,
      teamId: ctx.teamId,
      actor: ctx.actor,
      detail: ctx.detail
    })
    void dispatchWebhookEvent(wh, payload).catch(() => {
      /* 投递失败静默忽略，不阻塞业务 */
    })
  }
}

/** 测试投递（设置页「发送测试」按钮 / POST /api/webhooks/test）：等待结果返回调用方 */
export async function testWebhook(wh: WebhookConfig): Promise<WebhookDeliveryResult> {
  const payload = buildWebhookPayload({
    event: 'webhook_test',
    teamId: null,
    actor: null,
    detail: { message: 'This is a test delivery from RoxyBrowser Clone.' }
  })
  return dispatchWebhookEvent(wh, payload)
}
