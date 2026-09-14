# RoxyBrowser Clone · 功能说明

本文件汇总各模块的**功能详细说明与接口示例**（环境 / 指纹 / 代理 / RPA / Cookie / 扩展 / 账号 / 看板 / AI Agent 等）。

- 技术架构、目录结构、运行与打包命令 → [README.md](./README.md)
- 按时间排序的功能新增与问题修复 → [CHANGELOG.md](./CHANGELOG.md)
## 已实现功能（对标官网）

### 1. 环境管理（多账号防关联）

- 无限创建浏览器环境，每个环境独立 `session`（`persist:env-{id}`），Cookie / 缓存 / localStorage 完全隔离
- 环境列表：序号、名称、分组、平台标签、指纹摘要、绑定代理、运行状态、最后打开时间
- 批量打开 / 批量关闭、搜索、按分组筛选、5 秒轮询刷新运行状态
- 每个环境可设置起始页 URL，打开后进入内置新标签页（地址栏 + 快捷入口 + 当前指纹摘要）
- **手动切换线路**（对标官方）：环境列表「切换线路」按钮从 IP 池分配一条**不同的**可用代理替换当前绑定（旧线路自动释放回池；池中无空闲代理时复用已占用代理）；运行中的环境只改绑定，**重启后生效**（按钮与日志均有提示）
- 创建 / 编辑环境的指纹表单按**「基础设置 / 高级设置」分组**（对标官方 4.0.3）：操作系统、UA、语言、时区、屏幕等常用项默认展开；Navigator Platform、CPU / 内存、字体列表、WebGL、噪声开关等细粒度项折叠在「高级设置」中，减少首屏干扰
- **状态自愈**：Electron 进程退出时所有窗口都会销毁，启动时自动把 DB 中残留的 `running` 状态重置为 `idle`，避免「界面显示运行中、实际无窗口」导致打开 / 关闭 / RPA 回放全部失灵（重启不会自动重开之前运行的环境，需手动重新打开）

#### 1.1 整环境迁移（导出 / 导入单环境）

把一个环境**完整打包成单个 JSON 文件**、再在另一台机器 / 另一个团队空间里原样还原，用于跨设备备份与资料迁移。打包内容包含：指纹配置、分组、代理（连接信息）、账号、Cookie、扩展名。

- **导出**：环境列表每行「导出」按钮 → `GET /api/profiles/export/:id`，浏览器以附件下载 `roxy-profile-<名称>.json`。
- **导入**：导入弹窗粘贴内容或选择该文件 → `POST /api/profiles/import`。支持三种入参：整环境单对象导出文件（含 `name`）、`{ items: [...] }`、裸数组 `[...]`。
- **导入映射规则（导出字段直接被导入消费，所有 id 在导入端重新生成）**：
  - `name / platform / startUrl / remark / fingerprint`：原样写入新环境；`fingerprint` 缺失则随机生成。
  - `group`：按**名称**匹配已有分组，没有则新建。
  - `proxy` + `proxyDetail`：按**名称**优先复用已有代理；没有同名代理且 `proxyDetail.host/port` 齐全时，按 `proxyDetail` 就地新建代理。
  - `extensions`：导出的是**扩展名称数组**，导入端按名重映射回扩展 id；目标环境没有同名扩展则丢弃该引用（扩展实体含本地目录文件，无法跨设备重建，仅保留名称引用）。
  - `accounts`：逐条重建并绑定新环境（含平台 / 账号 / 密码 / 备注）。
  - `cookies`：逐条重建并绑定新环境（含 domain / name / value / path / Secure / HttpOnly / SameSite / 过期时间 / hostOnly）。
- 返回 `{ created, items, groupsCreated, proxiesCreated, accountsCreated, cookiesCreated }` 汇总新建数量。
- 与「批量导出 / 导入」（`GET /api/profiles/export` 数组 ↔ `POST /api/profiles/import`，见上 §批量导入 / 导出）共用同一导入器，只是整环境导出是**单对象**形态。

```bash
# 导出单个环境（保存为 roxy-profile-<name>.json）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:39100/api/profiles/export/12 -o roxy-profile-12.json

# 导入该文件（单对象直接投递，无需包一层 items）
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:39100/api/profiles/import \
  -d @roxy-profile-12.json
```

### 1.2 环境克隆工厂（批量派生 · 行为一致 / 指纹各异）

以某个环境为母本一键派生 N 个副本，用于「再开 N 个一样的号」这类批量开号场景。

**为什么不能原样复制指纹**：原样复制会让 N 个号共用同一套设备特征（分辨率 / CPU / 内存 / 显卡 / 字体全同），平台一比对即判定为同一批设备。因此 `deriveJitteredFingerprint()`（`src/shared/fingerprint.ts`）把字段分成两类：

| 类别 | 字段 | 理由 |
| -- | -- | -- |
| **保持**（行为一致） | 系统、UA / UA 版本、平台、语言、时区、时区偏移、DoNotTrack、WebRTC 策略、触摸、像素比、噪声开关 | 决定「像不像同一类用户」，共享才有批量运营的意义 |
| **抖动**（指纹各异） | 分辨率、CPU 核数、内存、显卡（Vendor / Renderer）、字体列表 | 设备指纹的高区分度项，各副本互不相同 |

Canvas / Audio 噪声无需额外处理——preload 的噪声种子由 `profileId` 派生（`seed = profileId * 2654435761`），新建环境拿到新 id，噪声天然互不相同。

**接口**：`POST /api/profiles/:id/duplicate-batch`，body `{ count: number(1–50), namePrefix?: string, copyAccounts?: boolean }` → `{ created, items: [{ id, name }] }`。

**边界**：

- 不复制 **Cookie**——登录态复制过去等于主动制造关联；
- 不继承代理绑定（`proxyId` 置空），需另行从 IP 池分配；
- 账号资料默认不复制，可显式传 `copyAccounts: true`；
- 模板环境（`isTemplate`）拒绝克隆；数量上限 50。

```bash
curl -X POST http://127.0.0.1:39100/api/profiles/12/duplicate-batch \
  -H "Authorization: Bearer <会话令牌>" -H "Content-Type: application/json" \
  -d '{"count":10,"namePrefix":"美区店铺","copyAccounts":false}'
```

> 与 `POST /api/profiles/:id/duplicate`（单个复制、**指纹原样**）的区别就在微抖动：批量开号用本接口，单环境资料迁移用前者。

### 1.3 全空间快照（团队整体打包 / 迁移）

把整个团队空间打包成单个 JSON 一键备份 / 迁移，解决「换机器 / 重装 / 整机迁移」时逐模块导出的繁琐与易漏。

