# 更新日志

按日期记录项目的**功能新增**与**问题修复**，最新在最上。

- 技术架构、目录结构（文件作用）、运行与打包命令 → [README.md](./README.md)
- 各模块功能详细说明与自动化 API 示例 → [FEATURES.md](./FEATURES.md)

条目格式为「说明（commit）」，可按 commit 哈希在 git 历史中查看完整改动。

---

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
