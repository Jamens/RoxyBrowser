// Support 模式知识检索（P0：全文检索，零外部依赖、零 token）
// 知识源 = 项目 README.md（架构/命令）+ FEATURES.md（功能详情），按 markdown 标题切成片段；
// 用户问题做关键词（CJK 2-gram + 拉丁词）打分，取 top-k 片段拼进 system prompt。
// 拆分的起因：README 早期同时承载「架构 + 全部功能说明」，越写越长；现在 README 只保留
// 技术架构 / 目录结构 / 运行命令，功能说明迁到 FEATURES.md，故这里必须同时读两份，
// 否则「产品客服」会答不了功能类问题。
// 文档量变大、或答不准时，再升级为 RAG（向量检索，见设计文档 P2）。

import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface DocChunk {
  /** 标题（含层级，如 "## 5. 代理 IP"） */
  heading: string
  /** 该片段全文（含标题行） */
  text: string
}

let cachedChunks: DocChunk[] | null = null
let cachedAt = 0
/** 缓存 5 分钟：README 不常变，避免每次对话都读盘切分 */
const CACHE_MS = 5 * 60 * 1000

/** 知识源文档（顺序即检索时的基础分权重：越靠前越优先） */
const DOC_FILES = ['README.md', 'FEATURES.md']

/** 解析文档路径：打包根 / 应用根 / 进程 cwd 多级回退，每个文档独立探测、缺失互不影响 */
function resolveDocPaths(): string[] {
  const roots = [app.getAppPath(), process.cwd()]
  const found: string[] = []
  for (const name of DOC_FILES) {
    for (const root of roots) {
      const p = join(root, name)
      try {
        readFileSync(p)
        found.push(p)
        break
      } catch {
        /* 尝试下一个根目录 */
      }
    }
  }
  return found
}

/** 按 markdown 标题（# ~ ####）切分文档为片段 */
export function chunkMarkdown(md: string): DocChunk[] {
  const lines = md.split(/\r?\n/)
  const chunks: DocChunk[] = []
  let heading = '(开头)'
  let buf: string[] = []
  const flush = () => {
    const text = buf.join('\n').trim()
    if (text) chunks.push({ heading, text })
    buf = []
  }
  for (const line of lines) {
    const m = /^(#{1,4})\s+(.+)$/.exec(line)
    if (m) {
      flush()
      heading = `${m[1]} ${m[2].trim()}`
      buf.push(line)
    } else {
      buf.push(line)
    }
  }
  flush()
  return chunks
}

/** 加载并缓存知识片段（README + FEATURES）；都读不到返回空数组（Support 退化为纯对话） */
export function loadKnowledge(): DocChunk[] {
  if (cachedChunks && Date.now() - cachedAt < CACHE_MS) return cachedChunks
  const chunks: DocChunk[] = []
  for (const p of resolveDocPaths()) {
    try {
      chunks.push(...chunkMarkdown(readFileSync(p, 'utf-8')))
    } catch {
      /* 单个文档读不到就跳过，不影响其它文档 */
    }
  }
  cachedChunks = chunks
  cachedAt = Date.now()
  return cachedChunks
}

/** 把问题拆成检索词：拉丁/数字词 + CJK 2-gram（中文无空格分词的朴素解法） */
export function tokenizeQuery(q: string): string[] {
  const tokens: string[] = []
  // 拉丁词（含中划线，如 "roxy-browser"、"api"）
  for (const m of q.match(/[A-Za-z0-9][A-Za-z0-9-]{1,}/g) || []) tokens.push(m.toLowerCase())
  // CJK 连续段切成 2-gram
  for (const seg of q.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 1 < seg.length; i++) tokens.push(seg.slice(i, i + 2))
  }
  return tokens
}

/** 关键词打分：片段命中越多分越高；标题命中的词权重加倍 */
function scoreChunk(chunk: DocChunk, tokens: string[]): number {
  if (!tokens.length) return 0
  const body = chunk.text.toLowerCase()
  const head = chunk.heading.toLowerCase()
  let score = 0
  for (const tk of tokens) {
    let hits = body.split(tk).length - 1
    if (!hits) continue
    score += hits + (head.includes(tk) ? 2 : 0)
  }
  return score
}

/**
 * 检索与问题最相关的 top-k 片段。
 * 带基础分排序（文档前部的基础章节介绍权重略高），完全无命中时返回前几个总览片段。
 */
export function retrieveChunks(question: string, k = 6, maxChars = 7000): DocChunk[] {
  const chunks = loadKnowledge()
  if (!chunks.length) return []
  const tokens = tokenizeQuery(question)
  const scored = chunks
    .map((c, i) => ({ c, s: scoreChunk(c, tokens) - i * 0.01 }))
    .sort((a, b) => b.s - a.s)
  const hits = scored.filter((x) => x.s > 0).slice(0, k)
  // 无任何命中：给开头的总览片段，至少让模型有产品背景可讲
  const picked = hits.length ? hits.map((x) => x.c) : chunks.slice(0, 3)
  // 总长度截断（本地模型上下文有限）
  const out: DocChunk[] = []
  let total = 0
  for (const c of picked) {
    if (total + c.text.length > maxChars) break
    out.push(c)
    total += c.text.length
  }
  return out
}

/** Support 模式 system prompt：产品客服人设 + 检索到的文档片段 */
export function buildSupportSystemPrompt(question: string): string {
  const chunks = retrieveChunks(question)
  const docs = chunks.map((c) => c.text).join('\n\n---\n\n')
  return [
    '你是 RoxyBrowser Clone（指纹浏览器，面向跨境电商多账号防关联）的产品客服助手。',
    '请只依据下面给出的产品文档片段回答用户关于本产品功能与用法的问题；',
    '文档片段没有覆盖的问题，如实说明文档中未提及，不要编造功能。',
    '回答用简体中文，条理清晰，必要时给出操作路径（如「设置 → AI Agent」）。',
    '',
    '===== 产品文档片段（按与问题的相关性检索）=====',
    docs || '（未找到相关文档片段）',
    '===== 文档片段结束 ====='
  ].join('\n')
}
