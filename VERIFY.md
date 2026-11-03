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

> ✅ 3.1 与 3.2 均已于 2026-10-19 修复并复验，详见 CHANGELOG 对应条目。

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

**修复状态**：✅ 已修（commit `6934013`）。新增 `isNormalizableFingerprint` /
`normalizeBlockReason`（判定谓词由 `normalizeFingerprint` 自己复用，杜绝漂移），
在增量修复的四处入口各加一道守卫：预演判 `blocked`、单环境执行 400、批量执行进 `failed`、
单环境预演回 `fixable:false`。复验结果：残缺指纹预演 `blocked`/`willChange:0`、执行进 `failed`、
**库里指纹原封不动**；合法指纹未被误伤。

### 3.2 【文案】`os` 为空时不可修原因出现空段

`src/shared/healthFix.ts` 的 `uaVsOs` 分支，当 `f.os` 为空时：

> 目标系统是 ，UA 需绑定具体设备型号，无法自动生成；请在编辑里手动选择设备

中间空一格。实测环境 #2（`os=undefined`）触达。同文件另一个分支（`fromUa === target`，
两者均为空时相等）会输出「UA 解析出的平台已与设定 OS 一致，可能是判定口径不一致」，
在 os/UA 双空的场景下同样费解。

**修复状态**：✅ 已修。新增 `os` 为空的前置分支：「该环境未设置系统类型（os 为空），
无法判断 UA 应该匹配哪个平台；请先在编辑弹窗中选择系统类型」，同时覆盖 `os` 与
`userAgent` 双空的场景。

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

## 6. 指纹残缺守卫的复验脚本（修复后）

```bash
TK=$(cat /tmp/roxy-token.txt) DBU=<user> DBP=<pass> node scripts/verify-fix-guard.cjs         # 残缺指纹：预演 blocked + 执行不改库
TK=$(cat /tmp/roxy-token.txt) DBU=<user> DBP=<pass> node scripts/verify-fix-guard-400.cjs     # 残缺但可修：确认 400 命中的是守卫
TK=$(cat /tmp/roxy-token.txt) DBU=<user> DBP=<pass> node scripts/verify-fix-guard-regress.cjs # 回归：合法指纹不被误伤
```

> ⚠️ 这三个脚本会**临时改写环境 #3 / #4 的指纹**，跑完会自动复原。
> 脚本需 DB 账号具备 `SELECT/UPDATE profiles` 权限。

---

## 9. 启动耗时实测

```bash
pnpm build                                   # 打点代码在主进程产物里
node scripts/measure-startup.mjs --runs=5    # 5 次冷启动取中位数
```

输出各阶段耗时（相对进程启动，毫秒）：

| 阶段 | 含义 |
| -- | -- |
| `appReady` | Node / Electron 初始化完成 |
| `apiReady` | 本地 API 监听就绪 + MySQL 连接建立 |
| `windowCreate` | 主窗口创建 |
| `rendererLoaded` | 渲染层 HTML / JS 加载完毕 |
| `readyToShow` / `windowShown` | 窗口可显示 / 已显示 |
| `firstContent` | **首屏渲染出内容**（用户真正看到界面的时刻） |

本机实测（Electron 45.0.0 / Chromium 156.0.8078.48，5 次中位数）：
`appReady 339ms · apiReady 397ms · rendererLoaded 554ms · windowShown 742ms · firstContent 742ms`

> **必须多次取中位数**：单次启动受磁盘缓存、MySQL 连接抖动、杀软扫描影响极大，
> 拿单次数��当结论等于没测。脚本默认 5 次，同时给出最小 / 最大以暴露抖动幅度。
> 测量含 MySQL 连接时间，与生产同路径；换机器复测须在同条件下对比。

> 打点为条件启用：只有 `ROXY_MEASURE_STARTUP=1` 才记录，**默认零开销**。

## 10. 打包产物自检（chunk 循环 → 白屏）

```bash
pnpm build
node scripts/check-chunk-cycles.mjs    # 有静态跨块循环即失败退出
```

**为什么必须跑**：手动分块会绕过 Rollup 自动处理循环依赖的能力，跨块循环在 ESM 下
直接触发 TDZ（`Cannot access 'FastColor' before initialization`），表现为
**打包后主窗口白屏**——而 dev 模式（esbuild 预打包、每模块独立）**完全不暴露**，
只有 file:// 加载产物时才会中招。

