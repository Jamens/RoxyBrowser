import type { Request } from 'express'

/**
 * 账户级隔离的公共定义。
 *
 * 原本这些散在 server.ts 内，但 server.ts 过大（近 4000 行）而路由正被按域拆分，
 * 每个 routes/* 模块都要把 ownerScope 当作 deps 逐层传递、还要从 server 反向
 * `import type` 取 AuthedRequest —— 既啰嗦又让 server 成了所有模块的隐性依赖中心。
 * 集中到本模块后：路由直接 import，deps 只保留真正属于「服务端装配」的东西
 * （DataSource 取值器、中间件、写日志、以及 browserManager 提供的动作）。
 */
export type AuthedRequest = Request & {
  uid?: number
  tid?: number
  username?: string
  role?: string
  /**
   * API 令牌身份（v1 的 tokenAuthMiddleware 注入）。
   * 令牌调用没有登录态、拿不到 uid，但审计必须能追溯「哪个令牌、谁创建的」，
   * 否则令牌能建环境 / 删数据 / 导出 Cookie 却零留痕，形成审计盲区。
   */
  apiToken?: { id: number; name: string; ownerId: number }
  /**
   * 会话令牌里声明的设备指纹（`dev`）。
   * 登出时据此**只吊销本设备**；缺失（旧令牌）时降级为全设备撤销。
   */
  dev?: string
}

// 账户级隔离：普通用户（member）只看到自己 ownerId 的数据；owner/admin 看全部（管理员视角）。
// 团队管理类接口（成员/团队信息/操作日志/设置）保持团队维度，不套用此隔离。
export function isAdminRole(role?: string): boolean {
  return role === 'owner' || role === 'admin'
}

export function ownerScope(req: AuthedRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (isAdminRole(req.role)) return { ...extra }
  return { ownerId: req.uid, ...extra }
}

/** 给 QueryBuilder 追加账户隔离条件（admin 不加） */
export function ownerAndWhere(
  qb: { andWhere: (sql: string, params?: Record<string, unknown>) => unknown },
  req: AuthedRequest,
  alias = 'p'
): void {
  if (!isAdminRole(req.role)) qb.andWhere(`${alias}.ownerId = :oid`, { oid: req.uid })
}
