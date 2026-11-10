// RPA 变量替换纯函数自测（node --experimental-strip-types 直接跑，无需构建）
// 运行：node --experimental-strip-types tests/rpa.test.ts
import {
  substituteVars, substituteSteps, varsToArray, arrayToVars,
  variableLabel, RPA_VARIABLE_LABELS, mergeRunVariables
} from '../src/shared/rpa.ts'

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

// variableLabel：界面标签必须给人读，不能再把 {{key}} 模板字面量当字段名
eq('市场变量名 keyword → 中文标签', variableLabel('keyword'), '搜索关键词')
eq('市场变量名 productUrl → 中文标签', variableLabel('productUrl'), '商品链接')
eq('自定义变量名回退为原名', variableLabel('my_custom'), 'my_custom')
eq('自定义变量名不带模板括号', /[{}]/.test(variableLabel('my_custom')), false)
eq('空变量名回退为空串', variableLabel(''), '')
eq('标签表覆盖 9 个市场变量', Object.keys(RPA_VARIABLE_LABELS).length, 9)
eq('标签值均不含模板括号', Object.values(RPA_VARIABLE_LABELS).every((v) => !/[{}]/.test(v)), true)

// mergeRunVariables：空覆盖值必须回退到脚本默认值
const baseVars = { keyword: 'wireless earbuds', query: 'roxy browser' }
eq('无覆盖 → 原样默认值', mergeRunVariables(baseVars, undefined), baseVars)
eq('覆盖为 null → 原样默认值', mergeRunVariables(baseVars, null), baseVars)
eq('覆盖为空对象 → 原样默认值', mergeRunVariables(baseVars, {}), baseVars)
eq('非空覆盖 → 用新值', mergeRunVariables(baseVars, { keyword: 'iphone' }), { keyword: 'iphone', query: 'roxy browser' })
eq('空串覆盖 → 回退默认值（本 bug 的核心）', mergeRunVariables(baseVars, { keyword: '' }), baseVars)
eq('纯空白覆盖 → 回退默认值', mergeRunVariables(baseVars, { keyword: '   ' }), baseVars)
eq('undefined 覆盖 → 回退默认值', mergeRunVariables(baseVars, { keyword: undefined }), baseVars)
eq('值本身不做 trim', mergeRunVariables({ a: 'd' }, { a: ' x ' }), { a: ' x ' })
eq('覆盖里多出的键不凭空新增变量', mergeRunVariables(baseVars, { injected: 'x' } as Record<string, string>), baseVars)
eq('base 为空时安全', mergeRunVariables(null, { keyword: 'x' }), {})
eq('多变量只覆盖其中一个', mergeRunVariables(baseVars, { query: 's' }), { keyword: 'wireless earbuds', query: 's' })

// 端到端：清空输入框后，URL 必须还是带默认关键词，而不是 ?k=
const amazonStep = [{ type: 'navigate', url: 'https://www.amazon.com/s?k={{keyword}}' }]
eq(
  '清空覆盖后回放 URL 保留默认关键词',
  substituteSteps(amazonStep, mergeRunVariables({ keyword: 'wireless earbuds' }, { keyword: '' }))[0].url,
  'https://www.amazon.com/s?k=wireless earbuds'
)
eq(
  '改成新关键词后回放 URL 同步变化',
  substituteSteps(amazonStep, mergeRunVariables({ keyword: 'wireless earbuds' }, { keyword: 'iphone' }))[0].url,
  'https://www.amazon.com/s?k=iphone'
)
// 旧实现的反证：直接把空串当变量表用，确实会得到空搜索 URL
eq('旧整体替换语义会把 URL 变成 ?k=', substituteVars('https://www.amazon.com/s?k={{keyword}}', { keyword: '' }), 'https://www.amazon.com/s?k=')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
