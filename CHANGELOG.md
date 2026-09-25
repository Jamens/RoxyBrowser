# 更新日志

按日期记录项目的**功能新增**与**问题修复**，最新在最上。

- 技术架构、目录结构（文件作用）、运行与打包命令 → [README.md](./README.md)
- 各模块功能详细说明与自动化 API 示例 → [FEATURES.md](./FEATURES.md)

条目格式为「说明（commit）」，可按 commit 哈希在 git 历史中查看完整改动。

---

## 2026-09-26 · 平台 API 一致性（Tier 2 #4）

### 新增

- **平台 API 一致性（Bluetooth/USB/Serial/HID/NFC 按 OS 暴露）**（`src/main/browser-preload.ts`）：按真实支持矩阵，把「该 OS 不该有、但宿主原生却暴露」的平台能力 API 用 `hide` 遮蔽（iOS 移除全部；Android 移除 serial/hid；桌面移除 nfc）；不凭空制造 own `undefined` 属性，否则 `'key' in navigator` 会误报存在。
- **环境体检新增 platformApis 项**（权重 4）：只判「不该有却出现」的矛盾信号（如 iOS 暴露 bluetooth/usb/serial/hid/nfc），「该有却因宿主未暴露而缺失」不计入，贯彻「不伪造」原则（`src/shared/healthcheck.ts` + `src/main/healthProbe.ts` + `src/renderer/src/pages/Environments.tsx` 标签）。
- 离线单测：10 条 healthcheck platformApis 逻辑用例全部通过（ios 全暴露 / windows 有 nfc / android 有 serial·hid / 各 OS 该有的组合 / 全 false 不判红 / actual 文案 / weight=4）。

### 设计要点

- 仅当宿主原生就有该 API 时才隐藏（不凭空新增），与「不伪造」同源；宿主未暴露时如实留空，避免高成本伪造 Web Bluetooth 等实现反而穿帮。
- 不新增数据库列与表单字段（与 WebGPU / Audio / EME / 反自动化同源，符合规则 #24）。
- 提交：`56f8807`（feat）。

---

## 2026-09-26 · 反自动化痕迹清除（Tier 1 #1）

### 新增

- **反自动化痕迹清除**（`src/main/browser-preload.ts`）：强制 `navigator.webdriver = false`（iOS 伪装整体隐藏该属性，与 EME / `userAgentData` 同源手法）；清除 CDP / ChromeDriver 注入的特征全局变量（`cdc_` / `$cdc_` / `__nightmare` / `callPhantom` / `_phantom` / `selenium` 等）——仅在 `window` / `document` 上**存在即删除**（own property，不动原型），属防御性清除，避免任何 CDP 连接意外注入后暴露。
- **环境体检新增 automation 项**（权重 5）：校验 `webdriver=false 且无自动化痕迹`，actual 文案带出 `webdriver` / `automationTraces` 两项状态（`src/shared/healthcheck.ts` + `src/main/healthProbe.ts` + `src/renderer/src/pages/Environments.tsx` 标签）。
- 离线单测：6 条 healthcheck automation 逻辑用例全部通过（webdriver=false&无痕迹 / webdriver=true / 有自动化痕迹 / 两者都命中 / actual 文案 / weight=5）。

### 设计要点

- `webdriver=false` 与真实非自动化浏览器一致，属「还原真实」而非「伪造」；不存在的自动化变量一律不主动定义，避免反倒制造 `hasOwnProperty` 类破绽。
- 不新增数据库列与表单字段（与 WebGPU / Audio / EME 同源，符合规则 #24）。
- 提交：`3c4ad83`（feat）。

---

## 2026-09-25 · EME 能力检测补全（CENC/CBCS，P3）

### 新增

- **EME 能力检测（对标 RoxyChrome 152「加密媒体能力检测」）**（`src/main/browser-preload.ts`）：Widevine / ClearKey 的 `requestMediaKeySystemAccess` 外壳不再只回最小配置，`getConfiguration()` 现返回与真实 Chrome + Widevine 一致的能力集——`initDataTypes` 含 `cenc` 与 `cbcs`，`videoCapabilities` 覆盖 avc/hevc/vp9/av1（含多档 `robustness`），`audioCapabilities` 覆盖 aac/opus/flac；并实现「协商」语义（检测站传入候选配置时按 Widevine 已知支持集筛选后回显），避免「只能 resolve 却拿不到真实能力列表」的破绽。
- **环境体检 eme 项增强**（`src/shared/healthcheck.ts` + `src/main/healthProbe.ts`）：非 iOS 不仅校验 Widevine + ClearKey 存在，还要求 `getConfiguration()` 真能报出 CENC 能力（initDataTypes 含 `cenc`）；探针额外采集 `emeInitDataTypes` / `emeVideoCaps` / `emeAudioCaps`，actual 文案带出能力详情便于排查。iOS 仍期望无 EME。
- 离线单测：10 条 healthcheck EME 能力逻辑用例全部通过（cenc+cbcs / cenc-only / 无 initDataTypes / 缺 widevine / 缺 clearkey / 有 playready / iOS 无 EME / iOS 有 EME / actual 文案）。

### 设计要点

- 复用既有 `def` 注入手法；不新增数据库列与表单字段，Widevine 能力集为静态真实配置（与 WebGPU / Audio 同源，符合规则 #24）。
- 提交：`f28d7e6`（feat）。

---

## 2026-09-25 · 内核版本同步到 154 + HTTP 安全警告（P2）

### 新增

- **内核版本切换范围升级 127–132 → 150–154**（`src/shared/fingerprint.ts`）：`CHROME_VERSIONS` 改为 150/151/152/153/154，并把内置 9 套 Chrome 系预设的 UA（`Chrome/xxx`、`uaFullVersion`）与 6 套预设名（如 `Windows 11 · Chrome 154 · 德国`）批量同步到 `154.0.7521.60`，对标竞品 RoxyChrome 154 内核。预设其余字段（平台 / GPU / 屏幕 / 时区语言）保持自洽不变。
- **HTTP 安全警告伪装**（`src/main/browser-preload.ts` + `src/shared/types.ts` + `src/renderer/src/components/ProfileForm.tsx`）：新增 `httpWarning` 字段（默认开启），环境窗口导航到明文 `http://` 站点时在页面顶部注入固定红色警告条，提示连接未加密、存在被窃听 / 篡改风险；`localhost` / `127.0.0.1` / `[::1]` 与 `file://` 不触发；监听 `DOMContentLoaded` / `popstate` / `hashchange` / `click` 重新评估当前 URL。表单「追踪器屏蔽」下方新增「HTTP 安全警告」开关。
- `httpWarning` 贯穿 `Fingerprint` 类型与全部 builder funnel（`randomFingerprint` 三分支、`presetFingerprint`、`normalizeFingerprint`、`deriveJitteredFingerprint`），legacy 老指纹无该字段时兜底为 `true`。

### 设计要点

- HTTP 警告复用既有「preload 注入」手法，仅在宿主原生有 `document` 时才注入，且严格排除本地回环与应用自身页面，避免干扰调试与控制台。
- 提交：`7bba1d1`（feat）。

---

## 2026-09-25 · EME / Widevine 伪装（P1 #5）

### 新增

- **EME / Widevine 伪装**（`src/main/browser-preload.ts`）：覆写 `navigator.requestMediaKeySystemAccess`，非 iOS 伪装报出 `com.widevine.alpha` 与 `org.w3.clearkey`，PlayReady / FairPlay 走原生自然 reject；iOS 伪装整体隐藏该 API（Safari 无 EME）。仅在宿主原生有该 API 时才覆写。
- **环境体检新增 eme 项**（权重 4）：非 iOS 期望「Widevine + ClearKey 可用」、iOS 期望「无 EME」，与 WebGPU 同理做一致性校验（`src/main/healthProbe.ts` + `src/shared/healthcheck.ts` + `src/renderer/src/pages/Environments.tsx` 标签）。
- 离线单测：5 条 healthcheck EME 逻辑用例（windows 生效 / ios 隐藏 / ios 漏隐藏判红 / windows 漏注入判红）全部通过。

### 设计要点

- 复用既有 `def` / `hide` 注入手法；不新增数据库列与表单字段，Widevine 可用性由 `fp.os` 派生（与 WebGPU / Audio 同源）。
- 提交：`59b2d59`（feat）。

---

## 2026-09-25 · 指纹深度补齐 2.0（Battery / plugins·mimeTypes / SpeechSynthesis / WebRTC 代理模式）

### 新增

- **Battery API 伪装**（`src/main/browser-preload.ts`）：`navigator.getBattery()` 返回按环境种子派生的稳定且自洽的电池状态（未满则充电中、chargingTime 为正；满电则不充电、dischargingTime=Infinity）。仅在宿主原生就有该 API 时才覆写——若宿主已移除则绝不凭空新增，避免制造非默认信号。
- **navigator.plugins / mimeTypes 伪装**：按真实 Chrome 默认形态补一套最小但结构正确的 `Plugin` / `PluginArray` / `MimeType` / `MimeTypeArray`（含 Chrome PDF Plugin + application/pdf），并设置对应原型，使 `instanceof` / `toString` 与真实 Chrome 一致，消除「plugins 为空」这一明显自动化信号。
- **SpeechSynthesis 语音列表对齐**：`getVoices()` 仅保留与 `fp.languages` 匹配的语音，避免宿主机已安装语言泄漏、与声明语言自相矛盾。
- **WebRTC 代理模式**（`WebRTCMode` 新增 `'proxy'`）：保留 WebRTC 功能（通话 / 数据通道），但强制 `iceCandidatePolicy='public'`，丢弃本地私有 IP 的 host 候选，只保留经环境代理出去的 srflx/relay 候选——外部看到的是代理公网 IP 而非宿主机局域网 IP，与代理身份自洽。`disable` / `real` 行为不变。
- **类型与前端**：`src/shared/types.ts` 的 `WebRTCMode` 联合类型增加 `'proxy'`；`ProfileForm.tsx` WebRTC 下拉新增「代理模式（隐藏本地 IP）」选项。

