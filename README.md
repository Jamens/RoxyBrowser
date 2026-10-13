# RoxyBrowser Clone · 跨境电商指纹浏览器（桌面端）

对标 [RoxyBrowser]的桌面端指纹浏览器实现，专注跨境电商 / 海外社媒多账号防关联。
每个浏览器环境拥有**独立 Cookie 缓存 + 独立设备指纹 + 独立代理 IP**，实现账号之间完全隔离。

## 文档索引

| 文档 | 内容 |
| ---- | ---- |
| [README.md](./README.md) | 技术架构、目录结构（文件作用）、运行与打包命令（本文件） |
| [FEATURES.md](./FEATURES.md) | 各模块功能详细说明与自动化 API 接口示例 |
| [CHANGELOG.md](./CHANGELOG.md) | 按时间的功能新增与问题修复记录 |

> 「产品客服」模式的知识来源为 README.md + FEATURES.md，因此功能类问题也能检索到。

## 技术栈

| 层     | 技术                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| 桌面壳 | Electron 44                                                                       |
| 构建   | electron-vite 5 + Vite 7 + pnpm                                                  |
| 前端   | React 19 + TypeScript + Ant Design 6 + React Router 6                            |
| 后端   | Express + TypeORM（内嵌在 Electron 主进程，本地 API + 自动化 API）               |
| 数据库 | MySQL（**需自备服务**；默认 `127.0.0.1:3306`，`root` / `1234560`，库名 `roxy_browser` 由应用首次启动自动创建） |

## 快速开始

```bash
pnpm install      # 安装依赖（首次需放行 electron 构建脚本，见下方注意事项）
pnpm dev          # 开发模式（vite HMR + 自动重启 Electron）
pnpm build        # 生产构建（输出到 out/）
pnpm app          # 以生产构建启动客户端
pnpm dist         # 打包 Windows 安装包（输出到 release/）

pnpm test         # 一键跑完全量离线测试（14 个：自动编译共享模块 + 逐个运行）
pnpm db:check     # 只读检查库表结构与实体定义的差异（不执行任何 DDL）
pnpm migrate:secrets        # 把历史明文凭据加密成密文（默认 dry-run）
pnpm migrate:secrets --apply  # 真执行迁移
pnpm clean:out    # 精确回收 out/ 里的陈旧构建产物（默认 dry-run，加 --apply 才真删）
```

首次启动会自动建库、建表，并创建默认账号：**`admin` / `123456`**。

**运行行为**：关闭主窗口不会退出程序，而是最小化到系统托盘，本地 API 与自动化接口继续提供服务；**单击托盘图标即可重新打开主窗口**，彻底退出请右键托盘图标 → 「退出」。

**应用图标**（`resources/`）：`icon.ico` 为品牌图标（蓝紫渐变圆角方块 + 浏览器窗口 + 指纹），含 16–256 七种尺寸，供 exe / 安装包 / 任务栏使用；`icon.png`（512）用于 Linux 与开发态窗口；`tray.png`（32）为托盘图标。三者在 `src/main/index.ts` 里按「asar 内 / asar.unpacked / extraResources」三种路径依次探测。

> **端口说明**：默认监听 `39100`，若被占用会自动递增。外部脚本不要硬编码端口，启动后读取 `~/.roxy-clone/api-base.json` 获取真实地址：
>
> ```bash
> # 读取真实 API 地址（端口可能不是 39100）
> API=$(grep -o '"apiBase":"[^"]*"' ~/.roxy-clone/api-base.json | cut -d'"' -f4)
> curl "$API/api/v1/profiles" -H "Authorization: Bearer <令牌>"
> ```

数据库配置可用环境变量覆盖：`DB_HOST` `DB_PORT` `DB_USER` `DB_PASS` `DB_NAME`。

## 数据库（必读）

本项目**必须依赖 MySQL**（不是内嵌数据库）。后端用 TypeORM 直连 MySQL；MySQL 没启动或连不上时，应用启动会直接报错退出，不会静默降级。拿到代码后**先确保有一个可达的 MySQL 再启动应用**。

### 1. 启动一个 MySQL（任选其一）

最省事的是用 Docker（端口、账号密码已按下方默认值配好，起完直接 `pnpm dev` 即可）：

```bash
docker run -d --name roxy-mysql \
  -e MYSQL_ROOT_PASSWORD=1234560 \
  -p 3306:3306 \
  mysql:8.0 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
```

> 容器启动后稍等几秒（MySQL 初始化需要时间），用 `docker logs -f roxy-mysql` 看到 `ready for connections` 后再启动应用。
> 等价替代：本机安装 MySQL 5.7+ / 8.0 并监听 `3306`，或用 XAMPP、既有 MySQL 实例——只要满足下方连接信息即可。
> **端口冲突？** 若你本机 3306 已被别的 MySQL 占用，把上面的 `-p 3306:3306` 改成 `-p 3307:3306`（宿主 3307 → 容器 3306），启动时带 `DB_PORT=3307` 即可，无需改代码。

### 2. 默认连接信息

| 项 | 默认值 | 覆盖环境变量 |
| -- | -- | -- |
| 地址 | `127.0.0.1` | `DB_HOST` |
| 端口 | `3306` | `DB_PORT` |
| 用户 | `root` | `DB_USER` |
| 密码 | `1234560` | `DB_PASS` |
| 库名 | `roxy_browser`（不存在会自动创建） | `DB_NAME` |

### 3. 不用手动建表——应用首次启动自动初始化

执行 `pnpm dev` / `pnpm app` 时，后端 `bootstrap()` 会按顺序完成：

1. 用 root 账号执行 `CREATE DATABASE IF NOT EXISTS roxy_browser`（utf8mb4）；
2. 用 TypeORM `synchronize: true` 自动创建 / 同步全部数据表；
3. 创建默认管理员账号 **`admin` / `123456`**（仅首次启动创建一次）。

因此**无需手动执行任何 SQL 即可直接跑起来**：打开应用后用 `admin / 123456` 登录即可。

### 4. 可选：手动建库建表（`db/schema.sql`）

如果你希望「先建好库再启动应用」（例如交给 DBA 评审、或某些环境下 `synchronize` 受限），仓库自带等效建表脚本 `db/schema.sql`（内含 `CREATE DATABASE` 与全部表结构）：

```bash
mysql -uroot -p1234560 < db/schema.sql
```

它与自动 `synchronize` **二选一**即可；脚本全是 `IF NOT EXISTS`，重复执行也安全。

> 若 MySQL 未启动，应用启动会弹出错误框：「无法连接数据库或启动服务……请确认 MySQL 已启动（默认 127.0.0.1:3306，root/1234560）」。

## 核心功能