- **内容范围**：环境（整环境结构，含指纹 / 分组 / 代理 / 账号 / Cookie / 扩展名引用）+ 代理池（结构化，保留国家 / 地区 / 到期等元信息）+ RPA 脚本 + 扩展元数据引用。
- **导出**：`GET /api/snapshot/export` → 直接下载 `.json`（文件名含团队 id 与时间戳）。
- **导入**：`POST /api/snapshot/import`，body 为快照 JSON → `{ profiles, proxiesCreated, proxiesSkipped, rpaCreated, extensionsReferenced }`。
- **复用既有导入器**：导出 / 导入直接复用 `src/main/exporters.ts` 中「整环境迁移 / 代理批量 / RPA」各模块的既有逻辑，保证单模块迁移与整团队迁移同源、字段一致。
- **导入顺序**：先恢复代理池（按名称复用，缺失则新建）→ 再导入环境（引用同名代理）→ 最后导入 RPA（定时配置重置为关闭）。扩展按名称重映射，目标缺同名扩展则忽略引用。
- **校验**：导入前用 `validateSnapshot()`（`src/shared/snapshot.ts`，纯函数）严格校验 `format` / `version` / `profiles[]`，非法文件直接 400 拒绝，不污染数据库。
- **定时自动备份**：设置页「空间快照」分区可开启，按设定间隔（小时）把**每个团队空间**自动打包写入本地目录，每个团队保留最近 7 份（按文件名时间戳排序，超出自动清理），目录不存在 / 不可写时静默跳过、不报错。复用代理巡检式 `setInterval` 调度器（保存设置即重启调度），逻辑集中在 `startSnapshotBackupScheduler()` / `runSnapshotBackupAll()`（`src/main/server.ts`）；文件复用 `buildSnapshot()`（`src/main/exporters.ts`，与手动导出 / 导入同源），保证自动备份与手动快照字段完全一致。

### 1.4 发布与自动更新

对标官方可分发产品形态：打包产物默认不签名，正式分发可一键接入代码签名；并内置基于 `electron-updater` 的自动更新。

- **代码签名（证书就绪）**：`electron-builder.yml` 已配置 `win.signingHashAlgorithms: [sha256]`，签名经环境变量 `CSC_LINK`（`.pfx` 路径 / URL）与 `CSC_KEY_PASSWORD` 驱动——本地 / CI 无证书时自动跳过、仅告警，不破坏构建。正式发布在签名机设置两变量后执行 `pnpm dist` 即可，主程序 exe 与 NSIS 安装包会被自动签名；Portable 版为 7z 自解包无法签名，仅作内部分发。
- **自动更新（electron-updater）**：`src/main/updater.ts` 在主进程接入 `autoUpdater`，仅打包安装版（`app.isPackaged`）生效，开发态只推送 `{ state: 'dev' }`；采用 manual 模式（自动检查但不自动下载，由用户在设置页「关于」区确认后再下载 / 安装，避免打断多账号操作）。
  - 更新源由 `electron-builder.yml` 的 `publish.generic` 决定（默认占位 `https://update.roxyclone.com`），可用环境变量 `UPDATE_FEED_URL` 在运行时覆盖。执行 `pnpm dist` 时生成 `latest.yml` 与安装包并上传到该地址。
  - 主进程经 IPC `app:update-status` 推送状态，渲染端 `window.roxy.onUpdateStatus` 订阅；设置页提供「检查更新」按钮与状态展示（发现新版本 → 下载并安装 → 立即重启安装），四语 i18n（`update.*`）。

```bash
# 导出当前团队快照
curl -H "Authorization: Bearer <会话令牌>" http://127.0.0.1:39100/api/snapshot/export -o roxy-snapshot.json

# 新机器一键灌入
curl -X POST http://127.0.0.1:39100/api/snapshot/import \
  -H "Authorization: Bearer <会话令牌>" -H "Content-Type: application/json" \
  -d @roxy-snapshot.json
```

> 扩展实际文件（`.crx` / 目录）不进快照（无法序列化），仅记录名称用于还原时按名重映射；如有同名扩展则自动挂回，否则忽略该引用。

### 2. 浏览器指纹（软件 + 硬件全维度模拟）

一键随机生成一整套**自洽**的指纹参数（操作系统 / UA / 语言 / 时区 / 分辨率 / CPU / 内存 / 显卡），也可逐项手动微调：

- **桌面 + 移动端**：支持 Windows / macOS / Android / iOS 四种形态。UA-CH（`navigator.userAgentData`）全平台接管——`brands` / `platform`（Windows / macOS / Android）/ `mobile` 与 `getHighEntropyValues` 高熵字段均与 UA 严格一致；移动端额外注入触摸能力（`maxTouchPoints`、`ontouchstart`）、`devicePixelRatio`；iOS 按 Safari 形态（移除 `userAgentData`），环境窗口按手机尺寸打开。
- **指纹预设库**：内置十余套「验证过的指纹组合」（如 `Windows 11 · Chrome 129 · 德国`、`Pixel 8 · Android 14 · 美东`、`iPhone 15 Pro · iOS 17.5 · 美西`），各字段之间保证一致（UA ↔ 平台 ↔ GPU ↔ 屏幕 ↔ 时区语言），一键套用，避免手工拼出互相矛盾的指纹。
- **内核版本切换（Chrome 大版本）**：指纹表单「内核版本 (Chrome)」下拉可选 **127–132** 任一版本——仅替换 UA 串里的 Chrome 大版本号（如 `Chrome/129.0.6668.100`），同步更新 `uaFullVersion` 与 UA-CH 客户端提示（`navigator.userAgentData`），让同一套设备指纹在不同时期表现为不同浏览器版本（对标官方「内核版本」切换）。iOS 走 Safari/WebKit，不走此路径（下拉自动隐藏）。
  - 切换由 `applyCoreVersion()`（`src/shared/fingerprint.ts`）实现：正则会把 UA 里的 `Chrome/[\d.]+` 整体替换，保持操作系统 / 平台 / 设备型号等其余字段不变，因此不会出现「Chrome 132 的 UA 却配着 Chrome 127 的 UA-CH」这类不自洽。
  - `POST /api/fingerprint/random` 支持 `body.coreVersion` 透传——随机指纹时即尊重所选内核；`normalizeFingerprint`（旧数据/缺字段规整）、`presetFingerprint`（预设套用）、克隆工厂（`deriveJitteredFingerprint`）均会正确保留或推导该字段，存储层无新增迁移需求（`Fingerprint.coreVersion` 为普通可选数字列）。

