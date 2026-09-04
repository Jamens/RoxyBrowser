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

## 常用命令
```bash
pnpm dev     # 开发（HMR）
pnpm build   # 构建到 out/
pnpm app     # 运行生产构建
env -u ELECTRON_RUN_AS_NODE npx electron out/main/index.js   # 终端直启（必须清除该环境变量）
```