- **环境管理**：无限创建隔离环境（每个独立 `persist:env-{id}` session），批量开关、分组筛选、回收站、整环境导出 / 导入迁移、手动切换线路
- **浏览器指纹**：UA / UA-CH / 平台 / 语言 / 时区 / 分辨率 / CPU·内存 / Canvas·Audio 噪声 / **WebGL + WebGPU** / **WebAudio 完整特征** / WebRTC / 字体防泄漏 / 地理位置，桌面 + 移动端四形态，另附指纹预设库；支持内核版本（Chrome 150–154 大版本）切换，UA 与 UA-CH 客户端提示同步一致
- **代理 IP**：HTTP(S) / SOCKS5，一键检测（出口 IP / 地区 / 延迟 / 匿名度）、IP 池视角、一键分配、定时巡检、扫码导出、**故障自愈**（连续失效后自动换绑，且绝不制造新的 IP 关联，详见下节）
- **环境体检**：伪装度评分 + 一致性红绿灯——把「设定指纹」与「环境窗口内实测回读值」逐项对撞（详见下节）
- **在线检测（外部视角）**：把环境窗口真正导航到第三方指纹检测站（PixelScan / BrowserLeaks / CreepJS / AmIUnique）跑一遍，抓取页面文本 + 截图回写报告——由外部站点从真实人群分布角度评判，能发现「设定值互相矛盾」或「某项落在真实人群分布之外」这类体检抓不到的问题（详见下节）
- **环境克隆工厂**：以某个环境为母本一键派生 N 个副本——行为一致（系统 / UA / 语言 / 时区）、指纹各异（分辨率 / CPU / 内存 / 显卡 / 字体），详见下节
- **全空间快照**：把整个团队空间（环境 + 代理 + RPA + 扩展引用）打包成单个 JSON，新机器一键灌入即还原；可选定时自动备份到本地目录，详见下节
- **多窗口同步**：键鼠轨迹级同步（稳定 selector + 元素内相对坐标 + 贝塞尔曲线插值）
- **RPA 脚本**：录制回放、变量替换、定时执行、运行日志、**脚本市场**（6 个内置预设，一键安装到我的脚本）
- **AI Agent**：本地 Ollama（默认，零 token）+ 云端 BYOK 可选，支持「看屏 → 决策 → 操作」执行闭环
- **AI 定时自动化**：自然语言指令 + 定时触发 AI Agent 在运行态环境自动执行，跑完把动作序列沉淀为 RPA 模板（下次离线零 token 回放），详见下节
- **团队协作 / 账号中心 / Cookie / 扩展**：成员角色控权、账号批量导入、Cookie 按环境隔离与批量导入、按环境加载 Chrome 扩展
- **数据看板 / 自动化 API（v1）**：核心指标与趋势图表；Bearer 令牌鉴权的本地 HTTP API，可对接外部调度器；**令牌的写操作统一落操作日志**（操作人记为 `api:<令牌名>`，删除 / 导入 / 导出自动标敏感），审计不留盲区
- **登录二次验证（2FA / TOTP）**：登录除密码外还需验证器动态码；设置页扫码启用 / 关闭，TOTP 用 Node 内置 crypto 实现（无外部依赖）
- **会话可撤销**：登出与「退出所有设备」会**吊销**该用户的全部会话令牌（不再是「只清本地、令牌在服务端还剩 7 天有效」）；其他设备下次请求收到 401 即自动跳登录页，详见下节
- **Webhook 通知**：把操作日志事件（创建/打开环境、增删代理、团队变更、AI Agent 执行等）实时推送到你自己的服务，用于自动化与审计；HMAC-SHA256 签名校验来源、设置页「发送测试」即时验证、按事件分类订阅（含「全部事件」），详见下节
- **操作日志导出**：操作日志页一键把当前筛选结果导出为 CSV / JSON，便于审计留存；导出本身记入操作日志（属敏感操作），四语支持，详见下节
- **团队切换器**：顶栏一键在「我所属的团队」之间切换工作区（无需退出登录）；切换时用该团队的实时角色重发会话令牌，并关闭旧团队运行中的环境窗口，切换后整页刷新、所有数据自动归属新团队，详见下节
- **环境分享转移**：环境列表每行「转移」即可把环境（含其 Cookie / 账号）分享到其他团队——跨团队数据按 `teamId` 强隔离，「转移」即把归属改写为目标团队；仅可转移到你同为成员的其他团队，详见下节
- **环境截图**：环境列表每行「截图」即可截取运行中环境窗口的当前视口为 PNG（用于 SEO 报告 / 收录检测 / A-B 测试证据 / 竞品调研留痕），弹窗内可一键下载；环境需先打开，详见下节
- **地理位置伪装（GEO）**：覆盖 `navigator.geolocation`，按环境时区回灌「代表城市」坐标；坐标与时区联动自洽，避免「东京时区 + 纽约坐标」这类自相矛盾的关联信号，详见下节
- **追踪器屏蔽**：环境级开关，拦截已知分析 / 广告 / 埋点域名的请求（GA、GTM、Facebook Pixel、Hotjar、Mixpanel 等），避免反复调研竞品时被对方埋点、Cookie 或第三方脚本识别甚至反监控；只拦明确的统计 / 广告子域，不影响登录与正常 CDN 资源，详见下节
- **指纹深度补齐（WebGPU / WebAudio）**：补齐此前缺失的两个高熵指纹维度，消除「WebGL 与 WebGPU 说法不一致」「音频特征裸奔」这类**自相矛盾而主动暴露**的缺口，详见下节
- **EME / Widevine 伪装（P1 + P3）**：环境窗口对检测站报出 Widevine + ClearKey（iOS 伪装隐藏该 API），`getConfiguration()` 还能报出真实的 CENC/CBCS 能力集（initDataTypes 含 cenc/cbcs、覆盖 avc/hevc/vp9/av1 视频与 aac/opus/flac 音频），避免「iOS UA 却暴露 Widevine」或「只能 resolve 却拿不到能力列表」的矛盾信号；环境体检 eme 项校验 Widevine + ClearKey + CENC 能力。
- **HTTP 安全警告（P2）**：环境窗口导航到明文 http:// 站点时，在页面顶部注入红色警告条提示连接未加密、存在被窃听/篡改风险（localhost 与 App 自身页面不触发），对标 RoxyChrome 154 的 HTTP Security Warnings。
- **反自动化痕迹清除（Tier 1）**：强制 `navigator.webdriver = false`（iOS 伪装整体隐藏该属性），并清除 CDP / ChromeDriver 注入的特征全局变量（`cdc_` / `$cdc_` / `__nightmare` / `callPhantom` 等），避免被 Cloudflare / PerimeterX 等风控识别为自动化；环境体检新增「反自动化痕迹」项（权重 5）校验。
- **平台 API 一致性（Tier 2）**：按真实支持矩阵隐藏「该 OS 不该有、但宿主原生却暴露」的平台能力 API——`bluetooth`/`usb` 全桌面+Android，`serial`/`hid` 仅桌面，`nfc` 仅 Android，iOS 一概移除；避免「iOS 伪装却暴露桌面 Web API」这类矛盾信号；环境体检新增「平台 API 一致性」项校验。
- **媒体查询偏好（Tier 2）**：`prefers-color-scheme`（light/dark/no-preference）与 `prefers-reduced-motion` 由指纹设定稳定驱动，`matchMedia` 仅对这两个查询回灌 fp 值、其余媒体查询透传原生；环境体检新增「媒体查询偏好」项校验回灌值与设定一致。
- **字体深度校验（Tier 3）**：字体防泄漏补丁从 `document.fonts.check` / Canvas `measureText` 延伸到 DOM 宽度枚举（`style.fontFamily` 赋值与 `setProperty('font-family')` 均过滤列表外字体），彻底封堵「设字体读 offsetWidth」这条经典侧信道；环境体检新增「字体与 OS 一致性」项，校验 `fp.fonts` 与 `fp.os` 自洽（含核心字体、无跨 OS 专属字体）。
- **批量体检总览（应用层）**：环境列表多选后一键「批量体检」，后端逐个环境跑完整指纹体检并聚合——给出平均伪装度、通过数、以及**系统级问题分布**（按失败环境数排序，快速暴露「一批环境共性的配置错误」，如统一选错 OS 字体、webdriver 未清）；逐环境可展开查看逐项明细。仅对「已打开」环境采集，未运行环境标记为跳过（可先批量打开再体检）。
- **智能代理分配（应用层）**：环境列表多选后一键「智能分配」，从可用代理池逐一分配**互不相同**的出口 IP
- **账号-环境批量关联（应用层）**：账号中心列表勾选多个账号，一键统一绑定到某个目标环境（改写 AccountEntity.profileId）
- **列表搜索 / 筛选 / 收藏（应用层）**：环境列表与账号列表均支持——环境：关键词搜索（名称/备注/平台）+ 分组筛选；账号：关键词搜索（平台/账号/备注）+ 所属环境筛选 + 平台筛选；两者均可叠加（后端 GET 参数）。两列表均新增首列星标「收藏」与工具栏「仅看收藏」开关，收藏集存于浏览器 localStorage（不落库、不加列），删除后自动裁剪脏 ID。；仅对当前用户可见的账号生效（member 只动自己账号），目标环境须为有效非模板环境。免去逐条在编辑弹窗里选环境。——彻底规避「两个环境共用同一代理」这一防关联大忌（与旧的「绑定代理=全部绑同一代理」反模式相反）。支持按国家 / 类型过滤；已独占合规代理的环境原地保留、运行中的环境不动、池不足的环境标记跳过（绝不强行复用）。分配核心逻辑抽成纯函数 allocateProxies（已离线单测 20 例全绿）。
- **智能助手 Planner（AI 客服）**：右下角悬浮助手，用自然语言查询全项目数据（环境 / 代理 / 账号 / Cookie / 日志 / 团队…），结果带**深链可一键跳转定位**到对应页面处理；支持顺手执行动作并按危险分级确认（safe 直执行 / medium 确认条 / destructive 强确认 + 审计）。敏感数据（`api_tokens` / `users`、密码 / 令牌字段）后端硬拦截，返回「请手动操作」而非查询结果，详见下节
- **接口限流 + 登录锁定**：滑动窗口限流抬高暴力尝试成本；登录失败按**用户名**计数并临时锁定，锁定事件写日志 + 推 webhook，详见下节
- **凭据静态加密**：账号密码 / 代理密码 / 2FA 密钥 / 云端 API Key 全部以 AES-256-GCM 密文入库，密钥来自环境变量或本地文件、**绝不回落默认值**；历史明文可一键迁移，详见下节
- **CDP 调试端口**：可选开启后可用 Playwright / Puppeteer 等外部工具接管环境窗口，并给出「环境 → target」映射；**仅监听 127.0.0.1**，详见下节

各模块的详细说明与接口示例见 [FEATURES.md](./FEATURES.md)。

### 环境体检（伪装度评分 + 一致性红绿灯）

在环境列表每行点「体检」（需环境已打开），后端会在**该环境窗口内真实执行 JS 回读**当前生效的指纹值，与数据库里的设定指纹逐项对撞：

- **伪装度 0–100**：按 UA / 平台 / 语言 / 屏幕 / 时区 / 时区偏移 / WebGL / UA-CH / CPU·内存 / Canvas·Audio 噪声 / WebRTC / 字体防泄漏等项加权得出，逐项展示「设定值 / 实测值 / 是否正常」。
- **一致性红绿灯**：代理出口 IP 国家 ↔ 时区 ↔ 浏览器语言 ↔ UA 平台 四件套是否自洽——不自洽是**关联高危信号**（比单项指纹更像真人更重要）。
- 噪声与防护类开关不看配置、看**注入是否真挂上**：通过判断原型方法是否被改写（原生方法 `toString()` 含 `[native code]`）来实测 Canvas / Audio / 字体防护是否生效。
- 环境限制不会误报：无 GPU 环境创建不出 WebGL 上下文时，该项标记为「不适用」且不计入总分，不会被当成「指纹注入失败」。

### 环境克隆工厂（批量派生 · 行为一致 / 指纹各异）

运营最常见的诉求是「再开 N 个一样的」。但**原样复制指纹等于把 N 个号绑成同一台设备**——平台一比对就全军覆没。克隆工厂因此把字段分成两类：

- **保持（行为一致）**：系统、UA / UA 版本、平台、语言、时区、触摸、像素比、噪声开关、WebRTC 策略——决定「像不像同一类用户」，共享才有批量运营的意义。
- **抖动（指纹各异）**：分辨率、CPU 核数、内存、显卡、字体——设备指纹的高区分度项，各副本互不相同。
- Canvas / Audio 噪声无需额外处理：preload 的噪声种子由 `profileId` 派生，新建环境拿到新 id，噪声天然不同。

**用法**：环境列表勾选 1 个母本 → 「克隆工厂」→ 填数量（1–50）与名称前缀 → 开始克隆。