| 维度       | 实现方式                                                                                |
| ---------- | --------------------------------------------------------------------------------------- |
| User Agent | 请求头 + `navigator.userAgent` + `navigator.userAgentData`（含 `getHighEntropyValues`） |
| 平台       | `navigator.platform`、UA 品牌与平台版本                                                 |
| 语言       | `navigator.language` / `navigator.languages`                                            |
| 时区       | `Date.prototype.getTimezoneOffset` + `Intl.DateTimeFormat.resolvedOptions()`            |
| 屏幕       | `screen.width/height/availWidth/availHeight`（移动端含 `devicePixelRatio`）             |
| 硬件       | `hardwareConcurrency`、`deviceMemory`                                                   |
| 触摸       | 移动端 `maxTouchPoints=5`、`'ontouchstart' in window`                                   |
| Canvas     | `toDataURL` / `getImageData` 注入**确定性噪声**（同环境稳定、异环境不同）               |
| WebGL      | `getParameter(37445/37446)` 返回自定义 Vendor / Renderer                                |
| Audio      | `AudioBuffer.getChannelData` 加入极小幅度噪声                                           |
| WebRTC     | 可禁用 `RTCPeerConnection`，防止真实 IP 泄漏                                            |
| 字体       | 伪造「已安装字体」列表（按 OS 取基础集 + 随机子集）；`document.fonts.check/load` 与 `Canvas.measureText` 防护，杜绝宿主机字体泄漏 |

> **指纹池覆盖范围**（`src/shared/fingerprint.ts`）：Windows 显卡 13 种——Intel Arc A/B 系列与 Iris Xe、NVIDIA RTX 30/40 系（含 4070/4080/4090）、AMD RX 6600 / 7800 XT，并保留 GTX 1650、UHD 630 等老型号以模拟长期未升级的机器；Mac 显卡 6 种（Apple M1–M4 / M4 Pro）；分辨率 9 种（1366×768 – 3440×1440）。池子越宽，随机与批量派生的重复率越低。

相关接口：`POST /api/fingerprint/random`（body `os` 可选 `windows|mac|android|ios`）、`GET /api/fingerprint/presets`。

### 2.1 环境体检（伪装度评分 + 一致性红绿灯）

「配置保存成功」不等于「指纹真的注入生效了」。体检把**数据库里的设定指纹**与**环境窗口内真实回读值**逐项对撞，回答两个问题：注入生效了吗？四件套自洽吗？

- **入口**：环境列表每行「体检」按钮（需环境已打开；未打开时提示先开窗）。
- **接口**：`POST /api/profiles/:id/healthcheck` → `{ score, items[], consistency[], checkedAt, proxyCountry }`。
- **伪装度 0–100**：按加权项计算，逐项展示「设定值 / 实测值 / 是否正常」，不适用项不计入总分：

  | 检查项 | 权重 | 实测来源 |
  | -- | -- | -- |
  | User Agent / 平台 / 语言 | 12 / 8 / 8 | `navigator.userAgent`、`platform`、`languages` |
  | 屏幕分辨率 | 8 | `screen.width` / `height` |
  | 时区 / 时区偏移 | 12 / 8 | `Intl.DateTimeFormat().resolvedOptions().timeZone`、`Date.getTimezoneOffset()` |
  | WebGL 显卡 | 10 | `getParameter(37445)` / `(37446)` |
  | UA-CH（userAgentData） | 8 | `platform` / `mobile`（iOS 伪装时必须整体不存在） |
  | CPU 核心 / 内存 / DNT | 4 / 4 / 2 | `hardwareConcurrency`、`deviceMemory`、`doNotTrack` |
  | 触摸能力 | 4 | `maxTouchPoints`、`'ontouchstart' in window` |
  | Canvas 噪声 | 6 | `HTMLCanvasElement.prototype.toDataURL` 是否被改写 |
  | Audio 噪声 | 5 | `AudioBuffer.prototype.getChannelData` 是否被改写 |
  | WebRTC | 8 | `RTCPeerConnection` 是否不可用 |
  | 字体防泄漏 | 5 | `document.fonts.check` 是否被改写 |

- **噪声 / 防护类不看配置、看注入是否真挂上**：通过判断原型方法是否被改写来实测——原生方法的 `toString()` 含 `[native code]`，被 JS 覆盖后是普通函数源码。因此能发现「配置存了但注入没生效」这类问题。
- **一致性红绿灯**（关联高危信号，不计入伪装度分）：

  | 检查项 | 含义 |
  | -- | -- |
  | 时区 ↔ 代理出口国家 | 时区所属国家与代理出口 IP 国家是否一致 |
  | 语言 ↔ 时区国家 | 浏览器语言地区与时区国家是否一致 |
  | UA 平台 ↔ 设定系统 | UA 解析出的平台与设定 OS 是否一致 |

  未绑定代理或代理未检测时显示「未检测」（灰色），不判红。
- **环境限制不误报**：无 GPU 环境创建不出 WebGL 上下文时，该项标记「不适用」且权重置 0，不会被当成注入失败。

> 实测值取自环境窗口内真实读取，因此体检**必须在环境窗口运行时执行**（与 RPA 录制要求一致）；窗口未运行会返回 400。

### 3. 代理 IP

- 支持 HTTP / HTTPS / SOCKS5，带用户名密码
- 一键检测：通过代理访问 ip-api.com，回写出口 IP、地区、延迟、可用状态，并判定**匿名度**
  - 判定依据：请求头出现 `X-Forwarded-For` / `X-Real-IP` 等 → 透明（泄露真实 IP）；仅出现 `Via` / `Proxy-Connection` → 匿名（看得出用了代理但未泄露 IP）；都没有 → 高匿；回显服务不可达则显示「未检测」（尽力而为，不影响主检测结果）
- 绑定到环境后，该环境窗口的所有流量走此代理（`proxyBypassRules` 已排除本地地址）
- **IP 池视角**：按「是否被环境占用 + 是否过期 + 检测状态」计算每个代理的池状态（空闲 / 使用中 / 已过期 / 失效）
- **一键分配**：优先分配空闲代理，可按地区筛选，可选直接绑定到指定环境
- **批量导入 / 导出**：支持 `类型:主机:端口:用户:密码` 一行一条的批量导入，以及列表导出
- **定时巡检**：按设置页「定时巡检间隔」（分钟，0=关闭）自动检测全部代理并回写状态，应用启动即开始调度
- **扫码导出**：列表每行「扫码」按钮生成该代理的配置二维码（编码为标准代理 URI `type://user:pass@host:port`），手机第三方代理工具扫码即可一键导入，免去手动输入主机 / 端口 / 账号密码

### 4. 窗口模板

保存一套指纹 + 平台 + 起始页配置，一键「从模板创建环境」，保证环境设置的完美一致性。

### 5. 多窗口同步（键鼠轨迹级）

开启后，任意环境窗口的操作会实时重放到其它环境窗口，适合批量发帖、互动、监控。

同步的事件类型：

| 类别 | 事件 |
| --- | --- |
| 鼠标 | `mousemove` / `mousedown` / `mouseup` / `click` / `wheel` |
| 键盘 | `keydown` / `keyup`（含 Ctrl / Alt / Shift / Meta 组合键） |
| 表单 | `input` / `change` / `focus` |
| 页面 | `scroll` |

