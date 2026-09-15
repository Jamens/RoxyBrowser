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
| 数据库 | MySQL（**需自备服务**；默认 `127.0.0.1:3307`，`root` / `1234560`，库名 `roxy_browser` 由应用首次启动自动创建） |

## 快速开始

```bash
pnpm install      # 安装依赖（首次需放行 electron 构建脚本，见下方注意事项）
pnpm dev          # 开发模式（vite HMR + 自动重启 Electron）
pnpm build        # 生产构建（输出到 out/）
pnpm app          # 以生产构建启动客户端
pnpm dist         # 打包 Windows 安装包（输出到 release/）
```

首次启动会自动建库、建表，并创建默认账号：**`admin` / `123456`**。

**运行行为**：关闭主窗口不会退出程序，而是最小化到系统托盘，本地 API 与自动化接口继续提供服务；**单击托盘图标即可重新打开主窗口**，彻底退出请右键托盘图标 → 「退出」。托盘图标由 `node scripts/gen-tray-icon.mjs` 生成到 `resources/tray.png`（纯 Node 实现，无第三方依赖）。

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
  -p 3307:3306 \
  mysql:8.0 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
```

> 容器启动后稍等几秒（MySQL 初始化需要时间），用 `docker logs -f roxy-mysql` 看到 `ready for connections` 后再启动应用。
> 等价替代：本机安装 MySQL 5.7+ / 8.0 并监听 `3307`，或用 XAMPP、既有 MySQL 实例——只要满足下方连接信息即可。

### 2. 默认连接信息

| 项 | 默认值 | 覆盖环境变量 |
| -- | -- | -- |
| 地址 | `127.0.0.1` | `DB_HOST` |
| 端口 | `3307` | `DB_PORT` |
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

> 若 MySQL 未启动，应用启动会弹出错误框：「无法连接数据库或启动服务……请确认 MySQL 已启动（默认 127.0.0.1:3307，root/1234560）」。

## 核心功能

- **环境管理**：无限创建隔离环境（每个独立 `persist:env-{id}` session），批量开关、分组筛选、回收站、整环境导出 / 导入迁移、手动切换线路
- **浏览器指纹**：UA / UA-CH / 平台 / 语言 / 时区 / 分辨率 / CPU·内存 / Canvas·Audio 噪声 / WebGL / WebRTC / 字体防泄漏，桌面 + 移动端四形态，另附指纹预设库；支持内核版本（Chrome 127–132 大版本）切换，UA 与 UA-CH 客户端提示同步一致
- **代理 IP**：HTTP(S) / SOCKS5，一键检测（出口 IP / 地区 / 延迟 / 匿名度）、IP 池视角、一键分配、定时巡检、扫码导出
- **环境体检**：伪装度评分 + 一致性红绿灯——把「设定指纹」与「环境窗口内实测回读值」逐项对撞（详见下节）
- **环境克隆工厂**：以某个环境为母本一键派生 N 个副本——行为一致（系统 / UA / 语言 / 时区）、指纹各异（分辨率 / CPU / 内存 / 显卡 / 字体），详见下节
- **全空间快照**：把整个团队空间（环境 + 代理 + RPA + 扩展引用）打包成单个 JSON，新机器一键灌入即还原；可选定时自动备份到本地目录，详见下节
- **多窗口同步**：键鼠轨迹级同步（稳定 selector + 元素内相对坐标 + 贝塞尔曲线插值）
- **RPA 脚本**：录制回放、变量替换、定时执行、运行日志
- **AI Agent**：本地 Ollama（默认，零 token）+ 云端 BYOK 可选，支持「看屏 → 决策 → 操作」执行闭环
- **AI 定时自动化**：自然语言指令 + 定时触发 AI Agent 在运行态环境自动执行，跑完把动作序列沉淀为 RPA 模板（下次离线零 token 回放），详见下节
- **团队协作 / 账号中心 / Cookie / 扩展**：成员角色控权、账号批量导入、Cookie 按环境隔离与批量导入、按环境加载 Chrome 扩展
- **数据看板 / 自动化 API（v1）**：核心指标与趋势图表；Bearer 令牌鉴权的本地 HTTP API，可对接外部调度器
- **登录二次验证（2FA / TOTP）**：登录除密码外还需验证器动态码；设置页扫码启用 / 关闭，TOTP 用 Node 内置 crypto 实现（无外部依赖）
- **Webhook 通知**：把操作日志事件（创建/打开环境、增删代理、团队变更、AI Agent 执行等）实时推送到你自己的服务，用于自动化与审计；HMAC-SHA256 签名校验来源、设置页「发送测试」即时验证、按事件分类订阅（含「全部事件」），详见下节
- **操作日志导出**：操作日志页一键把当前筛选结果导出为 CSV / JSON，便于审计留存；导出本身记入操作日志（属敏感操作），四语支持，详见下节
- **团队切换器**：顶栏一键在「我所属的团队」之间切换工作区（无需退出登录）；切换时用该团队的实时角色重发会话令牌，并关闭旧团队运行中的环境窗口，切换后整页刷新、所有数据自动归属新团队，详见下节
- **环境分享转移**：环境列表每行「转移」即可把环境（含其 Cookie / 账号）分享到其他团队——跨团队数据按 `teamId` 强隔离，「转移」即把归属改写为目标团队；仅可转移到你同为成员的其他团队，详见下节

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

## 目录结构


```
src/
├── main/                     # Electron 主进程（Node 环境）
│   ├── index.ts              # 入口：启动本地服务 → 打开主窗口
│   ├── server.ts             # Express + TypeORM：业务 API + 自动化 API v1
│   ├── webhook.ts            # Webhook 通知引擎：签名 / 事件匹配 / fire-and-forget 投递（纯函数，可单测）
│   ├── logExport.ts          # 操作日志导出（CSV / JSON）拼装：转义 / BOM / 字段顺序（纯函数，可单测）
│   ├── entities.ts           # 数据表实体（users/teams/proxies/profiles/accounts/cookies/...）
│   ├── agent/                # AI Agent：ollama.ts 本地模型适配 + knowledge.ts 知识检索
│   ├── browserManager.ts     # 环境窗口管理：独立 session、代理、Cookie 注入、同步转发
│   ├── browser-preload.ts    # 指纹注入脚本（注入到每个环境窗口的每个页面）
│   ├── exporters.ts          # 可复用导出/导入原子操作（整环境 / 代理池 / RPA），供各模块路由与全空间快照共用
│   └── healthProbe.ts        # 环境体检采集：在环境窗口内执行 JS，读回真实生效的指纹值
├── preload/index.ts          # 主窗口预加载：向渲染进程暴露 API 地址
├── shared/                   # 主进程 / 渲染进程共用
│   ├── types.ts              # DTO 与指纹类型
│   ├── fingerprint.ts        # 随机指纹生成器（UA / 时区 / 显卡池）
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
6. **构建默认不清理输出目录**：`electron.vite.config.ts` 中已设置 `emptyOutDir: false`，避免受限环境下批量删除失败。若在正常终端下希望每次构建前清空，改为 `true` 即可。
7. **存 base64 图片不要用 `text` 列**：MySQL 的 `text` 上限仅 64KB，而图片转 base64 常达数百 KB 甚至 1MB+，用 `text` 会静默截断 / 写入失败，表现为「上传大图既不报错也存不进去」。此类字段请用 `longtext`（见 `TeamEntity.icon`），并在前端先压缩再上传。

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
