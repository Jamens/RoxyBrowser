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

## 15. 设置页保存链路验证

```bash
node scripts/verify-settings-save-guard.mjs   # 起应用 → 操作真实 UI → 查服务端核对
```

前置：MySQL 已启动，默认账号 `admin` / `123456` 存在。
**脚本运行前会完整备份 `settings`，结束时无条件还原**（它要写数据库；上一版临时脚本没还原，
把占位符写进了用户的配置里，这次不允许再发生）。

> 脚本会优先连**正在运行的 dev server**（`ELECTRON_RENDERER_URL`）加载最新源码；
> 没有 dev server 时才用 `out/` 构建产物 —— 若产物是旧的，验的就不是最新代码了
> （踩过：早期版本没设这个变量，一度出现"修复没生效"的假象，断言全红而代码其实是对的）。

**验证什么**（15 项断言，退出码 0 = 全通过）：

| 编号 | 断言 | 意义 |
| -- | -- | -- |
| A1 | 保存请求确实发出（PUT /api/settings） | 校验没把整次保存拦掉 |
| A2 | 无校验错误阻断 | **根因项**：SMTP 未配置时不该有必填错误 |
| A3 | 有成功提示 | 成功必须可见 |
| A4 | 服务端：AI Agent 开关已落库 | 用户报障场景本身 |
| A5 | 服务端：视觉模型已落库 | 同上 |
| A6 | 服务端：SMTP 仍是未配置 | 没被偷偷写值 |
| B1 | 模型后端已切到云端（本地模型字段被卸载） | 构造条件渲染卸载的前提 |
| B2 | 本地视觉模型未被服务端默认值覆盖 | **同族问题**：卸载字段的值会被默认值补齐抹掉 |
| C1 | 校验失败有可见提示（toast） | 失败**绝不能**静默吞掉用户的改动 |
| C2 | 出错字段有红字提示 | 提示要落在出错的那一项上 |
| C3 | 校验失败时未发出 PUT | 不该提交半份配置 |
| D1 | 跳走再回来，视觉模型输入框仍是用户设的值 | 用户报障的原始观感 |
| D2 | 服务端仍是用户设的值 | — |
| D3 | AI Agent 页已识别为「已启用」 | 不再显示"未启用，请先到设置页开启" |

**为什么 A2 是根因项**：antd 的 `validateFields()` 校验**整张表**，任一字段不过整次保存就被拒
（连 `api.put` 都不发）。SMTP 的 host / user / pass 曾挂无条件 `required` 而默认值是空串 ——
于是「没配 SMTP」的用户**一个设置都存不进去**，改 AI Agent 开关与视觉模型同样丢，
重新进页面时 `load()` 拉回服务端旧值，观感就是「自己改的又被恢复了」。

**两档验证的分工**：

| 档位 | 文件 | 覆盖时机 |
| -- | -- | -- |
| 纯函数级（16 项） | `tests/settingsValidation.test.cjs` | 进 `pnpm test`，CI 可跑 |
| 源码级守卫（13 项） | `tests/settingsSaveGuard.test.cjs` | 进 `pnpm test`，防"改代码时无声退化" |
| 行为级（15 项） | `scripts/verify-settings-save-guard.mjs` | 手动跑，防 antd 版本差异这类运行时问题 |

> 源码级守卫里最值钱的一条是「**所有 `required` 字段的默认值都必须非空**」——
> 它防的是「以后又给某个默认空串的字段加 `required`，于是整个设置页再次锁死」。
> 合理例外（默认值空串、但只在用户主动进入某模式后才挂载的字段，如 `customProxyHost`）
> 需在测试里显式登记白名单并写明理由。


---

## 12. 本地 API 请求守卫验证

> 用途：确认本地 API 的**调用边界**符合预期——自家界面能用、第三方自动化脚本能用、
> 而网页侧与伪造 Host 的请求被服务端主动拒绝。

### 12.1 为什么需要单独验证

这层守卫的风险特征是「**改松了不会报错**」：没有异常、没有测试失败，
只是某天发现本地 API 被网页调走了。所以除了离线单测，还要对**真实运行的服务**
打真实请求——尤其是伪造 `Host` 头（DNS rebinding 的核心手法），
这一步**不能用 `fetch`**（undici 会拦掉手工设置的 `Host`），必须用裸 `http.request`。