实现要点（区别于简单的坐标广播）：

- **元素锚定**：事件位置编码为「稳定 selector + 元素内相对坐标」，而不是裸视口坐标。优先使用 `id` / `data-*` / `aria-label` / `name` 等稳定属性，退化时才用结构路径，因此各窗口尺寸不同也能命中同一控件；命中元素比视口还大时自动改用视口相对坐标，避免相对坐标被放大失真。
- **轨迹插值**：鼠标移动不是一次性跳转，而是沿带随机弧度的二次贝塞尔曲线、按缓动逐点派发 `pointermove` + `mousemove`。源窗口发 1 个 `mousemove`，目标窗口会重现出十余个连续采样点，轨迹形态接近真人。
- **完整按键序列**：`click` 不会直接调 `element.click()`，而是重放 `mousedown → mouseup → click` 并带随机按压时长；`click` 由「按下与抬起落在同一元素」配对补发（模拟内核行为），避免与来源的 `click` 事件叠加导致目标窗口被点两次。
- **视口纠偏**：目标元素不在视口内时先 `scrollIntoView` 再重新计算落点，落点始终钳制在视口范围内。
- **回环抑制**：重放期间用时间窗抑制自身采集（而非布尔开关），否则多帧轨迹动画会被自己的监听器二次采集并广播回去，形成回声放大。
- **同步范围可选**：开关旁可指定「只同步到哪几个窗口」，不选则同步到全部已打开窗口。

> 注意：同步的是**渲染层事件序列**。若目标页面用 `isTrusted` 做校验，合成事件仍是 `false`（这需要内核级注入，本项目未做）。

### 6. 团队协作

- 团队空间、成员邀请：支持**新建账号**（自动创建并加入）或**勾选系统内已有成员**一键批量加入，无需重复录入用户信息
- 角色权限：`owner` / `admin` / `member`
- 项目分组（文件夹）
- **团队图标自定义**：上传品牌或业务标识作为团队图标，多团队并行时一眼分辨。支持 JPG / PNG / WebP，单个文件 ≤ 2MB，边长超过 256px 会自动等比压缩后再存储；无图标时回退显示团队名首字母

### 7. 账号中心

每个环境可保存多个平台账号密码，团队无需互传密码即可协作。

支持**批量导入 / 导出**：可按「环境 + 平台/账号/密码」表格粘贴或上传文件导入，也可将某环境下的账号一键导出。导入弹窗提供**「下载模板」**（表头 + 两种格式示例 + 填写说明），解析时自动跳过表头行（`环境,…` / `平台,…` 开头）与 `;` / `//` 注释行，模板可直接填写后上传。

列表内每行账号 / 密码旁均有**一键复制**按钮（复制到剪贴板，不落日志、不改数据），便于快速粘贴到登录框或协作时转交。

**按角色控权**（对标官方 3.8.9）：`member` 角色的成员**看不到明文密码**（列表显示「无权限查看」，编辑弹窗密码框禁用）、**不能批量导出**（按钮禁用且接口返回 403），也不能修改账号密码；`owner` / `admin` 不受限。角色判定以数据库实时为准（不依赖登录时签发的 JWT），调整成员角色后**立即生效**，无需重新登录。

新建浏览器环境时，在「基本信息」页可用**「从已有账号带入」**选择器按账号回填「运营平台」与「起始页 URL」，减少重复填写（账号名 / 密码仍由账号中心统一管理，不在环境表单内存储）。

### 7.1 Cookie 管理（按环境隔离）

每个浏览器环境的 Cookie 独立持久化、独立注入，确保多账号登录态互不串号：

- **管理界面**：在右上角选择环境后，可对该环境的 Cookie 做增 / 删 / 改 / 清空，表格展示域名、名称、值、路径、Secure / HttpOnly / SameSite / 含子域属性与过期时间。
- **自动注入**：环境每次打开时，自动将该环境保存的 Cookie 写入对应 `session`，首屏即带登录态；环境运行中也可点击「立即应用」热更新到运行窗口。
- **批量导入**：支持三种业界通用格式——
  - Netscape cookie 文件（`domain\tflag\tpath\tsecure\texp\tname\tvalue`，`#HttpOnly_` 前缀识别 HttpOnly）
  - Set-Cookie 串（`name=value; Domain=...; Path=...; Expires=...; Secure; HttpOnly; SameSite=...`）
  - EditThisCookie / 本系统导出 的 JSON 数组
- **导出**：一键导出为 Netscape 文本，便于在浏览器插件 / 抓包工具间迁移。

后端接口：`GET/POST /api/cookies`、`PUT/DELETE /api/cookies/:id`、`DELETE /api/cookies`（清空）、`POST /api/cookies/import`、`GET /api/cookies/export`、`POST /api/cookies/apply`。

### 7.2 扩展管理（浏览器插件）

为每个浏览器环境安装并加载 Chrome 扩展（插件），用于广告拦截、翻译、爬虫脚本等场景：

- **扩展库**：在「扩展管理」页添加扩展，支持两种方式——
  - **本地路径**：直接填入本机已解压扩展目录的绝对路径（可指向 Chrome 用户数据目录下的 `Extensions/xxxx/版本` 文件夹）。
  - **上传目录**：选择本地已解压的扩展文件夹，前端递归读取后由后端解析 `manifest.json` 并保存到应用数据目录。
- **按环境启用**：在「环境管理 → 编辑环境」中勾选要启用的扩展；打开该环境窗口时自动用 Electron 的 `session.loadExtension` 加载。
- **隔离与权限**：扩展数据按账户隔离（同其他业务数据一致）；加载失败（扩展损坏或使用了 Electron 不支持的 API）仅告警，不影响窗口打开。

> ⚠️ Electron 只支持加载**解压后的扩展目录**，**不支持 `.crx` 打包格式**，且扩展必须在持久会话中加载（本工具每个环境使用 `persist:env-<id>` 持久会话，天然满足）。

后端接口：`GET/POST /api/extensions`、`GET /api/extensions/:id/icon`、`DELETE /api/extensions/:id`；环境绑定通过 `PUT /api/profiles/:id` 的 `extensions` 字段（扩展 ID 数组）。

### 7.3 RPA 脚本（录制与回放）

把重复操作固化成脚本，在任意环境窗口一键重放（如每日签到、批量上架流程）：

- **录制**：在「RPA 脚本」页选择一个**已打开**的环境 → 点「开始录制」→ 在环境窗口正常操作 → 点「停止录制」→ 命名保存。
  - 记录内容：点击（元素内相对坐标，与多窗口同步同一套「稳定 selector + 相对坐标」编码）、文本输入（连续输入只保留最终值）、下拉选择、滚动（合并为最终位置）、页面跳转。
  - 录制期间多窗口同步产生的重放事件会被抑制窗过滤，不会录进脚本。
