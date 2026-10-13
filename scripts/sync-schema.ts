/**
 * 一次性脚本：用 TypeORM synchronize 建库建表（与 server.ts 的 bootstrap 同一路径）。
 *
 * 为什么不直接跑 db/schema.sql：
 *   - synchronize 保证表结构与 `entities.ts` **永远一致**；手写 schema 迟早漂移；
 *   - db/schema.sql 里的凭据列宽还是旧的 256，而实体已是 512（今天刚改），
 *     走 schema.sql 建出来的表存长密码会被静默截断。
 *
 * 用法：DB_PORT=3306 node .tmp_dbsl/scripts/sync-schema.js
 */
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import {
  UserEntity, TeamEntity, TeamMemberEntity, TeamInviteEntity, GroupEntity,
  ProxyEntity, ProfileEntity, CookieEntity, AccountEntity, OperationLogEntity, OperationLogArchiveEntity,
  ApiTokenEntity, ExtensionEntity, RpaScriptEntity, AppSettingsEntity, AssistantSkillEntity
} from '../src/main/entities'

async function main() {
  const ds = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '1234560',
    database: process.env.DB_NAME || 'roxy_browser',
    charset: 'utf8mb4',
    entities: [
      UserEntity, TeamEntity, TeamMemberEntity, TeamInviteEntity, GroupEntity,
      ProxyEntity, ProfileEntity, CookieEntity, AccountEntity, OperationLogEntity, OperationLogArchiveEntity,
      ApiTokenEntity, ExtensionEntity, RpaScriptEntity, AppSettingsEntity, AssistantSkillEntity
    ],
    synchronize: true,
    logging: ['error', 'warn', 'schema']
  })
  await ds.initialize()
  console.log('[ok] synchronize 完成')
  await ds.destroy()
}

main().catch((e) => {
  console.error('[fail]', e.message)
  process.exit(1)
})
