// RPA 市场：内置预设自动化脚本目录（主进程专用，纯数据模块）
//
// 浏览器指纹浏览器的主要使用场景是跨境电商 / 海外社媒矩阵运营，这类账号的
// 日常操作高度重复（登录签到、搜索比价、采集 SERP、定时发帖……）。
// 市场把这些高频流程固化为「预设脚本」，用户一键安装到自己的脚本库即可回放。
//
// 设计要点：
// - 预设脚本以 navigate（开 URL）+ wait / scroll 为主，跨站点通用、装完即跑；
//   input / click 这类依赖 DOM 选择器的步骤，留作模板（注释里提示用户按站点微调）。
// - 可参数化部分一律用 {{变量名}} 暴露出来（见 shared/rpa.ts 的 substituteVars），
//   安装后用户在前端「编辑」里填真实账号 / 关键词即可复用。
// - 这里的 steps 是 RpaStep[]，与引擎回放、录制保存共用同一套类型，安装时直接落库。

import type { RpaStep } from '../shared/types'

export interface MarketScript {
  id: string
  name: string
  description: string
  category: string // SEO / 电商 / 社媒 / 账号
  tags: string[]
  steps: RpaStep[]
  variables: Record<string, string>
  /** 安装后提示（如「选择器需按你的站点微调」），可选 */
  note?: string
}

export const MARKET_SCRIPTS: MarketScript[] = [
  {
    id: 'serp-scrape',
    name: 'Google SERP 抓取',
    description: '打开 Google 搜索结果页并滚动加载，提取前几屏自然结果，用于 SEO 竞品词覆盖分析。',
    category: 'SEO',
    tags: ['搜索', '抓取', 'SEO'],
    variables: { query: 'roxy browser 指纹浏览器' },
    steps: [
      { type: 'navigate', url: 'https://www.google.com/search?q={{query}}' },
      { type: 'wait', ms: 2000 },
      { type: 'scroll', x: 0, y: 800 },
      { type: 'wait', ms: 1000 },
      { type: 'scroll', x: 0, y: 1600 }
    ]
  },
  {
    id: 'index-check',
    name: '收录检测（site:）',
    description: '用 site: 指令检查域名在搜索引擎的收录情况，运营站群时批量核验索引状态。',
    category: 'SEO',
    tags: ['收录', '站群', 'SEO'],
    variables: { domain: 'example.com' },
    steps: [
      { type: 'navigate', url: 'https://www.google.com/search?q=site:{{domain}}' },
      { type: 'wait', ms: 2000 },
      { type: 'scroll', x: 0, y: 600 },
      { type: 'wait', ms: 1000 }
    ]
  },
  {
    id: 'amazon-search',
    name: '亚马逊商品搜索比价',
    description: '按关键词打开亚马逊搜索结果，滚动加载商品列表，便于比价 / 选品调研。',
    category: '电商',
    tags: ['选品', '比价', '亚马逊'],
    variables: { keyword: 'wireless earbuds' },
    steps: [
      { type: 'navigate', url: 'https://www.amazon.com/s?k={{keyword}}' },
      { type: 'wait', ms: 2000 },
      { type: 'scroll', x: 0, y: 1000 },
      { type: 'wait', ms: 1000 }
    ]
  },
  {
    id: 'price-monitor',
    name: '竞品价格监控',
    description: '定时打开竞品商品页并记录价格（配合脚本「定时执行」可周期性巡检），监控调价。',
    category: '电商',
    tags: ['竞品', '价格', '监控'],
    variables: { productUrl: 'https://www.amazon.com/dp/B0EXAMPLE' },
    steps: [
      { type: 'navigate', url: '{{productUrl}}' },
      { type: 'wait', ms: 2000 },
      { type: 'scroll', x: 0, y: 500 },
      { type: 'wait', ms: 1000 }
    ],
    note: 'URL 换成你要监控的真实商品页；开启「定时执行」即可周期性巡检。'
  },
  {
    id: 'daily-checkin',
    name: '每日登录签到',
    description: '打开登录页、填入账号密码并点击登录，固化成脚本后可每日定时自动签到。',
    category: '账号',
    tags: ['登录', '签到', '自动化'],
    variables: { loginUrl: 'https://example.com/login', username: '', password: '' },
    steps: [
      { type: 'navigate', url: '{{loginUrl}}' },
      { type: 'wait', ms: 1500 },
      { type: 'input', sel: '#username', value: '{{username}}' },
      { type: 'input', sel: '#password', value: '{{password}}' },
      { type: 'click', sel: '.login-btn', rx: 0, ry: 0 },
      { type: 'wait', ms: 1000 }
    ],
    note: '选择器 #username / #password / .login-btn 为常见写法，请按你站点的真实 DOM 微调；账号密码用变量，避免写死在脚本里。'
  },
  {
    id: 'social-post',
    name: '社媒定时发帖',
    description: '打开发布页、填入正文并点击发布，配合「定时执行」可按时段批量铺内容。',
    category: '社媒',
    tags: ['发帖', '矩阵', '社媒'],
    variables: { composeUrl: 'https://example.com/compose', content: '今天的新品上线啦！' },
    steps: [
      { type: 'navigate', url: '{{composeUrl}}' },
      { type: 'wait', ms: 1500 },
      { type: 'input', sel: '.compose-text', value: '{{content}}' },
      { type: 'click', sel: '.post-btn', rx: 0, ry: 0 },
      { type: 'wait', ms: 1000 }
    ],
    note: '选择器 .compose-text / .post-btn 为示例，请按目标平台真实 DOM 调整；多账号可在不同环境里各装一份，分别填不同 content。'
  }
]

export function getMarketScript(id: string): MarketScript | undefined {
  return MARKET_SCRIPTS.find((m) => m.id === id)
}
