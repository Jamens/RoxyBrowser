// 离线单测：trackers.ts（追踪器屏蔽 2.0：主机清单 + 子资源路径签名 + 私有网段 / 协议保护）
// 运行：先 `tsc src/shared/trackers.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_tr`
//      再 `node tests/trackers.test.cjs`
const { isTrackerUrl, isTrackerRequest } = require('../.tmp_tr/trackers.js')

let failed = 0
function check(name, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

// ===== 主机清单（isTrackerUrl 既有行为保持）=====
check('主机命中 google-analytics.com', isTrackerUrl('https://google-analytics.com/x') === true)
check('子域命中 x.doubleclick.net', isTrackerUrl('https://x.doubleclick.net/y') === true)
check('主域 facebook.com 不误拦', isTrackerUrl('https://facebook.com/') === false)
check('wss 主机命中 hotjar.com', isTrackerUrl('wss://hotjar.com/socket') === true)
check('blob: 不是追踪', isTrackerUrl('blob:xxx') === false)
check('非法 URL 不是追踪', isTrackerUrl('not a url') === false)

// ===== isTrackerRequest（2.0 统一判定）=====
// 路径签名：第一方 / CDN 托管的追踪 SDK（非顶层文档）
check('第一方 /gtag/js 拦截', isTrackerRequest({ url: 'https://shop.example.com/gtag/js', resourceType: 'script' }) === true)
check('第一方 /matomo.php 拦截', isTrackerRequest({ url: 'https://shop.example.com/matomo.php?idsite=1', resourceType: 'xhr' }) === true)
check('CDN /analytics.js 拦截', isTrackerRequest({ url: 'https://cdn.example.com/analytics.js', resourceType: 'script' }) === true)
check('路径签名大小写不敏感', isTrackerRequest({ url: 'https://shop.example.com/GTAG/JS', resourceType: 'script' }) === true)
// 顶层文档不被路径签名误杀
check('mainFrame 首页不误拦', isTrackerRequest({ url: 'https://shop.example.com/', resourceType: 'mainFrame' }) === false)
check('mainFrame 带 gtag 路径不误拦', isTrackerRequest({ url: 'https://shop.example.com/gtag/js', resourceType: 'mainFrame' }) === false)
check('正常商品页不误拦', isTrackerRequest({ url: 'https://shop.example.com/products', resourceType: 'mainFrame' }) === false)
// WebSocket / fetch / beacon 走主机清单
check('wss 主机命中拦截', isTrackerRequest({ url: 'wss://hotjar.com/socket', resourceType: 'websocket' }) === true)
check('analytics.google.com/g/collect 拦截', isTrackerRequest({ url: 'https://analytics.google.com/g/collect', resourceType: 'ping' }) === true)
// 私有网段 / 本地保护
check('localhost 不误拦', isTrackerRequest({ url: 'http://localhost:3000/gtag/js', resourceType: 'script' }) === false)
check('127.0.0.1 不误拦', isTrackerRequest({ url: 'http://127.0.0.1/matomo.php', resourceType: 'xhr' }) === false)
check('192.168 私有网段不误拦', isTrackerRequest({ url: 'http://192.168.1.5/analytics.js' }) === false)
check('10.x 私有网段不误拦', isTrackerRequest({ url: 'http://10.0.0.2/gtag/js', resourceType: 'script' }) === false)
// 非网络协议放过
check('blob: 放过', isTrackerRequest({ url: 'blob:https://x/yyy', resourceType: 'script' }) === false)
check('data: 放过', isTrackerRequest({ url: 'data:text/html,xxx' }) === false)
check('about:blank 放过', isTrackerRequest({ url: 'about:blank' }) === false)
// 畸形 / 缺字段
check('空对象放过', isTrackerRequest({}) === false)
check('无 url 放过', isTrackerRequest({ resourceType: 'script' }) === false)
// 用户自定义 extraHosts
check('extraHosts 命中', isTrackerRequest({ url: 'https://my-tracker.test/x', resourceType: 'script' }, ['my-tracker.test']) === true)
check('无 extraHosts 不命中', isTrackerRequest({ url: 'https://my-tracker.test/x', resourceType: 'script' }) === false)

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
