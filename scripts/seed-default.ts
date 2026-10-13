/**
 * 一次性脚本：创建默认种子数据（与 server.ts 的 bootstrap 第 3 步一致）。
 * 前置：sync-schema 已建好 15 张表。
 *
 * 幂等：默认账号已存在则跳过，不重复创建。
 */
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import bcrypt from 'bcryptjs'
import {
  UserEntity, TeamEntity, TeamMemberEntity, GroupEntity
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
    entities: [UserEntity, TeamEntity, TeamMemberEntity, GroupEntity]
  })
  await ds.initialize()

  const userRepo = ds.getRepository(UserEntity)
  if ((await userRepo.count()) > 0) {
    console.log('[skip] 已存在用户，跳过种子数据')
    await ds.destroy()
    return
  }

  const admin = await userRepo.save(
    userRepo.create({ username: 'admin', passwordHash: await bcrypt.hash('123456', 10), nickname: '管理员' })
  )
  const team = await ds.getRepository(TeamEntity).save(
    ds.getRepository(TeamEntity).create({ name: '默认团队' })
  )
  await ds.getRepository(TeamMemberEntity).save(
    ds.getRepository(TeamMemberEntity).create({ teamId: team.id, userId: admin.id, role: 'owner' })
  )
  const g = ds.getRepository(GroupEntity)
  await g.save(g.create({ teamId: team.id, name: 'Default', sort: 0 }))

  console.log('[ok] 种子数据已创建：admin / 123456，团队「默认团队」')
  await ds.destroy()
}

main().catch((e) => {
  console.error('[fail]', e.message)
  process.exit(1)
})
