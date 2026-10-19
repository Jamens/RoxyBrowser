# 真机验证步骤（RoxyBrowser Clone · 指纹注入 / 环境体检）

> 适用场景：核对「指纹注入是否真的在环境窗口内生效」「各项体检红绿灯是否合理」。
> 本仓库 CI / 沙箱通常**无 GPU**、且 Electron 内置 Chromium 版本固定，WebGPU / Canvas / WebAudio
> 的**真机表现**只能在带显卡的机器上核对。代码与注入逻辑的正确性由离线单测保证（见各 `tests/*.test.cjs`），
> 但「窗口内真实回读值」只能在真机跑体检确认。

---

## 0. 离线单测（无需 GPU，先自检）

先跑纯函数单测，确认注入/派生逻辑本身正确（不依赖窗口）：

```bash
# 候选④：WebGPU 回退守卫 + Canvas 噪声确定性派生（19 例）
node node_modules/typescript/bin/tsc src/shared/webgpu.ts src/shared/canvasNoise.ts \
  --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_c4
node tests/candidate4.test.cjs
rm -rf .tmp_c4
```

预期：**19 例全绿**。关键项是「相同 (seed, 宽, 高) 派生出的噪声序列逐位相等」——这是体检 `canvasStable` 的根因。

> 其它维度（环境到期、GEO、追踪器、自动化审计等）也有各自 `tests/*.test.cjs`，改动对应模块后跑一遍即可。

---

## 1. 构建并启动

```bash
pnpm build
pnpm app          # = electron-vite build && electron out/main/index.js
# 或开发模式：pnpm dev
```

应用启动后，本地 API 默认 `http://127.0.0.1:39100`（端口被占用会自动 +1，以启动日志为准）。

---

## 2. 登录并打开环境

1. 用默认账号 `admin / 123456` 登录（或你的账号）。
2. 在「环境」列表选一个**已开启 Canvas 噪声 + Audio 噪声**的环境（默认开启）。
3. 点「打开」让环境进入 `running`。

> ⚠️ 体检接口 `POST /api/profiles/:id/healthcheck` **要求窗口处于 `running`**，否则返回
> 「请先打开环境窗口，再执行体检」。这与 RPA 录制、截图等要求一致——注入只有在真实页面上下文里才读得准。

---

## 3. 触发体检

- **UI（推荐）**：环境行 / 详情里的「体检」按钮，结果表格会列出所有检查项（含权重与状态）。
- **API（可选）**：

  ```bash
  curl -X POST "http://127.0.0.1:39100/api/profiles/<环境ID>/healthcheck" \
       -H "Authorization: Bearer <你的 rb_ 令牌>" | jq '.items'
  ```

  令牌可在 UI 登录后的请求里抓，或 `POST /api/auth/login` 获取。返回结构：`{ score, items[], consistency[], checkedAt, proxyCountry }`。

---

## 4. 核对候选④ 新增的检查项

| 检查项 key | 期望结果 | 说明 / 异常解读 |
| --- | --- | --- |
| `webgpu` | 非 iOS 且有独显时 `ok=true`，`actual` 与 WebGL 的 vendor/architecture 一致 | 若机器回退到 SwiftShader（`isFallbackAdapter=true`），该项显示「软件渲染回退：不伪装」且 `weight 0`——**这是正确行为**，不计入扣分（规则 #22 不伪造原则） |
| `webgpuSubgroup` | `min>0, max>0, min≤max`，`ok=true`，`weight 0` | 仅核验原生透传的 `subgroupMin/MaxSize` 未被破坏 |
| `canvasNoise` | `actual = "on / 一致性OK"`，`ok=true` | **若显示「一致性不一致!」→ 说明噪声随调用变化，会被检测站识别为注入**，属真实缺陷需修 |
| `audioCodecs` | `iamf=no / opus=probably / aac=probably`，`weight 0` | IAMF 为编解码能力查询（Chromium 版本/OS 决定，非硬件指纹），按不伪造原则**不注入**；当前 Electron Chromium <152 原生不支持 IAMF=no 即正确 |

---

## 5. 典型预期（带独显的 Windows 机器，伪装 Windows + NVIDIA）

- `webgpu`：`ok`，`actual = "nvidia / ampere"`（与 WebGL 一致）。
- `webgpuSubgroup`：`ok`，`min/max` 为合理正整数。
- `canvasNoise`：`on + 稳定`，`ok`。
- `audioCodecs`：`iamf=no`（符合运行时版本），其余正常。

---

## 6. 若某项红 / 异常

- `webgpu` 红但 `webgpuIsFallback` 为 true → 属环境限制（软件渲染），本就 `weight 0` 不扣分，无需处理。
- `canvasNoise` 一致性不一致 → 先重跑步骤 0 单测；若单测已过但真机仍不一致，多半是某条读取路径没走改写后的原型方法，回头查 preload 注入时机（须在导航前挂上）。
- 其余稳定绿即代表候选④三方向在真机层面自洽。

---

