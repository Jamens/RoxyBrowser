import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { decryptSecret, encryptSecret } from '../shared/secretCrypto'

const SECRET_FILE_NAME = 'secret-key'
/** 低于此长度的已存密钥视为无效（被清空 / 被截断），需重新生成 */
const MIN_SECRET_LEN = 32

/** 进程内缓存：密钥材料每次加密都要走 sha256 派生，不必反复读盘 */
let cached: string | null = null

function defaultDir(): string {
  return join(homedir(), '.roxy-clone')
}

/**
 * 解析凭据加密密钥，优先级：环境变量 > 本地持久化文件 > 首次生成并持久化。
 * 与 `jwtSecret.ts` 同构（同一套思路，避免两套心智模型），但**必须是不同的密钥**：
 * JWT 密钥泄漏的后果是「可伪造登录态」，凭据密钥泄漏的后果是「所有账号密码一次性裸奔」，
 * 二者影响面不同，不应共享同一份材料。
 *
 * 安全要点：**绝不回落任何硬编码默认值**。若代码里写死一个默认密钥，等于把全部
 * 凭据的安全性寄托在一个公开的字符串上——攻击者拿到源码即可解密所有人的库。
 *
 * 若落盘失败（只读环境 / 无权限），退回**进程内随机密钥**：本进程内加解密自洽，
 * 但重启后旧密文无法解密（`decryptSecret` 会打醒目错误日志并返回空串，fail-closed，
 * 不会出现「用错误的密码去登录」）。这比回落到弱密钥安全得多。
 *
 * @param dir 可选，用于单测注入临时目录（默认 ~/.roxy-clone）
 */
export function getSecretKeyMaterial(dir?: string): string {
  if (cached && !dir) return cached

  const fromEnv = process.env.ROXY_SECRET_KEY
  if (fromEnv && fromEnv.trim().length > 0) {
    if (!dir) cached = fromEnv.trim()
    return fromEnv.trim()
  }

  const targetDir = dir || defaultDir()
  const file = join(targetDir, SECRET_FILE_NAME)
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= MIN_SECRET_LEN) {
        if (!dir) cached = existing
        return existing
      }
    }
    const generated = randomBytes(32).toString('hex') // 64 位 hex
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(file, generated, 'utf8')
    if (!dir) cached = generated
    return generated
  } catch (e) {
    console.warn(
      '[roxy] 凭据加密密钥持久化失败，改用进程内随机密钥。重启后此前已加密的凭据将无法解密：',
      (e as Error).message
    )
    const ephemeral = randomBytes(32).toString('hex')
    if (!dir) cached = ephemeral
    return ephemeral
  }
}

/**
 * 懒加载代理：把「读密钥」的时机推迟到第一次真正加解密时。
 *
 * 为什么需要它：`entities.ts` 在模块顶层就要构造 ValueTransformer，而 Transformer
 * 是 `@Column` 装饰器的参数——模块 import 期就会执行。若在此处直接调 `getSecretKeyMaterial()`，
 * 会导致仅「导入实体定义」（如跑离线单测、`db:check` 只读检查）也去创建目录、写文件，
 * 产生意料之外的副作用。延迟到调用时求值，导入即保持零副作用。
 */
export function lazySecretCrypto(): {
  encrypt: (v: unknown) => string | null
  decrypt: (v: unknown) => string | null
} {
  return {
    encrypt: (v: unknown) => encryptSecret(v, getSecretKeyMaterial()),
    decrypt: (v: unknown) => decryptSecret(v, getSecretKeyMaterial())
  }
}

/** 仅供单测：清空进程内缓存，验证「同一进程内复用同一密钥」与「密钥切换后行为」 */
export function __resetSecretKeyCache(): void {
  cached = null
}
