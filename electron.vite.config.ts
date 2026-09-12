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
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      emptyOutDir: false,
      // 启动速度优化：大体积第三方库拆分独立 chunk，浏览器可并行解析 + 长期缓存，
      // 首屏不再必须等 3.4MB 单包解析完。各页还会进一步按路由懒加载（见 App.tsx）。
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
            if (id.includes('@ant-design') || id.includes('antd') || id.includes('rc-')) return 'antd'
            if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler')) return 'react-vendor'
            return 'vendor'
          }
        }
      }
    }
  }
})