## 7. 其它体检项（简述，详细见 `FEATURES.md` §2.1 / §7.x）

- `webgl` / `webglOsMatch`：WebGL 显卡与「显卡↔OS」一致性。
- `uaData`：UA-CH（iOS 伪装时必须整体不存在）。
- `audioProfile` / `audioReduction`：采样率 / 延迟 / 声道 / 压缩器响应（期望值由 `profileId` 同源 seed 现算）。
- `eme`：Widevine + ClearKey 可用性（iOS 期望无 EME）。
- `platformApis` / `mediaPrefs` / `fontOsConsistency` / `automation` 等：平台 API 一致性、媒体查询偏好、字体 OS 一致性、反自动化痕迹。

全部「不适用」项（`weight 0`）不参与伪装度总分，仅作环境信息展示。

---

## 8. 无显卡本机纯逻辑自检（纯函数 + 体检计算，无需 GPU / 窗口）

本机若无显卡 / 无显示（`DISPLAY` 为空、且无 `xvfb`），无法启动真实 Electron 窗口，也就读不到 WebGPU / Canvas / WebAudio 的**真实硬件回读值**，步骤 0–6 的「开窗 → API 体检」走不通。但候选④有两层**不依赖显卡**的逻辑可以在本机直接验证：

1. **注入侧纯函数**：`tests/candidate4.test.cjs`（19 例）—— WebGPU 回退守卫、Canvas 噪声确定性派生、seed 回退等。
2. **体检计算逻辑**：`tests/healthcheck_sim.cjs` —— 把 `buildHealthReport` 编成 CJS，用合成探针覆盖 `webgpu` / `webgpuSubgroup` / `canvasNoise(canvasStable)` / `audioCodecs` 四项的各分支，验证其 `ok / weight / expected / actual` 计算正确（独显通过、软件回退不适用、Canvas 不一致判红、iOS 无 WebGPU）。

### 运行命令

```bash
# 1) 注入侧纯函数（19 例）
node node_modules/typescript/bin/tsc src/shared/webgpu.ts src/shared/canvasNoise.ts \
  --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_c4
node tests/candidate4.test.cjs
rm -rf .tmp_c4

# 2) 体检计算逻辑仿真（编译 healthcheck.ts 及其纯依赖到 CJS）
node node_modules/typescript/bin/tsc src/shared/healthcheck.ts \
  --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --lib es2020,dom --outDir .tmp_hc
node tests/healthcheck_sim.cjs
rm -rf .tmp_hc
```

### 预期

- `candidate4.test.cjs`：打印「通过 19 项」，关键项是「相同 (seed, 宽, 高) 派生出的噪声序列逐位相等」（这是 `canvasStable` 的根因）。
- `healthcheck_sim.cjs`：四个场景（A 独显桌面 / B 软件回退 / C Canvas 不一致 / D iOS）的全部断言通过；其中 **C 的 `canvasNoise` 应判红**（`actual = "on / 一致性不一致!"`），证明不稳定的噪声会被识别为注入缺陷。

> 这两层验证覆盖候选④的「计算正确性」；「真实硬件回读值」仍需在带显卡的真机上按步骤 0–6 跑。


---

# 新增功能真机验证记录（2026-10-19）

> 本次为「快照导入预演 / 一致性批量修复预演 / 代理分配可视化」三项功能的真机验证。
> 环境：Electron 44.2.0 开发模式，MySQL（Docker `mysql:latest`），API `127.0.0.1:39100`，渲染进程 `localhost:5173`。

## 1. 启动方式（含两个环境坑）

```bash
# 坑 1：本仓库要求 MySQL，默认 root/1234560；若密码被改过，可用 DB_USER/DB_PASS 覆盖
# 坑 2：某些 Electron 宿主环境会设 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node，
#       主进程在 electron.ipcMain.on(...) 处直接崩（ipcMain 为 undefined）。
#       启动前必须 unset：
unset ELECTRON_RUN_AS_NODE
DB_USER=<user> DB_PASS=<pass> pnpm dev
```

GUI 窗口打开失败**不影响** API 服务继续运行（`src/main/index.ts` 启动流程里有专门注释），
所以无显示器环境也能验证接口。

## 2. 已验证通过的功能

### 2.1 代理分配预演（`POST /api/profiles/batch-allocate-proxy`，`preview: true`）

| 场景 | 结果 |
| --- | --- |
| 6 个代理（3 可用 US + 1 JP + 1 失效 + 1 过期） | 池构成正确：可用 4，排除 `{"invalid":1,"expired":1}`，逐条列出原因 |
| 加 `country: "United"` 筛选 | 可用降到 2，`countryFilter: 3`，建议正确提示「放宽筛选条件即可让它们进入可用池」 |
| 池不足 | 2 个 assigned + 2 个 skipped，提示「可用代理 2 个，待分配环境 4 个，缺 2 个」 |
| **预演只读性** | 预演后全部环境 `proxyId` 仍为 `NULL`，确认不写库 |
| 真实分配（不带 `preview`） | `applied: true`，4 个环境分到互不相同的代理，日志记 `batch_allocate_proxy` |

