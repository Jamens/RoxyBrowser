// 最小 HTTP 正向代理：把请求转发到目标站点。
// 用途：让应用的「代理检测」能真正走通 ip-api，从而在真机上端到端触发出口漂移逻辑。
// 用法：node scripts/tiny-forward-proxy.cjs [port]
const http = require('http')

const PORT = Number(process.argv[2] || 18080)
const server = http.createServer((req, res) => {
  let target
  try {
    target = new URL(req.url)
  } catch {
    res.writeHead(400); res.end('bad url'); return
  }
  const opts = {
    host: target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: target.host }
  }
  const up = http.request(opts, (r) => {
    res.writeHead(r.statusCode || 502, r.headers)
    r.pipe(res)
  })
  up.on('error', (e) => { res.writeHead(502); res.end('upstream error: ' + e.message) })
  req.pipe(up)
})
server.listen(PORT, '127.0.0.1', () => {
  console.log('[tiny-proxy] listening on 127.0.0.1:' + PORT)
})
