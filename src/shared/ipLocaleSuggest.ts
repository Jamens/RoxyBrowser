// 出口 IP → 语言 / 时区推导 —— 纯函数，零依赖，可离线单测
//
// ## 要解决的问题
//
// 建环境时最容易留下关联破绽的地方，就是**指纹的地理要素和代理出口对不上**：
// 代理走美国弗吉尼亚，浏览器却报 `Asia/Shanghai` + `zh-CN`——
// 这三条（出口 IP、时区、Accept-Language）本该来自同一个「人所在的地方」，
// 对不上就是现成的关联信号。
//
// 竞品（对标 RoxyBrowser 4.1.0）在建环境那一刻就按出口 IP 把语言 / 时区推好，
// 我们此前只有**事后告警**（体检报「时区 ↔ 代理国家不符」），
// 用户还得自己翻三个字段手改。这个模块补的就是「建的那一刻推对」。
//
// ## 为什么不能只按国家给一个时区
//
// 一国多时区是硬事实：US 跨 6 个时区、CA 跨 6 个、RU 跨 11 个、AU 跨 3 个。
// 美国代理落在德州还是落在加州，出口 IP 一样是「美国」，但正确时区分别是
// `America/Chicago` 和 `America/Los_Angeles`——给错时区比不给更糟，
// 因为它会让「看起来很认真的一致性」变成「精准但错误的一致性」。
//
// 故本模块的判定分三档：
//   1. 地区（regionName）能定位到具体时区 → 直接给，**无需用户确认**；
//   2. 国家有多时区但地区不认识 → 给该国**首选时区 + 全部候选**，并标记
//      `ambiguous`，要求用户确认后才写回；
//   3. 国家只有一个时区 → 直接给，**不可能错**。
//
// ## 绝不用宿主 IP 兜底
//
// 代理没检测成功时，**不能**退而用本机 IP 去推语言 / 时区——
// 那等于把「开发机所在城市」写进指纹，而这台机器大概率不在代理出口国，
// 写进去的是一个比「时区不匹配」更难看、且用户根本不知道被写进去的假一致。
// 故本模块只接受**已知的出口国家 / 地区**，推不出来就明确返回「推不出来」。
//
// ## 与体检的一致性口径必须同源
//
// 体检的 `langVsTz` 判定是「`navigator.languages[0]` 的地区码 == 时区所属国码」，
// `tzVsProxy` 判定是「时区所属国 == 代理出口国」。若本模块给出的语言 / 时区
// 与体检口径不同源，就会出现「按出口 IP 填完，体检反而报不一致」——
// 用户只会认为工具坏了。故本模块同时导出 `timeZoneToCountry`，
// 供体检与一键修复共用，判定口径只有一处。

/** 归一化匹配键：小写、去重音、只保留字母数字与汉字 */
function normKey(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
}

/** 一个国家的地理档案 */
export interface CountryGeo {
  /** ISO 3166-1 alpha-2 */
  code: string
  /** 中文名（固定中文，不随界面语言变化） */
  name: string
  /**
   * 英文名。
   * 必须与 ip-api `country` 字段的返回值一致——体检拿它和代理出口做字符串比对，
   * 差一个字母就会把「一致」判成「不一致」。
   */
  nameEn: string
  /**
   * 别名：同一国家的其他常见写法。
   *
   * 必要的原因是「英文名」这件事没有唯一答案：ip-api 用 "Czech Republic"，
   * 官方名是 "Czechia"；ip-api 用 "Russian Federation" 的变体在别的 IP 库里
   * 叫 "Russia"；"USA" 与 "United States" 同指一国。
   * 少收一个别名，体检就会把同一国判成不一致——而用户完全看不出原因。
   */
  aliases?: string[]
  /**
   * 浏览器首选语言（`navigator.languages[0]`）。
   *
   * **地区码必须等于国码**：这是体检 `langVsTz` 的判定依据，
   * 也是「一个美国人在美国看英文网站」的真实形态（en-GB 在英国、
   * en-AU 在澳洲，而不是一律 en-US）。写死 en-US 会让英国 / 澳洲 / 俄罗斯
   * 等国家的环境**永远判不一致、且一键修复也修不好**（修复目标同样是 en-US）。
   */
  browserLanguage: string
  /** 该国全部候选时区。单时区国家只有一项。 */
  timeZones: string[]
  /** 地区（ip-api 的 `regionName`）→ 具体时区。仅多时区国家需要。 */
  regions?: Record<string, string>
}

