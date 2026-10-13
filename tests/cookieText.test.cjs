// 离线单测：cookieText.ts（Cookie DTO 映射 + 多格式 Cookie 文本解析）
// 这段解析逻辑原先埋在 server.ts 里、零测试覆盖，而三种格式的边界很琐碎
// （tab 字段数、#HttpOnly_ 前缀、hostOnly 与前导点Domain 的关系、max-age 相对时间）。
// 运行：
//   node node_modules/typescript/bin/tsc src/main/cookieText.ts --module commonjs --target es2020 \
//     --moduleResolution node --esModuleInterop --skipLibCheck --outDir .tmp_ck
//   node tests/cookieText.test.cjs
const assert = require('assert')
// 产物路径带 main/ 前缀：tsc 以 rootDir=src 为基准保留 main/ shared/ 层级
const { mapCookie, parseCookieText } = require('../.tmp_ck/main/cookieText.js')

let pass = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok  -', name)
  } catch (e) {
    console.error('  FAIL -', name, '\n      ', e.message)
    process.exitCode = 1
  }
}

console.log('parseCookieText · Netscape 格式')
check('7 段 tab 字段正确解析', () => {
  const { cookies } = parseCookieText('.example.com\tTRUE\t/\tTRUE\t1700000000\tsid\tabc123')
  assert.strictEqual(cookies.length, 1)
  assert.strictEqual(cookies[0].domain, '.example.com')
  assert.strictEqual(cookies[0].name, 'sid')
  assert.strictEqual(cookies[0].value, 'abc123')
  assert.strictEqual(cookies[0].path, '/')
  assert.strictEqual(cookies[0].secure, true)
  // flag=TRUE 表示含子域 → hostOnly 应为 false
  assert.strictEqual(cookies[0].hostOnly, false)
  assert.strictEqual(cookies[0].expirationDate.getTime(), 1700000000 * 1000)
})
check('#HttpOnly_ 前缀被识别并剥离', () => {
  const { cookies } = parseCookieText('#HttpOnly_.example.com\tFALSE\t/\tFALSE\t0\ttok\tv')
  assert.strictEqual(cookies[0].name, 'tok')
  assert.strictEqual(cookies[0].httpOnly, true)
  assert.strictEqual(cookies[0].hostOnly, true) // flag=FALSE → 仅主机
})
check('exp=0 → 无过期时间', () => {
  const { cookies } = parseCookieText('.a.com\tFALSE\t/\tFALSE\t0\tn\tv')
  assert.strictEqual(cookies[0].expirationDate, null)
})
check('多行混合解析，注释行被跳过', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '// 由浏览器导出',
    '.a.com\tFALSE\t/\tFALSE\t0\tk1\tv1',
    '',
    '.b.com\tFALSE\t/x\tFALSE\t0\tk2\tv2'
  ].join('\n')
  const { cookies, failed } = parseCookieText(text)
  assert.strictEqual(cookies.length, 2)
  assert.strictEqual(cookies[1].path, '/x')
  assert.deepStrictEqual(failed, [])
})

console.log('parseCookieText · Set-Cookie 风格')
check('完整属性解析', () => {
  const { cookies } = parseCookieText('name=v; Domain=.example.com; Path=/app; Secure; HttpOnly; SameSite=lax')
  const c = cookies[0]
  assert.strictEqual(c.name, 'name')
  assert.strictEqual(c.value, 'v')
  assert.strictEqual(c.domain, '.example.com')
  assert.strictEqual(c.path, '/app')
  assert.strictEqual(c.secure, true)
  assert.strictEqual(c.httpOnly, true)
  assert.strictEqual(c.sameSite, 'lax')
  // 带前导点 → 含子域 → hostOnly=false
  assert.strictEqual(c.hostOnly, false)
})
check('Domain 无前导点 → hostOnly=true', () => {
  const { cookies } = parseCookieText('a=b; Domain=example.com')
  assert.strictEqual(cookies[0].hostOnly, true)
})
check('Expires 解析为时间戳', () => {
  const { cookies } = parseCookieText('a=b; Domain=x.com; Expires=Thu, 01 Jan 1970 00:00:10 GMT')
  assert.strictEqual(cookies[0].expirationDate.getTime(), 10000)
})
check('max-age 按当前时间换算为相对过期', () => {
  const { cookies } = parseCookieText('a=b; Domain=x.com; Max-Age=60')
  const d = cookies[0].expirationDate.getTime()
  assert.ok(Math.abs(d - (Date.now() + 60000)) < 5000, 'max-age=60 应约为 60 秒后')
})
check('值里含 = 号不被截断', () => {
  const { cookies } = parseCookieText('a=b=c=d; Domain=x.com')
  assert.strictEqual(cookies[0].value, 'b=c=d')
})
check('缺 Domain 的行进 failed，不抛错', () => {
  const { cookies, failed } = parseCookieText('a=b; Path=/')
  assert.strictEqual(cookies.length, 0)
  assert.strictEqual(failed.length, 1)
})

