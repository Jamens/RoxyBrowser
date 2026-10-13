// 离线单测：凭据静态加密（secretCrypto + secretKey）
// 核心不变量：
//   1) 往返一致（加密→解密还原原文，含中文 / emoji / 换行 / 超长文本）
//   2) 历史明文原样返回（本功能上线前入库的数据必须仍可读）
//   3) 密文被篡改时**报错而非吐垃圾明文**（GCM 认证），且对上层 fail-closed 返回空串
//   4) 空值不加密（「无密码」与「有密码」在库里可区分）
//   5) 密钥绝不回落任何硬编码默认值（与 jwtSecret 同构的不变量）
// 运行：先 `node node_modules/typescript/bin/tsc src/shared/secretCrypto.ts src/main/secretKey.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_sc`
//      再 `node tests/secretCrypto.test.cjs`
// 注意：tsc 以第一个入口（src/shared/）推算 rootDir，产物会带一层 shared/ 或 main/ 前缀，
//      故下面的 require 路径是 `.tmp_sc/shared/...` 与 `.tmp_sc/main/...`（非扁平）。
const { mkdtempSync, writeFileSync, existsSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  deriveKey,
  CIPHER_PREFIX,
  maxCiphertextLength
} = require('../.tmp_sc/shared/secretCrypto.js')
const { getSecretKeyMaterial, __resetSecretKeyCache } = require('../.tmp_sc/main/secretKey.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}
function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'roxy-sc-'))
}

const KEY = 'unit-test-key-material'

// ============ 1) 往返一致性 ============
{
  const cases = [
    'simple',
    'P@ssw0rd!2024',
    '带中文的密码·包含特殊符号#$%^&*()',
    'emoji🔐密码🚀',
    'multi\nline\ttab',
    ' leading and trailing ',
    'a'.repeat(256)
  ]
  let allOk = true
  for (const plain of cases) {
    const enc = encryptSecret(plain, KEY)
    const dec = decryptSecret(enc, KEY)
    if (dec !== plain) {
      allOk = false
      console.log(`     往返失真: ${JSON.stringify(plain.slice(0, 20))} -> ${JSON.stringify(dec.slice(0, 20))}`)
    }
  }
  check('往返一致（含中文/emoji/换行/256 字符）', allOk)
}

// ============ 2) 密文格式与识别 ============
{
  const enc = encryptSecret('hunter2', KEY)
  check('密文带版本前缀', typeof enc === 'string' && enc.startsWith(CIPHER_PREFIX))
  check('密文为 4 段（前缀 + iv + tag + data）', enc.split(':').length === 4, enc.slice(0, 24) + '...')
  check('密文不含明文', !enc.includes('hunter2'))
  check('isEncryptedSecret 识别密文', isEncryptedSecret(enc) === true)
  check('isEncryptedSecret 拒绝明文', isEncryptedSecret('hunter2') === false)
}

// ============ 3) 随机 IV：同一明文两次加密必须不同 ============
{
  const a = encryptSecret('same-password', KEY)
  const b = encryptSecret('same-password', KEY)
  check('随机 IV → 同一明文两次密文不同', a !== b)
  check('两者均能正确解回', decryptSecret(a, KEY) === 'same-password' && decryptSecret(b, KEY) === 'same-password')
}

// ============ 4) 历史明文惰性兼容 ============
{
check('历史明文原样返回', decryptSecret('legacy-plain-password', KEY) === 'legacy-plain-password')
// 关键安全断言：伪装成密文（带 rb1: 前缀）但格式损坏的数据，**不能**被当成明文放行。
// 否则攻击者只要让密文「损坏」，就能让系统把密文原文吐出来当密码用。
check('带前缀但格式损坏 → fail-closed 而非当明文', decryptSecret('rb1:not-really', KEY) === '')
}

// ============ 5) 空值语义 ============
{
  check('空串不加密（保持空串）', encryptSecret('', KEY) === '')
  check('null 保持 null', encryptSecret(null, KEY) === null)
  check('undefined 归一为 null（DB 存 NULL）', encryptSecret(undefined, KEY) === null)
  check('解密空串仍为空串', decryptSecret('', KEY) === '')
  check('解密 null 仍为 null', decryptSecret(null, KEY) === null)
}

