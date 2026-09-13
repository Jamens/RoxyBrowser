// 导航提示构造器：把用户指令里「点名的站点 / 搜索引擎」和「要搜索的关键词」
// 从弱视觉模型手里夺回来，用确定性规则解析后，作为强指令注入每一步的提示词。
//
// 为什么需要它：弱视觉模型（minicpm-v）看到当前页面已是某个搜索引擎（如预设的
// 百度）时，会把「当前页=已满足」误判，于是跳过「导航到指令点名的站点（必应）」，
// 也跳过「在该站点搜索关键词」，直接去点页面上的第一条链接。把目标 URL 与步骤顺序
// 用代码算出来塞进提示词，能绕过模型这个系统性误判。
//
// 更进一步（本轮增强）：实测发现弱模型即使被提示「输入末尾加 \n 回车提交」也常常
// 不加（日志里是 text=Electron 而非 text=Electron\n），于是「填进去了但没搜索」；
// 且它会反复重试 type、甚至去点搜索框本身。「手动点搜索框→键入→回车」这条路径对
// 弱 VLM 太脆弱。解决办法：算出**搜索结果页直达 URL**，让模型用 navigate 一步到位。
interface SiteAlias {
  kw: string[]
  url: string
  label: string
  /** 搜索结果页模板，{q} 为关键词占位符 */
  searchUrl?: string
}

// 常见站点 / 搜索引擎别名 → 确定 URL。排在前面的优先级更高。
const SITE_ALIASES: SiteAlias[] = [
  { kw: ['必应', 'bing'], url: 'https://www.bing.com', label: '必应(Bing)', searchUrl: 'https://www.bing.com/search?q={q}' },
  { kw: ['谷歌', 'google'], url: 'https://www.google.com', label: '谷歌(Google)', searchUrl: 'https://www.google.com/search?q={q}' },
  { kw: ['百度', 'baidu'], url: 'https://www.baidu.com', label: '百度(Baidu)', searchUrl: 'https://www.baidu.com/s?wd={q}' },
  { kw: ['duckduckgo', '多克', 'ddg'], url: 'https://duckduckgo.com', label: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q={q}' },
  { kw: ['雅虎', 'yahoo'], url: 'https://www.yahoo.com', label: '雅虎(Yahoo)', searchUrl: 'https://search.yahoo.com/search?p={q}' },
  { kw: ['yandex'], url: 'https://yandex.com', label: 'Yandex', searchUrl: 'https://yandex.com/search/?text={q}' },
  { kw: ['github'], url: 'https://github.com', label: 'GitHub', searchUrl: 'https://github.com/search?q={q}' },
  { kw: ['bilibili', '哔哩哔哩', 'b站'], url: 'https://www.bilibili.com', label: 'Bilibili', searchUrl: 'https://search.bilibili.com/all?keyword={q}' },
  { kw: ['youtube'], url: 'https://www.youtube.com', label: 'YouTube', searchUrl: 'https://www.youtube.com/results?search_query={q}' },
  { kw: ['育碧', 'ubisoft'], url: 'https://www.ubisoft.com', label: '育碧(Ubisoft)' },
  { kw: ['淘宝', 'taobao'], url: 'https://www.taobao.com', label: '淘宝(Taobao)', searchUrl: 'https://s.taobao.com/search?q={q}' },
  { kw: ['京东', 'jd'], url: 'https://www.jd.com', label: '京东(JD)', searchUrl: 'https://search.jd.com/Search?keyword={q}' },
  { kw: ['知乎', 'zhihu'], url: 'https://www.zhihu.com', label: '知乎', searchUrl: 'https://www.zhihu.com/search?q={q}' },
  { kw: ['微博', 'weibo'], url: 'https://weibo.com', label: '微博', searchUrl: 'https://s.weibo.com/weibo?q={q}' },
  { kw: ['维基', 'wikipedia', 'wiki'], url: 'https://www.wikipedia.org', label: '维基百科', searchUrl: 'https://zh.wikipedia.org/wiki/Special:Search?search={q}' }
]

const SITE_KW_LOWER = new Set(SITE_ALIASES.flatMap((s) => s.kw).map((k) => k.toLowerCase()))

function matchSite(instruction: string): SiteAlias | null {
  const lower = instruction.toLowerCase()
  for (const s of SITE_ALIASES) {
    if (s.kw.some((k) => lower.includes(k.toLowerCase()))) return s
  }
  // 显式 URL
  const urlM = instruction.match(/https?:\/\/[^\s,，。；;]+/i)
  if (urlM) return { kw: [], url: urlM[0], label: urlM[0] }
  // 「打开/进入/访问/去 <domain>」里的裸域名
  const domM = instruction.match(/(?:打开|进入|访问|去)\s*([a-z0-9-]+\.(?:com|cn|net|org|io|co|jp|uk|de|fr|ru|us|kr|in))\b/i)
  if (domM) {
    const d = domM[1]
    return { kw: [], url: `https://${d}`, label: d }
  }
  return null
}

// 关键词边界：碰到连接词/标点/句尾就收手，避免把后面的动作一起吞进来
// （旧实现在这里吃过亏：「搜索 Electron 然后点第一条」会把 term 解析成「Electron 然后」）
const TERM_BOUNDARY = '(?=并|然后|接着|之后|再|,|，|。|;|；|、|$)'

// 两种真实句式：
//  ① 关键词在「输入」之后 —— 「输入框输入Electron并搜索，然后点击第一个链接」
//  ② 关键词在「搜索/查」之后 —— 「搜索必应，并搜索Electron，点击第一条链接」
// 必须把 ① 放前面：旧实现只认 ②，遇到 user 的「输入Electron并搜索」句式会错误地
// 从「搜」字后面取词，把 term 解析成「索」。
const SEARCH_PATTERNS: RegExp[] = [
  new RegExp(`(?:输入|键入|填写|打入)\\s*([^,，。；;、]{1,40}?)${TERM_BOUNDARY}`),
  new RegExp(`(?:搜索|搜|查询|查|找)\\s*([^,，。；;、]{1,40}?)${TERM_BOUNDARY}`)
]

// 从指令里取出第一个不是站点别名的搜索关键词。
function matchSearchTerm(instruction: string): string {
  for (const base of SEARCH_PATTERNS) {
    const re = new RegExp(base.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(instruction)) !== null) {
      let cand = (m[1] || '').trim()
      // 去掉开头重复出现的触发词本身（如「输入框输入Electron」里多带出来的前缀）
      cand = cand.replace(/^(?:输入|键入|填写|打入|框|搜索|搜|查询|查|找)+/, '').trim()
      if (!cand) continue
      const cl = cand.toLowerCase()
      // 跳过站点别名本身（如「搜索必应」里的「必应」）
      if (SITE_KW_LOWER.has(cl)) continue
      if (SITE_ALIASES.some((s) => s.kw.some((k) => cl.includes(k.toLowerCase())))) continue
      return cand
    }
  }
  return ''
}

