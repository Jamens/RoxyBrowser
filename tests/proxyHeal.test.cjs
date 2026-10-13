// 离线单测：代理故障自愈的纯判定（shared/proxyHeal.ts）
// 核心不变量（三条不可让步的安全约束）：
//   1) 绝不把两个环境换绑到同一个出口 IP
//   2) 绝不把环境换绑到与它原代理相同的出口 IP
//   3) 必须有连续失败阈值——单次失败不动手（网络抖动会让环境 IP 反复跳变，
//      那本身就是极强的自动化信号且会触发平台风控）
// 运行：先 `node node_modules/typescript/bin/tsc src/shared/proxyHeal.ts --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --rootDir src --outDir .tmp_ph`
//      再 `node tests/proxyHeal.test.cjs`
const {
  shouldHealProfile,
  pickReplacementProxy,
  planProxyHealing,
  bumpFailureCount,
} = require('../.tmp_ph/shared/proxyHeal.js')

let failed = 0
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`)
  if (!cond) failed++
}

const P = (o) => ({
  id: 0, teamId: 1, type: 'http', host: 'h', port: 8080,
  country: 'US', region: 'CA', status: 'active', exitIp: '', expiresAt: null, ...o
})
const E = (o) => ({ id: 0, teamId: 1, name: 'env', proxyId: null, status: 'idle', ...o })

// ============ 1) bumpFailureCount：成功清零、失败递增 ============
{
  const c = new Map()
  check('首次失败计数为 1', bumpFailureCount(c, 1, false) === 1)
  check('连续第二次为 2', bumpFailureCount(c, 1, false) === 2)
  check('成功后清零', bumpFailureCount(c, 1, true) === 0)
  check('成功后 key 被移除', !c.has(1))
  // 抖动场景：失败→成功→失败 必须重新从 1 开始，不能累加
  bumpFailureCount(c, 2, false)
  bumpFailureCount(c, 2, true)
  check('抖动后重新计数（不累加历史）', bumpFailureCount(c, 2, false) === 1)
}

// ============ 2) shouldHealProfile：阈值闸门 ============
{
  const counts = new Map([[1, 1]])
  const p = E({ proxyId: 1 })
  check('未达阈值不动手', shouldHealProfile(p, 1, counts, 2).heal === false)
  check('未达阈值给出原因', /未达阈值/.test(shouldHealProfile(p, 1, counts, 2).reason))

  const counts2 = new Map([[1, 3]])
  check('达到阈值才动手', shouldHealProfile(p, 1, counts2, 2).heal === true)

  check('未绑定该失效代理的环境不动手', shouldHealProfile(E({ proxyId: 9 }), 1, counts2, 2).heal === false)
  // 运行中的环境不换绑：换代理需重启窗口，会打断用户正在做的操作
  const r = shouldHealProfile(E({ proxyId: 1, status: 'running' }), 1, counts2, 2)
  check('运行中的环境不自动换绑', r.heal === false && /运行中/.test(r.reason))

  check('阈值为 1 时首次失败即动手', shouldHealProfile(p, 1, new Map([[1, 1]]), 1).heal === true)
}

// ============ 3) pickReplacementProxy：约束 1 与 2 ============
{
  const a = P({ id: 10, exitIp: '1.1.1.1' })
  const b = P({ id: 11, exitIp: '2.2.2.2' })
  // 约束 1：1.1.1.1 已被别的环境占用 → 不能选它
  const r1 = pickReplacementProxy([a, b], new Set(['1.1.1.1']), '9.9.9.9')
  check('约束1：跳过出口IP已被占用的代理', r1.proxy && r1.proxy.id === 11, `选中 #${r1.proxy?.id}`)

  // 约束 2：新代理出口与原代理相同 → 等于没换，不选
  const r2 = pickReplacementProxy([P({ id: 12, exitIp: '3.3.3.3' })], new Set(), '3.3.3.3')
  check('约束2：不换到与原代理相同的出口IP', r2.proxy === null && /已被占用|相同/.test(r2.reason))

  // 两者都冲突 → 必须返回 null 并说明原因，绝不将就
  const r3 = pickReplacementProxy([a], new Set(['1.1.1.1']), '9.9.9.9')
  check('无合规替代时返回 null（宁可不动）', r3.proxy === null && r3.reason.length > 0)

  check('候选池为空时返回 null', pickReplacementProxy([], new Set(), '1.1.1.1').proxy === null)
  check('候选全是 invalid 时返回 null', pickReplacementProxy([P({ status: 'invalid' })], new Set(), '1.1.1.1').proxy === null)

  // 兜底：未巡检过（无 exitIp）的代理应放行，否则自愈永远无法生效
  const r4 = pickReplacementProxy([P({ id: 13, exitIp: '' })], new Set(), '1.1.1.1')
  check('未巡检过（无出口IP）的代理可作为兜底', r4.proxy && r4.proxy.id === 13)
  // 兜底应排在安全选项之后：有安全选项时绝不选无 exitIp 的
  const r5 = pickReplacementProxy([P({ id: 14, exitIp: '' }), b], new Set(['1.1.1.1']), '9.9.9.9')
  check('有安全选项时不选未巡检的代理', r5.proxy.id === 11)
}

