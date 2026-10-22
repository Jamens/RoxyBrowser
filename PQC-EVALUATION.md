# 后量子加密（PQC）升级评估

> 评估日期：2026-10-19　·　评估对象：RoxyBrowser Clone
> 触发问题：「能否升级 WebCrypto 后量子加密，强化网络数据抗量子攻击能力」

---

## 0. 一句话结论

**不要升级——WebCrypto 的后量子能力对这个项目是错的工具，而项目真正需要的抗量子能力，
底层栈已经免费给了。**

真正值得花时间的是另一件事（见第 5 节），它对"数据安全"的提升比 PQC 高几个数量级。

---

## 1. 先盘点：这个项目到底用了什么密码学

全仓扫描 `crypto.subtle` **零命中**——项目从未使用 WebCrypto。所有密码学操作都在
**主进程（Node）**里，用的是 `node:crypto`：

| 用途 | 算法 | 实现 | 是否需要 PQC |
| --- | --- | --- | --- |
| 凭据静态加密（账号密码 / 2FA / 代理密码 / AI Key） | AES-256-GCM | `src/shared/secretCrypto.ts` | ❌ 对称，AES-256 抗 Grover 至 128 位，**安全** |
| 密钥派生 | SHA-256 直接摘要 | `deriveKey()` | ❌ 同上 |
| 用户密码哈希 | bcrypt | `bcryptjs` | ❌ 与量子无关 |
| JWT 签名 | HS256 | `jsonwebtoken` | ❌ 对称 HMAC，**安全** |
| TOTP 校验 | HMAC-SHA1 | `src/main/totp.ts` | ❌ 同上 |
| Webhook 签名 | HMAC | `src/main/webhook.ts` | ❌ 同上 |

**全仓无 `generateKeyPair` / `createSign` / `createVerify` / RSA / ECDSA，
无 `.pem` / `.key` / `.crt` 文件——项目没有任何公钥密码学面。**

### 为什么这一条决定了结论

量子计算机破解的是**公钥密码学**（RSA、椭圆曲线），即 Shor 算法。
本项目用的全部是**对称算法**与**哈希**，量子威胁对它们的影响只有 Grover 算法
（平方根加速）：AES-256 → 有效 128 位，SHA-256 → 128 位。

**所以「harvest now, decrypt later」（先截获密文，将来用量子计算机解密）
这个 PQ 核心威胁，在这个项目里根本没有落点。**

---

## 2. 为什么 WebCrypto PQC 是错的工具

即便有需要，也不该用 WebCrypto：

| 问题 | 事实 |
| --- | --- |
| 位置不对 | 项目的密码学全在主进程（Node）。渲染进程（唯一能用 WebCrypto 的地方）**一行密码学代码都没有** |
| 可用性差 | WebCrypto PQC（ML-KEM/ML-DSA）在 **Chromium 152 仍处于原始试验期**（Chrome 151–153），需开 `chrome://flags/#enable-experimental-web-platform-features` 或申请试验令牌；**Safari 完全不支持** |
| 稳定性差 | MDN/规范状态为「非 Baseline」，各浏览器实现进度不一致 |
| 收益为零 | 就算明天全部可用，项目也没有需要 ML-KEM 封装或 ML-DSA 签名的场景 |

---

## 3. 好消息：需要的抗量子能力，底层栈已经免费给了

实测本项目运行时（Electron 44.2.0）：

```
Electron: 44.2.0 | Chromium: 152.0.7977.76 | Node: 24.20.0
```

### 3.1 Node 侧：ML-KEM / ML-DSA 原生可用，零 flag、零依赖

Node.js **v24.7.0 起**内置了 ML-KEM / ML-DSA。Electron 44 内置 Node 24.20.0，
满足门槛。实测（在本项目的 Electron 运行时里）：

```
ML-KEM-768: encapsulate/decapsulate 一致 ✅ | 密文 1088 B | 共享密钥 32 B
ML-DSA-65:  签名成功 ✅ | 签名 3309 B | 验签 true
```

**若将来真需要（例如给 webhook 载荷做 PQ 签名），一行 `require('node:crypto')` 即可，
不需要 WebCrypto、不需要 flag、不需要第三方依赖。**

### 3.2 TLS 侧：混合组已在客户端就绪