// ============ 6) 篡改检测（GCM 认证）============
{
  const enc = encryptSecret('tamper-target', KEY)
  const parts = enc.split(':')
  // 改一个字符的密文载荷
  const flipped = parts[3].slice(0, -2) + (parts[3].slice(-2, -1) === 'A' ? 'B' : 'A') + parts[3].slice(-1)
  const tampered = [parts[0], parts[1], parts[2], flipped].join(':')
  const result = decryptSecret(tampered, KEY)
  check('密文被篡改 → 返回空串而非垃圾明文', result === '')
  check('密文被篡改时绝不等于原文', result !== 'tamper-target')

  // 段数损坏
  check('段数损坏 → 返回空串', decryptSecret(CIPHER_PREFIX + 'a:b', KEY) === '')
}

// ============ 7) 错误密钥 → fail-closed ============
{
  const enc = encryptSecret('cross-key', KEY)
  const result = decryptSecret(enc, 'a-completely-different-key')
  check('错误密钥 → 返回空串（fail-closed）', result === '')
}

// ============ 8) deriveKey 稳定性 ============
{
  const k1 = deriveKey('anything-at-all')
  const k2 = deriveKey('anything-at-all')
  const k3 = deriveKey('anything-at-alls')
  check('deriveKey 恒定 32 字节', k1.length === 32)
  check('同输入得同密钥', k1.equals(k2))
  check('异输入得异密钥', !k1.equals(k3))
  // 非 hex 字符串（环境变量常见）也必须稳定产出 32 字节，否则 createCipheriv 会抛错
  check('非 hex 密钥材料也能工作', encryptSecret('x', 'zh-测试-密钥') !== null)
}

// ============ 9) 列宽评估：密文必须放得进 varchar ============
{
  const l256 = maxCiphertextLength(256)
  check('256 字节明文 → 密文长度可算', l256 > 256 && l256 < 512, `约 ${l256} 字符`)
  check('512 列宽足够容纳 256 字符明文', l256 <= 512)
}

// ============ 10) 密钥解析（与 jwtSecret 同构的不变量）============
{
  const dir = tmpDir()
  delete process.env.ROXY_SECRET_KEY
  __resetSecretKeyCache()
  const a = getSecretKeyMaterial(dir)
  check('生成 64 位 hex', /^[0-9a-f]{64}$/.test(a), a.slice(0, 12) + '...')
  check('已落盘 secret-key 文件', existsSync(join(dir, 'secret-key')))
  const b = getSecretKeyMaterial(dir)
  check('同目录复用同一密钥', a === b)

  // 环境变量优先
  process.env.ROXY_SECRET_KEY = 'env-secret-material'
  __resetSecretKeyCache()
  check('环境变量优先', getSecretKeyMaterial(dir) === 'env-secret-material')

  // 空白环境变量视为未配置
  process.env.ROXY_SECRET_KEY = '   '
  __resetSecretKeyCache()
  const w = getSecretKeyMaterial(dir)
  check('空白环境变量视为未配置', w === a)

  // 过短文件 → 重新生成
  const dir2 = tmpDir()
  writeFileSync(join(dir2, 'secret-key'), 'short', 'utf8')
  __resetSecretKeyCache()
  const s = getSecretKeyMaterial(dir2)
  check('过短密钥文件被重新生成', /^[0-9a-f]{64}$/.test(s) && s !== 'short')

  // 不同目录 → 不同密钥
  __resetSecretKeyCache()
  check('不同目录产出不同密钥', getSecretKeyMaterial(tmpDir()) !== getSecretKeyMaterial(tmpDir()))

  delete process.env.ROXY_SECRET_KEY
  __resetSecretKeyCache()
}

// ============ 11) 真实场景：跨密钥密文不会静默成明文 ============
{
  // 模拟密钥轮换：旧密钥加密的数据用新密钥读，必须拿到空串而不是「乱码当密码」
  const oldKey = 'old-key-material'
  const newKey = 'new-key-material'
  const cipher = encryptSecret('real-password', oldKey)
  const withOld = decryptSecret(cipher, oldKey)
  const withNew = decryptSecret(cipher, newKey)
  check('旧密钥下正常解出', withOld === 'real-password')
  check('新密钥下 fail-closed（不静默出错值）', withNew === '' && withNew !== 'real-password')
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