### 设计要点

- 四个维度全部复用既有 `def` / `setPrototypeOf` 注入手法，并包在 `try/catch` 内——单个维度失败不影响其余注入，也不会让页面崩溃。
- 严格遵循「只在宿主原生就有该 API 时才覆写」原则（呼应指纹不伪造约定）：Battery / SpeechSynthesis 都先判存在再改，不凭空新增非默认信号。
- 提交：`05643bd`（feat）。

---

## 2026-09-24 · 邮箱邀请成员（SMTP 发信 + 令牌邀请流 + 接受页）

### 新增

- **邮箱邀请成员**：管理员在「团队空间」用邮箱邀请成员，系统生成一次性令牌、入库并发送邀请邮件；收件人点击邮件链接进入接受页，设置账号后加入团队。完整闭环：邀请 → 发信 → 接受 → 入队（`ad93a5d`）。
- **零依赖 SMTP 发信器**（`src/main/smtp.ts`）：不引入 `nodemailer`，直接用 Node 内置 `net` / `tls` 手搓 SMTP 会话，支持 465 隐式 TLS 与 587 STARTTLS 两种接入，以及 `AUTH LOGIN` / `AUTH PLAIN`。已用本地假 SMTP 服务器做离线集成测试（PLAIN / LOGIN / 空配置拒绝），覆盖握手、认证、MAIL/RCPT/DATA 与点 Stuffing。
- **邀请实体** `TeamInviteEntity`（`team_invites` 表）：`teamId / inviterId / email / role / token(唯一) / expiresAt / usedAt`，令牌 7 天过期、用一次即失效（`usedAt` 标记）。
- **接受页**（`src/main/acceptInvitePage.ts` + `GET /accept-invite`）：Express 直接返回自包含 HTML，无需渲染进程参与；页面 `fetch` 同域接口完成校验与注册，跨机器只需把邀请链接的 host 换成邀请方可达地址。
- **后端接口**（`src/main/server.ts`）：
  - `POST /api/team/invites`（管理员）：解析多邮箱、生成令牌、入库、逐个发信，返回成功 / 失败清单。
  - `GET /api/team/invites`（管理员）：列出待接受邀请（未用且未过期）。
  - `DELETE /api/team/invites/:id`（管理员）：撤销未使用的邀请。
  - `POST /api/team/invites/test`（管理员）：向测试邮箱发一封测试信，支持用表单里未保存的配置覆盖。
  - `GET /api/team/invites/accept/info`（公开）：凭令牌返回团队名 / 角色（供接受页展示）。
  - `POST /api/team/invites/accept`（公开）：凭令牌创建 / 加入账号并标记已用，单独写审计日志。
- **前端**：
  - `Team.tsx`：邀请弹窗新增「邮箱邀请」模式（多邮箱 + 角色），页内展示待接受邀请列表与撤销。
  - `Settings.tsx`：新增「邮件 SMTP」配置段（服务器 / 端口 / 隐式 TLS / 账号 / 密码 / 发件人 / 证书校验 + 发送测试），四语 i18n 新增 20 个 key。
- 提交：`ad93a5d`（feat + 文档）。

### 修复 / 设计要点

- **令牌不泄露**：邀请列表接口只回显 `email / role / expiresAt`，不含令牌原文（避免管理员代接受）。
- **SMTP 密码明文存储告警**：密码随 `app_settings` JSON 入库，设置页已明确提示「仅用于受信任内网 / 自有邮件服务」。

---

## 2026-09-24 · 范围边界决策：不做 Firefox / Gecko 内核（候选 ⑥）

### 结论

竞品差距分析的候选功能里，⑥「Firefox 内核」**明确不做**。这不是排期问题，而是架构层面的范围边界，已写入 [FEATURES.md](./FEATURES.md) 的「明确范围边界」一节。

### 依据

- **引擎不可替换**：Electron 只内嵌 Chromium，无「Firefox-in-Electron」；引入 Gecko 等于另起一个项目，而非给本克隆加一个内核选项。
- **指纹注入机制完全不同**：本克隆依赖 Electron `session` + `--roxy-fp` 注入 preload + `session.webRequest` 拦截；Firefox 需走 `prefs.js` 逐项改写，且 `navigator.userAgentData` / WebGPU / `GPUAdapterInfo` / AudioContext 原型等注入点在 Gecko 上不存在或形态不同，`shared/fingerprint.ts` 与 `browser-preload.ts` / `browserManager.ts` 需近乎重写。
- **代理 / 扩展 / 网络拦截全换栈**：Chromium 的 `session.setProxy` + MV3 扩展与 Firefox 的 `prefs.js` + WebExtensions 不互通。
- **ROI 极低**：目标场景（跨境电商 / 社媒多账号）以 Chromium 系检测对抗为主，并行维护一套 Gecko 伪装工作量接近重写，仅多覆盖极少数必须用 Firefox UA 的平台。

> 强需求下的务实替代：保持 Chromium 主引擎，仅在 UA / 平台字段「声明」为 Firefox 形态（伪装成 Firefox 的 Chromium），而非真正切换内核——代价是底层信号仍暴露 Chromium，仅作权宜。

---

## 2026-09-24 · 智能助手 Planner 进阶（多步编排 + 技能库 + 防时间冻结）

### 新增

- **多步编排（forEach fan-out）**：动作可挂 `forEach: { fromQuery, map }`，表示「对第 N 条查询的每一行，用行字段填进参数展开成一组动作」；「查出 N 个快到期代理 → 逐个删除」这类依赖前一步结果的流程不再需要模型枚举 ID（本地小模型枚举极易出错），由后端 `expandActions`（`src/shared/assistantPlan.ts`，纯函数、可单测）确定性展开。
  - `forEach` 引用的查询**为空 / 越界**时天然产出 **0 条动作**——避免拿空参数去执行 `deleteProxy` 这类危险动作（单元测试覆盖）。
- **技能库（保存 / 复用计划模板）**：对话里「保存为技能」把本次 LLM 产出的结构化计划存进 `assistant_skills` 表（`AssistantSkillEntity`），之后在技能面板一键运行 / 删除；运行时不调 LLM，直接复用模板重跑 `executePlan`。
  - `executePlan` 是 LLM 路径与技能重跑路径的**唯一执行出口**，因此白名单 / 隔离 / 危险分级三道闸在重跑时**全部重新生效**，技能无法绕过校验。
  - 接口：`GET /api/assistant/skills`、`POST /api/assistant/skills`、`DELETE /api/assistant/skills/:id`、`POST /api/assistant/skills/:id/run`（复用 `runSkillPlan`）。
- **相对时间标记（防技能时间冻结）**：模板里写死绝对日期（如 `expiresAt < "2026-09-30"`）会在重跑时失效；改用 `@rel:now±N[d|h|m]`（或 `{"__rel":"now+7d"}`）后，查询时才解析成相对当前时间的偏移日期，「7 天内到期」类技能永远跟着现在走。系统提示词已指导模型对相对时间一律用此标记；`resolveRelTime`（`src/shared/assistantPlan.ts`）在查询执行时解析，离线单测覆盖字符串 / 对象 / 数组 / 越界 / 透传。
- 前端：`AssistantChat.tsx` 增加「执行全部」按钮（危险动作仍逐条强确认 + 审计）、技能库面板（运行 / 删除）、保存技能弹窗；四语 i18n 新增 13 个 key。
- 提交：`aaffb22`（feat + 文档）。

### 修复

- **forEach 索引错位**：`executePlan` 原用 `push` 压缩查询结果数组，而 `forEach.fromQuery` 引用的是 `plan.queries` 的原始下标——一旦某条前置查询被禁查 / 跳过，后续 forEach 就指向错误的查询，甚至 `undefined` → **静默产出 0 条动作**。现改为用与 `plan.queries` 等长的数组承载结果（跳过位留 `null`），`expandActions` 对空位天然返回 0 条，一行改动消除错位。
- **角色判定用过期 JWT 值**：三处 Planner 上下文原直接用 `req.role`（JWT 角色在「调整成员角色」后会过期），现已统一改为 `await freshRole(req)`（读数据库实时角色），与项目既有约定一致，保证权限调整即时生效。
- **技能重跑漏掉敏感拦截 / 隔离标记**：`runSkillPlan` 现会重新校验 `intent === 'blocked'`（模板若被标记敏感，重跑同样拒绝）并把 `sensitiveBlocked` 透传回前端；与 `planAssistant` 行为对齐。
- **前端两处静默失败**：技能列表加载失败现在弹错误提示（不再是空列表静默）；保存技能时「名称为空」由 `okButtonProps.disabled` 兜底，避免点确定后弹窗静默关闭。

---

## 2026-09-24 · 在线检测站实战验证（外部视角指纹体检）

### 新增

