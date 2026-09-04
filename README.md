# RoxyBrowser Clone · 跨境电商指纹浏览器（桌面端）

对标 [RoxyBrowser]的桌面端指纹浏览器实现，专注跨境电商 / 海外社媒多账号防关联。
每个浏览器环境拥有**独立 Cookie 缓存 + 独立设备指纹 + 独立代理 IP**，实现账号之间完全隔离。

## 技术栈

| 层     | 技术                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| 桌面壳 | Electron 44                                                                       |
| 构建   | electron-vite 5 + Vite 7 + pnpm                                                  |
| 前端   | React 19 + TypeScript + Ant Design 6 + React Router 6                            |
| 后端   | Express + TypeORM（内嵌在 Electron 主进程，本地 API + 自动化 API）               |
| 数据库 | MySQL（默认 `127.0.0.1:3307`，`root` / `1234560`，库名 `roxy_browser` 自动创建） |

## 快速开始

```bash
pnpm install      # 安装依赖（首次需放行 electron 构建脚本，见下方注意事项）
pnpm dev          # 开发模式（vite HMR + 自动重启 Electron）
pnpm build        # 生产构建（输出到 out/）
pnpm app          # 以生产构建启动客户端
pnpm dist         # 打包 Windows 安装包（输出到 release/）
```

首次启动会自动建库、建表，并创建默认账号：**`admin` / `123456`**。

**运行行为**：关闭主窗口不会退出程序，而是最小化到系统托盘，本地 API 与自动化接口继续提供服务；彻底退出请右键托盘图标 → 「退出」。托盘图标由 `node scripts/gen-tray-icon.mjs` 生成到 `resources/tray.png`（纯 Node 实现，无第三方依赖）。

> **端口说明**：默认监听 `39100`，若被占用会自动递增。外部脚本不要硬编码端口，启动后读取 `~/.roxy-clone/api-base.json` 获取真实地址：
>
> ```bash
> # 读取真实 API 地址（端口可能不是 39100）
> API=$(grep -o '"apiBase":"[^"]*"' ~/.roxy-clone/api-base.json | cut -d'"' -f4)
> curl "$API/api/v1/profiles" -H "Authorization: Bearer <令牌>"
> ```

数据库配置可用环境变量覆盖：`DB_HOST` `DB_PORT` `DB_USER` `DB_PASS` `DB_NAME`。

## 已实现功能（对标官网）

### 1. 环境管理（多账号防关联）

- 无限创建浏览器环境，每个环境独立 `session`（`persist:env-{id}`），Cookie / 缓存 / localStorage 完全隔离
- 环境列表：序号、名称、分组、平台标签、指纹摘要、绑定代理、运行状态、最后打开时间
- 批量打开 / 批量关闭、搜索、按分组筛选、5 秒轮询刷新运行状态
- 每个环境可设置起始页 URL，打开后进入内置新标签页（地址栏 + 快捷入口 + 当前指纹摘要）
- **状态自愈**：Electron 进程退出时所有窗口都会销毁，启动时自动把 DB 中残留的 `running` 状态重置为 `idle`，避免「界面显示运行中、实际无窗口」导致打开 / 关闭 / RPA 回放全部失灵（重启不会自动重开之前运行的环境，需手动重新打开）

### 2. 浏览器指纹（软件 + 硬件全维度模拟）

一键随机生成一整套**自洽**的指纹参数（操作系统 / UA / 语言 / 时区 / 分辨率 / CPU / 内存 / 显卡），也可逐项手动微调：

- **桌面 + 移动端**：支持 Windows / macOS / Android / iOS 四种形态。移动端注入触摸能力（`maxTouchPoints`、`ontouchstart`）、`devicePixelRatio`；Android 的 UA-CH 带 `mobile=true` 与 `platform="Android"`；iOS 按 Safari 形态（移除 `userAgentData`），环境窗口按手机尺寸打开。
- **指纹预设库**：内置十余套「验证过的指纹组合」（如 `Windows 11 · Chrome 129 · 德国`、`Pixel 8 · Android 14 · 美东`、`iPhone 15 Pro · iOS 17.5 · 美西`），各字段之间保证一致（UA ↔ 平台 ↔ GPU ↔ 屏幕 ↔ 时区语言），一键套用，避免手工拼出互相矛盾的指纹。

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