- **回放**：选脚本 + 环境 → 后台逐步执行（每步间隔约 1 秒，`navigate`/`wait` 在主进程执行，其余经多窗口同步通道拟人化重放）；结果写入操作日志。
- **变量**：脚本可定义变量（如 `token`、`keyword`），步骤里的 `navigate.url` / `input.value` / `change.value` 用 `{{变量名}}` 引用。回放弹窗可逐变量覆盖（留空则用脚本默认值），便于同一脚本在不同环境复用时切换账号、搜索词等。
  - 未定义的占位符**保留原样**（方便排查「漏配变量」），不会抛错。
- **导入 / 导出**：每个脚本支持单独导出为 JSON（含步骤与变量，浏览器以附件下载）；「导入」按钮支持单对象、`{ "items": [...] }` 或数组，可一次导入多个脚本（定时配置重置为关闭）。导入导出格式成对，往返测试通过。
- **定时执行**（对标官方 4.0.2）：编辑脚本可开启「定时执行」+ 间隔分钟 + 目标环境。内置调度器每 30 秒扫描一次，到点且目标环境**处于运行态**才自动回放；环境未运行则跳过本轮并写日志，**绝不自动开窗**（自动拉起窗口会绕过用户对环境的显式控制）。执行中的脚本不会被重复触发。
- **运行日志**（对标官方 4.0.2 实时监控）：RPA 页底部「运行日志」面板滚动展示本团队 RPA 相关记录（手动回放 / 定时完成 / 定时失败 / 定时跳过 / 录制），最新在上、固定高度滚动、每 5 秒自动刷新。
- **隔离**：脚本按账户隔离（同其他业务数据一致）。

后端接口：`GET/POST /api/rpa`、`PUT/DELETE /api/rpa/:id`、`GET /api/rpa/export/:id`（导出）、`POST /api/rpa/import`（导入）、`POST /api/rpa/record/start|stop`、`GET /api/rpa/record/status`、`POST /api/rpa/:id/run`（回放，body 可带 `profileId` 与覆盖 `variables`）。

```bash
# 导出脚本（保存为 rpa-<id>-<name>.json）
curl http://127.0.0.1:39100/api/rpa/export/1 -H "Authorization: Bearer <会话令牌>" -o rpa.json

# 导入脚本（支持单对象 / {items:[...]} / 数组）
curl -X POST http://127.0.0.1:39100/api/rpa/import \
  -H "Authorization: Bearer <会话令牌>" -H "Content-Type: application/json" \
  -d @rpa.json
```

> 提示：回放的是合成事件（`isTrusted=false`），对校验该属性的反爬站点无效；脚本在不同页面结构（selector 失效）时对应步骤会被跳过。

### 8. 操作日志

所有关键操作（创建 / 修改 / 删除 / 打开环境、代理、成员、令牌）记录**操作人 + 时间 + 详情**，便于责任追溯。

**AI 执行同样记入日志**：每次 Agent 运行写一条「AI 执行开始」（指令 + 目标环境），每个环境结束各写一条「AI 执行完成 / 失败」（步数 + 结果 / 失败原因）。操作人为触发执行的登录用户，未取到时回落为 `ai-agent`；日志按目标环境所属团队隔离，不产生无归属的孤儿记录。

### 9. 自动化 API（v1）

本地 HTTP API + 令牌鉴权，可对接调度器与脚本：

```bash
# 创建环境
curl -X POST http://127.0.0.1:39100/api/v1/profiles \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"name":"API环境","platform":"Amazon"}'

# 打开 / 关闭环境窗口
curl -X POST http://127.0.0.1:39100/api/v1/profiles/1/open  -H "Authorization: Bearer <令牌>"
curl -X POST http://127.0.0.1:39100/api/v1/profiles/1/close -H "Authorization: Bearer <令牌>"

# 环境列表 / 代理列表
curl http://127.0.0.1:39100/api/v1/profiles -H "Authorization: Bearer <令牌>"
curl http://127.0.0.1:39100/api/v1/proxies  -H "Authorization: Bearer <令牌>"
```

成功响应统一为 `{ "code": 0, "data": ... }`；失败为 `{ "code": <HTTP 状态码>, "message": "..." }` 且带对应 HTTP 状态码。

#### 写入类接口（供脚本调度）

**环境（Profile）**

```bash
# 查询单条环境
curl http://127.0.0.1:39100/api/v1/profiles/1 -H "Authorization: Bearer <令牌>"

# 更新环境（可传 name / remark / platform / startUrl / groupId / proxyId / fingerprint 任意子集；groupId、proxyId 传空串解除关联）
curl -X PUT http://127.0.0.1:39100/api/v1/profiles/1 \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"name":"新名字","proxyId":3}'

# 删除环境（级联清理：关联账号、Cookie，并把绑定该代理的其他环境的 proxyId 置空）
curl -X DELETE http://127.0.0.1:39100/api/v1/profiles/1 -H "Authorization: Bearer <令牌>"
```

**代理（Proxy）**

```bash
# 创建代理（host、port 必填；type 默认 http）
curl -X POST http://127.0.0.1:39100/api/v1/proxies \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"name":"美国节点","type":"http","host":"1.2.3.4","port":8080,"username":"u","password":"p"}'

# 查询单条代理
curl http://127.0.0.1:39100/api/v1/proxies/3 -H "Authorization: Bearer <令牌>"

# 更新代理（name/type/host/username/password/remark/expiresAt 任意子集；port 为数字）
curl -X PUT http://127.0.0.1:39100/api/v1/proxies/3 \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"port":8899}'

# 删除代理（同时把关联环境的 proxyId 置空）
curl -X DELETE http://127.0.0.1:39100/api/v1/proxies/3 -H "Authorization: Bearer <令牌>"

# 从 IP 池分配代理（profileId 可选；country / region 可选过滤）。复用与 /api/proxies/allocate 同一分配逻辑，保证口径唯一
curl -X POST http://127.0.0.1:39100/api/v1/proxies/allocate \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"profileId":1,"country":"US"}'

# 检测代理连通性（更新 status / latency / country / region / city / isp / exitIp / lastCheckAt）
curl -X POST http://127.0.0.1:39100/api/v1/proxies/check \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"id":3}'
```

**指纹（Fingerprint）**

```bash
# 随机生成指纹（os 可选：windows / mac / android / ios，缺省按默认 OS 池）
curl -X POST http://127.0.0.1:39100/api/v1/fingerprint/random \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"os":"windows"}'
```

**账号（Account）**