`X25519MLKEM768`（RFC 10024，2026-08 定稿）是 Chrome 131+ / Firefox 132+ / Safari 26+ /
OpenSSL 3.5+ 的**默认** TLS 1.3 密钥交换组。本项目 Chromium 152 > 131，**已默认启用**。

**实测验证**（不是查文档，是真握手）：起一个**只提供 `X25519MLKEM768`** 的本地
OpenSSL 3.5.7 服务器，用项目 Electron 的 Node 客户端去连：

```
✅ 握手成功 | 协议: TLSv1.3 | cipher: TLS_AES_128_GCM_SHA256
   → Node(Electron) 客户端支持 X25519MLKEM768（服务器仅提供该组）
```

**即：客户端会主动发混合组密钥份额**（classical + PQ 双跑，任一成立即安全）。

### 3.3 覆盖情况

| 出站面 | 走哪条栈 | 抗量子状态 |
| --- | --- | --- |
| 环境窗口浏览真实站点（TikTok / Amazon 等） | Chromium 152 | ✅ **已默认混合组** |
| Webhook 投递（`webhook.ts` → 用户自配 URL） | Node `fetch` | ✅ 客户端已支持；**能否协商取决于服务端** |
| AI 云端 API（`agent/cloud.ts`） | Node `fetch` | ✅ 同上 |
| SMTP 发信（`smtp.ts` → `tls.connect`） | Node `tls` | ✅ 客户端已支持 |
| 代理健康检查（`proxyService.ts`） | 经代理的 Node TLS | ✅ 同上 |
| 本地 API（`127.0.0.1:39100`） | 明文 HTTP | ➖ 回环，非 PQ 目标（但见 5.2） |

---

## 4. 剩下的真正缺口：源站侧

浏览器与客户端都已默认发混合组，但 **2026 年源站侧支持率仅约 10%**。
客户端发了、服务端不接 → 仍回落为纯经典密钥交换。

**这个缺口本项目无法自行消除**：

- 不能"要求"对端支持——Webhook URL、AI API 地址都是用户/第三方定的；
- 强行拒绝非 PQ 连接会直接打断功能（大量中小站点、SMTP 服务器至今不提供混合组）。

**这属于「等待生态成熟」而非「需要写代码」的事。** 可以做的只有两件：

1. 在文档里说明"本客户端已默认发混合组"；
2. 若某个具体对端（如自家 AI 网关）是自己控制的，**在服务端开启**
   `ssl_conf_command Groups X25519MLKEM768:X25519:prime256v1;` 即可——
   一行配置，客户端无需任何改动，兼容性自动兜底。

---

## 5. 比 PQC 更值得做的（按性价比排序）

### 5.1 密钥派生用 HKDF 而非 SHA-256 直接摘要 【推荐做】

现状（`src/shared/secretCrypto.ts`）：

```ts
export function deriveKey(keyMaterial: string): Buffer {
  return createHash('sha256').update(keyMaterial, 'utf8').digest()
}
```

问题不在 PQC（SHA-256 抗量子），而在**这不是一个合格的 KDF**：

- 缺少 **salt**：同一份密钥材料在任何部署上派生出同一把 AES 密钥；
- 缺少 **info/domain separation**：无法派生用途隔离的子密钥；
- SHA-256 单次摘要**没有拉伸**：若 `ROXY_SECRET_KEY` 配的是低熵口令，
  攻击者拿到库后爆破该摘要的成本几乎等于直接爆破 AES 密钥。

改用 HKDF-SHA256（Node 内置 `hkdfSync`，零依赖）即可，**改动量约 5 行**：

```ts
import { hkdfSync } from 'crypto'
hkdfSync('sha256', keyMaterial, salt, 'roxy:credential-encryption:v1', 32)
```

> 需注意：salt 必须是**每部署随机且持久化**的，不能每次随机——
> 否则重启后无法解密旧密文。若不想引入新文件，退一步用
> `hkdfSync('sha256', keyMaterial, <固定的库名派生盐>, info, 32)` 也比现状好。

### 5.2 本地 API 的 CORS 是全开的 【比 PQC 重要得多】

`src/main/server.ts:1338`：

```ts
app.use(cors())   // ← 无 origin 限制
```

