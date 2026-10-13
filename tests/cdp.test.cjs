// 离线单测：CDP 调试端口的纯逻辑（端口分配 / 规整 / 过滤 / endpoint 拼装）
// 核心不变量：
//   1) 端口被占用时必须**递增顺延**，绝不返回已占用的端口
//   2) 用户填的端口越界（0 / 负数 / 超范围 / 非数字）必须被规整而非照用
//   3) endpoint 只允许 127.0.0.1 —— CDP 等同完整浏览器控制权，绝不能暴露到局域网
//   4) 只保留 page 类型 target（service_worker / background_page 对用户无意义）
// 运行：先 `node node_modules/typescript/bin/tsc src/shared/cdp.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_cdp`
//      再 `node tests/cdp.test.cjs`
const {
  DEFAULT_CDP_PORT,
  clampPort,
  findAvailablePort,
  buildCdpEndpoint,
  pickPageTargets,
} = require('../.tmp_cdp/shared/cdp.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

/** 构造一个「指定端口已被占用」的探测桩（与真实 probePort 同签名：port → 是否空闲） */
function occupiedSet(...ports) {
  const busy = new Set(ports)
  return async (p) => !busy.has(p)
}

async function main() {
  // ============ 1) clampPort：越界输入规整 ============
  check('正常值原样返回', clampPort(39222) === 39222)
  check('字符串数字被接受', clampPort('39222') === 39222)
  check('小数取整', clampPort(39222.7) === 39222)
  // Windows 上端口 0 表示「随机分配」，而我们要给外部工具一个确定地址，故规整掉
  check('0 回落到默认（Windows 0 = 随机，不接受）', clampPort(0) === DEFAULT_CDP_PORT)
  check('负数回落默认', clampPort(-1) === DEFAULT_CDP_PORT)
  check('超范围回落默认', clampPort(99999) === DEFAULT_CDP_PORT)
  check('NaN 回落默认', clampPort(NaN) === DEFAULT_CDP_PORT)
  check('undefined 回落默认', clampPort(undefined) === DEFAULT_CDP_PORT)
  check('非数字字符串回落默认', clampPort('abc') === DEFAULT_CDP_PORT)
  check('默认值本身稳定', clampPort(DEFAULT_CDP_PORT) === DEFAULT_CDP_PORT)

  // ============ 2) 首选空闲则直接采用 ============
  const p1 = await findAvailablePort(39300, occupiedSet())
  check('首选端口空闲时直接采用', p1 === 39300, `得到 ${p1}`)

  // ============ 3) 被占用 → 递增顺延 ============
  const p2 = await findAvailablePort(39300, occupiedSet(39300, 39301, 39302))
  check('连续占用时顺延到首个空闲端口', p2 === 39303, `得到 ${p2}`)

  // ============ 4) 乱序占用也能找到空位 ============
  const p3 = await findAvailablePort(39400, occupiedSet(39400, 39402))
  check('跳号占用时取第一个空位', p3 === 39401, `得到 ${p3}`)

  // ============ 5) 首选段扫完 → 回到默认段重试 ============
  // 首选段只扫 100 个（39400..39499），全部占满后必须回落到默认段而不是直接失败。
  // 注意桩的语义是「返回是否**空闲**」，不是「是否忙碌」——写反会让所有端口都被判为空闲。
  const allBusy = async (p) => !(p >= 39400 && p < 39500)
  const p4 = await findAvailablePort(39400, allBusy)
  check(
    '首选段耗尽后回落默认段',
    p4 >= DEFAULT_CDP_PORT && p4 < DEFAULT_CDP_PORT + 100 && !(p4 >= 39400 && p4 < 39500),
    `得到 ${p4}`
  )

  // ============ 6) 真正无端口可用时必须抛错而非死循环 ============
  // 这是关键安全闸：找不到端口一定要失败并让用户知道，绝不能静默返回被占用的端口
  const nothingFree = async () => false
  let threw = false
  try {
    await findAvailablePort(39222, nothingFree)
  } catch {
    threw = true
  }
  check('全部端口占用时抛错（绝不返回已占用端口）', threw)

  // ============ 7) endpoint 只允许回环地址 ============
  const ep = buildCdpEndpoint(39222)
  check('endpoint 形如 http://127.0.0.1:39222', ep === 'http://127.0.0.1:39222')
  check('endpoint 不含 0.0.0.0', !ep.includes('0.0.0.0'))
  check('endpoint 不含 localhost（避免 hosts 劫持与 IPv6 解析差异）', !ep.includes('localhost'))

  // ============ 8) target 过滤 ============
  const targets = [
    { id: '1', type: 'page', title: '环境A', url: 'https://a.com', profileId: 1 },
    { id: '2', type: 'service_worker', title: 'sw', url: 'https://a.com/sw.js', profileId: 1 },
    { id: '3', type: 'background_page', title: 'bg', url: 'chrome-extension://x', profileId: null },
    { id: '4', type: 'page', title: '环境B', url: 'https://b.com', profileId: 2 },
  ]
  const pages = pickPageTargets(targets)
  check('只保留 page 类型', pages.length === 2, `剩 ${pages.length} 个`)
  check('保留环境的 target', pages.every((t) => t.type === 'page'))
  check('profileId 正确透传', pages[0].profileId === 1 && pages[1].profileId === 2)
  check('空数组不报错', pickPageTargets([]).length === 0)
  check('无 page 时返回空数组', pickPageTargets([targets[1]]).length === 0)

  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