### 12.2 两档验证

| 档位 | 文件 | 覆盖内容 |
| -- | -- | -- |
| 离线单测（36 项断言） | `tests/localRequestGuard.test.cjs` | 判定函数的纯逻辑：Host 解析 / Origin 白名单 / nonce 校验 / CORS 头内容。已进 `pnpm test` |
| 行为级验证（13 项断言） | `scripts/verify-local-api-guard.mjs` | 起真实应用 + 裸 HTTP 请求打真实端口：拒绝状态码、拒绝响应里有没有 CORS 头、预检是否被正确响应 |

### 12.3 运行方式

```bash
pnpm build                                  # 脚本跑的是 out/ 产物
node scripts/verify-local-api-guard.mjs     # 前置：MySQL 已启动
```

### 12.4 断言清单与判读

| 编号 | 场景 | 期望 | 说明 |
| -- | -- | -- | -- |
| G1 | 无 Origin（curl / 第三方脚本） | 200 | **自动化 API 不能被堵死**——这是功能边界，不是漏洞 |
| G2 | `Origin: https://evil.com` | 403 **且响应无任何 CORS 允许头** | 回了头等于放行，浏览器会把响应交给恶意脚本 |
| G3 | `Host: evil.com` | 403 | DNS rebinding |
| G4 | `Origin: null` 无 nonce | 403 | 沙箱 iframe 拿不到 nonce |
| G5 | `Origin: null` + 正确 nonce | 200，回显 `Access-Control-Allow-Origin: null` | 自家 `file://` 界面走这条 |
| G6 | `Origin: null` + 错误 nonce | 403 | |
| G7 | 伪造 Host + 合法 Origin + 正确 nonce | 403 | Host 判定优先 |
| G8 | `Origin: http://127.0.0.1:<port>` | 200 | 本机来源（dev server / 接受邀请页） |
| G9 | 预检 OPTIONS + 合法 Origin | 204，`Allow-Headers` 含 `X-Roxy-Nonce` | 渲染层每个请求都会预检 |
| G10 | 预检 OPTIONS + 恶意 Origin | 403 | |

### 12.5 顺带要跑的回归

守卫改的是**所有本地 API 请求的入口**，改坏了不会立刻暴露为报错，
而是表现为「应用打开就是白屏 / 某个页面的接口莫名全挂」。所以每次改完必须跑：

```bash
pnpm test                                   # 含 localRequestGuard（36 项断言）
node scripts/verify-profile-form-ux.mjs     # 真实 UI 全流程（登录→建环境→编辑保存→查库）
node scripts/verify-local-api-guard.mjs     # 攻击面断言
```

> `verify-profile-form-ux.mjs` 是关键的一道：它证明守卫**没有把应用自己挡在门外**
> （渲染层的请求带 `Origin: null` + nonce，能走通就说明放行链路是通的）。

---

## 13. 出口 IP → 语言 / 时区填充验证

> 用途：确认「按代理出口把时区与浏览器语言对齐」这条链路真的通了——
> 推导对、**填前预演**、填后落库，三段都要对。

### 13.1 为什么需要单独验证

这个功能有三个**都不会让 typecheck / build 失败**的失败点：

1. **推导口径与体检口径不同源** → 填完体检反而报「时区与代理国家不一致」，
   用户只会认为工具坏了。
2. **按钮不可用** → 「绑定代理 IP」那个 Select 没有 `name`，不被 Form.Item 订阅，
   `form.setFieldValue` 改了 store 却不触发重渲染，
   于是 `disabled={!form.getFieldValue('proxyId')}` 永远按旧值算，
   表现为「选完代理按钮还是灰的，点不动」。
3. **静默覆盖用户手调过的值** → 填前不预演就是吞掉手工调整且用户无从察觉。

### 13.2 两档验证

| 档位 | 文件 | 覆盖内容 |
| -- | -- | -- |
| 离线单测（30 项断言） | `tests/ipLocaleSuggest.test.cjs` | 推导纯逻辑 + 国家表不变式 + **「填完体检不报红」的端到端断言**。已进 `pnpm test` |
| 行为级验证（19 项断言） | `scripts/verify-ip-locale-fill.mjs` | 起真实应用 + 真实 HTTP 端口 + CDP 驱动真实 UI：端点各分支、预演弹窗内容、确认后落库核对 |