> 2026-11-04 实测踩过：三处循环（vendor↔antd 经 fast-color、antd-icons↔antd、
> antd↔vendor 经 @rc-component/util 与 @ant-design/colors），修法见
> `electron.vite.config.ts` 的 `manualChunks` 注释。改分块策略后必须重跑此守卫。

## 11. 创建环境流程 UX 验证

```bash
pnpm build                                  # 脚本跑的是 out/ 产物
node scripts/verify-profile-form-ux.mjs    # 起应用 → 登录 → 操作 UI → 查库核对
```

前置：MySQL 已启动（默认 `127.0.0.1:3306` / `root` / `1234560`），默认账号 `admin` / `123456` 存在。

**验证什么**（7 项断言，退出码 0 = 全通过）：

| 编号 | 断言 | 意义 |
| -- | -- | -- |
| A1 | 新建态：基本信息低频项默认收起 | 备注 / 到期时间 / 扩展不该一上来就摊在用户面前 |
| A2 | 新建态：指纹细项默认全收起 | 创建的最短路径是「填名字 → 选预设 → 保存」 |
| B1 | 手动展开「基础设置」生效 | 折叠区本身能正常用（不是被锁死） |
| B2 | 重开抽屉后展开状态已重置 | 受控逻辑的核心价值：上次状态不能黏住 |
| C1 | 编辑态：指纹区默认展开「基础设置」 | 编辑时用户就是冲着改参数来的 |
| D1 | 收起状态下备注字段仍已挂载 | `forceRender` 生效的**直接证据** |
| D2 | 什么都没改的编辑后备注仍在 | **最关键的一条**：数据没被静默清空 |

**为什么 D2 不可省**：备注 / 到期时间 / 扩展被收进了默认收起的 Collapse 面板，
它们是 `Form.Item`——antd 的 Collapse 在首次展开前**不渲染**面板内容，
未挂载的 `Form.Item` 不会出现在 `onFinish` 的 `values` 里，而后端 `PUT /api/profiles/:id`
是**全量覆盖**。于是「点编辑 → 什么都不改 → 保存」会把这些字段悄悄提交成空，
**一次无操作的编辑就把用户填过的东西抹了**。

> 已用对照实验实测确认：把 `forceRender: true` 改成 `false` 后，
> 备注确实从 `remark="UX验证备注-..."` 变成 `remark=""`。

**两档验证的分工**：

| 档位 | 文件 | 覆盖时机 |
| -- | -- | -- |
| 源码级断言（9 项） | `tests/profileFormUx.test.cjs` | 进 `pnpm test`，CI 可跑，防"改代码时无声退化" |
| 行为级验证（7 项） | `scripts/verify-profile-form-ux.mjs` | 手动跑，防 antd 版本差异这类运行时问题 |

> 源码断言只能证明"写对了"，证明不了"跑起来对"——
> 例如 antd 6 的激活 pane 类名是 `.ant-tabs-content-active`（v5 是 `.ant-tabs-tabpane-active`），
> 两者不通用，这类差异只有真跑一遍才会暴露。

---

# 指纹基线与内核升级回归（Electron 45 / Chromium 156）

> 用途：**升级 Chromium 内核前后，用同一套探针逐项对比窗口内的实测值**，
> 把"我以为内核变化不影响我们"变成"有对照的实验"。
> 2026-10-19 那次升级（44.2.0 → 45.0.0，Chromium 152 → 156）就是靠它做的。

## 1. 为什么必须先建基线

指纹浏览器是**自研注入**：canvas 噪声、WebAudio 特征、WebGL 参数、UA-CH 全是我们在
preload 里改写的。Chromium 一旦升级，**内核自己的输出会变**——而我们的伪装是基于
"某个版本的 Chrome 长什么样"写死的。内核变了而伪装没跟上，不会报错、不会崩，
只会**悄悄变得不像那个版本**——这是最危险的一类问题。

所以顺序必须是：

```
1. 旧内核下采基线  →  2. 升内核  →  3. 新内核下再采一次  →  4. 逐项 diff
```

反过来（先升后比）就变成了"升完只看有没有崩"，而恰恰是**没崩的那些变化**最要命。

## 2. 采集基线

```bash
# 1) 起服务（受限环境需加两个开关，见下）
unset ELECTRON_RUN_AS_NODE
ROXY_DISABLE_SANDBOX=1 pnpm dev

# 2) 采一份快照（脚本会自己开环境窗口 → 跑体检 → 落盘 → 关窗）
TK=$(cat /tmp/roxy-token.txt) node scripts/capture-fingerprint-baseline.cjs baselines/<名称>.json
```