```bash
# 账号列表（自动附带 profileName）
curl http://127.0.0.1:39100/api/v1/accounts -H "Authorization: Bearer <令牌>"

# 创建账号（profileId 必填且须属于本团队）
curl -X POST http://127.0.0.1:39100/api/v1/accounts \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"profileId":1,"platform":"Amazon","username":"buyer01","password":"****","remark":"主号"}'

# 更新账号（platform/username/password/remark 任意子集）
curl -X PUT http://127.0.0.1:39100/api/v1/accounts/5 \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"username":"buyer02"}'

# 删除账号
curl -X DELETE http://127.0.0.1:39100/api/v1/accounts/5 -H "Authorization: Bearer <令牌>"
```

**Cookie（按环境隔离）**

```bash
# 列出某环境的 Cookie
curl "http://127.0.0.1:39100/api/v1/cookies?profileId=1" -H "Authorization: Bearer <令牌>"

# 新增一条 Cookie
curl -X POST http://127.0.0.1:39100/api/v1/cookies \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"profileId":1,"domain":".example.com","name":"session","value":"abc"}'

# 更新 / 删除（按 id）
curl -X PUT  http://127.0.0.1:39100/api/v1/cookies/7 -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" -d '{"value":"new"}'
curl -X DELETE http://127.0.0.1:39100/api/v1/cookies/7 -H "Authorization: Bearer <令牌>"

# 清空某环境的全部 Cookie
curl -X DELETE "http://127.0.0.1:39100/api/v1/cookies?profileId=1" -H "Authorization: Bearer <令牌>"

# 批量导入（Netscape / Set-Cookie / JSON 文本）
curl -X POST http://127.0.0.1:39100/api/v1/cookies/import \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"profileId":1,"text":"example.com\tFALSE\t/\tFALSE\t0\tsession\tabc"}'

# 导出为 Netscape 文本
curl "http://127.0.0.1:39100/api/v1/cookies/export?profileId=1" -H "Authorization: Bearer <令牌>"

# 立即写入已打开的环境窗口（未打开则下次打开时自动注入）
curl -X POST "http://127.0.0.1:39100/api/v1/cookies/apply?profileId=1" -H "Authorization: Bearer <令牌>"
```

**RPA 脚本**

```bash
# 脚本列表（id / name / 步骤数 / 是否含变量）
curl http://127.0.0.1:39100/api/v1/rpa -H "Authorization: Bearer <令牌>"

# 脚本详情（含完整步骤与变量）
curl http://127.0.0.1:39100/api/v1/rpa/1 -H "Authorization: Bearer <令牌>"

# 触发回放（profileId 必填；variables 可选，覆盖脚本自带变量）
curl -X POST http://127.0.0.1:39100/api/v1/rpa/1/run \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"profileId":1,"variables":{"token":"abc123","keyword":"shoes"}}'
```

令牌可在客户端「自动化 API」页面生成，页面内含完整接口文档与 curl 示例。

### 10. 系统设置与界面主题

- **系统设置页**：全局默认配置（默认指纹操作系统、新建环境窗口尺寸、代理检测超时、定时巡检间隔、日志保留天数、主题与自动时段、所在国家 / 地区、界面语言、网络连接方式），保存即生效并持久化。
- **网络连接方式**：可选「跟随系统代理」或「自定义代理」（协议 / 主机 / 端口 / 可选账号密码），作用于**客户端自身出网**，无需再开代理软件的系统代理 / 全局开关。
  - 环境窗口使用各自的 `persist:env-{id}` 会话分区，仍按环境绑定的代理走，**不受此设置影响**。
  - 代理规则固定绕过 `localhost` / `127.0.0.1` / `[::1]`，否则本地 API 请求也会被代理，导致应用自身不可用。
- **任务栏图标显示**：可选「图标」（默认）或「窗口名称」。选择「窗口名称」后，环境窗口标题锁定为环境名，多窗口并行时在任务栏一眼定位目标窗口。
  - 实现要点：页面 `<title>` 会覆盖 `BrowserWindow` 的标题，因此监听 `page-title-updated` 并 `preventDefault()` 后重新 `setTitle(环境名)`，否则任务栏显示的是网页名而不是环境名；切换该设置对已打开的窗口立即生效。
- **关于（内核版本）**：设置页底部「关于」区块展示应用版本与内核版本（Chromium / Electron / Node.js / V8 / 平台架构），经 IPC 从主进程 `process.versions` 实时读取。
- **三态主题开关**（标题栏右上角常驻）：☀️ 白天（浅色）/ 🌙 黑夜（深色）/ 🕐 自动。
  - 自动模式按**可配置时段**切换：区间 `[白天起始, 黑夜起始)` 为白天、其余为黑夜（默认 7:00–18:00），起止小时可在设置页自定义；每分钟重算一次，跨边界自动切换。
  - 暗色下侧边栏 / 标题栏 / 内容区 / 卡片统一适配；主色随明暗微调（浅色 `#1677ff`、暗色 `#4096ff`）。
  - 主题与自动时段经 `localStorage` 即时套用，无需重启。

### 10.1 国家 / 地区与当地时间（含冬夏令时）

自动主题的「当前小时」取自设置里所选**国家**的当地时间，而不是宿主机系统时间——因此在国内把国家设为美国时，白天 / 黑夜按纽约时间判定，而不是北京时间。

- **国家切换**：内置 16 个主流跨境市场（中国 / 美国 / 英国 / 德国 / 法国 / 日本 / 韩国 / 新加坡 / 澳大利亚 / 加拿大 / 墨西哥 / 巴西 / 俄罗斯 / 印度 / 印尼 / 阿联酋），下拉支持按中文名、英文名或国家码搜索。
- **时区自动匹配**：每个国家绑定一个 **IANA 时区**（如 `America/New_York`），由运行时按当年的实际规则换算偏移，**冬夏令时自动生效**，无需维护偏移表。设置页实时显示该国的当地时间、`UTC±HH:mm` 偏移，并在处于夏令时时打上标记。
  - 北半球（纽约）夏季 `UTC-04:00`、冬季 `UTC-05:00`；南半球（悉尼）季节相反，夏季（1 月）为 `UTC+11:00`；印度 `UTC+05:30` 这类半小时偏移同样支持。
  - 实现见 `src/shared/timezone.ts`：小时与偏移都走 `Intl.DateTimeFormat` 的 `timeZone` 选项；夏令时判定取该时区同年 1 月与 7 月偏移的较小者作为「标准时」，当前偏移大于它即为夏令时（南北半球通用）。

### 10.2 多语言（中 / 英 / 日 / 德）

- 界面支持 **简体中文、English、日本語、Deutsch** 四门语言，切换后**立即生效**，无需重启。
- **国家与语言联动**：切换国家会自动带出该国常用语言（如选美国 → English、日本 → 日本語、德国 → Deutsch），语言下拉仍可**单独覆盖**，满足「人在中国但用英文界面」这类场景。
- **antd 与日期组件同步**：`ConfigProvider` 的 `locale` 与 dayjs 语言包跟随界面语言切换（分页、空状态、日期选择器等文案一并本地化）。
- **缺失翻译可编译期发现**：词典以简体中文为源语言，其余三份用 `MessageDict` 类型约束——**少翻译一个 key 会在 `pnpm typecheck` 阶段报错**，不会漏到运行时；运行时若仍缺失则回落到中文，再缺失才显示 key。
- 已本地化：侧边导航、登录 / 注册、系统设置（含国家与语言选择）、主题开关、通用按钮与提示。其余长尾文案走回落机制，可增量补齐。

