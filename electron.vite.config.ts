import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    esbuild: {
      tsconfigRaw: '{"compilerOptions":{"experimentalDecorators":true,"emitDecoratorMetadata":true,"target":"ES2022"}}'
    },
    build: {
      // 不清空输出目录：避免批量删除（CI / 受限环境下可能无删除权限）
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'browser-preload': resolve(__dirname, 'src/main/browser-preload.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { emptyOutDir: false }
  },
  renderer: {
    plugins: [react()],
    // 必须显式绑 IPv4 回环，不能用 Vite 默认的 'localhost'。
    //
    // 现象：窗口标题正常、内容全白。主进程日志是
    //   [roxy] 主窗口打开失败，本地 API 继续运行: ERR_FAILED (-2) loading 'http://localhost:5173'
    // 实测（本机）：Vite 只监听 [::1]:5173，127.0.0.1:5173 直接 ECONNREFUSED。
    // 而 Chromium 解析 localhost 时优先试 IPv4，第一个候选被拒就整条失败
    // （它不像 curl 那样会回退到下一个候选），于是 loadURL 抛 ERR_FAILED，
    // 渲染进程拿到的是一个从没加载成功的空壳 → 白屏。
    //
    // 绑 127.0.0.1 后 IPv4 可用，Chromium 第一个候选就通。
    // 不要改成 '0.0.0.0' / true：那会把 dev server 暴露到局域网。
    server: { host: '127.0.0.1' },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      emptyOutDir: false,
      // 启动速度优化：大体积第三方库拆分独立 chunk，浏览器可并行解析 + 长期缓存，
      // 各页还会按路由懒加载（见 App.tsx）。
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            //
            // 【分块的第一原则：互依的包必须同块】
            //
            // 手动分块会**绕过 Rollup 自动处理循环依赖的能力**：Rollup 默认会把
            // 互相 import 的模块放进同一 chunk 并排好执行顺序；一旦手动拆开，
            // 跨块循环就会成立，而 ESM 循环下先执行的 chunk 访问另一个 chunk
            // 尚未初始化的导出 → TDZ：
            //   Uncaught ReferenceError: Cannot access 'FastColor' before initialization
            // 表现是**打包后主窗口白屏**，且 dev 模式（esbuild 预打包、每模块独立）
            // **完全不暴露**——只有 file:// 加载产物时才会中招。
            //
            // 改完 manualChunks 必须跑 `node scripts/check-chunk-cycles.mjs` 验证。
            //
            // 为什么不能写 `id.includes('antd')`：那会命中路径里任意含 "antd" 的包
            // （含 transitively 依赖），实测把整个 antd 打成 2.4MB 单块，
            // 首屏必须整块下载+解析，而实际只用得到其中一小部分组件。
            //
            // react 运行时单独成块：它几乎不变，值得长期缓存。
            //
            // 匹配必须精确到 `/react/` 与 `/react-dom/`：写成 `.includes('react')`
            // 会把 react-router / @tanstack/* / rc-* 等一并吸进来，实测让本块
            // 从 544KB 膨胀到 1.8MB。
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'react-vendor'
            }
            // `@ant-design/fast-color` 单独成块（只有十几 KB）。
            //
            // 它被 antd 侧（@ant-design/colors）与 vendor 侧
            // （@rc-component/color-picker）**同时**依赖。若让它进 antd 块，
            // 就出现 vendor → antd 的反向依赖 → 跨块循环 → TDZ（白屏）。
            // 单独成块后两侧都只依赖它一个方向，环被彻底断开。
            if (id.includes('@ant-design/fast-color')) return 'fast-color'
            // `@ant-design/icons` 并入 antd 块（不再单独成块）。
            //
            // icons 依赖 antd 导出的 IconContext，antd 的组件又依赖 icons——天然互依。
            // 拆成两块即成环（Rollup 会直接警告 "Circular chunk: antd-icons -> antd"）。
            if (id.includes('@ant-design/icons')) return 'antd'
            // `@ant-design/colors` 归 vendor 块（不归 antd）。
            //
            // colors 依赖 fast-color；color-picker（在 vendor 侧）依赖 colors。
            // 若 colors 在 antd 块：vendor → antd（经 color-picker），而 antd → vendor
            // （经 @rc-component/util）→ 又成环。归到 vendor 侧后
            //   antd → vendor → fast-color（单向），无环。
            if (id.includes('@ant-design/colors')) return 'vendor'
            // 其余 @ant-design/* 与 rc-* 归入 antd 块（共享其内部依赖，拆太细反而重复）。
            //
            // 注意 `@rc-component/`（路径 `node_modules/@rc-component/<pkg>/`）**不**
            // 匹配下面的 `/rc-`（那只能命中 rc-util 这类顶层包），故不在此列——
            // 它们留在 vendor 块，与 @ant-design/colors 同侧，环才不会绕回来。
            if (id.includes('/@ant-design/') || id.includes('/rc-') || id.includes('/node_modules/antd/')) {
              return 'antd'
            }
            return 'vendor'
          }
        }
      }
    }
  }
})