### 13.3 运行方式

```bash
pnpm build                                  # 脚本跑的是 out/ 产物
node scripts/verify-ip-locale-fill.mjs     # 前置：MySQL 已启动
```

### 13.4 断言清单与判读

| 编号 | 场景 | 期望 | 说明 |
| -- | -- | -- | -- |
| E1 | 显式国家 + 地区 | 精确到州时区（美国 + California → `America/Los_Angeles`） | 一国多时区必须按地区细分 |
| E2 | 推导出的语言 | 地区码 == 国码（`en-US` / 美国） | 体检判定的依据 |
| E3 | 多时区国家且无地区 | `ambiguous=true` + 候选列表 | 认不出就必须让用户确认 |
| E4 | 出口国家不在内置表 | 400 且**响应里没有任何时区字段** | 绝不猜 |
| E5 | 既无代理也无国家 | 400 | 没有出口信息就拒绝推导 |
| E6 | 英国 | `Europe/London` + `en-GB` | 不是 `en-US` |
| E7 | 按 `proxyId` | 走真实数据库分支，返回该代理的出口国推导结果 | |
| E8 | 响应回显 | 带 `exitIp` | 界面要显示出口 IP |
| E9 | 多时区国家按 `proxyId` | 具体州时区 | |
| E10 | 代理未检测且检测失败 | 400 且无兜底时区 | **绝不拿宿主 IP 兜底** |
| E11 | 不存在的 `proxyId` | 404 | |
| U1 | 未选代理 | 按钮禁用 | |
| U2 | 点按钮 | 预演弹窗列出「当前值 → 新值」 | 时区 `Asia/Tokyo → Europe/London` |
| U3 | 预演内容 | 同时给出新语言 `en-GB` | |
| U4 | 确认后 | 弹窗关闭 | |
| U5 | 指纹页签 | 已显示新时区与新语言 | |
| W1–W3 | 落库核对 | `timezone=Europe/London`、`languages[0]=en-GB`、坐标随新时区同步到伦敦 | |

### 13.5 脚本里为什么直连数据库

端点读的是代理的 `country` / `region` / `exitIp`（代理检测时回写）。
真实检测要能连通 ip-api 且代理本身可用——那是外部依赖，脚本不能假设。
故用 mysql2 直接把两个**测试用代理**的出口信息写成已知值，
让端点走「代理已检测」这条真实分支。**生产代码路径完全没被绕过**：
读的就是同一张表、同一批字段。

> 列名是 typeorm 的默认驼峰（`exitIp`），不是 `exit_ip`——
> 写错会静默更新 0 行，表现为「端点说代理没检测过」这种看不懂的失败。脚本对此有断言。

### 13.6 顺带要跑的回归

```bash
pnpm test                                   # 含 ipLocaleSuggest（30 项）+ profileFormUx（11 项）
node scripts/verify-profile-form-ux.mjs     # 真实 UI 全流程（登录→建环境→编辑保存→查库）
node scripts/verify-ip-locale-fill.mjs      # 出口填充的行为级断言
```

---

## 14. 反检测审计验证

> 用途：回答「**这套伪装能不能瞒过浏览器**」——
> 不是「注入生效了吗」，而是「**外部检测站会怎么看**」。

### 14.1 为什么需要单独验证

环境体检是「自己出题自己判卷」：拿设定指纹对撞窗口内的回读值。
它能证明注入生效，**证明不了外部检测站看不出来**。这两件事不是一回事——
体检全绿的环境，完全可能在检测站上原形毕露。

而这类失效是**静默**的：typecheck 通过、build 通过、体检满分，
环境照样带着致命破绽流出去。所以必须有一条**独立于体检**的验证链路。

### 14.2 两档验证