> 不会复制 Cookie——登录态复制过去等于主动制造关联；也不继承代理绑定，需另行分配；账号资料可选一并复制。

### 环境生命周期 / 到期管理（可选到期时间 + 列表预警 + 到期拦截）

批量养号总有「这个号该下线了」的需求。本项目刻意**不做订阅计费**，到期只作为轻量的「该清理了」信号。

- **不新增数据库列**（项目铁律 #24）：到期时间存于 `ProfileEntity.fingerprint` 这一 JSON 列内（键 `expiresAt`，ISO 字符串），经 `src/shared/envExpiry.ts` 的 `getEnvExpiresAt` / `withEnvExpiresAt` 两个纯函数读写，前后端共用。
- **关键不变量**：`normalizeFingerprint` 必须**保留** `expiresAt` 这个自定义键。编辑 / 导入落库前都会跑归一化，一旦把它当成「未知字段」丢掉，到期时间就会**静默消失**——`tests/envExpiry.test.cjs` 专门锁死这一条。
- **三处生效**：环境列表新增「到期」列（复用代理到期的预警样式）；打开单个环境前拦截已过期环境并给出友好提示；批量打开同样拦截。

### 全空间快照（团队整体打包 / 迁移 + 定时备份）

做跨境多账号的，迟早要面对「换机器 / 重装 / 整机迁移」——把分散在数据库里的环境、代理、RPA、扩展一个个导出来再一个个灌进去既慢又容易漏。全空间快照把**整个团队空间**打成一个 JSON 文件：

- **内容**：每个环境的「整环境」结构（指纹 / 分组 / 代理 / 账号 / Cookie / 扩展名引用）+ 代理池（含国家 / 地区 / 到期等元信息）+ RPA 脚本 + 扩展元数据引用。
- **一键还原**：新机器导入该文件即可整体还原——代理按名称复用（缺失则按明细新建），环境重新生成（id 全部换新避免冲突），账号与 Cookie 随环境一起恢复。
- **复用既有导入器**：快照的导出 / 导入直接复用「整环境迁移」「代理批量」「RPA」各模块已有的逻辑，单模块迁移与整团队迁移走同一套代码，不会出现「单独导出能还原、快照却丢字段」的偏差。
- **扩展为名称引用**：扩展实际文件不进快照（无法序列化），只记录名称；导入端按名重映射，目标缺同名扩展则忽略该引用（与单环境导入行为一致）。
- **定时自动备份**：设置页「空间快照」分区可开启——按设定间隔（小时）把**每个团队空间**自动打包成 JSON 写入本地目录，每个团队保留最近 7 份（超出自动清理，避免占满磁盘），目录不存在 / 不可写时静默跳过。复用代理巡检式 `setInterval` 调度器，保存设置即重启调度。

**用法**：设置页 → 「空间快照」卡片 →「导出快照」下载 `.json`；「导入快照」选择文件即恢复；下方「定时自动备份」分区配置开关 / 目录 / 间隔。

### AI 定时自动化（自然语言指令 + 定时触发 + 沉淀 RPA）

把「AI Agent 执行闭环」升级成**无人值守的定时任务**：用一句自然语言指令，按设定间隔自动驱动运行中的环境去执行，跑完还能把动作序列沉淀成 RPA 模板，下次用 RPA 离线回放、零 token。

- **配置**：设置页「AI 定时自动化」分区，新增任务填「任务名 / 执行指令 / 目标环境（多选）/ 触发间隔（分钟）/ 单次最大步数 / 启用 / 沉淀为 RPA 模板」，可增删改多条。
- **定时触发**：复用代理巡检式 `setInterval` 扫描器（`AgentRunner.startAutoTaskScheduler()`，`src/main/agent/runner.ts`），按每条任务的 `intervalMin` 去抖触发，保存设置后即时生效（调度器每 60s 重读 `AppSettings.aiAutoTasks`，无需重启）。
- **绝不自动开窗**：触发时仅驱动**运行态**环境；目标环境未打开则自动跳过并写日志，绝不自动拉起窗口（与 RPA 定时调度同一约定）。
- **视觉预检**：每次跑前复用 `agent:start` 同款视觉模型预检（本地 Ollama / 云端 BYOK），模型未就绪直接跳过该轮、写日志，不会在循环里才炸。
- **沉淀 RPA 模板**：任务开启「沉淀为 RPA 模板」后，每个环境跑完的动作序列（`rpaSteps`）会落库为一条新的 RPA 脚本（默认关闭定时），归属取源环境的团队 / 创建者——下次直接用 RPA 定时执行离线回放，零 token。

> 前置依赖：本功能复用 AI Agent 执行闭环，需先在「设置 → AI Agent」启用并配好本地视觉模型（或云端 BYOK 视觉模型）。目标环境需提前处于运行态。

### Webhook 通知（操作日志实时外发）

把「谁在什么环境做了什么」以 HTTP POST 实时推送到你自己的接收端，方便接入运维机器人、审计存档、或联动外部系统。

- **触发点**：复用现有操作日志的单一收敛点（`writeLog` / `saveSchedulerLog` / `writeAgentLog`），凡是写操作日志的动作都会触发——覆盖环境增删改开关、代理增删分配、团队与成员变更、账号 / Cookie 操作、RPA 脚本、AI Agent 执行、定时调度等。
- **配置**：设置页「Webhook 通知」分区，可增删多条；每条含「名称 / 接收地址 / 签名密钥（可选）/ 启用开关 / 订阅事件」。事件订阅支持「全部事件」或按分类（环境 / 代理 / 团队 / 账号 / Cookie / RPA / AI Agent / 登录）勾选，命中规则为「事件名包含该关键词」（如 `profile` 命中 `create_profile` / `open_profile` / `batch_delete_profile`）。
- **投递**：`fire-and-forget`，绝不抛错阻塞主流程；8 秒超时；请求头携带 `X-Roxy-Event`（事件名）、`X-Roxy-Delivery`（唯一投递 ID，便于去重）、`X-Roxy-Signature: sha256=<HMAC>`（设置了密钥时）。Payload 含 `event` / `eventId` / `timestamp` / `teamId` / `actor` / `detail`。
- **签名校验**：接收端用同一密钥对原始请求体做 `HMAC-SHA256`，比对 `X-Roxy-Signature` 即可确认来源与完整性；密钥留空则不签名。
- **发送测试**：每条配置右侧「发送测试」按钮会立即单发一次（即使未启用），返回 HTTP 状态码，方便先验证地址与密钥再保存。
- **性能**：Webhook 配置缓存在内存（每次读取设置 / 保存设置时刷新），事件触发时直接读缓存、不查库。

**接收端示例（Node）**：

```js
import { createHmac } from 'node:crypto'
import express from 'express'
const app = express()
app.use(express.json({ limit: '1mb' }))
app.post('/roxy-webhook', (req, res) => {
  const secret = process.env.ROXY_HOOK_SECRET
  if (secret) {
    const sig = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex')
    if (sig !== req.headers['x-roxy-signature']) return res.status(401).end()
  }
  console.log('[roxy]', req.headers['x-roxy-event'], req.body)
  res.sendStatus(200)
})
app.listen(4000)
```

### 操作日志导出（CSV / JSON）

操作日志页把当前筛选结果（关键词 / 只看敏感）一键导出为 CSV 或 JSON 文件，便于审计留存与离线分析。

- **后端**：`GET /api/logs/export?format=csv|json`（需登录），仅导出当前团队数据，复用与列表一致的关键词筛选，并额外支持 `sensitive=1` / `action` / `from` / `to` 过滤。CSV 带 UTF-8 BOM（Excel 直接打开中文不乱码），字段为 `id, createdAt, teamId, userId, username, action, detail, sensitive`，`createdAt` 输出 ISO UTC（审计溯源 unambiguous），字段含逗号 / 引号 / 换行时自动转义加引号。
- **导出即审计**：导出动作本身写入操作日志（`export_logs`，属敏感操作），保证「谁导出了日志」也有据可查。
- **前端**：`Logs.tsx` 工具栏「导出」下拉（CSV / JSON），带 Bearer 头取回文件后本地下载（令牌不进 URL），文件名取自响应头 `Content-Disposition`。
- **纯函数可单测**：CSV 拼装抽为 `src/main/logExport.ts`（与 `webhook.ts` 同构，无 express 依赖），离线单测覆盖转义 / BOM / 字段顺序 / JSON 往返（19 项全绿）。

### 团队切换器（多团队工作区切换）

一个登录账号可属于多个团队（成员关系）。登录时下发的会话令牌里写入了「当前团队 `tid`」，所有业务数据都按 `tid` 隔离。团队切换器让你不退出登录就能换工作区。

- **列表**：`GET /api/auth/teams`（需登录）返回你所属的全部团队 `[{ id, name, role, isCurrent }]`，`isCurrent` 标注当前团队。
- **切换**：`POST /api/auth/switch-team`（需登录，body `{ teamId }`）——校验你确为该团队成员，用你在该团队的**实时角色**重发会话令牌（`tid` 变更，沿用 7 天有效期）；切换前关闭所有运行中的环境窗口（它们属于旧团队，不关会因 `teamId` 不匹配而报错），并写一条审计日志 `switch_team`（记在新团队下）。
- **前端**：顶栏团队切换下拉，选中其他团队即换本地令牌并整页刷新；刷新后所有列表自动归属新团队。仅 1 个团队时下拉只显示当前团队。
- **安全**：重发令牌沿用已通过的登录态（含 2FA），不重新验码；新角色直接读 `team_members` 表（实时），不取自旧 JWT，避免「改了角色却没生效」。

### 环境分享转移（跨团队）