// ============ 4) planProxyHealing：端到端且不制造关联 ============
{
  const bad = P({ id: 1, host: 'bad.proxy', port: 1080, exitIp: '5.5.5.5', status: 'invalid' })
  const spare1 = P({ id: 2, host: 's1', port: 1, exitIp: '6.6.6.6' })
  const spare2 = P({ id: 3, host: 's2', port: 2, exitIp: '7.7.7.7' })
  const all = [bad, spare1, spare2]
  const counts = new Map([[1, 5]])

  // 场景 A：两个环境共用同一个失效代理 → 必须换到**不同**的代理
  const profiles = [E({ id: 100, name: 'envA', proxyId: 1 }), E({ id: 101, name: 'envB', proxyId: 1 })]
  const dec = planProxyHealing([bad], profiles, all, counts, { threshold: 2 })
  check('两个受影响环境都会产生决策', dec.length === 2)
  check('两个环境换到了不同代理（绝不制造共用IP）', dec[0].toProxyId !== dec[1].toProxyId,
    `#${dec[0].toProxyId} 与 #${dec[1].toProxyId}`)
  check('决策不含原代理自身', dec.every((d) => d.fromProxyId === 1 && d.toProxyId !== 1))

  // 场景 B：池中只剩一个可用代理，两环境必须**只换绑一个**（另一个宁可不动）
  const onlyOne = [bad, spare1]
  const dec2 = planProxyHealing([bad], profiles, onlyOne, counts, { threshold: 2 })
  const healable = dec2.filter((d) => d.toProxyId !== null)
  check('池中仅一个可用代理时只换绑一个环境', healable.length === 1,
    `换绑 ${healable.length} 个，另有 ${dec2.length - healable.length} 个保持不动`)
  check('保持不动的环境给出明确原因', dec2.find((d) => d.toProxyId === null).reason.length > 0)

  // 场景 C：未达阈值 → 一条决策都不该产生
  const dec3 = planProxyHealing([bad], profiles, all, new Map([[1, 1]]), { threshold: 2 })
  check('未达阈值不产生任何决策', dec3.length === 0)

  // 场景 D：只影响绑了该代理的环境，其他团队/其他代理的环境不受牵连
  const otherTeam = [E({ id: 200, teamId: 2, proxyId: 1 })]
  const dec4 = planProxyHealing([bad], otherTeam, [bad, ...all.slice(1).map((x) => ({ ...x, teamId: 1 }))], counts, { threshold: 2 })
  check('其他团队的环境不受影响', dec4.length === 0)

  // 场景 E：已过期的备选代理不应被选中
  const expiredSpare = { ...spare1, expiresAt: new Date(Date.now() - 86400000) }
  const dec5 = planProxyHealing([bad], [E({ id: 300, proxyId: 1 })], [bad, expiredSpare, spare2], counts, { threshold: 2 })
  check('跳过已过期的备选代理', dec5[0]?.toProxyId === 3, `选中 #${dec5[0]?.toProxyId}`)
}

// ============ 5) 已占用出口IP需包含失效代理自己的 IP ============
{
  // 场景：失效代理 A 仍绑在环境上，备选代理 B 的出口 IP 与 A 相同。
  // 若不把 A 的 exitIp 计入已占用，B 会被选中 —— 等于把环境换回同一个 IP。
  const bad = P({ id: 1, exitIp: '8.8.8.8', status: 'invalid' })
  const sameIp = P({ id: 2, exitIp: '8.8.8.8' })
  const other = P({ id: 3, exitIp: '9.9.9.9' })
  const dec = planProxyHealing([bad], [E({ id: 1, proxyId: 1 })], [bad, sameIp, other], new Map([[1, 5]]), { threshold: 2 })
  check('不换到与失效代理同出口IP的备选', dec[0]?.toProxyId === 3, `选中 #${dec[0]?.toProxyId}`)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
if (failed) process.exit(1)