- **在线检测（外部视角）**：环境体检是「自己出题自己判卷」，只能证明注入生效；本功能让环境窗口真正导航到第三方检测站（PixelScan / BrowserLeaks / CreepJS / AmIUnique）跑一遍，抓回页面文本 + 截图回写成报告，由外部站点从真实人群分布角度评判，能发现「设定值互相矛盾」或「某项落在人群分布之外」这类体检抓不到的问题（`26e5bfa`）。
  - **证据优先、判定从简**：检测站 DOM 常改版，依赖精确选择器的解析会腐坏，所以只抓通用 `innerText` + 截图，**不下绝对的通过 / 不通过结论**；再按站点 `hints` 关键词摘录相关行辅助阅读。
  - **并发安全**：同一环境同时只允许一次检测（in-flight 锁），避免叠加导航造成「站点名 A、内容是 B」的张冠李戴——对卖点即证据的本功能是致命的。
  - **失败也留证**：网络不通 / 代理失效 / 撞人机验证（Cloudflare）时仍尽力带截图与错误页文本，`describeLoadError` 把 Chromium 错误码翻译成中文；检测异常同样写操作日志（这类记录最需要追溯）。
  - **不自动跳回**：用完停在检测站结果页（跳回会重载、可能丢失登录态 / 表单）；UI 用 Alert 明确告知「会把环境窗口真实指纹发送给第三方站点」，高价值账号环境需谨慎。

---

## 2026-09-24 · 指纹深度补齐（WebGPU 伪装 + WebAudio 完整特征）

### 新增

- **WebGPU 指纹伪装**：真实 Chrome 的 `navigator.gpu.requestAdapter()` 会暴露 `GPUAdapterInfo`（vendor / architecture），creepjs / pixelscan / browserleaks 已普遍采集。此前只伪造了 WebGL 而放过 WebGPU，会产出「WebGL 说 RTX 4090、WebGPU 说宿主机集显」的矛盾信号——**矛盾比不伪装更可疑**，等于告诉检测方「这个环境被改过」。
  - `src/shared/webgpu.ts`（纯函数、可单测）的 `webGpuInfoFor(os, webglVendor, webglRenderer)` 由**既有 WebGL 字段推导**，不加数据库字段，因此历史环境**零迁移、自动生效**（无需 `normalizeFingerprint` 兜底，也不用改指纹表单）。
  - **在真实实例上改写**：只在原生 `GPUAdapterInfo` 实例上用不可枚举 getter 覆盖 `vendor` / `architecture`，使 `instanceof GPUAdapterInfo` 成立、`subgroupMinSize` / `subgroupMaxSize` / `isFallbackAdapter` 继续由原生提供、`Object.keys` 仍为空。塞自制普通对象的写法会让这些维度变成 `undefined` 且 `instanceof` 判 `false`，反而制造出真实浏览器不可能出现的值。
  - **识别不出就放弃伪造**：`webglRenderer` 允许手填，遇到未见过的型号返回空信息（体检项标记为「不适用」），而不是兜底成某个架构去和 WebGL 打架。`device` / `description` 保持空串——真实 Chrome 未开启开发者特性时就是空串。
  - iOS WebKit 不支持 WebGPU，伪装成 iOS 时整体隐藏 `navigator.gpu`。
- **WebAudio 完整指纹**：音频指纹是 fingerprintjs 的核心熵源之一，此前只给 `AudioBuffer.getChannelData` 加了噪声（**1 个维度**），而检测站更常采集的 `sampleRate` / `baseLatency` / `maxChannelCount` / `DynamicsCompressorNode.reduction` 全部裸奔。
  - `src/shared/webaudio.ts`（纯函数、可单测）由环境 seed 确定性派生，保证「同环境稳定、异环境不同」；`baseLatency` 恒等于 `bufferSize / sampleRate`（128 / 256 / 512），不会出现自相矛盾的数值组合。
  - **不动 `OfflineAudioContext`**：其采样率必须等于构造参数，改了会让渲染结果与预期长度对不上。补丁打在 `BaseAudioContext.prototype`（`sampleRate` 真正所在处）并用 `instanceof` 放过它。
  - **刻意不注入 `outputLatency`**：真实 AudioContext 在无音频播放时该值为 0，强行填 0.015~0.045 会与真实人群脱节，而它几乎不泄漏硬件信息——收益不足以抵消穿帮风险。
  - 复用既有 `audioNoise` 开关：关闭即完全不伪装。
- **体检新增三项**：「WebGPU 显卡」（权重 8）、「音频特征（采样率/延迟/声道）」（6）、「音频压缩器 reduction」（3），可在体检报告里直接看到注入是否生效。采集走 `Promise`（`requestAdapter` 异步）并带 **3 秒超时**，避免 GPU 进程卡住导致体检请求悬挂。
- 提交：`82adf9b`（feat + 修复）。

### 修复

- **iOS 下移除 `navigator.userAgentData` 一直失效**（既有缺陷，本次顺带修复）：原实现用 `delete navigator.userAgentData`，但 WebIDL 定义的属性在 `Navigator.prototype` 上，而 `delete` **只能删除自身属性**——对原型属性返回 `true` 却什么也不删，是彻底的静默失效。结果是伪装成 iOS 时 UA-CH 仍然暴露（体检 `uaData` 项必然报红）。现改为用返回 `undefined` 的 own getter 遮蔽原型 getter；同因修复也避免了新增的 `navigator.gpu` 重蹈覆辙。
- 提交：`82adf9b`（feat + 修复）。

## 2026-09-16 · 应用品牌图标替换

### 新增

- **应用图标替换**：去除 Electron 默认图标，生成品牌图标（蓝紫渐变圆角方块 + 浏览器窗口 + 指纹）。产出 `resources/icon.ico`（16–256 七尺寸）、`resources/icon.png`（512）、`tray.png`（32，同步更新保持一致）。`src/main/index.ts` 新增 `appIconPath()` 并挂到 `BrowserWindow`，dev 态任务栏/标题栏立即生效；打包 exe 图标走既有 `win.icon`。
- 提交：`9925318`（feat）。

## 2026-09-16 · 智能助手 Planner（AI 客服 / 全项目自然语言查询）

### 新增

- **智能助手 Planner**：右下角悬浮气泡 + 抽屉式 AI 客服，支持对全项目数据用自然语言提问，并给出可点击深链定位到对应页面处理；可执行动作按危险分级（safe 直执行 / medium 确认条 / destructive 强确认弹窗 + 审计）。
  - 三道闸（后端硬兜底，不信任模型自觉）：① 敏感拦截——`api_tokens`/`users` 整体禁查，`password`/`token`/`secret` 等字段后端直接剔除；② 只读白名单——entity/field/filter 必须落在白名单，QueryBuilder 参数化 + 强制 team/owner 隔离；③ 动作映射——8 个动作白名单，危险分级决定确认强度。
  - 新增 `src/main/assistantSchema.ts`（查询白名单 + 动态时间系统提示）、`src/main/assistantPlanner.ts`（引擎 `planAssistant`/`executeAssistantAction`）、`src/renderer/src/components/AssistantChat.tsx`（悬浮 UI）、`src/renderer/src/hooks/useDeepLinkFocus.ts`（深链定位脉冲）。
  - 路由：`POST /api/assistant/chat`、`POST /api/assistant/action`（均 `authMiddleware` 保护）。环境 / 代理 两张表接 `data-dl-id` 深链；「环境快过期」语义映射为所绑代理 `expiresAt` 7 天内。
- **多轮对话修复**：归一化历史消息角色（`bot`→`assistant`），修复云端模型因非法 role 返回 400 的问题（`assistantPlanner.ts` 的 `normalizeRole` + 前端 history 构建）。
- 提交：`fdd15e2`（feat + 多轮对话修复）。

## 2026-09-16 · RPA 脚本市场（内置预设一键安装）

### 新增

- **脚本市场**：RPA 页新增「脚本市场」Tab（`Tabs` 拆「我的脚本 / 脚本市场」），展示 6 个内置预设自动化（SEO / 电商 / 账号 / 社媒四类），支持「查看步骤」预览与「安装」克隆。
- **预设数据**：`src/main/rpaMarket.ts`（主进程专用纯数据模块，离线可单测）导出 `MARKET_SCRIPTS` 与 `getMarketScript`。预设以 `navigate` + `wait`/`scroll` 为主、跨站点通用；`input`/`click` 留作模板并附 `note` 提示按站点微调；变量用 `{{变量名}}` 暴露。
- **后端路由**：`GET /api/rpa/market`（罗列目录 DTO：id/名称/描述/分类/标签/步骤数/变量/备注/步骤）、`POST /api/rpa/market/install/:id`（克隆为当前团队新脚本，归属当前用户、定时重置、备注带 `[市场]` 前缀、写 `install_rpa_market` 审计）。路由排在 `/rpa/:id` 之前（静态前缀优先约定）。
- 提交：`da78bbb`（feat + 文档）。

## 2026-09-15 · 内核版本切换（指纹层 Chrome 大版本可选）

### 新增

- **内核版本切换**：指纹表单新增「内核版本 (Chrome)」下拉（可选 Chrome 127–132），仅替换 UA 串与 UA-CH 客户端提示里的 Chrome 大版本号，让同一套设备指纹在不同时期表现为不同浏览器版本；iOS 走 Safari/WebKit 自动隐藏该下拉。实现 `applyCoreVersion()` 与 `CHROME_MAJORS`（`src/shared/fingerprint.ts`），`randomFingerprint` 支持透传 `coreVersion`，`normalizeFingerprint` / `presetFingerprint` / 克隆工厂均保留或推导该字段；`POST /api/fingerprint/random` 与 v1 接口支持 `body.coreVersion`。`Fingerprint.coreVersion` 新增到 `src/shared/types.ts`（无 DB 迁移）。