相关接口：`POST /api/fingerprint/random`（body `os` 可选 `windows|mac|android|ios`）、`GET /api/fingerprint/presets`。

### 3. 代理 IP

- 支持 HTTP / HTTPS / SOCKS5，带用户名密码
- 一键检测：通过代理访问 ip-api.com，回写出口 IP、地区、延迟、可用状态
- 绑定到环境后，该环境窗口的所有流量走此代理（`proxyBypassRules` 已排除本地地址）
- **IP 池视角**：按「是否被环境占用 + 是否过期 + 检测状态」计算每个代理的池状态（空闲 / 使用中 / 已过期 / 失效）
- **一键分配**：优先分配空闲代理，可按地区筛选，可选直接绑定到指定环境
- **批量导入 / 导出**：支持 `类型:主机:端口:用户:密码` 一行一条的批量导入，以及列表导出
- **定时巡检**：按设置页「定时巡检间隔」（分钟，0=关闭）自动检测全部代理并回写状态，应用启动即开始调度

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

- 团队空间、成员邀请（自动创建账号并加入）
- 角色权限：`owner` / `admin` / `member`
- 项目分组（文件夹）

### 7. 账号中心

每个环境可保存多个平台账号密码，团队无需互传密码即可协作。

支持**批量导入 / 导出**：可按「环境 + 平台/账号/密码」表格粘贴或上传文件导入，也可将某环境下的账号一键导出。

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
- **隔离**：脚本按账户隔离（同其他业务数据一致）。

后端接口：`GET/POST /api/rpa`、`PUT/DELETE /api/rpa/:id`、`POST /api/rpa/record/start|stop`、`GET /api/rpa/record/status`、`POST /api/rpa/:id/run`。

> 提示：回放的是合成事件（`isTrusted=false`），对校验该属性的反爬站点无效；脚本在不同页面结构（selector 失效）时对应步骤会被跳过。

### 8. 操作日志

所有关键操作（创建 / 修改 / 删除 / 打开环境、代理、成员、令牌）记录**操作人 + 时间 + 详情**，便于责任追溯。

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

令牌可在客户端「自动化 API」页面生成，页面内含完整接口文档与 curl 示例。

### 10. 系统设置与界面主题

- **系统设置页**：全局默认配置（默认指纹操作系统、新建环境窗口尺寸、代理检测超时、定时巡检间隔、日志保留天数、主题与自动时段），保存即生效并持久化。
- **三态主题开关**（标题栏右上角常驻）：☀️ 白天（浅色）/ 🌙 黑夜（深色）/ 🕐 自动。
  - 自动模式按**可配置时段**切换：区间 `[白天起始, 黑夜起始)` 为白天、其余为黑夜（默认 7:00–18:00），起止小时可在设置页自定义；每分钟重算一次，跨边界自动切换。
  - 暗色下侧边栏 / 标题栏 / 内容区 / 卡片统一适配；主色随明暗微调（浅色 `#1677ff`、暗色 `#4096ff`）。
  - 主题与自动时段经 `localStorage` 即时套用，无需重启。

## 目录结构

```
src/
├── main/                     # Electron 主进程（Node 环境）
│   ├── index.ts              # 入口：启动本地服务 → 打开主窗口
│   ├── server.ts             # Express + TypeORM：业务 API + 自动化 API v1
│   ├── entities.ts           # 数据表实体（users/teams/proxies/profiles/accounts/cookies/...）
│   ├── browserManager.ts     # 环境窗口管理：独立 session、代理、Cookie 注入、同步转发
│   └── browser-preload.ts    # 指纹注入脚本（注入到每个环境窗口的每个页面）
├── preload/index.ts          # 主窗口预加载：向渲染进程暴露 API 地址
├── shared/                   # 主进程 / 渲染进程共用
│   ├── types.ts              # DTO 与指纹类型
│   └── fingerprint.ts        # 随机指纹生成器（UA / 时区 / 显卡池）
└── renderer/src/             # React 前端
    ├── pages/                # 登录、环境管理、模板、代理、账号、Cookie、团队、日志、API、设置、新标签页
    ├── components/ThemeSwitch.tsx  # 三态主题开关（白天/黑夜/自动）
    └── theme.ts              # 主题解析：resolveDark / useIsDark（共享单一定时器）
```

