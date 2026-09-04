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
      emptyOutDir: false
    }
  }
})