/**
 * 国家地理档案表。
 *
 * 收录范围：跨境电商与海外社媒的主流市场 + 代理池常见出口国。
 * 新增国家时注意两条不变式：
 *   1. `browserLanguage` 的地区码 == `code`；
 *   2. `timeZones[0]` 是该国**默认时区**，且必须也出现在 `timeZones` 里；
 *   3. 多时区国家的每个 `regions` 映射值必须出现在 `timeZones` 里
 *      （否则候选列表与实际能给出的值对不上，用户选了也填不进去）。
 */
export const COUNTRY_GEO: CountryGeo[] = [
  // ---------- 东亚 ----------
  { code: 'CN', name: '中国', nameEn: 'China', browserLanguage: 'zh-CN', timeZones: ['Asia/Shanghai'] },
  { code: 'HK', name: '中国香港', nameEn: 'Hong Kong', browserLanguage: 'zh-HK', timeZones: ['Asia/Hong_Kong'] },
  { code: 'TW', name: '中国台湾', nameEn: 'Taiwan', browserLanguage: 'zh-TW', timeZones: ['Asia/Taipei'] },
  { code: 'MO', name: '中国澳门', nameEn: 'Macao', aliases: ['Macau'], browserLanguage: 'zh-MO', timeZones: ['Asia/Macau'] },
  { code: 'JP', name: '日本', nameEn: 'Japan', browserLanguage: 'ja-JP', timeZones: ['Asia/Tokyo'] },
  { code: 'KR', name: '韩国', nameEn: 'South Korea', aliases: ['Korea, Republic of', 'Republic of Korea', 'Korea'], browserLanguage: 'ko-KR', timeZones: ['Asia/Seoul'] },

  // ---------- 北美 ----------
  {
    code: 'US',
    name: '美国',
    nameEn: 'United States',
    browserLanguage: 'en-US',
    aliases: ['USA', 'United States of America', 'US'],
    timeZones: [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Phoenix',
      'America/Indiana/Indianapolis',
      'America/Boise',
      'America/Anchorage',
      'Pacific/Honolulu'
    ],
    regions: {
      // 西部
      california: 'America/Los_Angeles',
      washington: 'America/Los_Angeles',
      oregon: 'America/Los_Angeles',
      nevada: 'America/Los_Angeles',
      idaho: 'America/Boise',
      arizona: 'America/Phoenix',
      alaska: 'America/Anchorage',
      hawaii: 'Pacific/Honolulu',
      // 山地
      'new mexico': 'America/Denver',
      colorado: 'America/Denver',
      wyoming: 'America/Denver',
      utah: 'America/Denver',
      montana: 'America/Denver',
      // 中部
      'north dakota': 'America/Chicago',
      'south dakota': 'America/Chicago',
      nebraska: 'America/Chicago',
      kansas: 'America/Chicago',
      oklahoma: 'America/Chicago',
      texas: 'America/Chicago',
      minnesota: 'America/Chicago',
      iowa: 'America/Chicago',
      missouri: 'America/Chicago',
      arkansas: 'America/Chicago',
      louisiana: 'America/Chicago',
      wisconsin: 'America/Chicago',
      illinois: 'America/Chicago',
      mississippi: 'America/Chicago',
      alabama: 'America/Chicago',
      // 东部
      georgia: 'America/New_York',
      florida: 'America/New_York',
      pennsylvania: 'America/New_York',
      'new york': 'America/New_York',
      'new jersey': 'America/New_York',
      connecticut: 'America/New_York',
      massachusetts: 'America/New_York',
      'rhode island': 'America/New_York',
      vermont: 'America/New_York',
      'new hampshire': 'America/New_York',
      maine: 'America/New_York',
      maryland: 'America/New_York',
      delaware: 'America/New_York',
      virginia: 'America/New_York',
      'west virginia': 'America/New_York',
      'north carolina': 'America/New_York',
      'south carolina': 'America/New_York',
      kentucky: 'America/New_York',
      tennessee: 'America/New_York',
      ohio: 'America/New_York',
      indiana: 'America/Indiana/Indianapolis'
    }
  },
  {
    code: 'CA',
    name: '加拿大',
    nameEn: 'Canada',
    browserLanguage: 'en-CA',
    timeZones: [
      'America/Toronto',
      'America/Montreal',
      'America/Halifax',
      'America/Moncton',
      'America/St_Johns',
      'America/Vancouver',
      'America/Edmonton',
      'America/Regina',
      'America/Winnipeg',
      'America/Whitehorse',
      'America/Yellowknife',
      'America/Iqaluit'
    ],
    regions: {
      ontario: 'America/Toronto',
      quebec: 'America/Toronto',
      'nova scotia': 'America/Halifax',
      'prince edward island': 'America/Halifax',
      'new brunswick': 'America/Moncton',
      'newfoundland and labrador': 'America/St_Johns',
      'british columbia': 'America/Vancouver',
      alberta: 'America/Edmonton',
      saskatchewan: 'America/Regina',
      manitoba: 'America/Winnipeg',
      yukon: 'America/Whitehorse',
      'northwest territories': 'America/Yellowknife',
      nunavut: 'America/Iqaluit'
    }
  },
  { code: 'MX', name: '墨西哥', nameEn: 'Mexico', browserLanguage: 'es-MX', timeZones: ['America/Mexico_City'] },

  // ---------- 南美 ----------
  {
    code: 'BR',
    name: '巴西',
    nameEn: 'Brazil',
    browserLanguage: 'pt-BR',
    timeZones: [
      'America/Sao_Paulo',
      'America/Bahia',
      'America/Recife',
      'America/Fortaleza',
      'America/Maceio',
      'America/Belem',
      'America/Manaus',
      'America/Cuiaba'
    ],
    regions: {
      'sao paulo': 'America/Sao_Paulo',
      'rio de janeiro': 'America/Sao_Paulo',
      'minas gerais': 'America/Sao_Paulo',
      'rio grande do sul': 'America/Sao_Paulo',
      parana: 'America/Sao_Paulo',
      'santa catarina': 'America/Sao_Paulo',
      'distrito federal': 'America/Sao_Paulo',
      'espirito santo': 'America/Sao_Paulo',
      bahia: 'America/Bahia',
      pernambuco: 'America/Recife',
      ceara: 'America/Fortaleza',
      'rio grande do norte': 'America/Fortaleza',
      paraiba: 'America/Fortaleza',
      maranhao: 'America/Fortaleza',
      piaui: 'America/Fortaleza',
      alagoas: 'America/Maceio',
      Sergipe: 'America/Maceio',
      para: 'America/Belem',
      amazonas: 'America/Manaus',
      'mato grosso': 'America/Cuiaba'
    }
  },
  { code: 'AR', name: '阿根廷', nameEn: 'Argentina', browserLanguage: 'es-AR', timeZones: ['America/Argentina/Buenos_Aires'] },
  { code: 'CL', name: '智利', nameEn: 'Chile', browserLanguage: 'es-CL', timeZones: ['America/Santiago'] },
  { code: 'CO', name: '哥伦比亚', nameEn: 'Colombia', browserLanguage: 'es-CO', timeZones: ['America/Bogota'] },
  { code: 'PE', name: '秘鲁', nameEn: 'Peru', browserLanguage: 'es-PE', timeZones: ['America/Lima'] },

  // ---------- 西欧 ----------
  { code: 'GB', name: '英国', nameEn: 'United Kingdom', aliases: ['Great Britain', 'England', 'UK'], browserLanguage: 'en-GB', timeZones: ['Europe/London'] },
  { code: 'DE', name: '德国', nameEn: 'Germany', browserLanguage: 'de-DE', timeZones: ['Europe/Berlin'] },
  { code: 'FR', name: '法国', nameEn: 'France', browserLanguage: 'fr-FR', timeZones: ['Europe/Paris'] },
  { code: 'IT', name: '意大利', nameEn: 'Italy', browserLanguage: 'it-IT', timeZones: ['Europe/Rome'] },
  { code: 'ES', name: '西班牙', nameEn: 'Spain', browserLanguage: 'es-ES', timeZones: ['Europe/Madrid'] },
  { code: 'NL', name: '荷兰', nameEn: 'Netherlands', aliases: ['Holland'], browserLanguage: 'nl-NL', timeZones: ['Europe/Amsterdam'] },
  { code: 'BE', name: '比利时', nameEn: 'Belgium', browserLanguage: 'nl-BE', timeZones: ['Europe/Brussels'] },
  { code: 'AT', name: '奥地利', nameEn: 'Austria', browserLanguage: 'de-AT', timeZones: ['Europe/Vienna'] },
  { code: 'PT', name: '葡萄牙', nameEn: 'Portugal', browserLanguage: 'pt-PT', timeZones: ['Europe/Lisbon'] },
  { code: 'IE', name: '爱尔兰', nameEn: 'Ireland', browserLanguage: 'en-IE', timeZones: ['Europe/Dublin'] },
  { code: 'SE', name: '瑞典', nameEn: 'Sweden', browserLanguage: 'sv-SE', timeZones: ['Europe/Stockholm'] },
  { code: 'NO', name: '挪威', nameEn: 'Norway', browserLanguage: 'nb-NO', timeZones: ['Europe/Oslo'] },
  { code: 'DK', name: '丹麦', nameEn: 'Denmark', browserLanguage: 'da-DK', timeZones: ['Europe/Copenhagen'] },
  { code: 'FI', name: '芬兰', nameEn: 'Finland', browserLanguage: 'fi-FI', timeZones: ['Europe/Helsinki'] },
  { code: 'PL', name: '波兰', nameEn: 'Poland', browserLanguage: 'pl-PL', timeZones: ['Europe/Warsaw'] },
  { code: 'CZ', name: '捷克', nameEn: 'Czech Republic', aliases: ['Czechia'], browserLanguage: 'cs-CZ', timeZones: ['Europe/Prague'] },
  { code: 'GR', name: '希腊', nameEn: 'Greece', browserLanguage: 'el-GR', timeZones: ['Europe/Athens'] },
  { code: 'RO', name: '罗马尼亚', nameEn: 'Romania', browserLanguage: 'ro-RO', timeZones: ['Europe/Bucharest'] },
  { code: 'HU', name: '匈牙利', nameEn: 'Hungary', browserLanguage: 'hu-HU', timeZones: ['Europe/Budapest'] },
  { code: 'BG', name: '保加利亚', nameEn: 'Bulgaria', browserLanguage: 'bg-BG', timeZones: ['Europe/Sofia'] },
  { code: 'RS', name: '塞尔维亚', nameEn: 'Serbia', browserLanguage: 'sr-RS', timeZones: ['Europe/Belgrade'] },
  { code: 'HR', name: '克罗地亚', nameEn: 'Croatia', browserLanguage: 'hr-HR', timeZones: ['Europe/Zagreb'] },
  { code: 'SK', name: '斯洛伐克', nameEn: 'Slovakia', browserLanguage: 'sk-SK', timeZones: ['Europe/Bratislava'] },
  { code: 'SI', name: '斯洛文尼亚', nameEn: 'Slovenia', browserLanguage: 'sl-SI', timeZones: ['Europe/Ljubljana'] },
  { code: 'LT', name: '立陶宛', nameEn: 'Lithuania', browserLanguage: 'lt-LT', timeZones: ['Europe/Vilnius'] },
  { code: 'LV', name: '拉脱维亚', nameEn: 'Latvia', browserLanguage: 'lv-LV', timeZones: ['Europe/Riga'] },
  { code: 'EE', name: '爱沙尼亚', nameEn: 'Estonia', browserLanguage: 'ee-EE', timeZones: ['Europe/Tallinn'] },
  { code: 'LU', name: '卢森堡', nameEn: 'Luxembourg', browserLanguage: 'fr-LU', timeZones: ['Europe/Luxembourg'] },
  { code: 'IS', name: '冰岛', nameEn: 'Iceland', browserLanguage: 'is-IS', timeZones: ['Atlantic/Reykjavik'] },
  { code: 'MT', name: '马耳他', nameEn: 'Malta', browserLanguage: 'mt-MT', timeZones: ['Europe/Malta'] },
  { code: 'CY', name: '塞浦路斯', nameEn: 'Cyprus', browserLanguage: 'el-CY', timeZones: ['Asia/Nicosia'] },

  // ---------- 东欧 / 中亚 ----------
  {
    code: 'RU',
    name: '俄罗斯',
    nameEn: 'Russia',
    browserLanguage: 'ru-RU',
    aliases: ['Russian Federation'],
    timeZones: [
      'Europe/Moscow',
      'Europe/Samara',
      'Europe/Volgograd',
      'Europe/Saratov',
      'Asia/Yekaterinburg',
      'Asia/Omsk',
      'Asia/Novosibirsk',
      'Asia/Krasnoyarsk',
      'Asia/Irkutsk',
      'Asia/Vladivostok'
    ],
    regions: {
      moscow: 'Europe/Moscow',
      moskva: 'Europe/Moscow',
      'saint petersburg': 'Europe/Moscow',
      'st petersburg': 'Europe/Moscow',
      kazan: 'Europe/Moscow',
      rostov: 'Europe/Moscow',
      'rostov on don': 'Europe/Moscow',
      krasnodar: 'Europe/Moscow',
      sochi: 'Europe/Moscow',
      samara: 'Europe/Samara',
      volgograd: 'Europe/Volgograd',
      saratov: 'Europe/Saratov',
      yekaterinburg: 'Asia/Yekaterinburg',
      ekaterinburg: 'Asia/Yekaterinburg',
      chelyabinsk: 'Asia/Yekaterinburg',
      ufa: 'Asia/Yekaterinburg',
      omsk: 'Asia/Omsk',
      novosibirsk: 'Asia/Novosibirsk',
      krasnoyarsk: 'Asia/Krasnoyarsk',
      irkutsk: 'Asia/Irkutsk',
      vladivostok: 'Asia/Vladivostok'
    }
  },
  { code: 'UA', name: '乌克兰', nameEn: 'Ukraine', browserLanguage: 'uk-UA', timeZones: ['Europe/Kyiv'] },
  { code: 'KZ', name: '哈萨克斯坦', nameEn: 'Kazakhstan', browserLanguage: 'kk-KZ', timeZones: ['Asia/Almaty'] },
  { code: 'TR', name: '土耳其', nameEn: 'Turkey', aliases: ['Türkiye', 'Turkiye'], browserLanguage: 'tr-TR', timeZones: ['Europe/Istanbul'] },

  // ---------- 东南亚 / 南亚 ----------
  { code: 'SG', name: '新加坡', nameEn: 'Singapore', browserLanguage: 'en-SG', timeZones: ['Asia/Singapore'] },
  { code: 'MY', name: '马来西亚', nameEn: 'Malaysia', browserLanguage: 'ms-MY', timeZones: ['Asia/Kuala_Lumpur'] },
  { code: 'TH', name: '泰国', nameEn: 'Thailand', browserLanguage: 'th-TH', timeZones: ['Asia/Bangkok'] },
  { code: 'VN', name: '越南', nameEn: 'Vietnam', aliases: ['Viet Nam'], browserLanguage: 'vi-VN', timeZones: ['Asia/Ho_Chi_Minh'] },
  { code: 'ID', name: '印度尼西亚', nameEn: 'Indonesia', browserLanguage: 'id-ID', timeZones: ['Asia/Jakarta'] },
  { code: 'PH', name: '菲律宾', nameEn: 'Philippines', browserLanguage: 'en-PH', timeZones: ['Asia/Manila'] },
  { code: 'IN', name: '印度', nameEn: 'India', browserLanguage: 'en-IN', timeZones: ['Asia/Kolkata'] },
  { code: 'PK', name: '巴基斯坦', nameEn: 'Pakistan', browserLanguage: 'en-PK', timeZones: ['Asia/Karachi'] },
  { code: 'BD', name: '孟加拉国', nameEn: 'Bangladesh', browserLanguage: 'en-BD', timeZones: ['Asia/Dhaka'] },
  { code: 'LK', name: '斯里兰卡', nameEn: 'Sri Lanka', browserLanguage: 'si-LK', timeZones: ['Asia/Colombo'] },
  { code: 'NP', name: '尼泊尔', nameEn: 'Nepal', browserLanguage: 'ne-NP', timeZones: ['Asia/Kathmandu'] },

  // ---------- 中东 / 非洲 ----------
  { code: 'AE', name: '阿联酋', nameEn: 'United Arab Emirates', browserLanguage: 'ar-AE', timeZones: ['Asia/Dubai'] },
  { code: 'SA', name: '沙特阿拉伯', nameEn: 'Saudi Arabia', browserLanguage: 'ar-SA', timeZones: ['Asia/Riyadh'] },
  { code: 'IL', name: '以色列', nameEn: 'Israel', browserLanguage: 'he-IL', timeZones: ['Asia/Jerusalem'] },
  { code: 'ZA', name: '南非', nameEn: 'South Africa', browserLanguage: 'en-ZA', timeZones: ['Africa/Johannesburg'] },
  { code: 'EG', name: '埃及', nameEn: 'Egypt', browserLanguage: 'ar-EG', timeZones: ['Africa/Cairo'] },
  { code: 'NG', name: '尼日利亚', nameEn: 'Nigeria', browserLanguage: 'en-NG', timeZones: ['Africa/Lagos'] },
  { code: 'KE', name: '肯尼亚', nameEn: 'Kenya', browserLanguage: 'en-KE', timeZones: ['Africa/Nairobi'] },

  // ---------- 大洋洲 ----------
  {
    code: 'AU',
    name: '澳大利亚',
    nameEn: 'Australia',
    browserLanguage: 'en-AU',
    timeZones: [
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Perth',
      'Australia/Adelaide',
      'Australia/Darwin',
      'Australia/Hobart'
    ],
    regions: {
      'new south wales': 'Australia/Sydney',
      'australian capital territory': 'Australia/Sydney',
      victoria: 'Australia/Melbourne',
      queensland: 'Australia/Brisbane',
      'western australia': 'Australia/Perth',
      'south australia': 'Australia/Adelaide',
      'northern territory': 'Australia/Darwin',
      tasmania: 'Australia/Hobart'
    }
  },
  { code: 'NZ', name: '新西兰', nameEn: 'New Zealand', browserLanguage: 'en-NZ', timeZones: ['Pacific/Auckland'] }
]

