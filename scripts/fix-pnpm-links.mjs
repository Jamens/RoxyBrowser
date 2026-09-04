// 修复 pnpm 链接损坏：重建 node_modules/electron-vite、node_modules/electron 及 .bin 启动脚本
// 场景：pnpm add 失败中断后，部分 symlink / dist 缺失，且删除操作被安全策略拦截时用于就地修复
import { existsSync, symlinkSync, writeFileSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const root = process.cwd()
const pnpmDir = join(root, 'node_modules', '.pnpm')

function pickDir(prefix) {
  if (!existsSync(pnpmDir)) return []
  return readdirSync(pnpmDir)
    .filter((n) => n.startsWith(prefix))
    .map((n) => join(pnpmDir, n, 'node_modules', n.split('@')[0]))
    .filter((p) => existsSync(p))
}

function link(target, linkPath, name) {
  if (existsSync(linkPath) && existsSync(join(linkPath, 'package.json'))) {
    console.log(`✓ ${name} 链接正常`)
    return
  }
  if (existsSync(linkPath)) {
    try {
      rmSync(linkPath, { recursive: true, force: true })
    } catch (e) {
      console.log(`! 无法清理 ${name}: ${e.message}`)
      return
    }
  }
  symlinkSync(target, linkPath, 'junction')
  console.log(`✓ 已重建 ${name} → ${target}`)
}

// 1. electron-vite（优先选 @types/node 22 的那个实例）
const evDirs = pickDir('electron-vite@')
const evTarget = evDirs.find((p) => p.includes('@types+node@22')) || evDirs[0]
if (evTarget) link(evTarget, join(root, 'node_modules', 'electron-vite'), 'electron-vite')

// 2. electron：补齐 dist（从已有二进制的实例链接过去）
const eDirs = pickDir('electron@').filter((p) => p.endsWith('electron'))
if (eDirs.length) {
  const withDist = eDirs.find((p) => existsSync(join(p, 'dist', 'electron.exe')))
  const forLink = eDirs.find((p) => p.includes('supports-color')) || eDirs[0]
  if (withDist && forLink && !existsSync(join(forLink, 'dist', 'electron.exe'))) {
    symlinkSync(join(withDist, 'dist'), join(forLink, 'dist'), 'junction')
    console.log(`✓ 已链接 electron dist → ${join(withDist, 'dist')}`)
  }
  link(forLink, join(root, 'node_modules', 'electron'), 'electron')
}

// 3. .bin 启动脚本
const binDir = join(root, 'node_modules', '.bin')
mkdirSync(binDir, { recursive: true })
const shim = (name, relJs) => {
  writeFileSync(
    join(binDir, name),
    `#!/bin/sh\nexec node "$(dirname "$0")/${relJs}" "$@"\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(binDir, `${name}.cmd`),
    `@echo off\r\nnode "%~dp0${relJs.replace(/\//g, '\\')}" %*\r\n`
  )
  console.log(`✓ 已生成 .bin/${name}`)
}
if (evTarget) shim('electron-vite', '../electron-vite/bin/electron-vite.js')


// 4. electron-builder
const ebDirs = pickDir('electron-builder@')
const ebTarget = ebDirs[0]
if (ebTarget) {
  link(ebTarget, join(root, 'node_modules', 'electron-builder'), 'electron-builder')
  const pkg = JSON.parse(readFileSync(join(ebTarget, 'package.json'), 'utf8'))
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['electron-builder']
  if (binRel) shim('electron-builder', `../electron-builder/${binRel.replace(/\\/g, '/')}`)
}


// 5. electron 命令行启动脚本（npx / pnpm 使用）
if (existsSync(join(root, 'node_modules', 'electron', 'cli.js'))) {
  shim('electron', '../electron/cli.js')
}

console.log('\n修复完成，请执行 pnpm build 验证')