## 2026-09-15 · 登录二次验证（2FA / TOTP）

### 新增

- **登录二次验证（TOTP）**：用户可在「设置 → 登录二次验证」扫码启用 Google Authenticator / 1Password / Authy 等验证器的 6 位动态码；启用后每次登录除密码外还需动态码。
  - 后端 `src/main/totp.ts` 用 Node 内置 `crypto`（HMAC-SHA1 + base32）实现 `generateTotpSecret` / `buildOtpAuthUrl` / `verifyTotp` / `totpQrDataUrl`，**零新增依赖**（二维码复用已有的 `qrcode`）。
  - 接口：`POST /api/auth/2fa/setup`（生成密钥 + 二维码 data URL，pending）、`POST /api/auth/2fa/confirm`（首个动态码确认启用）、`POST /api/auth/2fa/disable`（动态码关闭）、`POST /api/auth/2fa/verify`（登录第二步：挑战令牌 + 动态码换正式令牌）。
  - 登录改造：`POST /api/auth/login` 在密码正确且已启用 2FA 时只返回 `{ twoFactorRequired, challengeToken }`（5 分钟短期令牌），不直接发令牌；`GET /api/auth/me` 返回 `twoFactorEnabled` 供设置页展示状态。

### 修复

- **2FA 挑战令牌防复用**：`authMiddleware` 原先仅校验 JWT 签名、未检查 `purpose` 声明，导致登录第二步下发的 `purpose:'2fa'` 挑战令牌可被当作 Bearer 会话令牌访问任意受保护接口（尤其 `/api/auth/2fa/setup` 会静默覆盖密钥并关闭 2FA），形成 2FA 降级/绕过。现显式拒绝任何携带 `purpose` 的令牌（`6d4da32`）。
  - 数据模型：`users` 表加 `twoFactorSecret`（base32，可空）+ `twoFactorEnabled`（tinyint），`synchronize:true` 自动加列，无迁移脚本。
  - 渲染端 `Login.tsx` 需配合处理 `twoFactorRequired` 挑战（本项目该文件受敏感内容门禁，挑战逻辑以补丁形式交付，详见提交说明）。

## 2026-09-15 · Webhook 通知（操作日志实时外发）

### 新增

- **Webhook 通知**：把操作日志事件实时 POST 到用户自有服务，用于运维机器人 / 审计 / 外部联动。
  - 数据模型：`AppSettings.webhooks: WebhookConfig[]`（`src/shared/types.ts`，JSON 列随设置持久化；`WebhookConfig` = `{ id, name, url, secret, enabled, events }`）。
  - 引擎 `src/main/webhook.ts`（纯函数、无 express 依赖）：`signWebhookBody`（HMAC-SHA256）、`webhookShouldFire`（命中规则：空/`*`=全部、精确、关键词分词匹配如 `profile`→`create_profile`/`batch_delete_profile`、`*kw*` 通配）、`buildWebhookPayload`、`dispatchWebhookEvent`（fetch + 头 + 8s 超时）、`dispatchWebhook`（fire-and-forget，绝不阻塞主流程）、`testWebhook`。
  - 事件收敛：在 `writeLog` / `saveSchedulerLog` / `writeAgentLog` 三个操作日志入口 fire-and-forget 调用，凡写日志的动作都外发；`getSettings()` 与 `PUT /settings` 刷新内存缓存，事件触发不查库。
  - 接口：`POST /api/webhooks/test`（需登录）接收一条配置单发并返回 `{ ok, status, error }`；设置页每条配置「发送测试」按钮调用它。
  - 请求头：`X-Roxy-Event` / `X-Roxy-Delivery`（去重 ID）/ `X-Roxy-Signature: sha256=<HMAC>`（设了密钥时）；Body = `{ event, eventId, timestamp, teamId, actor, detail }`。
  - 前端：`Settings.tsx` 新增「Webhook 通知」分区（`Form.List` 增删多条，含名称 / 地址 / 签名密钥 / 启用 / 事件多选），四语 i18n（`webhook.*` + `webhook.group.*`）。
  - 离线单测：编译为 CJS 后用 mock fetch 对拍签名 / 事件匹配 / 投递 / fire-and-forget（26 项全绿，已用独立 HMAC 参考实现交叉验证）。
  - 提交：`9128a2d`（feat + 离线单测）。

## 2026-09-15 · 操作日志导出（CSV / JSON）

### 新增

- **操作日志导出**：操作日志页一键把当前筛选结果导出为 CSV / JSON，便于审计留存。
  - 后端：`GET /api/logs/export?format=csv|json`（需登录），仅导出当前团队；复用列表关键词筛选，并支持 `sensitive=1` / `action` / `from` / `to` 过滤。CSV 带 UTF-8 BOM、`createdAt` 输出 ISO UTC、字段自动转义。
  - 纯函数 `src/main/logExport.ts`：`escapeCsvField` / `logsToCsv` / `logsToJson` / `exportStamp`（无 express 依赖，可单测）。
  - 导出本身写入操作日志（`export_logs`，敏感操作），形成审计闭环。
  - 前端：`Logs.tsx` 工具栏「导出」下拉（CSV / JSON），`fetch` 带 Bearer 头取回文件后本地下载（令牌不进 URL）；四语 i18n（`logs.export` / `logs.exportCsv` / `logs.exportJson` / `logs.exported` / `logs.exportFailed`）。
  - 离线单测：`logsToCsv` 转义 / BOM / 字段顺序 / 多行字段 / JSON 往返（19 项全绿）。
  - 提交：`dd807db`（feat + 离线单测 + 文档）。

## 2026-09-15 · 团队切换器（多团队工作区切换）

### 新增

- **团队切换器**：顶栏一键在「我所属团队」间切换工作区，无需退出登录。
  - 后端：`GET /api/auth/teams`（需登录）返回成员关系列表 `[{ id, name, role, isCurrent }]`；`POST /api/auth/switch-team`（需登录，body `{ teamId }`）校验成员关系后，用该团队**实时角色** `jwt.sign({ uid, tid: teamId, username, role }, 7d)` 重发令牌。
  - 切换前关闭所有运行中的环境窗口（`await import('./browserManager')` → `getRunningWindowIds()` + `closeWindow`，动态 import 避免循环依赖），避免旧团队窗口请求因 `teamId` 不匹配报错；并写审计日志 `switch_team`（记在新团队下）。
  - 安全：重发令牌沿用已通过登录态（含 2FA），不重新验码；新角色读 `team_members` 表实时值，不取自旧 JWT。
  - 前端：`Layout.tsx` 顶栏团队切换下拉，选中即 `setToken` + 整页 `reload`，刷新后数据按新 `tid` 重新归属；仅 1 团队时下拉只显示当前团队。
  - 四语 i18n（`team.switch` / `team.current` / `team.switched` / `team.switchedShort` / `team.switchFailed`）；`Logs.tsx` 的 `ACTION_LABELS` 补 `switch_team`。
  - 提交：`33e94c9`（feat + 文档）。

## 2026-09-15 · 环境分享转移（跨团队）

### 新增

- **环境分享转移**：环境列表每行「转移」即可把环境分享到其他团队。跨团队数据按 `teamId` 强隔离，「转移」= 把环境及其关联数据的归属 `teamId` 改写为目标团队。
  - 后端：`POST /api/profiles/:id/transfer`（需登录，body `{ teamId }`）——校验环境属于当前团队且未运行；校验操作人同时是目标团队成员（否则 403）；改写 `ProfileEntity.teamId/ownerId`，并级联把该环境的 `Cookie`（自带 `teamId` 列）迁到目标团队、把 `Account`（靠 `profileId` 隐式归属，无独立 `teamId` 列）同步 `ownerId`；写敏感审计日志 `transfer_profile`（已把 `transfer` 加入 `SENSITIVE_LOG_KEYWORDS`）。
  - 前端：`Environments.tsx` 行内「转移」按钮（`ShareAltOutlined`）打开 Modal，从 `GET /api/auth/teams` 拉取「我所属且非当前」的团队作目标候选；确认后环境即从当前团队列表消失，成功提示标注目标团队；只属 1 团队时提示无法转移。
  - 四语 i18n（`env.transfer` / `env.transferTitle` / `env.transferTo` / `env.transferConfirm` / `env.transferHint` / `env.transferred` / `env.noOtherTeam`）；`Logs.tsx` 的 `ACTION_LABELS` 补 `transfer_profile`。
  - 提交：`9790857`（feat + 文档）。

## 2026-09-15 · 环境截图（窗口视口 PNG）

### 新增