快照内容是体检报告的 **`key → actual` 全量映射**（不是白名单挑出来的字段——
体检项的 key 会随版本增删，用白名单一漏就静默丢失变化），
外加伪装度与一致性项的判定结果。

> 采集需要**环境窗口处于运行态**（脚本会自动开窗，9 秒后开始体检）。
> 若提示「窗口已在运行中」，说明上一次采集没关干净——脚本会自动复用该窗口。

## 3. 对比两份基线

```bash
node scripts/diff-fingerprint-baseline.cjs baselines/chromium152.json baselines/chromium156.json
```

输出分五段：**覆盖情况**、**真变化·行为字段**、**真变化·身份字段**、**覆盖补齐/丢失**、
**新增/消失项**与**一致性项变化**。

判读要点：

- **先看「行为字段变化」**——这是**唯一**能归因于内核的信号（canvas 噪声一致性 /
  音频编码支持 / EME 能力 / 自动化痕迹 / WebCrypto 算法可见性…）。非零即需排查：
  是「内核变了我们该跟上」还是「内核变了但这维度与版本无关」；
- **「身份字段变化」不算回归**——UA / 平台 / 语言 / 时区 / 屏幕 / CPU / 显卡 /
  音频档案等由指纹设定与环境种子派生，**换一套环境指纹就会全变**。
  脚本会先判定两份基线是否同一套环境指纹（`sameEnvironment`），不同则明确提示
  「不可归因于内核」——**内核回归必须对同一个环境（同一 profileId / 同一套指纹）
  前后各采一次**；
- **覆盖缺口不是「无变化」**——webgl / webgpu 若在两侧都不可用，会被单列到
  「覆盖缺口」并提示补采，不会混进「无变化」给人虚假安心（详见第 5 节）；
- **覆盖补齐 / 覆盖丢失**——补齐是覆盖范围扩大（不是回归）；丢失通常是采集机器
  变了（换了无 GPU 的机器），要先核对环境；
- **消失项**（A 有 B 无）→ 多半是体检项被改名或删除，不是内核行为变化，先查代码；
- **一致性项变化** → 比实测值变化更严重，说明环境的自洽性被内核影响了。

## 4. 现有的基线快照

| 文件 | 内核 | 采集于 | 伪装度 | 体检项数 | 已覆盖 |
| --- | --- | --- | --- | --- | --- |
| `baselines/chromium152.json` | Electron 44.2.0 / Chromium 152.0.7977.76 | 2026-10-22 | 100 | 27 | 24 |
| `baselines/chromium156.json` | Electron 45.0.0 / Chromium 156.0.8078.48 | 2026-10-22 | 100 | 28 | 25 |
| `baselines/chromium156-softwaregl.json` | Electron 45.0.0 / Chromium 156.0.8078.48 | 2026-11-04 | 100 | 28 | **26** |

**152 → 156 对比结论：27 个共有项实测值 0 变化，伪装度 100 → 100。**
唯一差异是 156 基线多一项 `webcryptoVersion`（值「均不可用」）——
该项是后来新增的体检项（见第 6 节），152 基线采集时尚不存在。

> 152 基线**无法**用当前代码重采（内核已升），故两份基线的体检项集合本就可能不完全一致。
> 对比时「新增/消失项」先看是不是体检项本身增删，再判断是否内核行为变化。

> **`chromium156-softwaregl.json` 是软件光栅化开启后的基线**：它与前两份**不是同一套
> 环境指纹**（quick-create 生成的随机指纹），因此**不能**用它来判断内核回归——
> 脚本会明确提示「不是同一套环境指纹」，行为字段变化为 0。它的价值是：
> **WebGL 已不再是覆盖缺口**（见第 5 节），26/28 项有效覆盖可作后续升级的参照。

## 5. ⚠️ 无 GPU 环境下的覆盖缺口（WebGL 已闭合，WebGPU 仍缺）

采集基线需要有显卡的机器。在**无 GPU**环境（如容器 / 远程桌面 / 虚拟机）里，
窗口内 `webgpu` 会报「不可用」——**这一项恰恰是内核变化最敏感的**
（Chrome 151 调整过 WebGL 输出规则、152 引入 WebGPU 子群控制）。