/**
 * 地区 → 时区的运行时索引。
 *
 * 必须在运行时把 regions 的键规范化：表里写的是带空格的原始写法
 * （'new south wales'），而查找用的是规范化键（'newsouthwales'），
 * 两者口径不一致时**所有带空格的国家/地区名都匹配不上**——
 * 表现为「明明是美国加利福尼亚，却判定为无法定位时区」。
 */
const REGION_INDEX = new Map<string, Map<string, string>>()
for (const g of COUNTRY_GEO) {
  if (!g.regions) continue
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(g.regions)) m.set(normKey(k), v)
  REGION_INDEX.set(g.code, m)
}

const GEO_BY_KEY = new Map<string, CountryGeo>()
for (const g of COUNTRY_GEO) {
  for (const k of [g.code, g.name, g.nameEn, ...(g.aliases || [])]) GEO_BY_KEY.set(normKey(k), g)
}

/**
 * 按代码 / 中文名 / 英文名查找国家档案。
 *
 * 宽容匹配是必需的：代理检测存的是 ip-api 的**英文名**（"United States"），
 * 而用户手工填的可能是国码（"US"）或中文名（"美国"）。
 * 三种写法必须指向同一份档案，否则「体检说一致、填充说不一致」必然发生。
 */
export function findCountryGeo(raw: unknown): CountryGeo | undefined {
  const k = normKey(raw)
  if (!k) return undefined
  return GEO_BY_KEY.get(k)
}