### 11. 数据看板（概览首页）

登录后首页即数据看板，一屏掌握全局资源与操作走势：

- **实时时钟**：顶部「当前时间」每秒走动；「数据更新于」记录最近一次拉取数据的时刻（默认每 30 秒自动刷新，也可手动「刷新」）
- **核心指标卡**：环境总数、运行中、代理总数、可用代理、账号总数、RPA 脚本、扩展数
- **近 30 天操作趋势**：折线 + 渐变面积图
- **代理状态分布**：环形图（可用 / 使用中 / 已过期 / 无效 / 未知）
- **环境平台分布 / 环境分组分布 / 代理国家分布**：横向条形图（国家取 Top 8）

**图表交互**：鼠标移入有高亮动效并弹出数值气泡——

| 图表       | 悬停效果                                                                       |
| ---------- | ------------------------------------------------------------------------------ |
| 折线图     | 出现虚线参考竖线，该点圆点放大并描白边，气泡显示「日期 · 次数」                |
| 环形图     | 该段加粗、其余段淡出，**圆心数值切换为该段数量与占比**（移开恢复总数）         |
| 横向条形图 | 该行保持高亮、其余行淡出，气泡显示「名称 · 数量（占比%）」                     |

> 图表为自研内联 SVG（`src/renderer/src/components/charts.tsx`），**不依赖第三方图表库**；
> 折线图与条形图按容器真实宽度 1:1 渲染（`ResizeObserver` 测量），保证字号为真实像素、气泡定位准确。

### 12. 启动速度优化

- 渲染层构建拆分为 `react-vendor` / `antd` / `vendor` 多个 vendor chunk（并行下载 + 长期缓存，首屏不再等待 3.4MB 单包解析）；各页面按路由懒加载（`React.lazy` + `Suspense`），进入对应页面时才加载其专属 chunk（Dashboard / Rpa / Environments 等均为独立小包），首屏体积与解析时间显著下降。

### 13. AI Agent（本地大模型 · 零 token）

内置 AI 助手面板（侧边栏「AI Agent」），模型后端**默认本地 Ollama**——推理完全在本机完成，不调用任何按量计费的云端 API，对话内容不出本机。

**三种模式**（面板右上角可切换）：

| 模式 | 行为 |
| ---- | ---- |
| 自动 | Dispatcher 按消息内容自动路由：命中产品词（环境 / 代理 / 指纹 / RPA…）→ 产品客服，其余 → 通用对话 |
| 通用对话 | 纯本地模型自由问答 |
| 产品客服 | 检索本产品 README 相关章节拼入上下文，讲解功能、回答「怎么用 / 怎么做」；文档未提及的会如实说明，不编造 |

**使用步骤**：

