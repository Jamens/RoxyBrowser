// AI Agent 模型选择链路的源码级守卫。
//
// ## 要锁住什么
//
// 用户报障：「设置里模型不能自定义，都是写死的；换了自定义模型等下又自动恢复」。
// 实测排查发现三个真问题，都很容易被"顺手改回去"，逐条钉死：
//
// 1. **模型匹配不能只比 base 名**（src/main/agent/ollama.ts）
//    原实现 `m.split(':')[0] === model.split(':')[0]` 会把没装的模型误判成已装：
//    本机装的是 qwen2.5:3b，配置写的是 qwen2.5:7b → base 名相同 → 判定「已安装」
//    → 设置页「检测连接」显示「模型就绪」，真正对话时 Ollama 按**完整名**找模型
//    → `404 {"error":"model \"qwen2.5:7b\" not found"}`。
//    判定逻辑必须走共享的 isModelInstalled（完整名匹配，只允许「省略 tag ≡ :latest」）。
//
// 2. **AutoComplete 不能按输入框内容过滤候选**（src/renderer/src/pages/Settings.tsx）
//    模型名是**完整标识符**而不是搜索词。输入框里本来就有当前配置的模型名，
//    一旦按输入框内容 filterOption，候选会被全滤光 → 下拉显示「未检测到已安装模型」，
//    而本机明明装了 4 个。必须恒定显示全部已装模型。
//
// 3. **notFoundContent 必须恒为非空字符串**
//    rc-select 里 `emptyListContent = !notFoundContent && emptyOptions` ——
//    选项为空且 notFoundContent 为空时**禁止展开下拉**，于是 onOpenChange 永不触发，
//    形成「下拉开不了 → 加载不到模型 → 还是开不了」的死锁。
//
// 用法：node tests/aiAgentModelSelect.test.cjs
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const settingsSrc = fs.readFileSync(path.join(root, 'src/renderer/src/pages/Settings.tsx'), 'utf8')
const ollamaSrc = fs.readFileSync(path.join(root, 'src/main/agent/ollama.ts'), 'utf8')
const assistantSrc = fs.readFileSync(path.join(root, 'src/main/routes/assistant.ts'), 'utf8')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✅', name)
  } catch (e) {
    console.error('  ❌', name)
    console.error('     ', e.message)
    process.exitCode = 1
  }
}

