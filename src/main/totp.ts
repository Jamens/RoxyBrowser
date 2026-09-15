import { createHmac, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'

// 登录二次验证（TOTP，RFC 6238）的最小实现。
// 不引入 otplib：纯 Node crypto 即可，构建零新增依赖、离线可跑。
// 仅主进程（server.ts）使用，渲染层不引用本文件，因此可安全依赖 node:crypto。

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_PERIOD = 30
const TOTP_DIGITS = 6

/** 生成一段随机的 base32 密钥（20 字节 -> 32 个字符，无填充） */
export function generateTotpSecret(length = 20): string {
  const bytes = randomBytes(length)
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)]
  }
  return out
}

/** 构造标准 otpauth:// URI，供验证器 App 扫码添加 */
export function buildOtpAuthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD)
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** 校验动态码：允许 ±1 个时间窗（默认 30s*2）的时钟漂移 */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const clean = (token || '').replace(/\s/g, '')
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(clean)) return false
  const epoch = Math.floor(Date.now() / 1000)
  for (let error = -window; error <= window; error++) {
    const counter = Math.floor((epoch + error * TOTP_PERIOD) / TOTP_PERIOD)
    if (totpAt(secret, counter) === clean) return true
  }
  return false
}

/** 生成二维码 data URL（PNG），供设置页直接 <img src> 展示 */
export async function totpQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 })
}

function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(TOTP_DIGITS, '0')
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')
  let bits = ''
  for (const c of clean) {
    const v = BASE32_ALPHABET.indexOf(c)
    if (v < 0) continue
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}