/** 取国家的浏览器首选语言；未知国家返回 undefined（**不猜**） */
export function countryBrowserLanguage(code: unknown): string | undefined {
  return findCountryGeo(code)?.browserLanguage
}

/**
 * 反查时区所属国家。
 *
 * 与体检的 `tzVsProxy` / `langVsTz` 判定同源：这两个判定都要拿「时区属于哪个国家」，
 * 若各写一份映射表，改一处忘一处就会出现「体检判一致、修复改出不一致」。
 *
 * 覆盖多时区国家的全部候选时区——否则填了 `America/Los_Angeles` 之后
 * 体检会因为「反查不到国家」而跳过该项检查（skipped），等于把检查能力静默关掉了。
 */
export function timeZoneToCountry(timeZone: unknown): CountryGeo | undefined {
  const tz = String(timeZone ?? '').trim()
  if (!tz) return undefined
  for (const g of COUNTRY_GEO) {
    if (g.timeZones.includes(tz)) return g
  }
  return undefined
}

/** 出口国家 + 地区推导出的语言 / 时区建议 */
export interface LocaleSuggestion {
  /** 归一化国码 */
  country: string
  /** 中文国名 */
  countryName: string
  /** 英文国名（与 ip-api 一致，可直接回显给用户） */
  countryNameEn: string
  /** 建议时区（IANA）。`ambiguous` 为真时它是该国首选值，需用户确认。 */
  timeZone: string
  /** 该国全部候选时区。多时区国家且地区无法定位时，供用户自行选择。 */
  timeZoneOptions: string[]
  /** 建议的浏览器首选语言，如 `en-GB` */
  locale: string
  /** 建议的 `navigator.languages` 数组，如 `['en-GB', 'en']` */
  languages: string[]
  /** 建议的 `Accept-Language` 头值，如 `en-GB,en;q=0.9` */
  acceptLanguage: string
  /**
   * 是否需要用户确认。
   * 为真表示「国家有多时区，但出口地区没能定位到具体时区」——
   * 此时给出的时区只是该国首选值，**必须让用户确认**，不能静默写回。
   */
  ambiguous: boolean
  /** 判定说明（中文，可直接展示给用户） */
  reason: string
}