- **环境截图**：环境列表每行「截图」即可截运行中环境窗口当前视口为 PNG，用于 SEO 报告 / 收录检测 / A-B 测试证据 / 竞品调研留痕（对标 RoxyBrowser「SEO 内容营销」用例的「截图报告」卖点）。
  - 主进程：`browserManager.ts` 新增 `captureScreenshot(profileId)`（`webContents.capturePage()` → `NativeImage.toPNG()`，复用 AI Agent 既有采集通道），挂到 `BrowserBridge` 接口并由 `index.ts` 注入。
  - 后端：`POST /api/profiles/:id/screenshot`（需登录）——校验环境属当前团队、未软删、且 `status === 'running'`（与体检同约束），取 PNG 转 base64 `data:image/png;base64,...` 回前端，写审计日志 `screenshot_profile`。
  - 前端：`Environments.tsx` 行内「截图」按钮（`CameraOutlined`）+ 弹窗展示图片 / 截图时间 /「下载 PNG」（`downloadDataUrl` 解码 data URL 为 Blob）；`utils/download.ts` 新增 `downloadDataUrl`。环境未运行时提示先打开。
  - 四语 i18n（`env.screenshot` / `env.screenshotTitle` / `env.screenshotNotRunning` / `env.screenshotDownload` / `env.screenshotCapturing` / `env.screenshotEmpty` / `env.screenshotCapturedAt`）；`Logs.tsx` 的 `ACTION_LABELS` 补 `screenshot_profile`。
  - 提交：`6e857b8`（feat + 文档，amend 后 hash 由 6c32c9d 变更为此值）。

## 2026-09-16 · 登录页左侧改为功能轮播

### 优化

- **登录页左侧视觉改版**：原「单张盾牌插画 + 三个特性标签」改为**三图功能轮播**，更直观地介绍产品能力。
  - 3 张插画全部内联 SVG（渐变 + SMIL 动效，无外部图片依赖）：① **AI 智能体**（机器人 + 神经网络 + 指令气泡）② **隐私安全**（盾牌 + 锁 + 环绕加密环）③ **多账号防关联**（三张独立窗口 + 隔断线，每张指纹纹路各不相同）。
  - 每 **2 秒**自动切换；**鼠标移入轮播区域暂停**，移出后从当前张继续（靠 `paused` 依赖重建定时器实现）。
  - **禁止手动切换**：不提供左右箭头，底部指示点也不可点击（`cursor: default`），仅作进度展示。
  - 文案走 i18n 四语：`login.slideAiTitle/Desc`、`login.slidePrivacyTitle/Desc`、`login.slideIsolateTitle/Desc`；顺带清掉随旧 UI 一起失效的 `login.feat1/2/3` 死 key。
  - 稳定性：三张 slide 绝对定位堆叠（容器高度恒定），文案区保底高度 110px——中/英/德三语行数差异大，不设保底会让切换时下方指示点抖动。
  - 窄屏（≤900px）左侧整体 `display: none`，轮播不影响移动端布局。
  - 验证：node / web 双 `tsc --noEmit` EXIT 0；`electron-vite build` EXIT 0。
  - 提交：`302e312`（ui）+ `docs: CHANGELOG` 同功能文档提交。

## 2026-09-16 · 追踪器屏蔽（隐身增强）

### 新增

- **追踪器屏蔽**：环境级开关，拦截已知分析 / 广告 / 埋点域名的请求，避免反复调研竞品时被对方的埋点、Cookie 或第三方脚本识别甚至反监控（对标 RoxyBrowser「屏蔽追踪器」）。
  - 实现：主进程 `browserManager.openWindow` 给环境 session 挂 `session.webRequest.onBeforeRequest`，命中即 cancel。**preload 跑在渲染进程，只能改 JS、拦不到网络请求**，所以这次不是走 preload 注入。
  - 判定：`src/shared/trackers.ts` 纯函数模块（可单测）导出 `TRACKER_HOSTS` 与 `isTrackerUrl(url, extraHosts)`；hostname 等于清单项或以其子域结尾即命中，非法 / 非 http(s) 一律放过。
  - 清单原则：只拦明确的分析 / 广告子域，绝不拦主域（拦 `facebook.com` 会让用户登不上号）；CDN 与错误上报（Sentry / Bugsnag）不在清单内。
  - 开关：`Fingerprint.blockTrackers`，新建环境默认开启；预设确定开启、克隆继承母本；`normalizeFingerprint` 对老数据兜底。上线前创建的环境默认不拦截，表单开启后生效。
  - 前端：`ProfileForm.tsx` 高级设置加「追踪器屏蔽」Switch（说明用 tooltip 避免撑高同排项）。
  - 验证：离线单测 98 项全绿（68 项判定 + 30 项指纹联动）；node / web 双 `tsc --noEmit` EXIT 0；build EXIT 0。
  - 提交：`4bf8bb1`（feat）+ `docs: CHANGELOG` 同功能文档提交。

## 2026-09-16 · 自动化 API 审计留痕（令牌操作进操作日志）

### 修复

- **自动化 API（v1）的令牌操作此前完全不落操作日志**：`writeLog` 有 `if (!req.tid || !req.uid) return` 守卫，而令牌鉴权（`tokenAuthMiddleware`）只设 `tid` / `role`，不设 `uid`——结果令牌能建环境、删数据、导出 Cookie 却零留痕，形成审计盲区。
  - `writeLog` 守卫放宽为「有 uid **或**有令牌身份」；`AuthedRequest` 新增 `apiToken`（id / name / ownerId），由 `tokenAuthMiddleware` 注入。
  - 日志 `userId` 记令牌创建者（`ApiTokenEntity.ownerId`，取不到记 0），`username` 记为 `api:<令牌名>`，界面上一眼分辨是人操作还是脚本调用。
  - `v1` 新增统一审计中间件（响应完成后 `res.on('finish')` 落日志），而非逐个路由手写，杜绝新增接口漏记。
  - 推导逻辑抽为纯函数模块 `src/main/apiAudit.ts`（与 `webhook.ts` / `logExport.ts` 同构）：`apiActionName` / `apiShouldAudit` / `apiAuditDetail`。
  - 只读 GET 不记（避免日志被列表查询刷屏），但 `/cookies/export` 属数据外泄单独记录；删除 / 导入 / 导出类 action 自动命中既有敏感词，标为敏感操作。
  - detail 只记「方法 + 路径 + 资源 id + 名称」，绝不写入 token / password / Cookie value。
  - `Logs.tsx` 补 `api_*` 中文标签与配色 21 项。
  - 离线单测 49 项全绿；node / web 双 `tsc --noEmit` EXIT 0；`electron-vite build` EXIT 0。
  - 提交：`71e051b`（fix）+ `docs: CHANGELOG` 同功能文档提交。

## 2026-09-16 · 地理位置伪装（GEO / navigator.geolocation）

### 新增

- **地理位置伪装（GEO）**：覆盖 `navigator.geolocation`，按环境时区回灌「代表城市」坐标——补齐了指纹维度上最后一个缺口（此前页面调用定位 API 会暴露宿主真实坐标或报错穿帮）。
  - 数据模型：`Fingerprint` 新增 `geoLatitude / geoLongitude / geoAccuracy`；`shared/fingerprint.ts` 的 `TZ_POOL` 每个时区带一组代表城市坐标，新增 `geoFor(tz, jitter)` / `tzGeo(tz)`。
  - 注入：`main/browser-preload.ts` 整体替换 `navigator.geolocation`（`getCurrentPosition` / `watchPosition` / `clearWatch`），回灌指纹坐标并伪造 `coords`；整体替换而非只改方法，以绕开 Chromium 原生定位权限弹窗流程。
  - 自洽性（关键）：历史环境（本功能上线前创建、无 GEO 字段）在 `normalizeFingerprint` 中按其**自身 timezone** 反查坐标补齐，不套用随机基准，避免「东京时区 + 纽约坐标」；克隆派生只做 ±0.03° 同城微抖，不漂出母本城市。
  - 前端：`ProfileForm.tsx` 时区下新增纬度 / 经度 / 精度输入，切换时区时坐标自动跟随到该时区代表城市。
  - 验证：离线单测 57 项全绿；node / web 双 `tsc --noEmit` EXIT 0；`electron-vite build` EXIT 0。
  - 提交：`56ced10`（feat）+ `docs: CHANGELOG` 同功能文档提交。

## 2026-09-15 · 代码签名与自动更新（electron-builder 签名 + electron-updater）

### 新增

- **代码签名（证书就绪）**：`electron-builder.yml` 接入 `win.signingHashAlgorithms: [sha256]`，签名经环境变量 `CSC_LINK`（`.pfx` 路径 / URL）与 `CSC_KEY_PASSWORD` 驱动；本地 / CI 无证书时 electron-builder 自动跳过、仅告警，不破坏构建。正式发布在签名机设置两变量后执行 `pnpm dist` 即可，主程序 exe 与 NSIS 安装包自动签名；Portable 版为 7z 自解包无法签名，仅作内部分发。
- **自动更新（electron-updater）**：新增 `src/main/updater.ts` 在主进程接入 `autoUpdater`——仅打包安装版（`app.isPackaged`）生效，开发态只推送 `{ state: 'dev' }`；manual 模式（自动检查但不自动下载，由用户在设置页确认后再下载 / 安装，避免打断多账号操作）。
  - 更新源由 `electron-builder.yml` 的 `publish.generic`（默认占位 `https://update.roxyclone.com`）决定，可用环境变量 `UPDATE_FEED_URL` 在运行时覆盖；`pnpm dist` 时生成 `latest.yml` 与安装包上传到该地址。
  - 主进程经 IPC `app:update-status` 推送状态，渲染端 `window.roxy.onUpdateStatus` 订阅；设置页「关于」区新增「检查更新」按钮与状态展示（发现新版本 → 下载并安装 → 立即重启安装），四语 i18n（`update.*`）。
  - 依赖 `electron-updater@6.8.9`（已写入 `package.json`）。

## 2026-09-15 · AI 定时自动化（自然语言指令 + 定时触发 + 沉淀 RPA）

### 新增

