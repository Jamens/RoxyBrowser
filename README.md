# RoxyBrowser Clone · 跨境电商指纹浏览器（桌面端）

对标 [RoxyBrowser]的桌面端指纹浏览器实现，专注跨境电商 / 海外社媒多账号防关联。
每个浏览器环境拥有**独立 Cookie 缓存 + 独立设备指纹 + 独立代理 IP**，实现账号之间完全隔离。

## 技术栈

| 层     | 技术                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| 桌面壳 | Electron 33                                                                      |
| 构建   | electron-vite 2 + Vite 5 + pnpm                                                  |
| 前端   | React 18 + TypeScript + Ant Design 5 + React Router 6                            |
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

### 2. 浏览器指纹（软件 + 硬件全维度模拟）

一键随机生成一整套**自洽**的指纹参数（操作系统 / UA / 语言 / 时区 / 分辨率 / CPU / 内存 / 显卡），也可逐项手动微调：

| 维度       | 实现方式                                                                                |
| ---------- | --------------------------------------------------------------------------------------- |
| User Agent | 请求头 + `navigator.userAgent` + `navigator.userAgentData`（含 `getHighEntropyValues`） |
| 平台       | `navigator.platform`、UA 品牌与平台版本                                                 |
| 语言       | `navigator.language` / `navigator.languages`                                            |
| 时区       | `Date.prototype.getTimezoneOffset` + `Intl.DateTimeFormat.resolvedOptions()`            |
| 屏幕       | `screen.width/height/availWidth/availHeight`                                            |
| 硬件       | `hardwareConcurrency`、`deviceMemory`                                                   |
| Canvas     | `toDataURL` / `getImageData` 注入**确定性噪声**（同环境稳定、异环境不同）               |
| WebGL      | `getParameter(37445/37446)` 返回自定义 Vendor / Renderer                                |
| Audio      | `AudioBuffer.getChannelData` 加入极小幅度噪声                                           |
| WebRTC     | 可禁用 `RTCPeerConnection`，防止真实 IP 泄漏                                            |

### 3. 代理 IP

- 支持 HTTP / HTTPS / SOCKS5，带用户名密码
- 一键检测：通过代理访问 ip-api.com，回写出口 IP、地区、延迟、可用状态
- 绑定到环境后，该环境窗口的所有流量走此代理（`proxyBypassRules` 已排除本地地址）

### 4. 窗口模板

保存一套指纹 + 平台 + 起始页配置，一键「从模板创建环境」，保证环境设置的完美一致性。

### 5. 多窗口同步

开启后，任意环境窗口的**滚动 / 点击 / 输入**会实时同步到所有已打开的环境窗口，适合批量发帖、互动、监控。

### 6. 团队协作

- 团队空间、成员邀请（自动创建账号并加入）
- 角色权限：`owner` / `admin` / `member`
- 项目分组（文件夹）

### 7. 账号中心

每个环境可保存多个平台账号密码，团队无需互传密码即可协作。

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

令牌可在客户端「自动化 API」页面生成，页面内含完整接口文档与 curl 示例。

## 目录结构

```
src/
├── main/                     # Electron 主进程（Node 环境）
│   ├── index.ts              # 入口：启动本地服务 → 打开主窗口
│   ├── server.ts             # Express + TypeORM：业务 API + 自动化 API v1
│   ├── entities.ts           # 9 张数据表实体
│   ├── browserManager.ts     # 环境窗口管理：独立 session、代理、同步转发
│   └── browser-preload.ts    # 指纹注入脚本（注入到每个环境窗口的每个页面）
├── preload/index.ts          # 主窗口预加载：向渲染进程暴露 API 地址
├── shared/                   # 主进程 / 渲染进程共用
│   ├── types.ts              # DTO 与指纹类型
│   └── fingerprint.ts        # 随机指纹生成器（UA / 时区 / 显卡池）
└── renderer/src/             # React 前端
    ├── pages/                # 登录、环境管理、模板、代理、账号、团队、日志、API、新标签页
    └── components/ProfileForm.tsx  # 环境/模板配置抽屉（基本信息 / 指纹 / 代理）
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
pnpm icon        # 生成托盘图标 resources/tray.png 与应用图标 resources/icon.ico（纯 Node，无依赖）
pnpm dist        # 构建 + 打包 Windows NSIS 安装包 → release/RoxyBrowser Clone Setup 1.0.0.exe
pnpm dist:dir    # 仅打包免安装目录 → release/win-unpacked/（调试分发更快）
pnpm dist:fresh  # 输出到 release-nsis/（当 release/ 目录被占用无法清理时使用）
```

打包配置见 `electron-builder.yml`：

- `appId: com.roxyclone.desktop`，产品名 `RoxyBrowser Clone`，简体中文安装向导（`nsis.language: 2052`）
- 支持自定义安装路径、创建桌面与开始菜单快捷方式
- `asarUnpack: resources/**` —— 托盘图标需真实文件系统可读，故从 asar 中解包
- 国内镜像已在 `.npmrc` 配置（`electron_mirror` / `electron-builder-binaries_mirror`），避免下载超时

> 打包产物未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「仍要运行」即可；正式分发请接入代码签名证书。

## 与商业产品的差异说明

本项目是**功能对等的自研实现**：指纹注入通过 Electron 的 `session` + preload 脚本完成；商业产品通常会对 Chromium 内核做二进制级改写，本项目未涉及内核定制。对于跨境电商 / 社媒多账号的隔离需求，本实现已覆盖其核心使用方式。