console.log('parseCookieText · JSON（EditThisCookie / 导出格式）')
check('数组格式', () => {
  const { cookies } = parseCookieText('[{"domain":".x.com","name":"n","value":"v","secure":true,"hostOnly":false}]')
  assert.strictEqual(cookies[0].domain, '.x.com')
  assert.strictEqual(cookies[0].secure, true)
  assert.strictEqual(cookies[0].hostOnly, false)
  // hostOnly 缺省时应为 true（浏览器默认仅主机）
})
check('单对象格式', () => {
  const { cookies } = parseCookieText('{"domain":".y.com","name":"n2","value":"v2"}')
  assert.strictEqual(cookies.length, 1)
  assert.strictEqual(cookies[0].hostOnly, true)
})
check('缺 name 的项进 failed', () => {
  const { cookies, failed } = parseCookieText('[{"domain":".x.com","value":"v"},{"domain":".y.com","name":"ok","value":"v"}]')
  assert.strictEqual(cookies.length, 1)
  assert.strictEqual(failed.length, 1)
})
check('非法 JSON 返回失败提示而非抛异常', () => {
  const { cookies, failed } = parseCookieText('{not json')
  assert.strictEqual(cookies.length, 0)
  assert.deepStrictEqual(failed, ['JSON 解析失败'])
})

console.log('parseCookieText · 边界')
check('空串返回空结果', () => {
  assert.deepStrictEqual(parseCookieText(''), { cookies: [], failed: [] })
  assert.deepStrictEqual(parseCookieText('   \n  '), { cookies: [], failed: [] })
})
check('BOM 被剥离', () => {
  const { cookies } = parseCookieText('﻿.x.com\tFALSE\t/\tFALSE\t0\tn\tv')
  assert.strictEqual(cookies.length, 1)
})
check('无法识别的行进 failed 并截断到 80 字符', () => {
  const junk = 'x'.repeat(200)
  const { failed } = parseCookieText(junk)
  assert.strictEqual(failed.length, 1)
  assert.strictEqual(failed[0].length, 80)
})

console.log('mapCookie · DTO 映射与默认值兜底')
check('缺省字段兜底为 path=/ sameSite=unspecified hostOnly=false', () => {
  const d = mapCookie({ id: 1, profileId: 2, domain: '.x.com', name: 'n', value: 'v', createdAt: new Date(0) })
  assert.strictEqual(d.path, '/')
  assert.strictEqual(d.sameSite, 'unspecified')
  assert.strictEqual(d.hostOnly, false)
  assert.strictEqual(d.secure, false)
  assert.strictEqual(d.expirationDate, null)
  assert.strictEqual(d.createdAt, new Date(0).toISOString())
})
check('expirationDate 转 ISO 字符串', () => {
  const d = mapCookie({ id: 1, profileId: 2, domain: 'x', name: 'n', value: 'v', expirationDate: new Date(1700000000000), createdAt: new Date(0) })
  assert.strictEqual(d.expirationDate, new Date(1700000000000).toISOString())
})

console.log(`\n通过 ${pass} 项`)