- **AI 定时自动化**（`#109`，缝合 FEATURES §13 执行闭环 与 §7.3 RPA 定时调度）：设置页「AI 定时自动化」分区可增删改多条定时任务——自然语言指令 + 目标环境（多选）+ 触发间隔（分钟）+ 单次最大步数 + 启用 + 「沉淀为 RPA 模板」开关。
  - 调度器 `AgentRunner.startAutoTaskScheduler()`（`src/main/agent/runner.ts`）每 60s 重读 `AppSettings.aiAutoTasks`，按 `intervalMin` 去抖触发；保存设置后即时生效，无需重启。
  - 程序化触发路径 `runScheduledTask()`：复用 `agent:start` 同款视觉模型预检（本地 Ollama / 云端 BYOK），仅驱动**运行态**环境，未运行自动跳过并写日志——**绝不自动开窗**（与 RPA 定时调度同一约定）；后台静默执行不抢焦点（`focusWindow=false` + 空 sink 丢弃 UI 事件）。
  - 跑完沉淀：任务开启「沉淀为 RPA 模板」后，每个环境跑完的动作序列（`rpaSteps`）经注入的 `saveRpaScript`（`server.ts` 的 `saveRpaFromSteps()`）落库为新的 RPA 脚本（默认关闭定时，归属取源环境的团队 / 创建者），下次用 RPA 离线回放零 token。
  - 设置项（JSON 单列 `app_settings`）：`aiAutoTasks: AiAutoTask[]`（默认 `[]`），`AiAutoTask` 结构（`id/name/instruction/envIds/intervalMin/enabled/saveRpa/maxSteps`）定义在 `src/shared/types.ts` 并并入 `DEFAULT_SETTINGS`。
  - 前端：设置页新增「AI 定时自动化」分区（任务卡片列表 + 编辑弹窗 + 环境多选，读取 `/api/profiles`），四语 i18n（`aiAuto.*`）。

## 2026-09-15 · 全空间快照新增「定时自动备份」（本地目录轮转）

### 新增

- **定时自动备份**（`#110`，延续 `24192c6` 全空间快照）：设置页「空间快照」分区可开启自动备份——按设定间隔（小时）把**每个团队空间**自动打包成 JSON 写入本地目录，每个团队保留最近 7 份（按文件名时间戳排序，超出自动清理），目录不存在 / 不可写时静默跳过、不报错。
  - 复用代理巡检式 `setInterval` 调度器（`startSnapshotBackupScheduler` / `runSnapshotBackupAll`，`src/main/server.ts`）：启动即调度，保存设置即重启；开关 / 目录 / 间隔任一变化立即生效。
  - 文件复用 `buildSnapshot()`（`src/main/exporters.ts`，与手动导出 / 导入同源），保证自动备份与手动快照字段完全一致；导入端仍是既有的 `validateSnapshot` → 逐模块导入器。
  - 设置项（JSON 单列 `app_settings`）：`snapshotBackupEnabled` / `snapshotBackupDir` / `snapshotBackupIntervalH`（默认 24 小时），默认值已并入 `DEFAULT_SETTINGS`（`src/shared/types.ts`）。
  - 前端：设置页新增「定时自动备份」分区（启用开关 / 备份目录 / 间隔），四语 i18n（`snapshot.backup*` / `common.hours`）。

## 2026-09-15 · 新增全空间快照（团队整体打包 / 迁移）

### 新增

- **全空间快照**（`24192c6`）：把整个团队空间（环境 + 代理 + RPA + 扩展引用）打包成单个 JSON，新机器一键灌入即还原，解决换机器 / 重装 / 整机迁移时逐模块导出的繁琐与易漏。
  - 导出 `GET /api/snapshot/export` 直接下载 `.json`（文件名含团队 id 与时间戳）；导入 `POST /api/snapshot/import`，body 为快照 JSON。
  - **复用既有导入器**：导出 / 导入直接复用 `src/main/exporters.ts` 中「整环境迁移 / 代理批量 / RPA」各模块的既有逻辑，保证单模块迁移与整团队迁移同源、字段一致。
  - **导入顺序**：先恢复代理池（按名称复用，缺失则新建）→ 再导入环境（引用同名代理）→ 最后导入 RPA（定时配置重置为关闭）；扩展按名称重映射，目标缺同名扩展则忽略引用。
  - **校验**：导入前用 `validateSnapshot()`（`src/shared/snapshot.ts`，纯函数）严格校验 `format` / `version` / `profiles[]`，非法文件直接 400 拒绝，不污染数据库。
  - 前端：设置页「空间快照」卡片提供「导出快照」「导入快照」按钮。
  - 定时自动备份（把每个团队空间按间隔写入本地目录的快照文件）为计划项，见任务 #110。

## 2026-09-15 · 指纹池更新至近几代硬件（含 Intel Arc）

### 优化

- **指纹池更新**（`3ff9a8a`）：原池子停留在 2023 年前后的硬件形态，伪装成「老机器」在部分站点反而显眼。
  - **Windows 显卡 5 → 13 种**：新增 RTX 4070 / 4080 / 4090、Intel Iris Xe、Intel Arc A770 / **B390**、AMD RX 6600 / 7800 XT；同时**保留** GTX 1650、UHD 630、AMD 核显等老型号——真实人群里确实有长期不升级的机器，全用最新型号反而不自然。
  - **Mac 显卡 3 → 6 种**：新增 Apple M3 / M4 / M4 Pro。
  - **分辨率 3 → 9 种**（1366×768 – 3440×1440）：此前多数时区只有 1–2 种，随机与批量派生都容易撞成同一分辨率（克隆工厂直接受益）。
  - 验证：80 次随机可覆盖全部 13 种显卡、9 种分辨率；克隆派生 20 个的综合签名仍 20/20 全唯一。
  - 注：仅影响**新建 / 重新随机指纹**的环境，已有环境的指纹保持不变。

## 2026-09-15 · 新增环境克隆工厂（批量派生 · 行为一致 / 指纹各异）

### 新增

- **环境克隆工厂**（`34343a0`）：以某环境为母本一键派生 N 个副本，用于「再开 N 个一样的号」这类批量开号场景。
  - 核心是 `deriveJitteredFingerprint()`（`src/shared/fingerprint.ts`）：**原样复制指纹会让 N 个号共用同一套设备特征被一锅端**，因此把字段分成两类——**保持**（系统 / UA / 平台 / 语言 / 时区 / 触摸 / 像素比 / 噪声开关 / WebRTC 策略，决定「像不像同一类用户」）与**抖动**（分辨率 / CPU 核数 / 内存 / 显卡 / 字体，设备指纹高区分度项）。
  - Canvas / Audio 噪声无需额外处理——preload 的噪声种子由 `profileId` 派生（`seed = profileId * 2654435761`），新建环境拿到新 id，噪声天然互不相同。
  - 接口 `POST /api/profiles/:id/duplicate-batch`（`count` 1–50、`namePrefix`、`copyAccounts`）；**不复制 Cookie**（登录态复制过去等于主动制造关联），也不继承代理绑定，需另行分配。
  - 前端：环境列表勾选 1 个母本 → 「克隆工厂」弹窗（数量 / 名称前缀 / 是否复制账号）。
  - 验证：纯函数层面 20 个副本的综合设备签名 **20/20 全唯一**、保持项与母本完全一致；真实 API 端到端克隆 3 个，保持项一致、分辨率 / CPU / 内存 / 显卡 / 字体均有差异，测试环境已清理。
  - 过程中修掉一个瑕疵：分辨率池每个时区仅 3 种，连抽会让副本撞成同一分辨率（实测 3 个副本全是 1920×1080），改为重抽最多 5 次保证与母本不同。

## 2026-09-15 · 新增环境体检（伪装度评分 + 一致性红绿灯）

### 新增

- **环境体检**（`2ae4411`）：环境列表每行新增「体检」按钮，后端 `POST /api/profiles/:id/healthcheck` 在**环境窗口内执行 JS 回读真实生效的指纹值**，与数据库里的设定指纹逐项对撞，输出**伪装度 0–100** 与**一致性红绿灯**（代理出口 IP 国家 ↔ 时区 ↔ 浏览器语言 ↔ UA 平台）。
  - 新增 `src/shared/healthcheck.ts`（纯函数：比对与加权计分，便于单测与前后端复用）与 `src/main/healthProbe.ts`（窗口内采集脚本，`executeJavaScript`）；`browserManager` 新增 `probeFingerprint` 并经 `browserBridge` 注入 server，避免与 server 产生循环依赖。
  - 噪声 / 防护类项（Canvas / Audio / 字体）不看配置、看**注入是否真挂上**：通过判断原型方法是否被改写来实测（原生方法 `toString()` 含 `[native code]`），因此能发现「配置存了但注入没生效」。
  - **一致性红绿灯**单独展示（不计入伪装度分），未绑定代理或代理未检测时显示「未检测」而不判红。
  - 环境限制不误报：无 GPU 环境创建不出 WebGL 上下文时该项标记「不适用」且权重置 0——实测中因此把伪装度从 91 纠正为 100，避免把环境限制当成注入失败。
  - 文档：README 新增「核心功能」概览与体检小节、目录结构补充两个新文件；FEATURES 新增 §2.1。
  - 验证：`pnpm typecheck` + `pnpm build` 均通过；真实 Electron 窗口端到端测试——未开窗返回 400「请先打开环境窗口，再执行体检」，开窗后返回 200，16 项中 15 项命中、1 项（WebGL，无 GPU）正确标记为不适用。