### 2.2 一致性批量修复预演（`POST /api/profiles/batch-fix-consistency`，`preview: true`）

| 场景 | 结果 |
| --- | --- |
| 4 个本来自洽的环境 | `willChange: 0`，提示「本次没有任何字段会被修改，无需执行修复」 |
| 时区与代理国家不符 | 正确算出 `timezone` + `languages` **两项**（改时区暴露的语言不一致也被一并处理，串行推演生效） |
| 执行后复查 | 时区/语言已按预期落库，`fix_consistency` 日志含成功/跳过计数 |
| 逐条失败不中断 | 代码路径覆盖（单个 try/catch），未构造失败样本 |

### 2.3 快照导入预演（`POST /api/snapshot/preview`）

| 场景 | 结果 |
| --- | --- |
| 同团队快照自导入 | 6 个代理全部 `reuse`，4 个环境，团队迁移提示准确 |
| 同名代理但连接信息不同 | 判 `conflict`，提示「现有 10.0.0.1:8080，快照 10.1.1.1:1111，导入时保留现有配置」 |
| **引用丢失且无 `proxyDetail`** | 判 `missing`，提示「将导入为无代理环境」——**这正是该功能要防的静默失败** |
| 引用丢失但带 `proxyDetail` | 判 `create`，`profileProxyCreate: 1` |

> 注意接口收 **JSON body**（不是 multipart 文件上传），字段名是 `proxy`（代理**名称**）而非 `proxyId`。

## 3. 真机验证中发现的两个问题

### 3.1 【严重】一致性修复在 `os` 缺失时会静默替换整份指纹

`src/main/routes/profileWindow.ts` 第 169 行（单环境）与第 252 行（批量）：

```ts
const next = normalizeFingerprint({ ...(before as Partial<Fingerprint>), ...patch } as Partial<Fingerprint>)
```

而 `normalizeFingerprint` 的第一件事是：

```ts
if (!fp || typeof fp.os !== 'string' || (fp.os !== 'windows' && ...)) {
  return defaultFingerprint()   // ← 整份随机指纹，传入的 patch 被全部丢弃
}
```

**实测**：把环境 #3 的指纹砍成 `{timezone, languages}`（无 `os`）后执行修复：

| | 修复前 | 接口报告 | 修复后实际 |
| --- | --- | --- | --- |
| timezone | Australia/Sydney | `timezone` | America/Los_Angeles ✓ |
| os | undefined | （未提及） | **windows（随机）** |
| userAgent | 无 | （未提及） | **有（随机）** |
| 其余字段 | 无 | （未提及） | **整份随机指纹** |

接口只回报 `applied: ["timezone","languages"]`，用户完全不知道整份指纹被换掉了。
**触发条件**：指纹缺 `os` 或 `os` 非法（老数据、导入数据、被部分更新的数据）。

**建议修法**（未实施，需确认）：修复前先校验 `before.os` 合法，不合法则**放弃该环境**并在
`failed` 里说明「环境指纹不完整（缺少 os），无法安全修复」，而不是硬套 `normalizeFingerprint`。

### 3.2 【文案】`os` 为空时不可修原因出现空段

`src/shared/healthFix.ts` 的 `uaVsOs` 分支，当 `f.os` 为空时：

> 目标系统是 ，UA 需绑定具体设备型号，无法自动生成；请在编辑里手动选择设备

中间空一格。实测环境 #2（`os=undefined`）触达。同文件另一个分支（`fromUa === target`，
两者均为空时相等）会输出「UA 解析出的平台已与设定 OS 一致，可能是判定口径不一致」，
在 os/UA 双空的场景下同样费解。

**建议**：`os` 为空时给出「该环境未设置系统类型，无法推断 UA」之类的明确文案。

## 4. 本次验证改动的数据

- 新增 6 个测试代理（`10.0.0.x` 段的假 IP，名称含「可用/失效/过期/国家不符」）
- 环境 #2/#3 的指纹被修复流程改写（#3 因 3.1 的 bug 被整份随机化）
- 数据库结构：`pnpm db:sync` 补了一列 `users.revokedDevices`（纯增量，无删除）
- 备份：`/tmp/roxy_browser_backup_20261019.sql`（同步前，37KB）

## 5. 复现用的脚本

验证脚本已落在 `scripts/` 下，可重复执行：

```bash
TK=$(cat /tmp/roxy-token.txt) node scripts/verify-snapshot.cjs          # 快照预演（正常）
TK=$(cat /tmp/roxy-token.txt) node scripts/verify-snapshot-conflict.cjs # 快照预演（冲突）
TK=$(cat /tmp/roxy-token.txt) node scripts/verify-snapshot-danger.cjs   # 快照预演（引用丢失）
```

> 说明：`/tmp/roxy-token.txt` 由登录响应落盘得到；token 有效期 7 天，过期后重新登录即可。
