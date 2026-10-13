/**
 * 造测试数据：往操作日志表插入横跨多个月的记录，用于验证归档功能。
 *
 * 为什么需要：日志表为空时点「试运行 / 执行归档」看不到任何效果，
 * 无法确认功能是否正常。造一批**跨越保留期边界**的数据才能看出搬运是否正确。
 *
 * 默认保留期 90 天（今天 2026-10-13 → 边界在 2026-07-15 附近）：
 *   2026-05 月 → 已过期，应被归档
 *   2026-06 月 → 已过期，应被归档
 *   2026-08 月 → 保留期内，不应动
 *   今天       → 保留期内，不应动
 *
 * 造完可用 `node scripts/tmp-clean-test-logs.cjs` 或界面上的「撤销归档」清理。
 */
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { OperationLogEntity } from '../src/main/entities'

async function main() {
  const ds = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '1234560',
    database: process.env.DB_NAME || 'roxy_browser',
    charset: 'utf8mb4',
    entities: [OperationLogEntity],
    synchronize: false,
    logging: ['error']
  })
  await ds.initialize()
  const repo = ds.getRepository(OperationLogEntity)

  const d = (y: number, m: number, day: number, h = 10, mi = 0) => new Date(y, m - 1, day, h, mi, 0, 0)
  const rows = [
    // 2026-05：已过期整月，应归档
    { teamId: 1, userId: 1, username: 'admin', action: 'create_profile', detail: '测试：5月创建环境 A', sensitive: false, createdAt: d(2026, 5, 3) },
    { teamId: 1, userId: 1, username: 'admin', action: 'export_cookie', detail: '测试：5月导出环境A的Cookie', sensitive: true, createdAt: d(2026, 5, 12) },
    { teamId: 1, userId: 1, username: 'admin', action: 'delete_profile', detail: '测试：5月删除环境 B', sensitive: true, createdAt: d(2026, 5, 28) },
    // 2026-06：已过期整月，应归档
    { teamId: 1, userId: 1, username: 'api:CI', action: 'create_proxy', detail: '测试：6月批量导入代理 50 条', sensitive: false, createdAt: d(2026, 6, 5) },
    { teamId: 1, userId: 1, username: 'api:CI', action: 'update_proxy', detail: '测试：6月自动巡检换绑代理', sensitive: false, createdAt: d(2026, 6, 20) },
    // 2026-08：保留期内，不应归档
    { teamId: 1, userId: 1, username: 'admin', action: 'create_profile', detail: '测试：8月创建环境 C', sensitive: false, createdAt: d(2026, 8, 8) },
    { teamId: 1, userId: 1, username: 'admin', action: 'export_profile', detail: '测试：8月导出环境清单', sensitive: true, createdAt: d(2026, 8, 22) },
    // 今天：保留期内，不应归档
    { teamId: 1, userId: 1, username: 'admin', action: 'login', detail: '测试：今天登录', sensitive: false, createdAt: new Date() }
  ]

  await repo.save(repo.create(rows))
  console.log(`已插入 ${rows.length} 条测试日志：`)
  console.log('  2026-05（3条）→ 应被归档')
  console.log('  2026-06（2条）→ 应被归档')
  console.log('  2026-08（2条）→ 保留期内，不应动')
  console.log('  今天（1条）    → 保留期内，不应动')
  console.log('\n下一步：打开「操作日志 → 归档区」点「试运行」，应报告只归档 5 条（5月+6月）')

  await ds.destroy()
}

main().catch((e) => {
  console.error('[fail]', e.message)
  process.exit(1)
})