团队切换器打通了多团队模型，而所有业务数据按 `tid`（团队）强隔离。环境分享转移让你把某个环境**移动 / 分享**到其他团队——因为数据隔离靠 `teamId`，「转移」的本质就是把环境及其关联数据的归属 `teamId` 改写为目标团队。

- **接口**：`POST /api/profiles/:id/transfer`（需登录，body `{ teamId }`）——校验该环境属于当前团队且未运行；校验操作人**同时是目标团队成员**（否则无权把数据塞进该团队）；改写 `ProfileEntity.teamId/ownerId`，并级联把该环境的 `Cookie`（自带 `teamId` 列）迁到目标团队、把 `Account`（靠 `profileId` 隐式归属，无独立 `teamId` 列）同步 `ownerId`。全程写敏感审计日志 `transfer_profile`。
- **前端**：环境列表每行「转移」按钮打开弹窗，从 `GET /api/auth/teams` 拉取「我所属且非当前」的团队作为目标候选；确认后环境即从当前团队列表消失（归属已变更），成功提示标注目标团队；只属于 1 个团队时给出「无法转移」提示。

### 环境截图（窗口视口 PNG）

对标 RoxyBrowser「SEO 内容营销」用例里「截图报告」的卖点——把运行中环境窗口的当前视口截成 PNG，用于 SEO 排名核对、收录检测、A-B 测试证据、竞品调研留痕等。

- **接口**：`POST /api/profiles/:id/screenshot`（需登录）——校验环境属于当前团队、未软删、且 `status === 'running'`（与体检同理，`capturePage` 只能在真实窗口上下文里截到页面）；经 `browserBridge.captureScreenshot` 调 `webContents.capturePage()` 取 PNG，`Buffer` 转 base64 `data:image/png;base64,...` 回前端；写审计日志 `screenshot_profile`。
- **前端**：环境列表每行「截图」按钮（`CameraOutlined`）打开弹窗展示图片，标注截图时间，提供「下载 PNG」按钮（`downloadDataUrl` 把 data URL 解码为 Blob 落盘）；环境未运行时按钮提示先打开。
- **复用**：截图能力底层复用 AI Agent 已有的 `webContents.capturePage()` 采集通道（`src/main/agent/session.ts`），不另起一套。

### 地理位置伪装（GEO / navigator.geolocation）

此前只伪装了时区、语言与代理出口 IP，页面一旦调用 `navigator.geolocation.getCurrentPosition()` 就会暴露宿主真实坐标（或报错穿帮）——这是指纹维度上的最后一个缺口。

- **数据模型**：`Fingerprint` 新增 `geoLatitude` / `geoLongitude` / `geoAccuracy` 三字段，与 `timezone` 联动——`TZ_POOL` 每个时区都带一组「代表城市坐标」（如 `Asia/Tokyo → 35.6762, 139.6503`）。
- **注入**：`browser-preload.ts` 整体替换 `navigator.geolocation`（`getCurrentPosition` / `watchPosition` / `clearWatch`），回灌指纹坐标；整体替换而非只改方法，是为了绕开 Chromium 原生的定位权限弹窗流程。
- **自洽性（关键）**：坐标抖动幅度刻意压得很小（随机 ±0.04° ≈ 4km、克隆派生 ±0.03°），既让不同环境坐标互不相同，又不会飘到邻市 / 邻国而与设定的时区、语言矛盾。历史环境（本功能上线前创建、无 GEO 字段）在 `normalizeFingerprint` 中按其**自身的 timezone** 反查坐标补齐，不会套用随机基准而产生矛盾。
- **联动**：环境表单里切换时区，纬度 / 经度 / 精度会自动跟随到该时区代表城市；也可手工微调。

### 追踪器屏蔽（隐身增强）

对标 RoxyBrowser「屏蔽追踪器 / 自动清理指纹」——调研竞品时反复用同一环境访问对方站点，很容易被埋点、Cookie 或第三方脚本识别出来，甚至被对方反监控。

- **实现位置与其它指纹项不同**：请求拦截只能在**主进程**做——`browserManager.openWindow` 里给环境 session 挂 `session.webRequest.onBeforeRequest`，命中即 `cancel`。preload 跑在渲染进程，只能改 JS、**拦不到网络请求**。必须在导航前挂上，否则首屏的统计脚本早已发出去了。
- **判定规则**：`src/shared/trackers.ts` 纯函数模块（可离线单测）导出 `TRACKER_HOSTS` 与 `isTrackerUrl(url, extraHosts)`；主机名等于清单项或以其子域结尾即命中。
- **清单原则（关键，别乱加）**：只拦**明确的分析 / 广告子域**，绝不拦主域——拦 `facebook.com` 会让用户直接登不上号，拦 `connect.facebook.net` 才只是干掉 SDK 而不影响登录；CDN（jsdelivr / unpkg / cdnjs）与错误上报（Sentry / Bugsnag）也不在清单内，否则页面会碎或报错刷屏。
- **开关**：`Fingerprint.blockTrackers`，新建环境**默认开启**（与 Canvas / Audio 噪声一致），可在环境表单「高级设置」里单独关闭；克隆派生继承母本设置，保持批量号行为一致。
- **兼容性**：本功能上线前创建的环境没有该字段，按「不改变既有环境行为」的原则默认不拦截，在表单里开启后生效。
- **2.0：只靠主机清单会漏**。埋点脚本经常就托管在**你自己的站点或 CDN** 下（`/gtag/js`、`/matomo.php`、`/analytics.js`），主机名是自家域名，永远不会命中域名清单。`isTrackerRequest` 因此改为**双路判定**：域名清单 + **子资源路径签名**。
- **不误杀原则（比功能本身更重要）**：路径签名只对**非顶层文档**生效——命中 `mainFrame` 一律放行，否则用户停在一个恰好带 `gtag` 字样的页面上会整页打不开。`localhost` / `127.0.0.1` / `10.x` / `192.168.x` 私有网段与 `blob:` / `data:` / `about:` 全部放过，避免误伤本地开发与内网业务。
- **覆盖 WebSocket / fetch / beacon**：这三类请求在 Chromium 里同样以 `webRequest` 事件出现且都带 hostname，无需额外机制即被同一套判定覆盖。

### WebGL ↔ OS 一致性守卫（自相矛盾比单项错更致命）

原有 WebGL 体检项只验「设定值 == 回读值」，证明的是**注入生效**，不是「组合起来像不像真人」。而检测站真正盯的是**矛盾**：iOS 伪装却报出 NVIDIA 独显、Android 伪装却报出桌面 GPU——这类组合在真实世界根本不存在，等于直接自曝「这个环境被改过」。

- **实现**：`src/shared/webglOsMatch.ts` 纯函数 `webglMatchesOs(os, vendor, renderer)`，零依赖可离线单测（`tests/webglOsMatch.test.cjs`，23 例）。
- **规则按 OS 收紧**：iOS / macOS **必须**是 Apple（ANGLE 始终报 Apple）；Android 禁桌面 GPU（NVIDIA / AMD / Intel）但放行 Adreno / Mali / PowerVR；Windows / Linux 反过来禁移动 GPU，但不强制具体桌面品牌。
- **老数据不误报**：字段为空时标记「不适用」（weight 0），不计入总分——区分「环境限制」与「注入失败」是体检的基本原则。

### 指纹深度补齐（WebGPU + WebAudio）

官方产品的迭代重心已从「功能广度」转向**指纹深度**（Chromium 150→153 多次内核更新都在调 WebGL 输出规则、WebAudio、WebGPU）。本项目此前在这两个维度上是空的，属于**会因为自相矛盾而主动暴露**的缺口。

**WebGPU**（`src/shared/webgpu.ts`）：真实 Chrome 的 `navigator.gpu.requestAdapter()` 会暴露 `GPUAdapterInfo`（vendor / architecture），creepjs、pixelscan、browserleaks 等检测站已普遍采集。此前只伪造了 WebGL 而放过 WebGPU，会产出「WebGL 说 RTX 4090、WebGPU 说宿主机集显」的矛盾信号——**矛盾比不伪装更可疑**，等于告诉检测方「这个环境被改过」。

- **不加数据库字段**：`info` 完全由已有的 `webglVendor` / `webglRenderer` 推导，天然与 WebGL 自洽，且历史环境**零迁移、自动生效**。
- **在真实实例上改写**：只在原生 `GPUAdapterInfo` 实例上覆盖 `vendor` / `architecture` 两个不可枚举 getter，这样 `instanceof GPUAdapterInfo` 依然成立、`subgroupMinSize` 等其余字段继续由原生提供。早期塞一个自制普通对象的做法会让这些维度变成 `undefined` 且 `instanceof` 判 false，反而制造「真实浏览器不可能出现的值」。
- **不识别就放弃伪造**：遇到没见过的型号（用户手填的 `webglRenderer`）返回空信息，让体检项标记为「不适用」，而不是兜底成某个架构去和 WebGL 打架。
- **iOS 整体隐藏**：iOS WebKit 不支持 WebGPU，伪装成 iOS 时必须移除 `navigator.gpu`。

**WebAudio**（`src/shared/webaudio.ts`）：音频指纹是 fingerprintjs 的核心熵源之一。此前只给 `AudioBuffer.getChannelData` 加了噪声（**1 个维度**），而检测站更常采集的 `sampleRate`、`baseLatency`、`maxChannelCount`、`DynamicsCompressorNode.reduction` 全部裸奔。

- 由环境 seed 确定性派生，保证「同环境稳定、异环境不同」；`baseLatency` 恒等于 `bufferSize / sampleRate`（128 / 256 / 512），不会出现自相矛盾的数值组合。
- **不动 `OfflineAudioContext`**：它的采样率必须等于构造参数，改了会让渲染结果与预期长度对不上，比不改更糟。补丁打在 `BaseAudioContext.prototype` 上并用 `instanceof` 放过它。
- **刻意不注入 `outputLatency`**：真实 AudioContext 在无音频播放时该值为 0，强行填 0.015~0.045 会与真实人群脱节，而它本身几乎不泄漏硬件信息——收益不足以抵消穿帮风险。

