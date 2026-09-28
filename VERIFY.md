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