而这个 API 背后是**账号密码、2FA 密钥、代理凭据、AI API Key**。
任意网页（含用户在其他窗口打开的站点）都能对本机 `127.0.0.1:39100` 发跨域请求
并**读取响应**。

当前靠 JWT Bearer 头兜底（跨域页面拿不到应用的 localStorage），所以并非立即可利用；
但 `rateLimiter.ts` 的注释已经点明：**本地请求全来自 127.0.0.1，按 IP 计数等于没有限流**，
于是"登录爆破"这一条在跨域场景下是**完全敞开**的（`POST /api/auth/login` 无需任何凭据即可打）。

**这才是"网络数据"层面最该补的口子**，且与 PQC 无关。

### 5.3 密码学敏捷性（crypto agility）——现在做成本最低

若不想为将来的算法更替做架构改造，**现在**就该做的只有一件事：
**把算法名从"散落在调用点"收敛到"一个策略层"**。当前散落情况：

```
createCipheriv('aes-256-gcm', ...)   ← 算法名硬编码在调用点
generateKeyPairSync('ml-kem-768')     ← 将来引入时会是同样的模式
```

这是迁移指南里点名的头号反模式（"Hardcoded cipher suites"）。代价是现在几乎为零
（只有 1 处 `aes-256-gcm`），将来则是全库返工。

---

## 6. 风险与陷阱（如果将来真要引入 PQC）

| 陷阱 | 说明 |
| --- | --- |
| **别用 WebCrypto** | 项目密码学在 Node；WebCrypto PQC 还在试验期，Safari 不支持 |
| **用 Node 原生，不用依赖** | Node ≥ 24.7 内置 `ml-kem-768` / `ml-dsa-65`，无需 npm 包 |
| **优先混合而非纯 PQ** | 社区共识：过渡期用 classical + PQ 双跑，任一成立即安全。纯 ML-KEM 部署尚属过早 |
| **注意体积** | ML-KEM 密文 1088 B、ML-DSA-65 签名 3309 B——放进 JWT / header / 二维码前先量 |
| **不要"必须 PQ 才连"** | 源站侧支持仅约 10%，强制要求会直接打断功能 |
| **数据留存期决定优先级** | 认证令牌几小时，客户记录/账号凭据几十年。**本项目的账号密码/2FA 属长敏感**——但已由 AES-256-GCM 保护，AES-256 抗 Grover 至 128 位，**不需要 PQC** |

---

## 7. 决策建议

| 选项 | 结论 |
| --- | --- |
| 引入 WebCrypto PQC（ML-KEM / ML-DSA） | ❌ **不做**。位置不对、可用性差、收益为零 |
| 改用 Node 24.20 原生 ML-KEM / ML-DSA | ⏸️ **暂不需要**。但要知道它已可用且零成本，将来有需求时无需再评估 |
| 强制出站连接必须 PQ | ❌ **不做**。源站侧仅约 10% 支持，会打断功能 |
| 为自家服务端（若有）开启混合组 | ⚪️ 可选，一行 OpenSSL 配置 |
| **密钥派生改 HKDF** | ✅ **推荐**，约 5 行，收益远超 PQC |
| **收紧本地 API 的 CORS** | ✅ **推荐**，这是当前"网络数据"层面最大的实际缺口 |
| **把算法名收敛到策略层** | ✅ **推荐**，趁改动面还只有 1 处 |

---

## 附：本次评估用到的实测命令

```bash
# Electron 44 内置 Node 24.20.0，ML-KEM / ML-DSA 原生可用
unset ELECTRON_RUN_AS_NODE
node_modules/.pnpm/electron@44.2.0_*/node_modules/electron/dist/electron.exe -e "
  const c=require('crypto');
  const kp=c.generateKeyPairSync('ml-kem-768');
  const {ciphertext,sharedKey}=c.encapsulate(kp.publicKey);
  console.log(c.decapsulate(kp.privateKey,ciphertext).equals(sharedKey));
"

# 客户端是否真发混合组密钥份额（只提供 X25519MLKEM768 的服务器）
openssl s_server -accept 14443 -cert c.pem -key c.pem -groups X25519MLKEM768 -www
# 另开一个终端用 Node 连 localhost:14443，能握手即支持
```

> 实测环境：Windows 11 / Electron 44.2.0 / Chromium 152.0.7977.76 / Node 24.20.0 /
> OpenSSL 3.5.7（2026-06）
