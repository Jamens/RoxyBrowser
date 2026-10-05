/**
 * 库表结构差异检查（**只读，不执行任何 DDL**）。
 *
 * 用途：synchronize: true 会在启动时自动改表，好处是首次安装免手动建表，
 * 坏处是**发版时改实体可能静默丢列**。本脚本用 TypeORM 的 schemaBuilder.log()
 * 列出「若执行 synchronize 会发生什么」，让发版前能先看到破坏性变更。
 *
 * 运行：
 *   node node_modules/typescript/bin/tsc scripts/db-schema-log.ts src/main/entities.ts \
 *     --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck \
 *     --experimentalDecorators --emitDecoratorMetadata --outDir .tmp_dbsl
 *   node .tmp_dbsl/scripts/db-schema-log.js
 */
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import {
  UserEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamInviteEntity,
  GroupEntity,
  ProxyEntity,
  ProfileEntity,
  AccountEntity,
  CookieEntity,
  OperationLogEntity,
  ApiTokenEntity,
  AppSettingsEntity,
  ExtensionEntity,
  RpaScriptEntity,
  AssistantSkillEntity
} from '../src/main/entities'

async function main() {
  const ds = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3307),
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '1234560',
    database: process.env.DB_NAME || 'roxy_browser',
    timezone: '+00:00',
    logging: false,
    entities: [
      UserEntity,
      TeamEntity,
      TeamMemberEntity,
      TeamInviteEntity,
      GroupEntity,
      ProxyEntity,
      ProfileEntity,
      AccountEntity,
      CookieEntity,
      OperationLogEntity,
      ApiTokenEntity,
      AppSettingsEntity,
      ExtensionEntity,
      RpaScriptEntity,
      AssistantSkillEntity
    ]
  })
  await ds.initialize()
  try {
    const sqlInMemory = await ds.driver.createSchemaBuilder().log()
    if (sqlInMemory.upQueries.length === 0) {
      console.log('✅ 库表结构与实体一致，无待执行变更。')
      return
    }
    const destructive = /^\s*(DROP|RENAME)\b/i
    // upQueries 元素类型在不同 typeorm 版本里载荷不一（string 或 {query}），统一取出 SQL 文本
    const sqlOf = (u: unknown): string => {
      const raw = u as { query?: unknown }
      if (typeof raw.query === 'string') return raw.query
      const inner = raw.query as { query?: unknown } | undefined
      return typeof inner?.query === 'string' ? inner.query : ''
    }
    console.log(`待执行变更 ${sqlInMemory.upQueries.length} 条：\n`)
    for (const q of sqlInMemory.upQueries) {
      const sql = sqlOf(q)
      const flag = destructive.test(sql) ? '🔴 破坏性' : '🟢 增量'
      console.log(`  [${flag}] ${sql.replace(/\s+/g, ' ').slice(0, 160)}`)
    }
    const n = sqlInMemory.upQueries.filter((q) => destructive.test(sqlOf(q))).length
    console.log(`\n合计 ${n} 条破坏性变更（会丢数据，发版前务必确认）`)
  } finally {
    await ds.destroy()
  }
}

main().catch((e) => {
  console.error('检查失败：', e.message)
  process.exit(1)
})