两项均已接入**环境体检**（新增 `WebGPU 显卡` / `音频特征` / `音频压缩器 reduction` 三个检查项），可在体检报告里直接看到注入是否生效。

**后续补强（继续对齐真实 Chrome 的暴露面）**：

- **WebGPU 软件渲染回退不伪装**（`webGpuSpoofAllowed`）：`adapter.isFallbackAdapter === true`（SwiftShader / llvmpipe）时**不覆盖** vendor / architecture。否则会造出一个新的矛盾——「WebGL 说 RTX 4090、WebGPU 说软件渲染」，正是上面那条原则的延伸。
- **子群尺寸改为原生透传**（`subgroupMinSize` / `subgroupMaxSize`）：体检新增「WebGPU 子群尺寸」项，只校验「min ≤ max 且 > 0」的自洽性，weight 0 不计分。
- **Canvas 噪声改为按画布确定性派生**（`src/shared/canvasNoise.ts`）：检测站的**首要**检查点是「同一块画布读两次是否一致」。此前噪声种子共享一个随调用推进的 rng，两次读取结果不同 → 直接暴露注入。现在种子由 `(环境种子, 宽, 高)` 派生，相同画布必得完全相同的噪声序列。配套两条：极小画布（< 8px 的 1×N 纯色参考条）跳过噪声，避免被「反篡改纯色探针」识别；种子为 0 / NaN 时退回 `webglVendor` 哈希，防止无种子环境共用同一套噪声被聚类。体检 `canvasNoise` 项新增**一致性要求**（探针画两遍比 `toDataURL`），不一致即判红——那是真实注入缺陷，不是环境限制。
- **WebAudio IAMF 刻意不注入**：IAMF 属**编解码能力查询**（`canPlayType` / `MediaCapabilities`），由 Chromium 版本与 OS 决定，**不是硬件指纹**；且本项目 Electron 内置 Chromium 低于 152，原生即不支持，伪造反而制造「浏览器声称支持、实际解不了」的矛盾。体检新增「音频编解码能力」信息项（weight 0）如实展示环境的编解码面，并记录「不注入」这一决策。

### 在线检测（外部视角验证）

环境体检是「自己出题自己判卷」，只能证明注入生效；而平台真正识别账号靠的是**外部检测站**——它们从真实人群分布的角度判断「这几个指标组合起来像不像一个人」。两者互补，缺一不可。

- **站点**：内置 4 个代表性检测站，按「一致性 → 综合指纹 → 深度分析 → 唯一性」覆盖不同维度——PixelScan（代理出口 IP / 时区 / 语言是否自洽，最贴近防关联诉求）、BrowserLeaks（Canvas / WebGL / 字体 / WebRTC 实测）、CreepJS（trust score / 是否被识破 lies / 熵值）、AmIUnique（你的指纹在多大规模样本里是唯一的）。
- **证据优先、判定从简**：检测站 DOM 常改版，依赖精确选择器解析会腐坏，所以只做两件稳的事——抓页面可见文本 + 截图留证，再按站点配置的 `hints` 关键词从正文摘录相关行辅助阅读，**不下绝对的通过 / 不通过结论**。
- **实现位置**：`src/main/fingerprintScan.ts`（`SCAN_SITES` 站点定义、`extractHighlights` 纯函数、页面提取脚本、`runSiteScan`）；经 `browserManager.scanSite` 接入环境窗口，路由 `POST /api/profiles/:id/scan` 与 `GET /api/scan-sites`，前端在体检报告 Drawer 内展示。
- **并发安全**：同一环境同时只允许一次检测（in-flight 锁）；叠加两次导航会让前一次读到后一个站点的页面，造成「站点名是 A、内容是 B」的张冠李戴——对本功能（卖点就是证据）是致命的，故必须拦。
- **失败也留证**：网络不通 / 代理失效 / 撞上人机验证（Cloudflare）时，仍尽力带上截图与错误页文本，并把 Chromium 网络错误码翻译成中文提示；检测异常同样写入操作日志（这类记录恰恰最需要追溯）。
- **不会自动跳回**：检测后停在检测站结果页（而不是退回起始页），因为跳回会重新加载、可能丢失用户登录态或表单；需要时请自行后退。
- **隐私提示**：此功能会把环境窗口的真实指纹发送给第三方站点，UI 已用 Alert 明确告知；对高价值账号环境请谨慎使用。

### 接口限流 + 登录锁定

**先说清风险评估，避免过度设计**：本地 API 只监听 `127.0.0.1`（`server.ts` 的 `s.listen(port, '127.0.0.1')`），**不暴露局域网**——外部攻击面本就很小。所以限流的价值不是「防网络攻击」，而是两个仍然成立的点：

1. **浏览器里的恶意脚本**：`fetch('http://127.0.0.1:39100/api/...')` 对同机任何网页都成立。CORS 只阻止**读**响应，不阻止**发出**请求，所以同源策略挡不住这里。
2. **登录爆破**：本机任意进程可无限次尝试 `/auth/login`，而默认账号是 `admin / 123456`，无锁定机制时爆破成本几乎为零。

- **滑动窗口而非固定窗口**：固定窗口（每分钟计数清零）有经典绕过——窗口末尾打满 N 次、下个窗口开头再打 N 次，实际 2 倍速率。滑动窗口按时间戳保留每次请求，边界无法卡。判定逻辑在 `src/shared/rateLimit.ts`（纯函数，可离线单测）。
- **登录失败按「用户名」计数而非 IP** —— 这是本功能最关键的一个决策。本地所有请求都来自 `127.0.0.1`，若按 IP 计数，等于**所有人共用一个额度**：攻击者只要猛打任意账号，就能把正常用户一起锁在门外（自我 DoS）。按用户名计数才能精准打击爆破目标。
- **但按用户名计数可被「轮换用户名」绕过** —— 故注册接口也限流（每客户端每小时 10 次），否则攻击者注册新号重试就能规避锁定。
- **锁定检查必须在比对密码之前**：先查锁定可直接拒掉；若先比对密码，被锁期间攻击者仍能不断发送密码尝试（拿不到会话，但等于保留了密码爆破的探测能力）。
- **锁定到期后失败计数必须清零** —— 否则用户解封后第一次输错就又被锁，永远解不开。实现上采用**惰性清理**（下次调用检查入口时 `pruneHits` 顺手清），不额外起定时器。
- **剩余次数提示只在临界值给**（剩余 ≤3）：过早提示等于帮爆破者精确定位阈值。
- **超限不消费额度**：若被拒的请求也记入窗口，会错误地延长恢复时间。
- **状态码区分**：限流 429、锁定 423（Locked），响应带 `Retry-After` 与 `X-RateLimit-Remaining`。
- **限额走内存缓存**：限流中间件在每个请求前执行，若每次 `await getSettings()` 就多一次 MySQL 查询，高频轮询下成瓶颈。缓存在 `PUT /settings` 时失效重取，兼顾「改设置立即生效、无需重启」。
- **`/healthz` 不限流**：外部调度器可能高频探测，超限会导致误判服务已死。
- **锁定事件写操作日志 + 推 webhook**（`login_locked`），可接告警及时察觉账号正被爆破。此刻可能尚未登录（甚至在爆破不存在的用户名），故用系统日志入口记 `tid=0` ——「谁被攻击」比「记在哪个团队下」更重要。

设置页 →「安全」分区可调三项：接口限流（0 = 关闭）、锁定阈值（0 = 不锁定）、锁定时长。

### 凭据静态加密（AES-256-GCM）

此前 `accounts.password`、`proxies.password`、`users.twoFactorSecret` 与 `app_settings.aiAgent.cloudApiKey` **全部明文入库**——全项目没有任何加解密实现。对一个以「多账号防关联」为卖点、且专门做了 `api_tokens` 敏感拦截的产品，一份 mysqldump 就等于全部店铺账号 + 2FA 长期接管权，是自相矛盾的硬伤。

- **透明加解密**：加解密挂在 TypeORM 的 `ValueTransformer` 上（`entities.ts` 的 `secretTransformer`），「进入实体即加密、离开实体即解密」是默认行为。**这是唯一能防住「以后新增代码忘记加解密」的做法**——凭据散落在账号 CRUD、代理检测、导出、快照、RPA、AI 助手等几十条路径上，手动改造必然漏。
- **覆盖四类凭据**：`accounts.password`、`proxies.password`、`users.twoFactorSecret`（TOTP 密钥泄漏 = 账号被长期接管，敏感度与密码同级）、`app_settings.aiAgent.cloudApiKey`（JSON 列无 Transformer，在 `getSettings()` / `PUT /settings` 两处收口）。
- **密文格式**：`rb1:<b64(iv)>:<b64(authTag)>:<b64(ct)>`。前缀用于区分历史明文——上线前的数据没有 `rb1:` 标记，`decryptSecret` 判否即**原样返回**，读取路径完全不受影响（惰性兼容）。
- **用 GCM 而非 CBC**：认证标签能在密文被篡改（库被改、备份损坏）时**抛错**而非吐出一段垃圾明文。对「密码能否登录」这种场景，静默产出错误值比报错危险得多。上层统一 fail-closed 返回空串——为了一个坏数据让整个列表接口 500 代价过高，而空串会导致登录/连接失败（安全地失败），不会误用错误密码。
- **密钥管理**（`src/main/secretKey.ts`，与 `jwtSecret.ts` 同构）：`ROXY_SECRET_KEY` 环境变量 > `~/.roxy-clone/secret-key` 持久化文件 > 首次随机生成。**绝不回落任何硬编码默认值**——那等于把全部凭据的安全性寄托在一个公开字符串上。JWT 密钥与凭据密钥是两份独立材料：前者泄漏可伪造登录态，后者泄漏即全部凭据裸奔，影响面不同。
- **列宽已同步加宽**：密文比明文长（256 字符明文 → 约 385 字符密文）。列宽仍为 256 会被 MySQL **静默截断**，表现为「密码莫名错误」且报错点离病因极远，故 `accounts.password` / `proxies.password` / `users.twoFactorSecret` 统一改为 `SECRET_COLUMN_LENGTH = 512`。
- **历史数据迁移**：`pnpm migrate:secrets` 扫全表把明文加密，**默认 dry-run**，加 `--apply` 才写库；幂等（已带 `rb1:` 前缀的跳过）。不能只靠读取时惰性加密——长期不用的环境、废弃代理那些行永远不会被读到，密码就会一直以明文躺在库里。
- **注意**：密钥文件或环境变量一旦更换，旧密文**无法恢复**（这是对称加密的固有性质，非缺陷）。更换前请先导出快照。解密失败时应用会打一条醒目的 error 日志指明原因。