export interface NavInfo {
  /** 注入每一步提示词的强指令；无明确站点时为空串 */
  hint: string
  /** 解析出的搜索词 */
  term: string
  /** 搜索结果页直达 URL（无搜索词或不明站点时为空串） */
  searchUrl: string
}

/**
 * 构造导航强指令。无明确站点时 hint 为空串（交给模型自行判断）。
 * 有搜索词且该站点有已知结果页模板时，会额外给出「搜索直达 URL」，
 * 让模型用一次 navigate 完成搜索，绕开脆弱的「点搜索框→键入→回车」链路。
 */
export function buildNavHint(instruction: string): NavInfo {
  const site = matchSite(instruction)
  if (!site) return { hint: '', term: '', searchUrl: '' }
  const term = matchSearchTerm(instruction)
  const searchUrl = term && site.searchUrl ? site.searchUrl.replace('{q}', encodeURIComponent(term)) : ''

  let hint = `【导航要求】指令点名要打开「${site.label}」。你第一步【必须】执行 navigate 动作跳转到 ${site.url}`
  hint += `；若当前页面已经是该地址则跳过此步，但不要复用其它已打开的页面（哪怕它也是搜索引擎，例如不要拿百度顶替必应）。`
  if (searchUrl) {
    hint += ` 【搜索直达】要搜索「${term}」时，直接执行 navigate 跳转到 ${searchUrl} —— 一次跳转就能拿到搜索结果页。`
    hint += `【不要】去点搜索框再手动输入、也不要反复 typing（实测这条链路极易失败），更不要去点搜索按钮。`
    hint += ` 到达搜索结果页后，再点击第一条结果链接。`
  } else if (term) {
    hint += ` 到达后，在该站点的搜索框输入「${term}」并以回车("\\n")提交；`
    hint += `看到搜索结果页后再点击第一条结果链接。`
  } else {
    hint += ` 到达后按指令继续操作。`
  }
  hint += ` 严格按「先拿到搜索结果页 → 再点结果链接」的顺序执行；在结果页出现之前，严禁去点页面上的任何链接（包括搜索框和搜索按钮）。`
  return { hint, term, searchUrl }
}
