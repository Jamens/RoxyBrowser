import { Router, type Response, type NextFunction } from 'express'
import type { DataSource } from 'typeorm'
import { app } from 'electron'
import { existsSync, readFileSync, statSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'fs'
import { join, sep } from 'path'
import { ExtensionEntity } from '../entities'
import { ownerScope } from '../authScope'
import type { AuthedRequest } from '../authScope'

export interface ExtensionRouteDeps {
  /**
   * 取 DataSource 的**函数**而非值：`AppDataSource` 在 server.ts 中是 `export let`，
   * 由 initDb 在运行时赋值。若在模块加载时按值捕获，注册路由那一刻它仍是 undefined。
   */
  getDs: () => DataSource
  authMiddleware: (req: AuthedRequest, res: Response, next: NextFunction) => void
  writeLog: (req: AuthedRequest, action: string, detail: string) => Promise<void>
}

/**
 * 浏览器插件（扩展）管理路由：列表 / 上传或从本地目录添加 / 取图标 / 删除。
 *
 * ## 扩展的存储形态
 * Electron 只认**解压目录**的扩展，不支持直接加载 .crx。所以落盘形态是
 * `userData/extensions/<id>/`，每条记录先落库拿到自增 id，再把目录建出来——
 * 顺序反了就没法用 id 当目录名（库里那条记录也就没有稳定的落点）。
 *
 * ## 失败时必须回滚落盘
 * 建记录 → 建目录 → 校验manifest → 回填名称/版本 → 保存。
 * 中间任何一步抛错都要 `remove` 记录 + `rmSync` 目录，否则会留下一条
 * extPath 指向空目录的僵尸记录：列表里能看见、点开啥也没有、还删不掉。
 */

// ---------- 扩展（浏览器插件）存储辅助 ----------
function extUserDir(): string {
  return join(app.getPath('userData'), 'extensions')
}
function readExtensionManifest(dir: string): Record<string, unknown> | null {
  const mPath = join(dir, 'manifest.json')
  if (!existsSync(mPath)) return null
  try {
    return JSON.parse(readFileSync(mPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
/** 依次挑 128/96/64/48/32/16 的图标，都没有就拿第一个声明的 */
function pickExtensionIcon(manifest: Record<string, unknown> | null): string {
  const icons = (manifest?.icons ?? {}) as Record<string, string>
  if (!icons || Object.keys(icons).length === 0) return ''
  const key = ['128', '96', '64', '48', '32', '16'].find((k) => icons[k]) || Object.keys(icons)[0]
  return icons[key] ? String(icons[key]).replace(/^\//, '') : ''
}
/** 上传时的路径是 POSIX 风格（/a/b/c.js），落盘前要换成当前平台的分隔符 */
function normalizeRelPath(p: string): string {
  return p.split('/').join(sep)
}

export function registerExtensionRoutes(router: Router, deps: ExtensionRouteDeps): void {
  const { getDs, authMiddleware, writeLog } = deps

  router.get('/extensions', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ExtensionEntity)
    const list = await repo.find({ where: ownerScope(req), order: { id: 'DESC' } })
    res.json(
      list.map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        description: e.description,
        createdAt: e.createdAt
      }))
    )
  })

  router.post('/extensions', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const body = req.body || {}
    const repo = getDs().getRepository(ExtensionEntity)
    const ext = repo.create({ teamId: req.tid!, ownerId: req.uid!, name: '', version: '', description: null, extPath: '', iconPath: '' })
    const saved = await repo.save(ext)
    const dest = join(extUserDir(), String(saved.id))
    mkdirSync(dest, { recursive: true })
    try {
      if (body.localPath) {
        const src = String(body.localPath)
        if (!existsSync(src) || !statSync(src).isDirectory()) {
          throw new Error('本地路径不存在或不是目录')
        }
        if (!existsSync(join(src, 'manifest.json'))) {
          throw new Error('该目录不含 manifest.json，不是有效的扩展目录')
        }
        cpSync(src, dest, { recursive: true })
      } else if (Array.isArray(body.files) && body.files.length) {
        for (const f of body.files as Array<{ path: string; data: string }>) {
          if (!f || !f.path) continue
          const target = join(dest, normalizeRelPath(f.path))
          mkdirSync(join(target, '..'), { recursive: true })
          writeFileSync(target, Buffer.from(f.data || '', 'base64'))
        }
        if (!existsSync(join(dest, 'manifest.json'))) {
          throw new Error('上传内容中未找到 manifest.json，不是有效的扩展目录')
        }
      } else {
        throw new Error('请提供 localPath（本地已解压扩展目录）或 files（上传的目录文件列表）')
      }
      const manifest = readExtensionManifest(dest)
      if (!manifest) {
        throw new Error('目录中没有 manifest.json，无法识别为扩展')
      }
      saved.name = String(manifest.name || '未命名扩展').slice(0, 128)
      saved.version = String(manifest.version || '').slice(0, 32)
      saved.description = manifest.description ? String(manifest.description) : null
      saved.extPath = `extensions/${saved.id}`
      const iconRel = pickExtensionIcon(manifest)
      saved.iconPath = iconRel ? `extensions/${saved.id}/${iconRel}` : ''
      await repo.save(saved)
      await writeLog(req, 'create_extension', `添加扩展「${saved.name}」(#${saved.id})`)
      res.json({ id: saved.id, name: saved.name, version: saved.version, description: saved.description, createdAt: saved.createdAt })
    } catch (e) {
      await repo.remove(saved).catch(() => {})
      rmSync(dest, { recursive: true, force: true })
      res.status(400).json({ message: (e as Error).message })
    }
  })

  router.get('/extensions/:id/icon', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ExtensionEntity)
    const ext = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!ext || !ext.iconPath) return res.status(404).end()
    const abs = join(app.getPath('userData'), ext.iconPath)
    if (!existsSync(abs)) return res.status(404).end()
    res.sendFile(abs)
  })

  router.delete('/extensions/:id', authMiddleware, async (req: AuthedRequest, res: Response) => {
    const repo = getDs().getRepository(ExtensionEntity)
    const ext = await repo.findOne({ where: { id: Number(req.params.id), ...ownerScope(req) } })
    if (!ext) return res.status(404).json({ message: '扩展不存在' })
    const dest = join(extUserDir(), String(ext.id))
    // remove 后实体主键会被清空，先取出来写日志
    const { id: extId, name } = ext
    await repo.remove(ext)
    rmSync(dest, { recursive: true, force: true })
    await writeLog(req, 'delete_extension', `删除扩展「${name}」(#${extId})`)
    res.json({ ok: true })
  })
}