// ===== 1. 模型匹配必须走共享的完整名判定 =====
t('探活不再用「只比 base 名」的宽松比较', () => {
  assert.ok(
    !/baseOf\s*\(/.test(ollamaSrc),
    'ollama.ts 里又出现了 baseOf 比较 —— 同 base 不同 tag 会被误判成已安装'
  )
  assert.ok(
    /isModelInstalled\(/.test(ollamaSrc),
    'ollama.ts 应改用共享的 isModelInstalled（完整名匹配）'
  )
})

t('探活引入了共享的模型名判定', () => {
  assert.ok(
    /from\s+'\.\.\/\.\.\/shared\/ollamaModels'/.test(ollamaSrc),
    'ollama.ts 应从 @shared/ollamaModels 引入 isModelInstalled'
  )
})

// ===== 2. AutoComplete 不能按输入框过滤 =====
t('模型下拉不过滤候选（filterOption 恒为 true）', () => {
  // 找出所有 AutoComplete 块，检查里面没有「按 input 过滤」的 filterOption
  const blocks = settingsSrc.match(/<AutoComplete[\s\S]*?\/>/g) || []
  assert.ok(blocks.length >= 2, `应有两个 AutoComplete（文本模型 + 视觉模型），实际 ${blocks.length}`)
  for (const b of blocks) {
    assert.ok(
      /filterOption=\{\(\)\s*=>\s*true\}/.test(b),
      'AutoComplete 的 filterOption 必须恒为 true：模型名是完整标识符，按输入框过滤会把候选全滤光\n' + b.slice(0, 400)
    )
    assert.ok(
      !/filterOption=\{\s*\(input/.test(b),
      'AutoComplete 的 filterOption 不能用 input 过滤候选\n' + b.slice(0, 400)
    )
  }
})

t('模型下拉用 options 提供本机已装模型', () => {
  const blocks = settingsSrc.match(/<AutoComplete[\s\S]*?\/>/g) || []
  for (const b of blocks) {
    assert.ok(
      /options=\{ollamaModels\.map/.test(b),
      'AutoComplete 应通过 options 提供本机已装模型\n' + b.slice(0, 400)
    )
  }
})

t('模型下拉仍保留自由输入能力（不是 Select 锁定）', () => {
  const blocks = settingsSrc.match(/<AutoComplete[\s\S]*?\/>/g) || []
  assert.ok(blocks.length >= 2, '应有两个 AutoComplete')
  // AutoComplete 本身就是「可输入 + 可下拉」，不能换成 Select（那会锁死只能选）
  assert.ok(
    !/<Select[^>]*name=\{\['aiAgent',\s*'localModel'\]/.test(settingsSrc),
    '本地模型名不应改成 Select —— 那会让用户无法输入未 pull 的模型名'
  )
  assert.ok(
    !/<Select[^>]*name=\{\['aiAgent',\s*'localVisionModel'\]/.test(settingsSrc),
    '视觉模型不应改成 Select —— 那会让用户无法输入未 pull 的模型名'
  )
})

// ===== 3. notFoundContent 恒非空 =====
t('AutoComplete 的 notFoundContent 恒为非空（避免下拉死锁）', () => {
  const blocks = settingsSrc.match(/<AutoComplete[\s\S]*?\/>/g) || []
  for (const b of blocks) {
    assert.ok(
      /notFoundContent=\{t\('aiAgent\.modelsNotFound'\)\}/.test(b),
      'notFoundContent 必须恒为非空字符串，否则 rc-select 会禁止展开空下拉（死锁）\n' + b.slice(0, 400)
    )
    assert.ok(
      !/notFoundContent=\{[^}]*\?\s*t\(/.test(b),
      'notFoundContent 不能是条件表达式（初始为 null 时下拉永远开不了）\n' + b.slice(0, 400)
    )
  }
})

// ===== 4. 模型清单接口 =====
t('后端提供本机模型清单接口', () => {
  assert.ok(
    /'\/ai-agent\/models'/.test(assistantSrc),
    'assistant.ts 应注册 GET /ai-agent/models（供前端下拉列本机已装模型）'
  )
  assert.ok(
    /listOllamaModels\(\)/.test(assistantSrc),
    '模型清单接口应调用 listOllamaModels'
  )
})

t('前端在进入设置页时就拉取模型清单', () => {
  assert.ok(
    /loadOllamaModels/.test(settingsSrc),
    'Settings.tsx 应有 loadOllamaModels'
  )
  assert.ok(
    /useEffect\(\(\)\s*=>\s*\{\s*void loadOllamaModels\(\)\s*\},\s*\[loadOllamaModels\]\)/.test(settingsSrc),
    '应在挂载时拉取模型清单（而不是等用户点开下拉才拉）'
  )
})

// ===== 5. 报错要能指导用户 =====
t('模型未安装的错误提示列出本机已装模型', () => {
  assert.ok(
    /describeMissing/.test(assistantSrc),
    'assistant.ts 应有 describeMissing 之类的辅助函数，列出本机已装模型'
  )
  assert.ok(
    /本机已安装/.test(assistantSrc),
    '模型未安装的提示应列出本机已安装的模型'
  )
})

t('对话 404 时给出可操作的提示（含本机已装模型）', () => {
  assert.ok(
    /404/.test(assistantSrc) && /not found/i.test(assistantSrc),
    '对话失败应识别 404 model not found 并给出针对性提示'
  )
  assert.ok(
    /findSameBaseModel/.test(assistantSrc),
    '应能提示「本机已安装同系列的另一个 tag」'
  )
})

console.log(`\n  aiAgentModelSelect: ${passed} 项通过`)