| 档位 | 文件 | 覆盖内容 |
| -- | -- | -- |
| 离线单测（67 项断言） | `tests/stealthAudit.test.cjs` | 判定规则集。构造「两处互相矛盾」的探针值 → 断言能抓到；构造「两处自洽」→ 断言不误报。已进 `pnpm test` |
| 行为级验证（24 项断言） | `scripts/verify-stealth-audit.mjs` | 起真实 Electron + 真实环境窗口 + 真实端口 + 真实 preload，采到实测值后再判定 |
| 伪装形态守卫（17 项断言） | `tests/preloadPatchNative.test.cjs` | 源码级 + 行为级双闸门：禁止实例级 navigator/screen 伪装、禁止往 `Window.prototype` 上加属性、要求补丁函数走 `patchNative` |

> 离线单测的手法和体检测试相反但目的一致：**矛盾必须同时看到两处才能判出来**，
> 单看一处永远测不出来。故每条用例都只改基线里的一项。

### 14.3 运行方式

```bash
pnpm build                                   # 脚本跑的是 out/ 产物
node scripts/verify-stealth-audit.mjs        # 行为级：真实窗口实测 + 审计
node tests/stealthAudit.test.cjs            # 离线单测（需先 tsc 编出 .tmp_sa，见 pnpm test）
```

### 14.4 脚本刻意制造矛盾

脚本创建的环境**故意伪装成 macOS**（宿主是 Windows）——
矛盾会立刻显现，任何漏网的伪装都在第一次运行时就暴露，而不是等到用户上线。

### 14.5 断言清单与判读

| 编号 | 场景 | 期望 | 说明 |
| -- | -- | -- | -- |
| P1 | 探针采到 UA | 非空 | |
| P2 | 探针采到 appVersion | 非空 | 用于与 UA 交叉验证 |
| P3 | 探针采到 iframe UA | 非空 | 跨 frame 一致性 |
| P4 | 探针采到 canvas 双读 | 两个哈希 | 熵稳定性 |
| P5 | 探针采到被改函数的 toString | ≥ 10 个取样 | 原生性测谎的输入 |
| P6 | iframe UA 与主 frame 一致 | 完全相同 | iframe 读到真身 = 一眼穿帮 |
| P7 | 被改写的函数通过原生性测谎 | 全部含 `[native code]` | 漏掉一个 `patchNative` 就红 |
| P8 | **穷尽原生性扫描无露馅** | 扫描 > 0 且露馅 0 | 遍历全部关键原型的所有函数 |
| P9 | canvas 两次读一致 | 相同 | 实时改写指纹会被判死 |
| P10 | appVersion 与 UA 自洽 | 系统段一致 | |
| P11 | 无自动化痕迹 | `webdriver=false` 且无特征全局变量 | |
| P12 | **原型绕过后 platform 仍是伪装值** | 绕过后 == 实例值 | 绕过后读到宿主真身 = 本项目最大的漏洞 |
| P13 | 原型绕过后 languages 仍是伪装值 | 同上 | |
| P14 | 原型绕过后 hardwareConcurrency 仍是伪装值 | 同上 | |
| P15 | 原型绕过后 deviceMemory 仍是伪装值 | 同上 | |
| P16 | navigator 自有键为空 | 空数组 | 真实 Chrome 恒为空 |
| P17 | screen 自有键为空 | 空数组 | 同上 |
| P18 | UA 与 UA-CH 自洽 | 无 `uach:` 类结论 | |
| P19 | 时区三件套自洽 | 无 `timezone:offsetMismatch` / `notInjected` | 偏移 / Intl / `Date.toString` |
| P20 | Intl 构造器行为与原生一致 | 静态方法在 + new 约束在 | 包装器丢了 `supportedLocalesOf` → 页面直接坏掉 |
| P21 | window 自有键基线已采集 | 基线键数 > 0 | 基线没采到 → 那条规则等于没武装 |
| P22 | API 存在性已采集 | 用 `in` 判定采集到 > 0 个 | 存在 ≠ 读出 undefined |
| P23 | devicePixelRatio 被真正改成设定值 | 实测 == 设定（测试刻意取 3，宿主真实值 2） | 证明伪装生效，而非碰巧本来就对 |
| P24 | 无致命破绽 | `summary.passed === true` | 收口断言 |

### 14.6 判读要点

- **「扫描 0 个函数」不等于通过**——那说明扫描环节本身没跑起来。
  判定侧有对应的 `nativeLie:scanNotRun`（警告）专门区分这两种情况。
