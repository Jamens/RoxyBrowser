const Module = require('module')
const path = require('path')
const origResolve = Module._resolveFilename
// stub electron / browserManager / entities —— 只为验证路由注册与匹配顺序
const stubs = {
  electron: { app: { getPath: () => path.join(process.cwd(), '.tmp_fake_userdata') } },
  '../browserManager': {
    getRunningWindowIds: () => [],
    replayRpaScript: async () => 0,
    startRpaRecording: () => {},
    stopRpaRecording: () => [],
    isRpaRecording: () => false,
    rpaRecordCount: () => 0
  },
  '../rpaMarket': { MARKET_SCRIPTS: [{ id: 'm1', name: '预设', description: 'd', category: 'c', tags: [], steps: [{ type: 'navigate', url: '{{u}}' }], variables: { u: 'x' } }] },
  '../entities': { RpaScriptEntity: class {}, ProfileEntity: class {}, ExtensionEntity: class {} },
  '../../shared/rpa': require('./.tmp_rt/shared/rpa.js')
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  for (const [k, v] of Object.entries(stubs)) {
    if (request === k || request.endsWith(k.replace(/^\.\.\//, ''))) {
      if (request.includes('browserManager')) return stubs['../browserManager']
      if (request.includes('rpaMarket')) return stubs['../rpaMarket']
      if (request.includes('entities')) return stubs['../entities']
      if (request.includes('electron')) return stubs.electron
    }
  }
  return origLoad.apply(this, arguments)
}

const express = require('express')
const { registerRpaRoutes } = require('./.tmp_rt/main/routes/rpa.js')
const { registerExtensionRoutes } = require('./.tmp_rt/main/routes/extensions.js')

// 记录命中：authMiddleware 打标记，res.json 时读出来
let hit = null
const ds = { getRepository: () => ({ find: async () => [], findOne: async () => null, create: (o) => o, save: async (o) => ({ id: 7, createdAt: new Date(), ...o }), remove: async () => {} }) }

function makeApp() {
  const r = express.Router()
  const authMiddleware = (req, res, next) => { req.tid = 1; req.uid = 1; next() }
  // 用 monkey-patch res.json 捕获「哪个 handler 命中」：给每个 handler 前插探针
  registerRpaRoutes(r, { getDs: () => ds, authMiddleware, writeLog: async () => {} })
  registerExtensionRoutes(r, { getDs: () => ds, authMiddleware, writeLog: async () => {} })
  return r
}

const cases = [
  ['GET', '/rpa', 200], ['POST', '/rpa', 400],
  ['GET', '/rpa/market', 200], ['POST', '/rpa/market/install/m1', 200],
  ['POST', '/rpa/market/install/nope', 404],
  ['POST', '/rpa/import', 400],
  ['GET', '/rpa/export/1', 404], // 命中导出 handler（findOne → null），而非被 :id 抢先
  ['POST', '/rpa/record/start', 400], ['POST', '/rpa/record/stop', 400],
  ['GET', '/rpa/record/status', 400],
  ['GET', '/rpa/1', 404], ['PUT', '/rpa/1', 404], ['DELETE', '/rpa/1', 404],
  ['POST', '/rpa/1/run', 400], // 先校验 profileId，是原逻辑顺序
  ['GET', '/extensions', 200], ['POST', '/extensions', 400],
  ['GET', '/extensions/1/icon', 404], ['DELETE', '/extensions/1', 404]
]

;(async () => {
  const app = express()
  app.use(express.json())
  app.use(makeApp())
  const server = app.listen(0)
  await new Promise(r => server.on('listening', r))
  const port = server.address().port
  let fail = 0
  for (const [m, p, expect] of cases) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: m, headers: { 'content-type': 'application/json' },
      body: ['GET', 'DELETE'].includes(m) ? undefined : '{}'
    })
    const ok = res.status === expect
    if (!ok) { fail++; console.log(`  ✗ ${m} ${p} → ${res.status}（期望 ${expect}）  ${await res.text()}`) }
    else console.log(`  ✓ ${m} ${p} → ${res.status}`)
  }
  console.log(fail ? `\n${fail} 条不匹配` : '\n全部 18 条通过')
  server.close()
  process.exit(fail ? 1 : 0)
})()