离线单测：`tests/secretCrypto.test.cjs`（40 例全绿）覆盖往返一致（含中文 / emoji / 换行 / 256 字符）、随机 IV、篡改检测、错误密钥 fail-closed、历史明文兼容、空值语义、密钥优先级。

### 会话撤销（登出真正失效 / 退出所有设备）

会话令牌是 `jwt.sign({...}, secret, { expiresIn: '7d' })`——**无状态**。这带来两个绕不过去的问题：

1. 「登出」此前只做前端清 localStorage，令牌在服务端**依然有效满 7 天**。令牌一旦被截获（XSS、日志泄漏、备份文件），攻击者可在有效期内完整使用该账号——登出这个动作在安全上形同虚设。
2. 用户无法强制让某个账号的全部会话下线（比如怀疑账号被盗）。

- **为什么用 `tokenVersion` 而不是 JWT 黑名单**：JWT 无状态，要撤销单个令牌就得维护黑名单，而黑名单要么无限增长、要么过期清理出错（**漏删即等于该死令牌仍然有效**）。而我们真正需要的语义是「让某个用户的全部会话失效」——登出、改密码、管理员强制下线三种场景都是这个。递增 `users.tokenVersion`（一个整数）即吊销该用户全部令牌：**O(1)、无存储、无清理**。
- **代价是「改密码会让所有设备下线」**，但这恰恰是**用户期望的行为**（密码泄露时你当然希望把其他设备踢下线），不是缺陷。
- **升级不踢人**：`ver` 缺失的旧令牌按版本 0 处理。若把「缺失」判为非法，所有在线用户会在升级瞬间被集体登出。`tests/sessionRevoke.test.cjs` 专门锁死这一条。
- **反向不一致也不放行**：令牌版本**高于**库里的当前值（库被回滚 / 重置，或令牌来自另一套环境）同样拒绝——放行等于绕过撤销。
- **签发收敛到唯一入口** `signSessionToken()`：原本 5 处 `jwt.sign` 各自手写 payload，漏掉 `ver` 不会有任何编译错误或测试报错，只会**悄悄让该入口签发的令牌永不被撤销**。收敛后从结构上杜绝。
- **2FA 挑战令牌同样带 `ver`**：否则用户改密码后，已发出的 5 分钟挑战令牌仍能换正式令牌，撤销被绕过。
- **前端 401 自动登出**（`api.ts` + `SessionGuard`）：服务端吊销后，其他设备下次请求拿到 401 会自动清本地令牌并跳登录页。此前 401 完全无处理，被踢下线的设备会拿着废令牌反复报错，只能手动清 localStorage。
- **登出请求必须先于清本地令牌发出**：`clearToken()` 之后请求就不再带 `Authorization` 头，服务端鉴权失败、撤销不执行——恰好是这个功能要修的那个洞。
- **接口**：`POST /api/auth/logout`（当前用户全设备下线）、`POST /api/auth/logout-all`（同义，供 UI 表达「退出所有设备」）、`GET /api/auth/session`（会话状态 / 有效期）。撤销均写审计日志 `logout`。

### 代理故障自愈（巡检失效后自动换绑，避免环境裸奔）

定时巡检原本只把 `proxies.status` 写成 `invalid` 就结束了——**没有任何后续动作**。对矩阵运营来说，一个环境的代理掉线等于该环境的出口 IP 变成了宿主真实 IP；多个环境同时掉线则可能挤到同一个 IP 上，这正是防关联最忌讳的情况。

- **默认关闭**：自动改环境 IP 属于「用户不可见的重大变更」，必须由用户显式选择加入，而不是默认替他做决定。设置页 →「代理检测」分区可开启并配置阈值。
- **三条不可让步的约束**（做这个功能最容易踩的坑，判定逻辑全在 `shared/proxyHeal.ts` 纯函数里，可离线单测）：

  1. **绝不把两个环境换绑到同一个出口 IP**。「自动换绑」最朴素的做法是随便找个可用代理，但那会把 N 个掉线环境全部挤到同一个新代理上——等于亲手制造关联，比代理失效本身更糟。故挑选时排除「出口 IP 已被占用」的代理。
  2. **绝不换绑到与原代理相同的出口 IP**。不同代理地址完全可能共享同一出口 IP（同一服务商的不同接入点），换过去等于什么都没换，还白白改了配置。
  3. **必须有连续失败阈值**（默认 2 轮）。网络抖动、检测站偶发超时都会让单次巡检失败；若一次失败就换绑，用户会发现环境 IP 几分钟内反复跳变——**这本身就是一个极强的自动化信号**，且会连带触发平台风控。

- **跨环境去重（本功能最关键的一处实现细节）**：若每个环境各自独立决策，两个共用同一失效代理的环境会**各自挑中同一个备选代理**——自愈跑完了，两个环境还是共用同一出口 IP，等于没修甚至更糟（用户以为修好了）。故 `planProxyHealing` 内用 `claimedProxyIds` / `claimedExitIps` 记录本轮已认领的资源，后续决策排除之。`tests/proxyHeal.test.cjs` 用「两个环境共用同一失效代理」的场景专门锁死这条。
- **运行中的环境不自动换绑**：换代理需重启窗口才生效，会打断用户正在进行的操作；此时保持原状并在日志中说明原因。
- **找不到合规替代时保持原状并告警**，绝不将就——宁可保持失效代理（用户能看见并处理），也不换成会造成关联的代理。告警写 `proxy_heal_failed` 日志并推 webhook（事件名 `proxy_heal_failed`，可在 webhook 订阅里按 `proxy` 关键词命中）。
- **检测抛错也算一轮失败**：否则网络整体异常时 `checkProxy` 全部抛错，自愈永远不会触发。
- **连续失败计数是进程内状态**，重启后从 0 开始——意味着重启不会误触发批量换 IP（宁可晚一点动手）。
- **每次换绑都写操作日志**（`proxy_heal`，操作人 `system`），可推送 webhook（`proxy_heal`）接入运维机器人。

### CDP 调试端口（外部自动化工具接管环境）

此前外部自动化只能通过本地 HTTP API「开关环境」，无法真正**操作**页面——Playwright / Puppeteer / Selenium 一律接不进来，等于半封闭。开启 CDP 后，外部工具可直接接管运行中的环境窗口。

- **形态差异（重要，先看这段）**：市面上的指纹浏览器多为「每环境一个独立 Chrome 进程 → 每环境一个端口」，工具用 `connectOverCDP('http://127.0.0.1:<该环境端口>')` 直连单个环境。**本项目是 Electron 应用**，环境窗口是同一个 Chromium 实例内的多个 `BrowserWindow`，而 `remote-debugging-port` 是**进程级命令行开关**（app ready 前设置一次、全局生效），没有「每窗口一个端口」。因此形态是 **1 个端点 + 多个 target**：工具连一次即可看到全部环境窗口。
- **环境 ↔ target 精确映射**：外部工具从 CDP 拿到的只是 `targetId + url + title`，无从判断「哪个 target 是哪个环境」——同一站点开了多个环境时靠 URL 猜必然出错。`browser-preload.ts` 因此注入 `window.__roxyProfileId`（不可枚举，尽量不干扰特征检测面），主进程逐 target 发 `Runtime.evaluate` 求值，把 target 精确映射回环境 id，结果直接展示在设置页表格里，工具侧照着取即可。
- **配置存本地文件而非数据库**：这是本功能最 tricky 的一点。`app.commandLine.appendSwitch` 必须在 `app.whenReady()` **之前**调用，而 MySQL 是在 `whenReady` 里才连的（`bootstrap`）——**读到设置那一刻数据库还连不上**。若开关存在 `app_settings` 表，启动时序成死结：要读设置 → 需要 DB → 需要 whenReady → 但 whenReady 前就得设好开关。故运行时只认本地文件 `~/.roxy-clone/cdp-config.json`（与 `jwt-secret` / `secret-key` 同属「影响启动的本地配置」），`app_settings` 里只留一份供设置页回显。
- **需重启生效**：Chromium 命令行开关无法运行时更改，设置页已明确提示。端口被占用时会**自动顺延**，`cdp-info.json` 里写的是**实际生效**的端口，工具侧应读它而非配置值。
- **安全**：CDP 端点等同于**完整浏览器控制权**（读页面、执行脚本、注入 Cookie）。因此默认**关闭**、仅监听 `127.0.0.1`（不开 `0.0.0.0`，局域网无法连接）、开启/关闭均写操作日志（`enable_cdp` / `disable_cdp`，属敏感操作）。设置页有醒目 Alert。
- **接口**：`GET /api/v1/cdp`（Bearer 令牌）返回 endpoint、实际端口与 target 映射；`GET/PUT /api/cdp`（登录态）供设置页读写配置。