## 注意事项

1. **pnpm 构建脚本**：pnpm 默认拦截依赖的 postinstall，若 `electron` 二进制没下载，在项目根目录执行 `pnpm install`，如需放行可运行 `pnpm approve-builds` 勾选 `electron`、`esbuild`。
2. **TypeORM + esbuild**：esbuild 不支持 `emitDecoratorMetadata`，因此所有 `@Column` 均**显式声明 `type`**（如 `type: 'varchar'`）。新增实体字段时请沿用该写法，否则会报 `Column type is not defined`。
3. **列名**：未启用 snake_case 命名策略，数据库列名与属性名一致（如 `teamId`），QueryBuilder 里不可写 `team_id`。
4. **`ELECTRON_RUN_AS_NODE`**：若当前终端设置了该环境变量，Electron 会以纯 Node 模式启动导致 `ipcMain` 等 API 不可用，启动前请 `unset ELECTRON_RUN_AS_NODE`（Windows PowerShell：`$env:ELECTRON_RUN_AS_NODE=$null`）。
5. **`pnpm add` 中断会弄脏 node_modules**：pnpm 依赖安装被中断（如 electron postinstall 失败）后，可能留下断裂的 symlink，表现为 `Cannot find package 'electron-vite'`。此时执行 `node scripts/fix-pnpm-links.mjs` 可就地重建链接（junction 方式，不删除任何文件）；彻底解决请删掉 `node_modules` 后重装。
6. **构建默认不清理输出目录**：`electron.vite.config.ts` 中已设置 `emptyOutDir: false`，避免受限环境下批量删除失败。若在正常终端下希望每次构建前清空，改为 `true` 即可。

## 打包分发

```bash
pnpm icon         # 生成 resources/tray.png 与 resources/icon.ico（纯 Node，无第三方依赖）
pnpm dist         # 构建 + 打包 Windows 安装包（NSIS + 免安装版）→ dist/
pnpm dist:dir     # 仅产出免安装目录 → release/win-unpacked/（调试分发更快）
```

打包配置在 **`package.json` 的 `build` 字段**（非独立的 electron-builder.yml）：

- `appId: com.roxyclone.browser`，产品名 `RoxyBrowserClone`，简体中文安装向导（`nsis.language: 2052`）
- 支持自定义安装路径、创建桌面与开始菜单快捷方式
- 同时产出 NSIS 安装包与 Portable 免安装版：
  - `dist/RoxyBrowserClone-1.0.0-win32-x64.exe`（≈84 MB，安装向导）
  - `dist/RoxyBrowserClone-1.0.0-win32-x64-Portable.exe`（≈75 MB，双击即用）
- `resources/` 打进 `app.asar`，托盘图标按「asar 内 / asar.unpacked / extraResources」三种路径依次探测（`src/main/index.ts` 的 `trayIconPath()`）
- 国内镜像：Electron 用 `.npmrc` 的 `electron_mirror`，打包器二进制用环境变量 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

> **已知环境限制**：在受限终端（如带删除保护沙箱的 IDE 内置终端）中，electron-builder 收尾清理临时文件可能报错，**但安装包已在此之前生成完毕**，属无害告警；普通终端下不会出现。若 `release/` 残留旧目录无法清理，用 `-c.directories.output=<新目录>` 换个输出路径即可。
>
> 打包产物未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「仍要运行」即可；正式分发请接入代码签名证书（EV 更佳）。

## 与商业产品的差异说明

本项目是**功能对等的自研实现**：指纹注入通过 Electron 的 `session` + preload 脚本完成；商业产品通常会对 Chromium 内核做二进制级改写，本项目未涉及内核定制。对于跨境电商 / 社媒多账号的隔离需求，本实现已覆盖其核心使用方式。
