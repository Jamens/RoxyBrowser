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
            // 只按 @ant-design/icons 的**精确作用域**匹配。
            //
            // 为什么不能写 `id.includes('antd')`：那会命中路径里任意含 "antd" 的包
            // （含 transitively 依赖），实测把整个 antd 打成 2.4MB 单块，
            // 首屏必须整块下载+解析，而实际只用得到其中一小部分组件。
            if (id.includes('@ant-design/icons')) return 'antd-icons'
            // react 运行时单独成块：它几乎不变，值得长期缓存。
            //
            // 匹配必须精确到 `/react/` 与 `/react-dom/`：写成 `.includes('react')`
            // 会把 react-router / @tanstack/* / rc-* 等一并吸进来，实测让本块
            // 从 544KB 膨胀到 1.8MB。
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'react-vendor'
            }
            // 其余 @ant-design/* 与 rc-* 归入 antd 块（共享其内部依赖，拆太细反而重复）
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