```js
// Playwright：连上后按 __roxyProfileId 区分环境
const browser = await chromium.connectOverCDP('http://127.0.0.1:39222')
for (const ctx of browser.contexts()) {
  const page = await ctx.newPage()
  // ... 用 GET /api/v1/cdp 拿到的 profileId → targetId 映射定位到具体环境
}
```

### 脚本市场（RPA 预设目录）

指纹浏览器的核心场景是跨境电商 / 海外社媒矩阵运营，这类账号的日常操作高度重复。脚本市场把这些高频流程固化为**内置预设**，用户在 RPA 页「脚本市场」Tab 一键安装到自己的脚本库即可回放，省去从零录制。

- **预设清单（6 个，按场景分类）**：`Google SERP 抓取`（SEO）、`收录检测 site:`（SEO）、`亚马逊商品搜索比价`（电商）、`竞品价格监控`（电商）、`每日登录签到`（账号）、`社媒定时发帖`（社媒）。
- **安装即克隆**：`POST /api/rpa/market/install/:id` 把预设克隆成当前团队的一条新脚本（归属当前用户，定时配置重置），之后可像普通脚本一样编辑 / 回放 / 定时。
- **预设设计原则**：以 `navigate`（开 URL）+ `wait` / `scroll` 为主，跨站点通用、装完即跑；`input` / `click` 这类依赖 DOM 选择器的步骤留作模板，附 `note` 提示用户按自己站点的真实 DOM 微调。所有可参数化部分用 `{{变量名}}` 暴露（`shared/rpa.ts` 的 `substituteVars` 回放时替换），账号密码等绝不写死在脚本里。
- **数据位置**：`src/main/rpaMarket.ts`（主进程专用纯数据模块），`GET /api/rpa/market` 罗列目录、`POST /api/rpa/market/install/:id` 安装；前端在 `Rpa.tsx` 用 Tabs 拆出「我的脚本 / 脚本市场」两个视图。

### 智能助手 Planner（AI 客服）

右下角悬浮气泡（登录页与全屏浏览器页不显示），打开即用自然语言问全项目的数据，例如「哪些环境快过期了」「哪个代理 3 天内到期」「最近删了哪些环境」。

- **查得到**：覆盖环境 / 代理 / 账号 / Cookie / 扩展 / RPA 脚本 / 操作日志 / 分组 / 团队。每条结果都带**深链**，点「跳转处理 →」直接定位到对应页面并高亮该行（环境页与代理页已接入）。
- **答得了语义**：「环境快过期」本身没有过期字段，会映射为「所绑定代理的 `expiresAt` 在未来 7 天内」，并在结果里补出「使用该代理的环境」。
- **做得到（且可控）**：可顺手执行动作，按危险分级确认——`safe`（打开环境、跑 RPA）直接执行；`medium`（分配代理、重命名）确认条；`destructive`（删除环境 / 代理、转团队、移除成员）强确认弹窗 + 写敏感审计。
- **敏感数据后端硬拦截**：`api_tokens` / `users` 整体禁查，密码 / 令牌 / Cookie 值等字段后端直接剔除，返回「该数据敏感，请到对应模块手动操作」。三道闸（敏感拦截 → 只读白名单 → 动作映射）全在后端兜底，**不依赖模型自觉**；查询走白名单 + QueryBuilder 参数化，并强制 team / owner 隔离。
- **前置条件**：需在「设置 → AI Agent」开启；默认本地 Ollama（`qwen2.5:7b`，零 token），也可切云端 BYOK。

## 目录结构


```
src/
├── main/                     # Electron 主进程（Node 环境）
│   ├── index.ts              # 入口：启动本地服务 → 打开主窗口
│   ├── server.ts             # Express + TypeORM：业务 API + 自动化 API v1（已按域抽出 auth/settings/logs/cookies/v1Cookie，剩余待拆）
│   ├── apiAudit.ts           # 自动化 API 审计：method+path → action / detail 推导（纯函数，可单测）
│   ├── webhook.ts            # Webhook 通知引擎：签名 / 事件匹配 / fire-and-forget 投递（纯函数，可单测）
│   ├── logExport.ts          # 操作日志导出（CSV / JSON）拼装：转义 / BOM / 字段顺序（纯函数，可单测）
│   ├── entities.ts           # 数据表实体（users/teams/proxies/profiles/accounts/cookies/...）+ 凭据加密 Transformer
│   ├── secretKey.ts          # 凭据加密密钥：环境变量 > ~/.roxy-clone/secret-key > 随机生成（绝不回落默认值）
│   ├── cdpManager.ts         # CDP 调试端口：app.commandLine 开关 / 端口探测 / target→profileId 映射（Node 侧）
│   ├── agent/                # AI Agent：ollama.ts 本地模型适配 + knowledge.ts 知识检索
│   ├── browserManager.ts     # 环境窗口管理：独立 session、代理、Cookie 注入、同步转发
│   ├── browser-preload.ts    # 指纹注入脚本（注入到每个环境窗口的每个页面）
│   ├── exporters.ts          # 可复用导出/导入原子操作（整环境 / 代理池 / RPA），供各模块路由与全空间快照共用
│   ├── rpaMarket.ts          # RPA 市场：内置预设脚本目录（纯数据模块，可离线单测）
│   ├── healthProbe.ts        # 环境体检采集：在环境窗口内执行 JS，读回真实生效的指纹值
│   ├── fingerprintScan.ts    # 在线检测：站点定义 / 文本提取 / 导航扫描（runSiteScan、extractHighlights 纯函数，可单测）
│   ├── cookieText.ts         # Cookie 纯函数：实体→DTO 映射 + Netscape / Set-Cookie / JSON 三格式文本解析（可离线单测）
│   ├── authScope.ts          # 账户隔离公共定义：AuthedRequest 类型 + isAdminRole / ownerScope / ownerAndWhere（server 与 routes 共用）
│   ├── jwtSecret.ts          # JWT 签名密钥：环境变量 > ~/.roxy-clone/jwt-secret 持久化 > 随机生成（绝不回落默认值）
│   ├── routes/               # 按域拆出的路由模块（依赖经 deps 注入，避免与 server.ts 形成运行时循环依赖）
│   │   ├── auth.ts           #   认证域：注册 / 登录 / 登出 / 会话 / 团队切换 / 2FA（12 个端点）
│   │   ├── settings.ts       #   设置域：API 令牌 / 全局设置 / CDP 调试端口 / Webhook 测试
│   │   ├── logs.ts           #   操作日志：列表（take 500）+ CSV/JSON 导出
│   │   ├── cookies.ts        #   Cookie 管理：增删改查 / 批量导入导出 / 立即注入已打开窗口
│   │   └── v1Cookie.ts       #   Cookie 自动化接口（Bearer 令牌鉴权，按 teamId + profileId 过滤）
├── preload/index.ts          # 主窗口预加载：向渲染进程暴露 API 地址
├── shared/                   # 主进程 / 渲染进程共用
│   ├── types.ts              # DTO 与指纹类型
│   ├── fingerprint.ts        # 随机指纹生成器（UA / 时区 / 显卡池 / GEO 坐标 / 反追踪开关）
│   ├── secretCrypto.ts       # 凭据静态加密：AES-256-GCM 加解密 + rb1: 版本前缀 + 历史明文惰性兼容（纯函数，可单测）
│   ├── cdp.ts                # CDP 调试端点：端口规整 / 分配 / endpoint 拼装（**零 Node 依赖**，renderer 也会 import）
│   ├── proxyHeal.ts          # 代理故障自愈：阈值闸门 / 合规替代代理挑选 / 跨环境出口 IP 去重（纯函数，可单测）
│   ├── sessionRevoke.ts      # 会话撤销判定：tokenVersion 比对 / 类型校验（纯函数，可单测）
│   ├── rateLimit.ts          # 接口限流与登录锁定：滑动窗口 / 失败计数 / 锁定到期（纯函数，可单测）
│   ├── trackers.ts           # 追踪器屏蔽：分析 / 广告 / 埋点域名清单与 isTrackerUrl 判定（纯函数，可单测）
│   ├── webgpu.ts             # WebGPU 指纹：由 WebGL vendor/renderer 推导 GPUAdapterInfo（纯函数，可单测）
│   ├── webaudio.ts           # WebAudio 指纹：由环境 seed 派生 sampleRate / baseLatency / 声道 / reduction（纯函数，可单测）
│   ├── canvasNoise.ts        # Canvas 噪声种子：按 (环境种子,宽,高) 确定性派生，保证同画布读两次一致（纯函数，可单测）
│   ├── webglOsMatch.ts       # WebGL ↔ OS 一致性守卫：显卡品牌与操作系统的矛盾检测（纯函数，可单测）
│   ├── envExpiry.ts          # 环境到期时间读写（expiresAt 存 fingerprint JSON，不新增数据库列，纯函数，可单测）
│   ├── countries.ts          # 16 个主流跨境电商国家（国家码 / 中英文名 / IANA 时区 / 默认语言）
│   ├── locales.ts            # 支持的语言（zh-CN / en-US / ja-JP / de-DE）与 antd·dayjs 包名映射
│   ├── timezone.ts           # IANA 时区工具：本地小时、UTC 偏移、夏令时判定（冬夏令时自动）
│   ├── healthcheck.ts        # 环境体检比对：设定指纹 vs 实测值 → 伪装度分与一致性红绿灯（纯函数）
│   └── snapshot.ts           # 全空间快照：文件结构定义 + 纯函数校验/规整（不依赖 DB / Electron，可单测）
└── renderer/src/             # React 前端
    ├── pages/                # 登录、环境管理、模板、代理、账号、Cookie、团队、日志、API、设置、新标签页
    ├── i18n/                 # 多语言：I18nProvider / useT / messages 词典 / antd·dayjs 语言包桥接
    ├── components/ThemeSwitch.tsx  # 三态主题开关（白天/黑夜/自动）
    └── theme.ts              # 主题解析：resolveDark / useIsDark（按所选国家当地时间判定）
```

