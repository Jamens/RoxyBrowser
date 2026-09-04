# RoxyBrowser Clone 项目长期记忆

## 项目定位
桌面端指纹浏览器（对标 roxybrowser.cn），面向跨境电商 / 海外社媒多账号防关联。

## 技术栈与约定
- Electron 33 + electron-vite 2 + Vite 5 + React 18 + TS + Antd 5 + React Router 6（HashRouter）
- 后端：Express + TypeORM，**内嵌在 Electron 主进程**，本地 API 端口 39100（占用则递增），自动化 API 前缀 `/api/v1`（Bearer 令牌鉴权，令牌前缀 `rb_`）
- 数据库：MySQL `127.0.0.1:3307`（容器 `nest-js-config_end-db1-1`），`root` / `1234560`，库名 `roxy_browser`，`synchronize: true`
- 默认账号：`admin` / `123456`
- 包管理：pnpm（本项目 `pnpm-workspace.yaml` 里配 `allowBuilds`）

## 硬性代码约定（踩过坑，勿违反）
1. 所有 `@Column` **必须显式写 `type`**（esbuild 不支持 emitDecoratorMetadata）
2. QueryBuilder / 原生 SQL 里列名用**驼峰**（`teamId`），不是 `team_id`
3. 新增 async 路由不用额外处理，`wrapAsync()` 已统一兜底，但新路由必须用 `wrapAsync` 挂载的 router
4. 指纹相关改动需同时更新：`src/shared/fingerprint.ts`（生成器）、`src/main/browser-preload.ts`（注入）、`src/renderer/src/components/ProfileForm.tsx`（表单）
5. 环境窗口使用 `session.fromPartition('persist:env-{id}')` 隔离，指纹通过 `additionalArguments` 传 `--roxy-fp=<base64>` 给 preload
6. **Express 路由顺序**：同层静态路径（如 `/profiles/export`）必须排在 `:param` 路由（`/profiles/:id`）之前
7. **导出格式与导入解析器必须成对**，改动任一都要跑一次「导出→导入」往返测试
8. **代理 IP 池状态口径必须唯一**：`available`/`in-use`/`expired`/`invalid`/`unknown` 全部由 `proxyPoolStatus(p, usageCount, now)` 判定；`allocate` 候选筛选、`GET /api/proxies` 列表、`GET /api/proxies/pool-stats` 三处都必须复用它，新增状态分支要同步改三处（曾因 allocate 只认 `active`、proxyPoolStatus 把 `unknown` 也算 available，导致"显示有可用代理却分配失败"）
9. **停 Electron 实例**：PID 写在 `~/.roxy-clone/api-base.json`，但该 PID 是 Windows 原生进程，Git Bash `kill -0` 测不到、POSIX `kill` 杀不掉；必须用 `taskkill.exe /F /PID <pid>`（PowerShell `Stop-Process` 在本沙箱输出被吞，优先用 taskkill.exe）

## 验证注入 / 同步类逻辑的可复用方法
对 preload 注入、事件同步这类「跑在渲染层」的功能，只测 HTTP API 是验证不到真问题的。
做法：写一个临时 Electron 测试台（临时目录，测完即删）——
- 两个 BrowserWindow，加载本地测试页，`preload` 指向构建产物 `out/main/browser-preload.js`
- 主进程复刻真实的 `sync-event` → `sync-apply` 转发
- 用 **`webContents.sendInputEvent()` 产生可信输入**（而不是 `dispatchEvent`），驱动窗口 A
- 测试页把事件（含 `isTrusted`、时间戳、target）记进 `window.__events`，用 `executeJavaScript` 取回对比
- 必查三项：目标窗口事件数是否被放大（重复派发）、静置后事件数是否继续增长（回声）、落点坐标是否越界

其他要点：
- `BrowserWindow.getTitle()` 返回页面 `<title>`，不是构造函数的 `title` 选项
- 后台跑 Electron 要用 Bash 工具的 `run_in_background`，**不能用 `( ... &)` 脱离**——会随 shell 一起被杀
- 临时文件写项目目录，别写 `/tmp`（Git Bash 下有时落不了盘）
- **环境陷阱：本环境有 safe-delete 文件系统钩子**，删除会被转丢回收站（非真删，磁盘不释放）；要真正腾空间必须 `Clear-RecycleBin -DriveLetter D -Force`。`.asar` 等大归档常被 Windows Defender 锁住（`EBUSY`），会话内删不掉，需重启后再清。

## 提交规范（用户 2026-09-04 明确）
- **每个功能独立一个 commit，禁止跨功能合并提交**（如「环境迁移 + 多窗口同步 + 托盘 + 打包」塞进一个 commit 是反面教材）。
- 已推送到 origin 的历史 commit 不要随意改写；若要拆已发布的合并 commit 需用户明确同意并 force push。
- 不提交敏感/记忆文件：`login.json` / `exp.json` / `pex.json` / `.workbuddy/`（这些要么未跟踪要么不应入库）。
- **分工（用户 2026-09-04 明确）**：AI 负责把每个功能按「单功能单 commit」提交到本地 master；**推送（git push）由用户自己负责**。原因：本机 Bash 环境被 WorkBuddy 代理（127.0.0.1:51987）拦截，对 github.com 出站一律 502，且无直连路由，AI 侧无法 push。不要反复尝试从本环境 push，直接把提交留给你推即可。

## 常用命令
```bash
pnpm dev     # 开发（HMR）
pnpm build   # 构建到 out/
pnpm app     # 运行生产构建
env -u ELECTRON_RUN_AS_NODE npx electron out/main/index.js   # 终端直启（必须清除该环境变量）
```
