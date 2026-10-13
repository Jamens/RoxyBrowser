import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

/**
 * 凭据静态加密（AES-256-GCM），零第三方依赖、纯函数、可离线单测。
 *
 * ## 为什么需要
 * 此前 `accounts.password`、`proxies.password`、`users.twoFactorSecret`、
 * `app_settings.aiAgent.cloudApiKey` 全部**明文入库**。全项目 grep
 * `encrypt|cipher` 仅命中 `crypto.randomBytes`（生成令牌），没有任何加解密实现。
 * 对一个以「多账号防关联」为卖点、且专门做了 `api_tokens` 敏感拦截的产品，
 * 密码躺在库里是自相矛盾的硬伤：拿到一份 mysqldump 就等于拿到全部账号 + 2FA 长期接管权。
 *
 * ## 密文格式
 * `rb1:<b64(iv)>:<b64(authTag)>:<b64(ciphertext)>`
 *
 * 用**前缀标记**而不是「解密失败就报错」，是为了兼容历史明文数据：
 * 本功能上线前入库的老数据没有 `rb1:` 前缀，`isEncryptedSecret` 判否即原样返回，
 * 读取路径完全不受影响（惰性迁移，见 `scripts/migrate-secrets.ts`）。
 *
 * 用 GCM 而非 CBC：GCM 带认证标签，密文被篡改（数据库被改、备份损坏）时解密会**抛错**
 * 而不是吐出一段垃圾明文——对「密码能否登录」这种场景，静默产出错误值比报错危险得多。
 *
 * ## 为什么不自带密钥管理
 * 本模块只管加解密，密钥来源由 `main/secretKey.ts` 提供（注入式依赖），
 * 这样纯函数可以被单测直接喂固定密钥，不依赖文件系统与环境变量。
 */

/** 密文版本前缀。改动密文结构时升版本号（`rb2:`），旧前缀仍可识别以便迁移。 */
export const CIPHER_PREFIX = 'rb1:'

const IV_BYTES = 12 // GCM 推荐 96 位
const TAG_BYTES = 16

/**
 * 把任意长度的密钥材料派生成固定 32 字节（AES-256）。
 *
 * 为什么要派生而不是直接用：环境变量里配的可能是任意字符串、文件里存的是 64 位 hex。
 * 直接 `Buffer.from(key, 'hex')` 遇到非 hex 字符会得到**长度不确定**的 buffer，
 * 进而让 `createCipheriv` 在某些输入下抛「Invalid key length」——同一份配置在不同机器上
 * 时好时坏，极难排查。统一走 sha256 后，任何来源的密钥都稳定得到 32 字节。
 */
export function deriveKey(keyMaterial: string): Buffer {
  return createHash('sha256').update(keyMaterial, 'utf8').digest()
}

/** 是否为本模块产出的密文（用于区分历史明文） */
export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(CIPHER_PREFIX)
}

/**
 * 加密。空值与 null **原样返回**——不加密有两个好处：
 * 1. 「无密码」与「有密码」在库里可区分（否则空串会变成一段密文，看起来像设过密码）；
 * 2. 代理/账号里绝大多数记录本来就没有密码，省掉无意义的加密与列膨胀。
 */
export function encryptSecret(plain: unknown, keyMaterial: string): string | null {
  if (plain === null || plain === undefined) return null
  const text = String(plain)
  if (text === '') return ''
  const key = deriveKey(keyMaterial)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return (
    CIPHER_PREFIX +
    [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':')
  )
}

/** 解密失败（密钥不对 / 密文被篡改 / 格式损坏）时只警告一次，避免刷屏 */
const warned = new Set<string>()

/**
 * 解密。对**历史明文**直接原样返回（惰性兼容）。
 *
 * 解密失败时返回空串而非抛错：凭据列散落在代理检测、代理检测入库、账号列表、
 * 环境 DTO 映射等多条读取路径上，一旦抛出就会让整个列表接口 500——为了一个坏数据
 * 让整个页面不可用，代价过高。空串是**fail-closed**：登录/连接会失败，但不会误用
 * 一段垃圾明文，且首次失败会打一条醒目的 error 日志指向根因（密钥文件丢失/被换）。
 */
export function decryptSecret(stored: unknown, keyMaterial: string): string | null {
  if (stored === null || stored === undefined) return null
  const text = String(stored)
  if (text === '') return ''
  if (!isEncryptedSecret(text)) return text // 历史明文，原样返回

  try {
    const parts = text.slice(CIPHER_PREFIX.length).split(':')
    if (parts.length !== 3) throw new Error('密文段数不为 3，格式损坏')
    const [ivB64, tagB64, dataB64] = parts
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch (e) {
    const msg = (e as Error).message
    if (!warned.has(msg)) {
      warned.add(msg)
      console.error(
        `[roxy] 凭据解密失败（${msg}）。若本机曾加密过数据，请确认密钥未更换：` +
          `环境变量 ROXY_SECRET_KEY 或 ~/.roxy-clone/secret-key 文件。` +
          `密钥丢失将导致已加密的账号密码 / 代理密码 / 2FA 密钥**无法恢复**。`
      )
    }
    return ''
  }
}

/** 密文的最大长度评估：用于确认 varchar 列宽是否够用（见 entities.ts 注释） */
export function maxCiphertextLength(plainMaxBytes: number): number {
  const b64 = (n: number) => Math.ceil((n / 3) * 4)
  return CIPHER_PREFIX.length + b64(IV_BYTES) + 1 + b64(TAG_BYTES) + 1 + b64(plainMaxBytes)
}