## 注意事项

1. **pnpm 构建脚本**：pnpm 默认拦截依赖的 postinstall，若 `electron` 二进制没下载，在项目根目录执行 `pnpm install`，如需放行可运行 `pnpm approve-builds` 勾选 `electron`、`esbuild`。
2. **TypeORM + esbuild**：esbuild 不支持 `emitDecoratorMetadata`，因此所有 `@Column` 均**显式声明 `type`**（如 `type: 'varchar'`）。新增实体字段时请沿用该写法，否则会报 `Column type is not defined`。
3. **列名**：未启用 snake_case 命名策略，数据库列名与属性名一致（如 `teamId`），QueryBuilder 里不可写 `team_id`。
4. **`ELECTRON_RUN_AS_NODE`**：若当前终端设置了该环境变量，Electron 会以纯 Node 模式启动导致 `ipcMain` 等 API 不可用，启动前请 `unset ELECTRON_RUN_AS_NODE`（Windows PowerShell：`$env:ELECTRON_RUN_AS_NODE=$null`）。
5. **`pnpm add` 中断会弄脏 node_modules**：pnpm 依赖安装被中断（如 electron postinstall 失败）后，可能留下断裂的 symlink，表现为 `Cannot find package 'electron-vite'`。此时执行 `node scripts/fix-pnpm-links.mjs` 可就地重建链接（junction 方式，不删除任何文件）；彻底解决请删掉 `node_modules` 后重装。
6. **构建默认不清理输出目录**：`electron.vite.config.ts` 中已设置 `emptyOutDir: false`，避免受限环境下批量删除失败。若在正常终端下希望每次构建前清空，改为 `true` 即可；或用 `pnpm clean:out` 精确回收——它从当前构建入口递归解析可达 chunk，**只删证明不可达的文件**（默认 dry-run，`--apply` 才真删），既回收磁盘又不违反上面的受限环境假设。
7. **存 base64 图片不要用 `text` 列**：MySQL 的 `text` 上限仅 64KB，而图片转 base64 常达数百 KB 甚至 1MB+，用 `text` 会静默截断 / 写入失败，表现为「上传大图既不报错也存不进去」。此类字段请用 `longtext`（见 `TeamEntity.icon`），并在前端先压缩再上传。
8. **JWT 密钥没有默认值**：首次启动用 `crypto.randomBytes(32)` 生成并落盘到 `~/.roxy-clone/jwt-secret`，也可用环境变量 `JWT_SECRET` 指定。**绝不回落任何硬编码默认值**——那等于任何拿到该值的人都能自行签发 JWT、绕过全部鉴权。升级后旧令牌失效、需重新登录一次，属预期；删除该文件即等同重置密钥。
9. **改动实体前先跑测试**：`pnpm test` 会自动把共享模块编译后跑 14 个离线单测。`normalizeFingerprint` 必须保留 `expiresAt` 等自定义键这类不变量，都在测试里锁着，改坏了会立刻红。
10. **新增实体必须注册进 DataSource**：`synchronize` 只会为 `server.ts` 中 `entities` 数组里**已注册**的实体建表。漏注册会导致该表在全新安装时根本不存在（且 `db/schema.sql` 也不会补建），表现为功能一调用就报 `ER_NO_SUCH_TABLE`。加完实体后跑 `pnpm db:check` 确认：应看到对应的 `CREATE TABLE` 增量变更。
11. **新增凭据列必须挂 `secretTransformer` 且给足列宽**：往 `entities.ts` 加带密码 / 密钥语义的列时，**务必**带上 `transformer: secretTransformer`，否则该列又会以明文入库——加解密只在这一层自动生效，绕过 ORM（如手写 SQL、`QueryBuilder.getRawMany()`）拿到的会是密文。加解密靠 `server.ts` 的 `getSettings()` / `PUT /settings` 收口（JSON 列用不了 Transformer），新增 JSON 内的凭据字段还需同步加进 `SETTINGS_SECRET_PATHS`。**列宽不能只加 256**：密文比明文长（约 1.5 倍），沿用 `SECRET_COLUMN_LENGTH = 512`，否则 MySQL 会**静默截断**，症状是「密码莫名错误」且极难定位。
12. **凭据加密密钥不可更换**：`~/.roxy-clone/secret-key`（或 `ROXY_SECRET_KEY`）一旦更换，此前所有密文**无法恢复**——这是对称加密的固有性质。换密钥前先「设置 → 空间快照」导出备份。反过来，删除该文件会生成新密钥，旧数据将 fail-closed（登录失败 + 应用打 error 日志指明原因），不会静默出错值。
13. **`src/shared/` 禁止 import Node 模块**：shared 是主进程 / 渲染进程共用层，只要 renderer 侧（`@shared/xxx`）引用到某个文件，该文件就会被 vite 打进浏览器包。引入 `net` / `fs` / `path` 等会直接构建失败，报 `Module "net" has been externalized for browser compatibility`。需要 Node 能力的实现拆成两个文件——纯逻辑留 `shared/`、Node 侧留 `main/`（如 `shared/cdp.ts` 只有端口规整与 endpoint 拼装，`probePort` 在 `main/cdpManager.ts`）。
14. **新增 `jwt.sign` 会话令牌只能走 `signSessionToken()`**：手写 payload 漏掉 `ver`（会话版本号）不会有任何编译错误或测试报错，只会让该入口签发的令牌**永不被撤销**——撤销功能静默破防，且极难定位。判定逻辑见 `shared/sessionRevoke.ts`。同理，任何"要求客户端重新登录"的改动都必须同时确认 `api.ts` 的 401 分支能正确清理本地令牌并跳登录页。
15. **往 `routes/` 拆路由必须经 deps 注入，且不得反向 import server**：`routes/* → server → routes` 会形成运行时循环依赖，而 `AppDataSource` 是 `export let`（`initDb` 运行时才赋值），模块加载期按值捕获会拿到 `undefined`——表现为「一调用就报 undefined」，且只在启动后才暴露。故 `getDs` 一律传 `() => AppDataSource` 函数；跨模块只用 `import type`（编译期擦除）。连 `clientKeyOf` 这类纯工具也下沉到 `shared/`，避免 `routes → main` 的反向依赖。另注意**注册顺序**：`/logs/export` 这类静态路径必须先于 `/logs` 注册，否则被动态路由抢先匹配。
16. **每请求前执行逻辑不要直接查库**：限流中间件在每个请求前跑，若每次 `await getSettings()` 就多一次 MySQL 查询，高频轮询下成瓶颈。用内存缓存 + 在写入口（`PUT /settings`）失效重取，兼顾「改设置立即生效」。同理，`BucketStore` 用定时 `sweep` 清理空桶，且定时器要 `unref()` 以免阻止应用退出。

## 打包分发

```bash
pnpm icon         # 生成 resources/tray.png 与 resources/icon.ico（纯 Node，无第三方依赖）
pnpm dist         # 构建 + 打包 Windows 安装包（NSIS + 免安装版）→ dist/
pnpm dist:dir     # 仅产出免安装目录 → release/win-unpacked/（调试分发更快）
```

打包配置在 **`electron-builder.yml`**（`README.md` / `FEATURES.md` 已列入 `files`，因此安装版仍可作为「产品客服」的知识源）：

- `appId: com.roxyclone.browser`，产品名 `RoxyBrowserClone`，简体中文安装向导（`nsis.language: 2052`）
- 支持自定义安装路径、创建桌面与开始菜单快捷方式
- 同时产出 NSIS 安装包与 Portable 免安装版：
  - `dist/RoxyBrowserClone-1.0.0-win32-x64.exe`（≈84 MB，安装向导）
  - `dist/RoxyBrowserClone-1.0.0-win32-x64-Portable.exe`（≈75 MB，双击即用）
- `resources/` 打进 `app.asar`，托盘图标按「asar 内 / asar.unpacked / extraResources」三种路径依次探测（`src/main/index.ts` 的 `trayIconPath()`）
- 国内镜像：Electron 用 `.npmrc` 的 `electron_mirror`，打包器二进制用环境变量 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

### 代码签名（消除 SmartScreen「未知发布者」）
默认不签名（本地 / CI 无证书时 electron-builder 自动跳过、仅告警，不破坏构建）。正式分发请在签名机上设置环境变量后执行 `pnpm dist`：
- `CSC_LINK`：Authenticode 代码签名证书（`.pfx`）路径或下载 URL（建议 EV 证书，SmartScreen 声誉积累更快）
- `CSC_KEY_PASSWORD`：证书私钥密码

> electron-builder 会自动签名主程序 `RoxyBrowserClone.exe` 与 NSIS 安装包；Portable 版为 7z 自解包，无法签名，仅作内部分发。

### 自动更新（electron-updater）
- 已接入 `electron-updater`：安装版启动后静默检查一次更新，设置页「关于」区可手动「检查更新」并一键下载安装（不自动下载，避免打断多账号操作）。
- 更新源由 `electron-builder.yml` 的 `publish.generic` 决定（默认占位 `https://update.roxyclone.com`）。生产环境请改为你托管的更新服务器，或用环境变量 `UPDATE_FEED_URL` 在运行时覆盖。
- 执行 `pnpm dist` 时，electron-builder 会生成 `latest.yml` 与安装包并上传到该地址；安装版据此差分下载更新。

> **已知环境限制**：在受限终端（如带删除保护沙箱的 IDE 内置终端）中，electron-builder 收尾清理临时文件可能报错，**但安装包已在此之前生成完毕**，属无害告警；普通终端下不会出现。若 `release/` 残留旧目录无法清理，用 `-c.directories.output=<新目录>` 换个输出路径即可。