1. 本机安装 [Ollama](https://ollama.com) 并拉取模型：`ollama pull qwen2.5:7b`（中文友好，约 4.5GB；显存富余可上 `qwen2.5:14b`）
2. 「设置 → AI Agent」：开启 AI Agent，填本地模型名，点「检测连接」——会明确提示 Ollama 未启动 / 模型未拉取 / 就绪三种状态
3. 侧边栏进入「AI Agent」即可对话；Enter 发送、Shift+Enter 换行，产品客服的回复会带「产品客服」标签

**实现要点**：

- 模型适配层 `src/main/agent/ollama.ts`：`/api/tags` 连通探针 + `/api/chat` 对话，纯 `fetch` 零额外依赖；对话接口只携带最近 20 条历史（本地模型上下文有限）
- 知识检索 `src/main/agent/knowledge.ts`：README 按标题切片（5 分钟缓存），中文 2-gram + 拉丁词打分取 top-6 片段拼入 system prompt，总长 ≤7000 字符
- 接口：`POST /api/ai-agent/chat`（`mode: auto/chat/support`）、`GET /api/ai-agent/status`（探针）
- 云端 BYOK（自带 Key）为可选兜底配置：在「设置 → AI Agent」选「云端」并填写 API Key 与模型名即可使用（DeepSeek / 通义千问 / 智谱 GLM / OpenAI 均走 OpenAI 兼容的 chat/completions，base URL 可自定义覆盖代理 / 私有部署）；会产生 token 费用，非默认路径，默认仍是本地 Ollama（零费）。云端不仅覆盖 Chat/Support/auto 文本对话，**Agent 执行闭环的视觉模型也可切到云端多模态模型**——需单独填「视觉模型（云端）」（如 gpt-4o / qwen-vl-max / glm-4v），即可零本地算力看屏自动操作
- **执行闭环**（看屏自动操作浏览器）：Route A「截图 + DOM → 本地视觉模型 / 云端 BYOK 多模态模型 → sendInputEvent」，支持**矩阵并行**（多选环境并发执行同一条指令）、执行完成后可把动作序列**存为 RPA 模板**离线回放；`session.ts` / `actions.ts` 带主进程 console 日志便于排查
- 原子动作：`click` / `type` / `navigate` / `scroll` / `wait` / `finish` / `ask`。其中 **`navigate`** 由主进程直接 `webContents.loadURL` 打开目标网址（与 `BrowserTab.go → env-navigate` 同一底层），用于「打开某网站 / 搜索某词」时直接跳转，避免弱视觉模型在地址栏里输入失败；system prompt 同时约束「指令未完成不得提前 finish」，所以环境窗口不会停在预设起始页不动作
- **执行日志**：AI 执行的开始 / 完成 / 失败写入操作日志（见 §8），日志页可用 `AI 执行开始 / 完成 / 失败` 标签追溯每次运行的指令、环境与结果
- **对话态跨页保活**：对话内容、输入框残值、当前标签页（自动 / 对话 / 客服 / 执行）通过模块级 `src/renderer/src/agentChatStore.ts`（`useSyncExternalStore` 单例）持久化。切到其它页面再切回不会清空对话，也不会回落到默认的「自动」标签，停留在离开前的标签继续对话（提交 `45171b4`）
- **AI 定时自动化**：把执行闭环升级为无人值守的定时任务。设置页「AI 定时自动化」可增删改多条任务（自然语言指令 + 目标环境 + 触发间隔 + 单次最大步数 + 沉淀 RPA 开关），`AgentRunner.startAutoTaskScheduler()` 每 60s 重读 `AppSettings.aiAutoTasks` 按 `intervalMin` 去抖触发；触发时复用 `agent:start` 同款视觉预检、仅驱动运行态环境（未运行自动跳过、绝不自动开窗），跑完若开启「沉淀为 RPA 模板」则把动作序列（`rpaSteps`）落库为新的 RPA 脚本（默认关闭定时）供离线零 token 回放。调度与执行逻辑集中在 `src/main/agent/runner.ts` 的 `runScheduledTask()` / `tickAutoTasks()`，RPA 落库走 `server.ts` 的 `saveRpaFromSteps()`（按源环境取团队 / 创建者）。

## 运行时验证（真实窗口 E2E）

指纹注入、RPA 回放、多窗口同步回声抑制均已通过**真实 Electron 窗口**端到端验证（非仅接口 / 路由层探活）：

- **指纹注入真值回读**：桌面 / 移动两套环境分别校验 UA、`platform`、`languages`、`hardwareConcurrency`、`deviceMemory`、`screen`、`timezone` / `tzOffset`、`userAgentData`（UA-CH 的 `platform` 与 `mobile`）、WebGL Vendor / Renderer、Canvas 噪声、触摸与 `devicePixelRatio`，全部与设定一致。
- **RPA 回放真实驱动页面**：`sync-apply` 下发的 `click` / `input` 能真实命中按钮、写入输入框。
- **回声抑制**：回放期间不会把自身合成事件回发为 `sync-event`。

> 测试中发现并修复的运行时问题：`navigator.userAgentData` 曾被宿主平台值「穿透」（桌面 / 移动都漏成宿主 Windows），以及桌面 `maxTouchPoints` 漏成宿主真实值；均已修正为桌面 `0`、移动 `5`、UA-CH 与 UA 严格一致。

## 与商业产品的差异说明

本项目是**功能对等的自研实现**：指纹注入通过 Electron 的 `session` + preload 脚本完成；商业产品通常会对 Chromium 内核做二进制级改写，本项目未涉及内核定制。对于跨境电商 / 社媒多账号的隔离需求，本实现已覆盖其核心使用方式。

## 附录 A：AI Agent 设计参考

> 本节汇集 AI Agent 的底层设计契约，供二次开发与排障参考。功能层面的使用说明见 §13。

### A.1 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│ UI 层（renderer）                                             │
│  指令输入框(@窗口/模板/文件/审批) · 实时步骤流 · 审批弹窗 ·      │
│  Settings 里 AI Agent 配置（backend/localModel/cloudKey）     │
└───────────────┬─────────────────────────────────────────────┘
                │ IPC: agent:start / step / need-approval / done / approve / stop
┌───────────────▼─────────────────────────────────────────────┐
│ Agent 编排层（main 进程，agent/ 模块）                         │
│  Supervisor（矩阵调度） → Session（单窗口闭环状态机）          │
│  Planner（拆解） · AntiDetect（拟人化） · Approver（审批）     │
└───────────────┬─────────────────────────────────────────────┘
                │ VisionModelAdapter 统一接口
┌───────────────▼─────────────────────────────────────────────┐
│ 模型适配层（agent/vision/）                                    │
│  LocalAdapter  → Ollama（minicpm-v / llama3.2-vision）        │
│  CloudAdapter  → DeepSeek-VL / Qwen-VL / GLM-4V（自带 Key）   │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP（本地 11434 / 用户填的 baseUrl）
┌───────────────▼─────────────────────────────────────────────┐
│ 浏览器执行层（现有能力，复用不重写）                            │
│  BrowserWindow.webContents.capturePage()  ← 截图              │
│  webContents.sendInputEvent()            ← 可信输入           │
│  现有 RPA 引擎（录制/回放）            ← 模板沉淀            │
│  现有多窗口 + 指纹/代理隔离            ← 矩阵并行           │
└─────────────────────────────────────────────────────────────┘
```

### A.2 三种模式与分发器（Dispatcher）

- **自动（Auto）**：按消息内容路由——命中产品词（环境 / 代理 / 指纹 / RPA…）→ 产品客服；其余 → 通用对话。
- **通用对话（Chat）**：纯本地模型自由问答，零浏览器控制。
- **产品客服（Support）**：检索本产品文档（README + 功能文档 + changelog）→ 组织答案，讲解功能、回答「怎么做」；文档未提及的如实说明，不编造。

### A.3 动作协议（VLM 输出契约）

```ts
type AgentAction =
  | { thought: string; action: 'click'; x: number; y: number }
  | { thought: string; action: 'type'; text: string }
  | { thought: string; action: 'navigate'; url: string }
  | { thought: string; action: 'scroll'; delta: number }
  | { thought: string; action: 'wait'; ms: number }
  | { thought: string; action: 'finish' }
  | { thought: string; action: 'ask'; question: string }   // 转人工
```

### A.4 IPC 通道（renderer ↔ main）

```
renderer → main:
  agent:start     { envIds:number[], instruction:string, options?:{needApproval?:boolean, maxSteps?:number} }
  agent:approve   { runId:string, approved:boolean }
  agent:stop      { runId:string }
main → renderer:
  agent:step         { runId, envId, step:AgentAction, screenshot?:string }
  agent:need-approval{ runId, envId, step:AgentAction }
  agent:done         { runId, envId, result }
  agent:error        { runId, envId, error }
```

### A.5 推荐本地模型栈（零 token，Ollama 一键拉取）

| 阶段 | 用途 | 推荐模型 | 显存/内存参考 |
| --- | --- | --- | --- |
| 通用对话 / 客服 | 中文问答 | `qwen2.5:7b` / `qwen2.5:14b` / `deepseek-r1:8b` | 4.5–9 GB VRAM，或 CPU 慢跑 |
| 视觉（看屏决策） | VLM | `minicpm-v:latest`（≈3B） / `llama3.2-vision:11b` / `qwen3-vl` | 4–12 GB VRAM |

> 约束：本地模型质量弱于官方托管 VLM；弱机建议先上 `minicpm-v` / `qwen2.5:7b`，显存不足可走 CPU（慢但零费）。

### A.6 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 开源/本地 VLM 识别率弱于官方，复杂页易点错 | 约束 prompt + 解析失败重试；高风险动作默认走审批；关键流程先人工确认 |
| 本地模型需 GPU/大内存，CPU 慢 | 默认本地 Ollama（零 token）；弱机可走 CPU 慢速，或用户启用 BYOK 兜底（会产生费用）；启动前检测本机 Ollama 已安装且模型已拉取 |
| 云端模型费用 | 用户自带 Key，文档标注预估单价；本地方案零费；可设步数上限控成本 |
| 反风控有限 | 文档明示不保证过风控，仅降机械感；敏感业务人工值守 |
| 矩阵并发吃资源 | 可配置最大并发窗口数；超出排队 |
| 自带 Key 明文泄露 | `cloudApiKey` 加密存储（OS keychain / 加密字段），不落明文日志 |