## 2026-09-14（七续）· README 新增「数据库（必读）」章节

### 文档

- **README 补数据库使用说明**（本次提交）：原 README 仅零散提及 MySQL 地址 / 自动建库 / 环境变量，未说明如何起一个 MySQL、也未引用 `db/schema.sql`。新增「## 数据库（必读）」整节：MySQL 非内嵌（未启动应用直接报错退出）、Docker 一键起库命令、默认连接信息表 + 环境变量覆盖、首次启动经 `bootstrap()` + `synchronize:true` 自动建库建表 + 默认管理员 `admin/123456`（无需手动 SQL）、可选 `db/schema.sql` 手动路径、MySQL 未启动错误提示。技术栈表数据库一行加「需自备服务」标识。

## 2026-09-14（六续）· 检测连接修复（表单覆盖 / 探针 token / 云端隐藏按钮）

### 修复

- **检测连接误报「本地模型已连接」**（本次提交）：设置页选了云端 backend 但未保存就点「检测连接」时，原 `GET /ai-agent/status` 只读已保存配置，会用旧的本地后端探活并误报「本地模型已连接」。现端点改为 `POST`，接收前端表单当前值 `req.body.aiAgent` 做覆盖（`src/main/server.ts` + `src/renderer/src/pages/Settings.tsx` 的 `checkAi` 改为 `api.post` 并带上 `form.getFieldValue('aiAgent')`），与页面选中状态一致。
- **云端正确配置被误报「返回内容为空」**（本次提交）：`checkCloudStatus`（`src/main/agent/cloud.ts`）的探针原 `maxTokens: 1`，`deepseek-flash` 在 1 token 上限下会返回空 `content`（真实对话用正常上限所以正常）。现改为 `maxTokens: 16`；非空内容的严格判定（防无效 Key 返回空 200）予以保留。
- **检测连接按钮云端隐藏**（本次提交）：按需求「只在本地 backend 出现」，云端区块移除「检测连接」按钮与状态展示，仅本地渲染；云端配置错误改由 `agent:start` 运行时预检暴露。

## 2026-09-14（五续）· 云端连通性自检严格化

### 修复

- **云端自检误判无效 Key 为连通**（`ceaa5c2`）：`checkCloudStatus`（`src/main/agent/cloud.ts`）原成功判据只看 `cloudChat` 是否抛错。部分网关 / 中继对无效 Key 仍返回 HTTP 200，只是 `choices` 为空或 `content` 为空串，`cloudChat` 返回 `''` 不抛错，于是被误判为「连通」——导致错误 Key（如多打一个字母）检测仍通过。现改为严格判定：探针不仅要「未抛错」，还要求返回**非空内容**，否则判为不可达并提示「API Key 无效或模型无响应」。该判定同时加固「设置页检测连接」与 `runner.ts` 的 `agent:start` 预检（两者都走 `checkCloudStatus`）。

## 2026-09-14（四续）· 执行 tab 显示后端与模型名

### 优化

- **执行 tab 显示后端与模型名**（`538ce73`）：`AiAgent.tsx` 卡片右上角原本只在「自动 / 对话 / 客服」三个 tab 显示「本地 / 云端」标签与模型名，「执行（agent）」tab 被 `uiMode !== 'agent'` 条件排除、不显示。现对所有 tab 展示后端标签；模型名按 tab 区分——对话/客服/自动显示文本模型（`localModel` / `cloudModel`），执行 tab 显示其实际看屏决策所用的**视觉模型**（`localVisionModel` / `cloudVisionModel`），避免把执行闭环误显示成文本模型。清空按钮仍仅非执行 tab 渲染。

## 2026-09-14（三续）· 状态探活覆盖视觉模型 + 云端可测

### 修复

- **状态探活覆盖视觉模型**（`ee036de`）：`GET /ai-agent/status` 此前只校验文本模型（云端 `cloudModel` / 本地 `localModel`），导致视觉模型（云端 `cloudVisionModel`）填错时状态仍显示正常、只有真正点「开始执行」才报错。现与 `runner.ts` 的 `agent:start` 预检对齐——云端并发校验 `cloudModel` + `cloudVisionModel` 两次多模态自检，本地校验 `localModel` + `localVisionModel` 两个 Ollama 模型是否已拉取；响应新增 `visionModel` / `visionReachable` / `visionError` 字段，失败时回传具体中文错误。
- **云端后端开放「检测连接」**（`ee036de`）：设置页 AI Agent 区块原先只有本地 backend 渲染「检测连接」按钮与状态文案，云端用户无法在保存前预检。现两个 backend 共用 `renderAiStatus()`，云端也展示检测按钮与（文本 + 视觉）连通结果；新增 `aiAgent.statusCloudReachable` 四语 key。

## 2026-09-14（再续）· Agent 执行闭环支持云端 BYOK 视觉模型

### 新增

- **Agent 执行闭环云端视觉模型**（`e2873a7`）：视觉适配器 `src/main/agent/vision.ts` 按 `backend` 分支——本地走 Ollama 视觉模型，云端走 BYOK 多模态模型（`cloudVisionChat`，OpenAI 兼容 chat/completions 多模态消息，截图以 `image_url` 传入）。新增「视觉模型（云端）」设置项 `AIAgentSettings.cloudVisionModel`（`src/shared/types.ts`），与文本对话的 `cloudModel` 分开配置；设置页（Settings.tsx）与四语 i18n 同步补充，提示文案引导用户到各厂商官网确认可用的多模态模型名。`runner.ts` 的 `agent:start` 预检在云端后端下改为校验 `cloudVisionModel` 的连通性与多模态支持。FEATURES §13 同步更新。

## 2026-09-14（续）· 对话保活 / 云端 BYOK / UI 修复 / 文档重构（11 commits）

### 新增

- **云端 BYOK 对话链路**（`c56b03c`）：新增 `src/main/agent/cloud.ts`，统一 DeepSeek / 通义千问 / 智谱 GLM / OpenAI 的 OpenAI 兼容 `chat/completions`（Bearer 鉴权，base URL 可自定义覆盖代理 / 私有部署）；`/ai-agent/chat` 与 `/ai-agent/status` 在 `backend=cloud` 时走云端，本地 Ollama 仍为默认零费路径（FEATURES §13 同步更新，`741b0d0`）。
- **对话态模块级 store**（`45171b4`）：新增 `src/renderer/src/agentChatStore.ts`，把对话内容 / 输入框残值 / 当前标签页（自动 / 对话 / 客服 / 执行）提到模块作用域（`useSyncExternalStore`），切到其它页面再切回不再清空对话、也不会回落到默认 auto 标签。

### 修复

- **云端调用 Key 去空白**（`15056fd`）：发送前对 API Key / 模型名统一 `trim()`，避免复制粘贴带入的空格 / 换行被 DeepSeek 等厂商判为「无效 Key」(401)。
- **看板底部卡片不等高 / 暗色暂无数据黑字 / 设置按钮贴死**（`ec018bd`）。
- **AiAgent 执行截图边框硬编码暗色值不可见**（`1eaa4c8`）：改用主题色 `colorBorderSecondary`。
- **看板代理到期提醒文案未走 i18n**（`4028fa1`）：新增 `dashboard.proxyExpiring` 多语言 key（中英日德）。

### 文档 / 其它

- **知识源改为多文档**（`785f399`）：Support 客服检索 README + FEATURES，不再只读 README，避免 README 精简后答不了功能类问题。
- **文档结构重构**（`adec312`）：新增本 CHANGELOG.md 与 FEATURES.md，README 精简为「架构 · 文件作用 · 运行命令」。
- **设计文档归档**（`125a842`）：`AI_AGENT_FREE_DESIGN.md` 的设计参考并入 FEATURES.md 附录，原文件移入 `.workbuddy/archive/` 本地留存。
- **仓库清理**（`e88a1fd`）：`.gitignore` 忽略 `.workbuddy/`（本地记忆 / 数据不再入库），并取消已误跟踪的内存文件。

---

## 2026-09-14 · AI Agent 执行链路稳定性（4 commits）

### 新增

- **navHint 搜索直达**（`8f45e69`）：解析指令里点名的站点与搜索词，直接算出**结果页 URL**（如 `bing.com/search?q=Electron`），让 Agent 用一次 `navigate` 拿到结果页，绕开对弱视觉模型极不友好的「点搜索框→键入→回车」链路。新增 `src/main/agent/navHint.ts`。
- **视觉模型抖动容错**（`8f45e69`）：单次 VLM 调用失败不再 abort 整轮，跳过本步并保留已有进度重试，连续失败 3 次才判定本轮失败。
- **执行态提到模块级 store**（`ffcea51`）：新增 `src/renderer/src/agentStore.ts`，执行状态改为模块作用域 + `useSyncExternalStore`，IPC 订阅进程级只注册一次。
- **搜索类输入框自动提交**（`4081349`）：检测到焦点落在搜索框时，即便模型没给换行也自动补一次回车。

### 修复

