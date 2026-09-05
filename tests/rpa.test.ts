// RPA 变量替换纯函数自测（node --experimental-strip-types 直接跑，无需构建）
// 运行：node --experimental-strip-types tests/rpa.test.ts
import { substituteVars, substituteSteps, varsToArray, arrayToVars } from '../src/shared/rpa.ts'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.error(`FAIL  ${name}\n      got=${a}\n      want=${b}`)
  }
}

// substituteVars
eq('替换单个变量', substituteVars('a={{x}}', { x: '1' }), 'a=1')
eq('未定义保留原样', substituteVars('a={{x}}', {}), 'a={{x}}')
eq('允许空白', substituteVars('{{ x }}', { x: 'v' }), 'v')
eq('多占位符', substituteVars('{{a}}-{{b}}', { a: '1', b: '2' }), '1-2')
eq('混合已定义/未定义', substituteVars('{{a}} {{b}}', { a: '1' }), '1 {{b}}')
eq('空串直接返回', substituteVars('', { x: '1' }), '')
eq('null 变量安全', substituteVars('{{a}}', null as unknown as Record<string, string>), '{{a}}')

// substituteSteps：仅 url / value 参与替换
const steps = [
  { type: 'navigate', url: 'https://x.com/{{u}}' },
  { type: 'input', value: '{{v}}' },
  { type: 'click', x: 1, y: 2 },
  { type: 'wait', ms: 100 }
] as const
const out = substituteSteps(steps as unknown as Array<{ type: string; url?: string; value?: string }>, {
  u: 'p',
  v: 'txt'
})
eq('steps navigate.url 替换', out[0].url, 'https://x.com/p')
eq('steps input.value 替换', out[1].value, 'txt')
eq('steps click 透传', out[2], { type: 'click', x: 1, y: 2 })
eq('steps wait 透传', out[3], { type: 'wait', ms: 100 })
eq('steps 无变量原样返回', substituteSteps(steps as unknown as Array<{ type: string }>, {}), steps)

// varsToArray / arrayToVars 互转
eq(
  'varsToArray',
  varsToArray({ a: '1', b: '2' }),
  [
    { key: 'a', value: '1' },
    { key: 'b', value: '2' }
  ]
)
eq('arrayToVars 丢弃空 key', arrayToVars([{ key: 'a', value: '1' }, { key: ' ', value: '2' }]), { a: '1' })
eq('round-trip', arrayToVars(varsToArray({ a: '1', b: '2' })), { a: '1', b: '2' })
eq('空变量转数组', varsToArray(undefined), [])
eq('空数组转变量', arrayToVars([]), {})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
