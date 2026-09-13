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

## 目录结构

```
src/
├── main/                     # Electron 主进程（Node 环境）
│   ├── index.ts              # 入口：启动本地服务 → 打开主窗口
│   ├── server.ts             # Express + TypeORM：业务 API + 自动化 API v1
│   ├── entities.ts           # 数据表实体（users/teams/proxies/profiles/accounts/cookies/...）
│   ├── agent/                # AI Agent：ollama.ts 本地模型适配 + knowledge.ts 知识检索
│   ├── browserManager.ts     # 环境窗口管理：独立 session、代理、Cookie 注入、同步转发
│   └── browser-preload.ts    # 指纹注入脚本（注入到每个环境窗口的每个页面）
├── preload/index.ts          # 主窗口预加载：向渲染进程暴露 API 地址
├── shared/                   # 主进程 / 渲染进程共用
│   ├── types.ts              # DTO 与指纹类型
│   ├── fingerprint.ts        # 随机指纹生成器（UA / 时区 / 显卡池）
│   ├── countries.ts          # 16 个主流跨境电商国家（国家码 / 中英文名 / IANA 时区 / 默认语言）
│   ├── locales.ts            # 支持的语言（zh-CN / en-US / ja-JP / de-DE）与 antd·dayjs 包名映射
│   └── timezone.ts           # IANA 时区工具：本地小时、UTC 偏移、夏令时判定（冬夏令时自动）
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

> **已知环境限制**：在受限终端（如带删除保护沙箱的 IDE 内置终端）中，electron-builder 收尾清理临时文件可能报错，**但安装包已在此之前生成完毕**，属无害告警；普通终端下不会出现。若 `release/` 残留旧目录无法清理，用 `-c.directories.output=<新目录>` 换个输出路径即可。
>
> 打包产物未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「仍要运行」即可；正式分发请接入代码签名证书（EV 更佳）。