- **切到其它标签再切回，执行数据被清空**（`ffcea51`）：执行态原本放在组件 `useState` / `useRef`，路由卸载即丢失，且新实例 runId 为 `null` 会过滤掉主进程仍在推送的事件。
- **输入框填不进字**（`4081349`）：`sendInputEvent` 键盘事件只投递到**已聚焦的 DOM 元素**，此前只做了窗口级 focus。新增 `focusInputAt()`，用 `elementFromPoint` 精确定位后再 focus。
- **字填进去了但不搜索**（`4081349`）：① 回车发在兜底设值**之前**，真实按键失效时回车打在空输入框上；② JS 直接改 `value` + `dispatchEvent` 是**不可信事件**，站点框架状态不更新，实际提交的是空查询 → 改用 `webContents.insertText()` 可信插入，并把回车挪到值确认写入之后。
- **UnknownVizError**（`a007831`）：截图改为**只截视口**（`capturePage` 不传参会截整页，可达数千 px 高，既破坏「坐标与截图 1:1」约定也易触发 Ollama 内部视觉错误）；不再给 Ollama 传 `format:'json'`（structured output 与 vision/images 冲突）；先 `res.text()` 再 `JSON.parse`，并透传 Ollama 的真实错误信息而非掩盖成「未 pull 模型」。

---

## 2026-09-13 · AI Agent 从 0 到 1 + 对标官方集中补齐（约 50 commits）

### 新增

**AI Agent（本地大模型 · 零 token）**

- **执行闭环**（`00f3887`）：Route A「截图 + DOM → 本地 VLM → `sendInputEvent`」，新增 `src/main/agent/{vision,dom,actions,session,runner}.ts`；原子动作 `click` / `type` / `navigate` / `scroll` / `wait` / `finish` / `ask`。
- **矩阵并行**（`6fd56e4`）：Supervisor 并发驱动 N 个环境（上限 5），父子双层 runId，结果按环境分别回报。
- **闭环资产化**（`9d65fd3`）：执行动作序列归一化为 RPA 步骤，可存为模板脱离 AI 离线回放（零推理成本）。
- **原生 navigate 动作**（`aa22743`）：主进程直接 `webContents.loadURL`，避免弱视觉模型在地址栏输入失败。
- **三模式**（`b291fac` / `9fb6c66` / `93dedfe`）：本地 Ollama 接入与设置面板、Chat 对话、Support 产品客服 + Dispatcher 意图路由。
- **AI 执行写入操作日志**（`14442d7`）。

**环境 / 代理 / 团队 / 账号**

- 环境软删除回收站（恢复 / 彻底删除）（`01ed8a7`）
- 环境批量操作（移动分组 / 绑定代理 / 删除 / 打开）（`8ffd6d2`）
- 环境手动切换线路，从 IP 池换一条**不同**的代理（`0e058e5`）
- 代理到期提醒（列表预警 + 看板卡片）（`7a8dab6`）
- 代理匿名度检测与展示（`786e511`）
- 代理 IP 扫码导出二维码（`658ca93`）
- 团队图标自定义上传（`99cf0f3`）
- 邀请成员支持勾选系统内已有成员批量加入（`9529040`）
- 账号密码查看 / 批量导出按角色控权（`ba77bcc`）
- 账号导入支持标准模板下载与表头 / 注释行自动跳过（`6e08174`）
- 创建窗口指纹表单按「基础 / 高级」分组（`c255288`）

**设置 / RPA / 性能 / 看板**

- 设置页内核版本展示（`6a4c416`）、任务栏支持显示窗口名称（`3f4248b`）、自定义代理作为客户端联网方式（`2791630`）
- RPA 运行日志滚动面板，5s 自动刷新（`ce9dc7b`）
- 启动速度优化：渲染层 vendor 分包 + 路由懒加载（`ba51b5f`）
- 图表悬停高亮动效与数值气泡（`b0171f7`）
- 敏感操作日志标记（高亮 + 筛选 + 看板计数）（`34a9437`）

### 修复

- 暗黑模式切换页面时右侧白闪（`b487815`）
- 大图标存不进去且无提示，上传旁补充大小标注（`8457a88`）
- Agent 启动前预检视觉模型是否已 pull，避免执行中途 404（`31c8d7c`）
- 运行前预检覆盖 Ollama 未启动 + 执行前聚焦目标窗口（`d9fb184`）
- Settings 状态文字重叠 + Agent 执行无反应（`2191d7c`）

---

## 2026-09-06 · 数据看板与登录体验（14 commits）

### 新增

- 全局概览数据看板页面 `/dashboard`（`4371dd1`）
- 营销落地页 Hero 区块（`218987e`）
- 登录页左侧科技感安全主题视觉（`644d0c2`）
- 图表组件抽离到 `charts.tsx` 并做 SSR 冒烟验证（`21da8ff`）

### 修复

- 看板页面崩溃不再拖垮整个应用（`26cfb28`）
- `/dashboard` 路由移入 AppLayout 布局内，修复点进去后左侧导航消失（`7514210`）
- 登录卡片强制浅色主题，修复暗色模式下输入框黑底 + 文字看不见（`bdaab4c`）
- 顶部时间改为每秒走动的实时时钟（`fe7d199`）
- 看板图表：底部条形图字号（`693007e`）、按卡片高度自适应填充（`83b0563`）、按真实宽度 1:1 渲染解决字号被缩小（`41dc4a7`）、趋势图与状态分布卡片等高对齐（`c301dd9`）
- 编辑环境抽屉空白——规整不完整指纹防止渲染崩溃（`8ffadc3`）

---

## 2026-09-05 · 指纹增强、RPA、国际化与整环境迁移（约 30 commits）

### 新增

- 移动端指纹模拟（Android / iOS）（`8176f85`）
- 指纹预设库（内置验证过的指纹组合，一键套用）（`98cac0f`）
- 字体指纹随机化，防御字体枚举（`46019f8`）
- RPA 脚本录制与回放（`86ad39c`）
- RPA 变量替换 + 导入导出 + v1 触发端点（`9a8a0b8`）
- RPA 定时任务到点自动执行 + 运行日志（`d6495b4`）
- 整环境迁移：单环境导出 + 导入按字段直接映射（`bb9cf99`）
- i18n：国家切换 + 当地时间自动匹配（含冬夏令时）+ 中英日德多语言（`2948a64`）
- 扩展管理（浏览器插件，按环境启用）（`31051ce`）
- 快速创建环境（一键随机指纹 + 自动开窗）（`697a0de`）
- v1 创建环境支持 `templateId` 模板复用（`6d32d89`）
- 顶栏右上角 CPU / 内存占用指示（`7358170`）
- 账号一键复制 + 新建环境从账号带入平台 / 起始页（`51dbc66`）
- Cookie 自动化端点 + RPA 脚本详情（`5d2a2a6`）

### 修复

- 启动自愈：重置残留 `running` 状态，避免假性「运行中」（`2d60717`）
- UA-CH（`userAgentData`）平台穿透与桌面 `maxTouchPoints` 泄漏（`1e7dd16`）
- 生成的指纹 `tzOffset` 与 `timezone` 自相矛盾且随宿主机漂移（`aecd633`）
- 新建环境点击无反应（指纹未就绪导致抽屉不渲染）（`53caaf9`）
- 保存时必填项校验失败无提示（`858c89f`）
- MySQL 连接统一按 UTC 解释 DATETIME，修正时间整体偏移 8 小时（`963cc0e`）
- 操作日志时间按所选地区时区显示（`e054783`）
- 托盘改为单击打开主窗口（`bffcb77`）
- 起始页三处问题：暗色下文字不可见、搜索写死 Google 不可达、快捷导航无说明（`1632eab`）；导航改走主进程不再「点了没反应」（`ce17956`）；快捷导航回填与点击反馈（`0d74e2c`）
- 起始页代理预警，失败原因带上具体代理地址（`d2e1806`）
- 暗黑模式下静态 message / 弹层 / 全局 reset 跟随主题（`cba1fed`）

---

## 2026-09-04 · 项目起步（约 25 commits）

### 新增

- **项目架构实现**（`322f140`）：Electron 主进程 + 内嵌 Express / TypeORM 本地服务 + React 渲染层
- 主窗口关闭时驻留托盘，保持后台服务（`6ac5d59`）
- 环境与代理批量导入导出 + 端口发现（`9b196f4`）
- 代理 IP 池：地区字段、池状态、一键分配与统计（`ac0ef60`）
- 系统设置页（全局默认配置）（`42f6b78`）
- 账号批量导入 / 导出（`6e37963`）
- 代理定时巡检（自动检测 + 可配置间隔）（`296a0e3`）
- 三态主题开关（白天 / 黑夜 / 自动）（`3aec525`）与暗黑模式系列适配（`99da884` `d1981b1` `b8f5223` `3142ab9`）
- Cookie 管理（按环境隔离 + 自动注入 + 多格式导入）（`10e0579`）
- 自动化 API v1 写入类（环境 / 代理 / 账号 CRUD + 分配 + 检测 + 指纹）（`b13a9f1`）
- 账户级隔离，管理员 / 普通用户数据互不互通（`cd4ba58`）
- 自动主题时段可配置（`91be5a5`）
- 依赖升级：React 18→19.2.8 + antd 5→6.6.2（`ac26f0b`）、Vite 5.4→7.3.6 + electron-vite 2.3→5.0.0（`22bc118`）、Electron 33.4→44.2.0 + @types/node 22→24.13.3（`eb6351e`）

### 修复

- `pnpm dev` 启动失败：Cookie 实体 `value`(TEXT) 误设 DEFAULT（`89277ca`）
- 设置页 `useEffect` 无限重渲染导致点击卡死（`5e394d1`）
- 主题开关选中指示卡住（`27af752`）、合并 `useIsDark` 重复定时器为模块级单例（`6c891f9`）
- 代理 IP 池表格在窗口最小宽度下字段挤压（`9eb1b9b`）