/** 由首选语言构造 `navigator.languages` 与 `Accept-Language` */
function buildLanguageParts(locale: string): { languages: string[]; acceptLanguage: string } {
  const base = locale.split('-')[0]
  const languages = base && base !== locale ? [locale, base] : [locale]
  const acceptLanguage = languages.map((l, i) => (i === 0 ? l : `${l};q=0.9`)).join(',')
  return { languages, acceptLanguage }
}

/**
 * 按出口国家（可带地区）推导语言 / 时区建议。
 *
 * @param country 出口国家：国码 / 中文名 / 英文名（ip-api 的 `country` 字段值）
 * @param region  出口地区：ip-api 的 `regionName` 字段值；缺省表示只知道国家
 * @returns 推不出时返回 undefined（**不返回宿主 IP 兜底值**）
 */
export function suggestLocaleFromExit(country: unknown, region?: unknown): LocaleSuggestion | undefined {
  const geo = findCountryGeo(country)
  if (!geo) return undefined

  const regionName = String(region ?? '').trim()
  const regionKey = normKey(regionName)

  // 地区能定位到具体时区 → 直接给，无需用户确认
  if (regionKey) {
    const hit = REGION_INDEX.get(geo.code)?.get(regionKey)
    if (hit) {
      const { languages, acceptLanguage } = buildLanguageParts(geo.browserLanguage)
      return {
        country: geo.code,
        countryName: geo.name,
        countryNameEn: geo.nameEn,
        timeZone: hit,
        timeZoneOptions: geo.timeZones,
        locale: geo.browserLanguage,
        languages,
        acceptLanguage,
        ambiguous: false,
        reason: `按出口地区「${regionName}」定位到 ${hit}`
      }
    }
  }

  const { languages, acceptLanguage } = buildLanguageParts(geo.browserLanguage)

  // 单时区国家：不存在「给错」的可能
  if (geo.timeZones.length === 1) {
    return {
      country: geo.code,
      countryName: geo.name,
      countryNameEn: geo.nameEn,
      timeZone: geo.timeZones[0],
      timeZoneOptions: geo.timeZones,
      locale: geo.browserLanguage,
      languages,
      acceptLanguage,
      ambiguous: false,
      reason: `${geo.name}只有一个时区，直接采用 ${geo.timeZones[0]}`
    }
  }

  // 多时区国家且地区不认识：给首选 + 全部候选，**标记需确认**
  return {
    country: geo.code,
    countryName: geo.name,
    countryNameEn: geo.nameEn,
    timeZone: geo.timeZones[0],
    timeZoneOptions: geo.timeZones,
    locale: geo.browserLanguage,
    languages,
    acceptLanguage,
    ambiguous: true,
    reason: regionName
      ? `${geo.name}跨 ${geo.timeZones.length} 个时区，出口地区「${regionName}」未能定位到具体时区，已给出首选值 ${geo.timeZones[0]}，请确认`
      : `${geo.name}跨 ${geo.timeZones.length} 个时区，未能定位到具体时区，已给出首选值 ${geo.timeZones[0]}，请确认`
  }
}

/**
 * 判定「该时区是否属于该国」。
 * 体检的 `tzVsProxy` 判定用得上——代理出口给的是英文国名，时区给的是 IANA 名，
 * 两者要经同一份档案换算到国码再比。
 */
export function timeZoneBelongsToCountry(timeZone: unknown, country: unknown): boolean {
  const geo = findCountryGeo(country)
  if (!geo) return false
  const tzGeo = timeZoneToCountry(timeZone)
  if (!tzGeo) return false
  return tzGeo.code === geo.code
}
