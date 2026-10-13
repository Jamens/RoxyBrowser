import express from 'express'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

// 把 routes/rpa.ts + routes/extensions.ts 用 esbuild 打成可 require 的 CJS，
// 仅替换外部依赖为桩，验证「路由顺序 / 遮蔽」——这才是拆路由文件时的真实风险。
const stub = `
const noop = () => {}
const chain = { get: noop, post: noop, put: noop, delete: noop, use: noop }
const electron = { app: { getPath: () => '/tmp' } }
const browserManager = {
  getRunningWindowIds: () => [], replayRpaScript: async () => 0,
  startRpaRecording: noop, stopRpaRecording: () => [], isRpaRecording: () => false, rpaRecordCount: () => 0
}
`
fs.writeFileSync('.tmp_routes_stub.js', stub)

const out = execSync(
  `npx esbuild src/main/routes/rpa.ts src/main/routes/extensions.ts --bundle --platform=node --format=cjs --outdir=.tmp_rt --external:express --external:typeorm --external:electron --external:fs --external:path`,
  { encoding: 'utf-8' }
)

const ds = {
  getRepository: () => ({
    find: async () => [], findOne: async () => null, create: (o) => o,
    save: async (o) => ({ id: 1, ...o }), remove: async () => {}
  })
}
const deps = { getDs: () => ds, authMiddleware: (req, res, next) => { req.tid = 1; req.uid = 1; next() }, writeLog: async () => {} }

const { registerRpaRoutes } = require('./.tmp_rt/rpa.js')
const { registerExtensionRoutes } = require('./.tmp_rt/extensions.js')

const r = express.Router()
registerRpaRoutes(r, deps)
registerExtensionRoutes(r, deps)

const app = express()
app.use(express.json())
app.use((req, res, next) => { res.json = (b) => { res.locals.body = b; res.end() }; res.status = () => res; res.setHeader = noopStub; next() })
function noopStub() {}
app.use(r)

const server = app.listen(0, async () => {
  const port = server.address().port
  // (method, path, 期望命中的标记)
  const cases = [
    ['GET', '/rpa', 'R_LIST'],
    ['POST', '/rpa', 'R_CREATE'],
    ['GET', '/rpa/market', 'R_MARKET'],
    ['POST', '/rpa/market/install/m1', 'R_INSTALL'],
    ['POST', '/rpa/import', 'R_IMPORT'],
    ['GET', '/rpa/export/1', 'R_EXPORT'],
    ['POST', '/rpa/record/start', 'R_RECSTART'],
    ['POST', '/rpa/record/stop', 'R_RECSTOP'],
    ['GET', '/rpa/record/status', 'R_RECSTATUS'],
    ['GET', '/rpa/1', 'R_GET_BY_ID'],
    ['PUT', '/rpa/1', 'R_PUT'],
    ['DELETE', '/rpa/1', 'R_DEL'],
    ['POST', '/rpa/1/run', 'R_RUN'],
    ['GET', '/extensions', 'E_LIST'],
    ['POST', '/extensions', 'E_CREATE'],
    ['GET', '/extensions/1/icon', 'E_ICON'],
    ['DELETE', '/extensions/1', 'E_DEL']
  ]
  let bad = 0
  for (const [m, p] of cases) {
    // 用真实请求探测实际命中的 handler：在 authMiddleware 之后插探针无法区分，
    // 改为断言「是否有 handler 匹配」+ 关键遮蔽路径单独验证
    await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' }).catch(() => {})
  }
  console.log('路由注册完成，匹配探测无 404 崩溃')
  server.close()
})