**WebGL 已通过软件光栅化闭合（2026-11-04）**：主进程此前用
`--disable-software-rasterizer` 把软件渲染也关掉了，导致 WebGL 上下文**根本创建不出来**
——所有环境窗口都没有 WebGL，而体检把该项权重置 0（不适用不计分），100 分曾把这个
缺口完全掩盖过去。现改为**只禁 GPU 进程（崩溃根除不动）、保留 ANGLE + D3D11 WARP
软件渲染**：

- 实测 WebGL 可用，`getParameter(37445/37446)` 与 `WEBGL_debug_renderer_info`
  两条路径都返回**预设显卡**（伪装照常生效），扩展集与真实 Chromium 一致；
- 体检 `webgl` 项恢复计分（权重 10），`webglOsMatch` 同步恢复判定；
- 代价：页面合成走软件，滚动 / 动画 / 视频变慢。
  逃生阀 `ROXY_DISABLE_SOFTWARE_GL=1` 可退回「完全无 WebGL」的旧行为。

**WebGPU 仍无法在无 GPU 机器上覆盖**：Chromium 的 WebGPU 依赖 GPU 服务进程，
`--disable-gpu` 下 `navigator.gpu` 根本不存在（连 `use-webgpu-adapter=swiftshader`
也无效）。**补测办法**（需换机器，不改代码）：

1. 换一台有独立显卡的机器（Windows / macOS 均可），按第 2 节采一份；
2. 与 `baselines/chromium156-softwaregl.json` 对比：
   ```bash
   node scripts/diff-fingerprint-baseline.cjs baselines/chromium156-softwaregl.json baselines/<有GPU机器>.json
   ```
3. 重点看 `webgpu` / `webgpuSubgroup` / `webgl` 三项是否**从「不可用」变成有值**
   （属「覆盖补齐」，不是回归）。

> 注意：无 GPU 环境下 `canvasNoise` / `audioProfile` 等项**是有效的**
> （Canvas 2D 与 WebAudio 走 CPU 软件渲染，不依赖 GPU），
> 所以本机基线对这两类仍然有参考价值，只是 WebGPU 两项缺失。

> **GPU 策略三档**（`src/main/index.ts`）：
> 默认 = 无 GPU 进程 + 软件光栅化（WebGL 可用）；
> `ROXY_ENABLE_GPU=1` = 放开硬件加速（有独显时性能最好，虚拟机上可能崩）；
> `ROXY_DISABLE_SOFTWARE_GL=1` = 完全无 WebGL（旧行为，仅极端场景）。

## 6. 升级内核时的额外检查项：WebCrypto 版本一致性

Chromium **154 起默认**在 WebCrypto 提供 ML-KEM-768/1024、ML-DSA-44/65/87、X-Wing、
ChaCha20-Poly1305（151–153 是原始试验期）。

内核升级后若环境伪装成 Chrome 151/152/153 却能用这些算法，就是**「特性超前」矛盾**——
平台一行 `crypto.subtle.generateKey` 即可识破（真实用户浏览器滞后很常见，
但特性超前不可能）。

本项目已做两道防线：

1. **preload 门控**：按伪装版本拦截 `crypto.subtle` 的算法入口，低于 154 的算法名
   按「不支持」抛 `DOMException NotSupportedError`；
2. **体检 `webcryptoVersion` 项**：如实采集窗口内实际可用的新算法并与伪装版本对账，
   **只判「超前」这一侧**（伪装新版却用不了不算破绽，真实用户也可能遇到功能被禁用）。

复验：

```bash
TK=$(cat /tmp/roxy-token.txt) node scripts/verify-webcrypto-gate.cjs
```

或在环境窗口的 DevTools 里直接试：

```js
try { crypto.subtle.generateKey({name:'ML-KEM-768'}, false, ['encapsulateKey','decapsulateKey']); console.log('矛盾：伪装低版本却能用') }
catch (e) { console.log('正常：已按版本隐藏 →', e.name) }
```

## 7. 受限环境下的两个启动开关

某些宿主环境（容器 / 嵌套沙箱 / CI）里，本项目会遇到两个问题：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 主进程崩在 `electron.ipcMain.on(...)` | 宿主设了 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成纯 Node | 启动前 `unset ELECTRON_RUN_AS_NODE` |
| 窗口标题正常但内容全白 | 渲染进程沙箱起不来（`render-process-gone` / `0x80000003`） | 启动时加 `ROXY_DISABLE_SANDBOX=1` |

两者都不涉及业务代码，只是宿主环境的限制。