- **`nativeLie:exhaustive` 是致命**。它意味着有函数在检测站遍历原型时能看见补丁源码，
  修复方式只有一条：所有补丁函数必须走 `patchNative` 登记。
- **原型绕过类结论（`bypass:*`）优先级最高**。实例读值对、原型绕过后不对，
  意味着页面直接读没问题、检测站一 call 就露馅——这类问题**只有外部视角能发现**。
- **「提示」不是问题**。报告里只有提示时会直接给肯定结论——
  把提示说成「发现 N 处问题」会让人养成忽略结论的习惯，那比多报一条更糟。

### 14.7 踩过的一个坑：基于错误前提的规则

写「window 的可枚举自有键必须为空」这条规则时，我以为真实 Chrome 的 `Object.keys(window)`
是空的。**实测不是**——是一份约 50 项的清单（`window` / `self` / `document` / `location` /
`screen` / `innerWidth` / `devicePixelRatio` / `styleMedia` / `onpagereveal` …），
因为 Window 接口上 `[LegacyUnforgeable]` 的属性按 WebIDL 就是全局对象**自己的可枚举属性**。

这条规则一上线就误报。**基于错误前提的规则比没有规则更糟**：它会一直报警，
直到被人习惯性忽略。

改法不是「放宽阈值」，而是**换判据**：

1. preload 在**注入任何伪装之前**把 window 的可枚举自有键拍一张基线；
2. 审计时拿「当前键集合」与基线相减——多出来的才是后来添的；
3. 基线来自同一个浏览器自己，故与 Chromium 版本无关，也不会误报。

同理，**伪装该落在实例还是原型，不能靠推理**——必须实测。本轮实测结论：

| 属性 | 真实形态 | 正确落点 |
| -- | -- | -- |
| `navigator.platform` / `languages` / `hardwareConcurrency` / `deviceMemory` | `Navigator.prototype` 上的**访问器** | 原型 |
| `navigator.getBattery` / `requestMediaKeySystemAccess` | `Navigator.prototype` 上的**方法**（数据属性） | 原型上覆写**函数值**（不是改成 getter） |
| `navigator.userAgentData` / `gpu` / `webdriver`（iOS 下） | `Navigator.prototype` 上的访问器 | 原型；「该平台没有」时**从原型删掉** |
| `screen.width` / `height` / `availWidth` / `availHeight` | `Screen.prototype` 上的访问器 | 原型 |
| `window.devicePixelRatio` / `matchMedia` / `fetch` | **window 自己的**属性（window 有 237 个自有可枚举键，`Window.prototype` 上一个都没有） | **实例**（挪到原型上会被自有属性遮蔽而失效） |

> 落错位置有两种失败模式，**都很难察觉**：
> ① 挪到原型上 → 多出一个真实 Chrome 没有的属性（结构破绽），且被实例自有属性遮蔽 → **伪装直接失效**；
> ② 留在实例上 → 留下自有键，且原型上的原生 getter 一 call 就穿帮。
>
> 判据是「**这个属性在真实浏览器里本来就在哪**」，所以只能实测，不能推理。

### 14.8 「该不存在的 API」要判**存在性**，不是读值

真实 iOS Safari 里**根本没有** `navigator.userAgentData`。检测站查的不只是
「读出来是不是 undefined」，还有 **`'userAgentData' in navigator` 是不是 false**。

只把原型上的 getter 改成返回 undefined，**`in` 判定仍然是 true**——一样露馅。
故改为**从原型上真正删掉**（WebIDL 属性实测 `configurable: true`，`delete` 生效；
注意 `delete navigator.xxx` 删的是实例自有属性，对原型无效——项目此前踩过这个坑）。

审计侧对应规则 `platform:apiShouldBeAbsent`（致命），探针侧用 `key in navigator` 采集。

### 14.9 顺带要跑的回归

```bash
pnpm test                                    # 45 项，含 stealthAudit（67 项断言）+ preloadPatchNative（17 项）
node scripts/verify-stealth-audit.mjs        # 反检测审计的行为级断言
node scripts/verify-profile-form-ux.mjs      # 真实 UI 全流程
```

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
