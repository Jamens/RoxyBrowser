/**
 * 一次性迁移：把历史**明文**凭据加密成 `rb1:` 密文。
 *
 * 为什么需要独立的迁移脚本（而不是依赖读取时惰性加密）：
 * 惰性方案要求「每条数据都要被读一次并回写」，而实际上有些行永远不会被读到
 * （长期不用的环境、废弃代理）。那些行的密码就会**一直以明文躺在库里**——
 * 对一个以安全为卖点的产品，这是不可接受的残留。所以必须有一趟全表扫描。
 *
 * 用法：
 *   pnpm migrate:secrets        # 默认 dry-run，只统计会改多少行
 *   pnpm migrate:secrets --apply  # 真执行
 *
 * 安全性：
 *   - 默认 dry-run，不碰数据；
 *   - **幂等**：`isEncryptedSecret` 判否才加密，重复执行不会二次加密已加密数据；
 *   - 已加密的数据原样跳过（密钥不变时永远跳过）；
 *   - 只 UPDATE 凭据列，不动其他字段。
 */
import { createConnection } from 'mysql2/promise'
import { encryptSecret, isEncryptedSecret } from '../src/shared/secretCrypto'
import { getSecretKeyMaterial } from '../src/main/secretKey'

const APPLY = process.argv.includes('--apply')

/** 与 entities.ts 中 transformer 覆盖的列严格对应，漏一个就留一份明文 */
const TARGETS = [
  { table: 'accounts', column: 'password' },
  { table: 'proxies', column: 'password' },
  { table: 'users', column: 'twoFactorSecret' }
]

async function main() {
  const key = getSecretKeyMaterial()
  const conn = await createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3307),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '1234560',
    database: process.env.DB_NAME || 'roxy_browser'
  })

  let migrated = 0
  let skipped = 0
  let empty = 0

  try {
    let tableMigrated = 0
    let tableSkipped = 0
    let tableEmpty = 0
    for (const { table, column } of TARGETS) {
      tableMigrated = 0
      tableSkipped = 0
      tableEmpty = 0
      const [rows] = (await conn.query(`SELECT id, \`${column}\` AS v FROM \`${table}\``)) as [
        Array<{ id: number; v: string | null }>,
        unknown
      ]
      for (const row of rows) {
        const current = row.v
        // 空值无需加密：无密文可产生，也不构成泄漏
        if (current === null || current === undefined || current === '') {
          tableEmpty++
          continue
        }
        if (isEncryptedSecret(current)) {
          // 已是本模块产出的密文 → 幂等跳过。
          // 只按前缀判（不做「能解密」校验）：密钥轮换后旧密文也需要被重新加密，
          // 若在此处因解密失败就跳过，轮换场景将永远无法迁移。
          tableSkipped++
          continue
        }
        if (APPLY) {
          const cipher = encryptSecret(current, key)
          await conn.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE id = ?`, [cipher, row.id])
        }
        tableMigrated++
      }
      console.log(
        `  ${table}.${column}: 已加密 ${tableMigrated} / 已是密文跳过 ${tableSkipped} / 空值 ${tableEmpty}`
      )
      migrated += tableMigrated
      skipped += tableSkipped
      empty += tableEmpty
    }

    console.log(`\n合计：将加密 ${migrated} 条，已是密文 ${skipped} 条，空值 ${empty} 条`)
    console.log(APPLY ? '迁移完成，凭据已全部加密' : '[dry-run] 加 --apply 执行')
  } finally {
    await conn.end()
  }
}

main().catch((e: any) => {
  // ECONNREFUSED 是最常见的失败：MySQL 没起。给出可操作的提示，而不是甩一串 errno
  if (e?.code === 'ECONNREFUSED') {
    console.error(
      `\n连不上数据库（${e.address ?? '127.0.0.1'}:${e.port ?? 3307}）。\n` +
        `请先启动 MySQL（默认 root/1234560，库名 roxy_browser），或用环境变量 DB_HOST / DB_PORT / DB_USER / DB_PASS 覆盖。\n` +
        `参考 README「数据库（必读）」一节的 docker run 示例。`
    )
    process.exit(1)
  }
  console.error('迁移失败:', e)
  process.exit(1)
})
