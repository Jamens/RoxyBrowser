import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

const SECRET_FILE_NAME = 'jwt-secret'
/** 低于此长度的已存密钥视为无效（被清空 / 被截断），需重新生成 */
const MIN_SECRET_LEN = 32

function defaultDir(): string {
  return join(homedir(), '.roxy-clone')
}

/**
 * 解析 JWT 签名密钥，优先级：环境变量 > 本地持久化文件 > 首次生成并持久化。
 *
 * 安全要点：**绝不回落任何硬编码默认值**。此前 `JWT_SECRET` 回落固定字符串
 * `roxy-clone-secret-9f8e7d6c`，未配置环境变量时任何拿到该值的人都能伪造 JWT
 * 直接绕过鉴权——对一个以「多账号防关联」为卖点的产品是硬伤。
 *
 * 若落盘失败（只读环境 / 无权限），退回**进程内随机密钥**：令牌不跨重启存活，
 * 但依然不存在「已知固定密钥」，安全性不退化。
 *
 * @param dir 可选，用于单测注入临时目录（默认 ~/.roxy-clone）
 */
export function getJwtSecret(dir?: string): string {
  const fromEnv = process.env.JWT_SECRET
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()

  const targetDir = dir || defaultDir()
  const file = join(targetDir, SECRET_FILE_NAME)
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= MIN_SECRET_LEN) return existing
    }
    const generated = randomBytes(32).toString('hex') // 64 位 hex
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(file, generated, 'utf8')
    return generated
  } catch (e) {
    console.warn('[roxy] JWT 密钥持久化失败，改用进程内随机密钥（重启后令牌失效）:', (e as Error).message)
    return randomBytes(32).toString('hex')
  }
}
