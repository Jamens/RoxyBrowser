import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { Card, Form, Select, InputNumber, Input, Button, Space, Typography, Tag, Divider, Switch, Upload, Modal, Alert, Table, Collapse, Checkbox, AutoComplete, theme } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { SaveOutlined, DownloadOutlined, UploadOutlined, DatabaseOutlined, PlusOutlined, EditOutlined, DeleteOutlined, LockOutlined, SafetyOutlined, QrcodeOutlined, NotificationOutlined } from '@ant-design/icons'
import { api, apiFetch, getToken } from '../api'
import { readTextFile } from '../utils/download'
import { DEFAULT_SETTINGS, SEARCH_ENGINES, WEBHOOK_EVENT_GROUPS, type AppSettings, type AiAutoTask, type UpdaterStatus, type WebhookConfig } from '@shared/types'
import { NOTIFY_CATEGORIES } from '@shared/notifications'
import { COUNTRIES, countryLanguage, countryTimezone, findCountry } from '@shared/countries'
import { LOCALES } from '@shared/locales'
import { describeTimeZone } from '@shared/timezone'
import { DEFAULT_CDP_PORT, type CdpInfo } from '@shared/cdp'
import { mergeSettingsPayload, missingSmtpFields, smtpConfigured, type SmtpConfigLike, type SmtpTripleField } from '@shared/settingsValidation'
import { checkCloudBaseUrl } from '@shared/cloudConfigValidation'
import type { SnapshotDiff, ProxyDiffItem, ProfileDiffItem } from '@shared/snapshotDiff'
import { useI18n, LOCALE_CHANGE_EVENT } from '../i18n'
import type { MessageKey } from '../i18n/messages'

// 主题、自动时段、国家与语言同步进 localStorage，供渲染层 resolveDark / i18n 同步读取
// （theme.ts 与 i18n 都在模块级同步读取，不能依赖 React 状态或异步请求）
// 把客户端出网代理交给主进程套用到默认 session（system 模式时主进程会恢复系统代理）。
// 放组件外：load 的 useCallback 依赖数组保持不变，避免每次渲染生成新引用导致请求重跑。
/**
 * 深度相等（用于「未保存改动」判定）。
 *
 * 为什么不用 `JSON.stringify(a) === JSON.stringify(b)`：
 * 字符串比较**依赖键的插入顺序**，两个内容相同但键序不同的对象会被判为不等
 * → 用户刚进设置页就被误报「有未保存的改动」，久而久之就不信这个提示了。
 * 误报比漏报更糟 —— 提示一旦不可信，用户就再也不会注意它。
 *
 * 只处理 JSON 形态（对象 / 数组 / 标量），足以覆盖表单值。
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // NaN === NaN 为 false，但两者确实「一样」
    return Number.isNaN(a as number) && Number.isNaN(b as number)
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}

function applyNetworkProxy(s: AppSettings) {
  window.roxy?.setNetworkProxy?.({
    mode: s.networkMode,
    type: s.customProxyType,
    host: s.customProxyHost,
    port: s.customProxyPort,
    username: s.customProxyUsername,
    password: s.customProxyPassword
  })
}

// 任务栏图标显示模式交给主进程（'name' 时环境窗口标题锁定为环境名）
function applyTrayDisplay(s: AppSettings) {
  window.roxy?.setTrayDisplay?.(s.trayDisplay || 'icon')
}

/** SMTP 三件套各自的必填文案 key（条件必填，规则见 missingSmtpFields） */
const SMTP_REQUIRED_KEY: Record<SmtpTripleField, MessageKey> = {
  host: 'settings.smtpHostRequired',
  user: 'settings.smtpUserRequired',
  pass: 'settings.smtpPassRequired'
}

function persistThemeLocals(s: AppSettings) {
  localStorage.setItem('roxy_theme', s.theme)
  localStorage.setItem('roxy_auto_day_start', String(s.autoDayStart))
  localStorage.setItem('roxy_auto_night_start', String(s.autoNightStart))
  localStorage.setItem('roxy_country', s.country)
  localStorage.setItem('roxy_language', s.language)
  window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT))
}

/**
 * 快照导入预演的展示：把「这次导入会发生什么」摊开给用户看。
 *
 * 呈现原则：**先说会被跳过的，再说会新建的**。
 * 用户点导入是为了拿到数据，而「哪些没拿到」远比「拿到了多少」更重要——
 * 后者系统本来也会告诉他，前者只有这里会说。
 * 故有冲突 / 丢失时用 warning 色，完全无损时才用 success 色。
 */
function SnapshotDiffView({ diff, warnings }: { diff: SnapshotDiff; warnings: string[] }) {
  const { t } = useI18n()
  const c = diff.counts
  const risky = c.proxyConflict > 0 || c.extensionDropped > 0 || c.versionAhead > 0 || diff.notes.length > 0
  const notes = [...new Set([...warnings, ...diff.notes])]

  return (
    <div>
      <Alert
        type={risky ? 'warning' : 'success'}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <Space wrap size={[8, 4]}>
            <Tag color="blue">{t('snapshot.diffProfiles', { n: c.profileTotal })}</Tag>
            <Tag color="green">{t('snapshot.diffProxyCreate', { n: c.proxyCreate })}</Tag>
            {c.proxyReuse > 0 && <Tag>{t('snapshot.diffProxyReuse', { n: c.proxyReuse })}</Tag>}
            {c.groupCreate > 0 && <Tag>{t('snapshot.diffGroupCreate', { n: c.groupCreate })}</Tag>}
            {c.rpaTotal > 0 && <Tag color="purple">{t('snapshot.diffRpa', { n: c.rpaTotal })}</Tag>}
          </Space>
        }
        description={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('snapshot.diffVersion', { src: diff.sourceVersion, cur: diff.formatVersion })}
            {diff.migrations.length > 0 ? ` · ${diff.migrations.join(' / ')}` : ''}
            {diff.sourceTeam ? ` · ${t('snapshot.diffFromTeam', { team: diff.sourceTeam })}` : ''}
          </Typography.Text>
        }
      />

      {notes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('snapshot.diffNotes')}
          description={
            <ul style={{ paddingLeft: 18, margin: 0, maxHeight: 180, overflow: 'auto' }}>
              {notes.map((n, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{n}</li>
              ))}
            </ul>
          }
        />
      )}

      {/* 明细默认折叠，避免几十行把关键信息淹没 */}
      {diff.proxies.length > 0 && (
        <Collapse ghost size="small" items={[{
          key: 'p',
          label: t('snapshot.diffProxyDetail', { n: diff.proxies.length }),
          children: (
            <Table<ProxyDiffItem>
              size="small"
              rowKey={(r, i) => r.name || String(r.reason || i)}
              pagination={false}
              dataSource={diff.proxies}
              columns={[
                { title: t('snapshot.diffColName'), dataIndex: 'name' },
                {
                  title: t('snapshot.diffColAction'),
                  dataIndex: 'action',
                  render: (a, r) => {
                    if (a === 'create') return <Tag color="green">{t('snapshot.diffActCreate')}</Tag>
                    if (a === 'reuse') return <Tag>{t('snapshot.diffActReuse')}</Tag>
                    if (a === 'conflict') return <Tag color="orange">{t('snapshot.diffActConflict')}</Tag>
                    return <Tag color="red">{t('snapshot.diffActInvalid')}{r.reason ? ` (${r.reason})` : ''}</Tag>
                  }
                },
                {
                  title: t('snapshot.diffColEndpoint'),
                  render: (_, r) => (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.currentHost != null ? `${r.currentHost}:${r.currentPort}` : ''}
                      {r.currentHost != null && r.incomingHost != null ? ' → ' : ''}
                      {r.incomingHost != null ? `${r.incomingHost}:${r.incomingPort}` : ''}
                    </Typography.Text>
                  )
                }
              ]}
            />
          )
        }]} />
      )}

      {diff.profiles.length > 0 && (
        <Collapse ghost size="small" items={[{
          key: 'e',
          label: t('snapshot.diffProfileDetail', { n: diff.profiles.length }),
          children: (
            <Table<ProfileDiffItem>
              size="small"
              rowKey={(r, i) => `${r.name}-${i}`}
              pagination={false}
              dataSource={diff.profiles}
              columns={[
                { title: t('snapshot.diffColName'), dataIndex: 'name' },
                {
                  title: t('snapshot.diffColGroup'),
                  render: (_, r) =>
                    r.group ? (
                      <Tag color={r.groupWillCreate ? 'green' : undefined}>
                        {r.group}{r.groupWillCreate ? ` (${t('snapshot.diffNew')})` : ''}
                      </Tag>
                    ) : <Typography.Text type="secondary">—</Typography.Text>
                },
                {
                  title: t('snapshot.diffColProxy'),
                  render: (_, r) => {
                    if (r.proxyAction === 'none') return <Typography.Text type="secondary">—</Typography.Text>
                    const color = r.proxyAction === 'missing' ? 'red' : r.proxyAction === 'create' ? 'green' : undefined
                    return <Tag color={color}>{r.proxy}</Tag>
                  }
                },
                {
                  title: t('snapshot.diffColExt'),
                  render: (_, r) => {
                    if (!r.extensions.length) return <Typography.Text type="secondary">—</Typography.Text>
                    return (
                      <span>
                        {r.extensions.map((e, i) => (
                          <Tag key={i} color={e.found ? undefined : 'red'}>{e.name}</Tag>
                        ))}
                      </span>
                    )
                  }
                }
              ]}
            />
          )
        }]} />
      )}
    </div>
  )
}

export default function Settings() {
  const { message } = useAppCtx()
  const [form] = Form.useForm<AppSettings>()
  // antd token：吸底保存栏的底色/边框色随主题自动切换
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(false)
  /**
   * 「服务端已落库的值」的快照，作为未保存改动的比对基线。
   *
   * 必须在 load() 之前声明：load() 里会写它，若声明在后面，加载路径上的赋值会撞 TDZ。
   */
  const savedSnapshotRef = useRef<Record<string, unknown> | null>(null)
  /**
   * 订阅**所有**表单字段的值变化。
   *
   * 用途是让「有未保存改动」的提示能随用户的每一次改动重新渲染。
   * antd 的 Form 本身不提供「整体脏检查」的通知机制，而直接读
   * `form.getFieldsValue()` 拿不到响应式订阅。
   * `Form.useWatch()` 不带参数会订阅所有字段，其返回值每次变化都是新引用，
   * 组件因此会在任意字段变化时重渲染 —— 这正是我们要的。
   */
  Form.useWatch([], form)
  const [saving, setSaving] = useState(false)
  // 探活结果。error / visionError 是后端已分类好的中文文案（含厂商原文），
  // 直接展示即可；errorKind 供后续按类型给不同引导。
  const [aiStatus, setAiStatus] = useState<{
    reachable: boolean
    modelPulled: boolean
    model?: string
    error?: string
    models?: string[]
    backend?: 'local' | 'cloud'
    visionModel?: string
    visionReachable?: boolean
    visionError?: string
    errorKind?: string
    visionErrorKind?: string
    visionSupports?: boolean
  } | null>(null)
  const [checking, setChecking] = useState(false)
  // 本机已安装的 Ollama 模型：模型输入框的下拉候选。
  // 用户手打模型名很容易写成同 base 但不同 tag 的名字（qwen2.5:7b vs qwen2.5:3b），
  // 而 Ollama 按**完整名**找模型 → 探活显示正常、真正调用 404。
  // 下拉直接列出本机真实装了的模型，从源头消除这类错误。
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [testingId, setTestingId] = useState<number | null>(null)
  const { t, setLocale } = useI18n()

  // SMTP 测试
  const [testSmtpEmail, setTestSmtpEmail] = useState('')
  const [testingSmtp, setTestingSmtp] = useState(false)

  // 桌面通知测试（立即弹一条系统通知，与表单是否已保存无关）
  const [testingNotify, setTestingNotify] = useState(false)
  const sendNotifyTest = async () => {
    setTestingNotify(true)
    try {
      const r = await api.post<{ ok: boolean; error?: string }>('/api/notifications/test')
      if (r.ok) message.success(t('notif.setting.testOk'))
      else message.error(t('notif.setting.testFail', { error: r.error || '' }))
    } catch (e) {
      message.error(t('notif.setting.testFail', { error: (e as Error).message }))
    } finally {
      setTestingNotify(false)
    }
  }

  // ===== 登录二次验证（2FA / TOTP）=====
  const [twoFaEnabled, setTwoFaEnabled] = useState(false)
  const [twoFaBusy, setTwoFaBusy] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupSecret, setSetupSecret] = useState('')
  const [setupQr, setSetupQr] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [disableOpen, setDisableOpen] = useState(false)

  // ===== 空间快照导入（两阶段：预演差异 → 确认后写库）=====
  // pendingImport 非空即表示「差异已算好，等用户确认」，此时不写任何数据。
  const [pendingImport, setPendingImport] = useState<{
    file: File
    data: Record<string, unknown>
    diff: SnapshotDiff
    warnings: string[]
  } | null>(null)
  const [importing, setImporting] = useState(false)
  const [disableCode, setDisableCode] = useState('')

  const loadTwoFa = useCallback(async () => {
    try {
      const me = await api.get<{ twoFactorEnabled?: boolean }>('/api/auth/me')
      setTwoFaEnabled(!!me.twoFactorEnabled)
    } catch {
      /* 忽略：未登录等极端情况 */
    }
  }, [])
  useEffect(() => {
    loadTwoFa()
  }, [loadTwoFa])

  const startTwoFaSetup = async () => {
    setTwoFaBusy(true)
    try {
      const r = await api.post<{ secret: string; qrCodeDataUrl: string }>('/api/auth/2fa/setup')
      setSetupSecret(r.secret)
      setSetupQr(r.qrCodeDataUrl)
      setSetupCode('')
      setSetupOpen(true)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTwoFaBusy(false)
    }
  }
  const confirmTwoFaSetup = async () => {
    setTwoFaBusy(true)
    try {
      await api.post('/api/auth/2fa/confirm', { code: setupCode })
      setTwoFaEnabled(true)
      setSetupOpen(false)
      message.success('二次验证已启用')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTwoFaBusy(false)
    }
  }
  const confirmTwoFaDisable = async () => {
    setTwoFaBusy(true)
    try {
      await api.post('/api/auth/2fa/disable', { code: disableCode })
      setTwoFaEnabled(false)
      setDisableOpen(false)
      message.success('二次验证已关闭')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTwoFaBusy(false)
    }
  }

  // AI 定时自动化：任务列表管理与编辑
  const [profiles, setProfiles] = useState<{ id: number; name: string }[]>([])
  const [editing, setEditing] = useState<{ index: number; open: boolean } | null>(null)
  const [taskForm] = Form.useForm<AiAutoTask>()
  useEffect(() => {
    api
      .get<{ id: number; name: string }[]>('/api/profiles')
      .then((p) => setProfiles(Array.isArray(p) ? p : []))
      .catch(() => {})
  }, [])

  const genTaskId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const genWebhookId = () => `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const openTaskEditor = (index: number) => {
    const task = (form.getFieldValue(['aiAutoTasks', index]) as AiAutoTask) || {
      id: genTaskId(),
      name: '',
      instruction: '',
      envIds: [],
      intervalMin: 60,
      enabled: true,
      saveRpa: true,
      maxSteps: 0
    }
    taskForm.setFieldsValue(task)
    setEditing({ index, open: true })
  }

  const onTaskOk = async () => {
    try {
      const v = await taskForm.validateFields()
      if (editing) form.setFieldValue(['aiAutoTasks', editing.index], v)
      setEditing(null)
    } catch {
      /* 校验未通过，保持弹窗 */
    }
  }

  // 让「当地时间 / UTC 偏移 / 是否夏令时」每 30 秒自刷新一次
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  // 内核版本信息（对标官方「内核版本」）：主进程 process.versions 经 IPC 取回
  const [versions, setVersions] = useState<{ app: string; electron: string; chrome: string; node: string; v8: string; platform: string; arch: string } | null>(null)
  useEffect(() => {
    window.roxy?.getVersions?.().then(setVersions).catch(() => {})
  }, [])

  // ===== CDP 调试端口 =====
  // 状态独立于主表单：它落在本地配置文件（不是 app_settings），且需重启生效。
  // info 里的 port 是「实际生效」的端口（可能被占用后顺延），与表单里的配置值不一定相同，
  // 所以两者分开存——配置值用于下次启动，info.port 用于当前展示连接地址。
  const [cdpEnabled, setCdpEnabled] = useState(false)
  const [cdpPort, setCdpPort] = useState(DEFAULT_CDP_PORT)
  const [cdpInfo, setCdpInfo] = useState<CdpInfo | null>(null)
  const [savingCdp, setSavingCdp] = useState(false)

  const loadCdp = useCallback(async () => {
    try {
      const res = await api.get<{ enabled: boolean; port: number; info: CdpInfo }>('/api/cdp')
      setCdpEnabled(res.enabled)
      setCdpPort(res.port)
      setCdpInfo(res.info)
    } catch {
      /* 后端未就绪时保持默认展示 */
    }
  }, [])

  useEffect(() => {
    void loadCdp()
  }, [loadCdp])

  const saveCdp = useCallback(async () => {
    setSavingCdp(true)
    try {
      await api.put('/api/cdp', { enabled: cdpEnabled, port: cdpPort })
      message.success(t('cdp.saved'))
      // 重新拉一次：让「实际端口 / target 列表」反映当前运行态
      await loadCdp()
    } catch {
      /* 错误提示由 api 层统一处理 */
    } finally {
      setSavingCdp(false)
    }
  }, [cdpEnabled, cdpPort, loadCdp, t])

  const country = Form.useWatch('country', form) || DEFAULT_SETTINGS.country
  const networkMode = Form.useWatch('networkMode', form) || DEFAULT_SETTINGS.networkMode
  const backend = Form.useWatch(['aiAgent', 'backend'], form) || 'local'
  const tz = countryTimezone(country)
  const tzInfo = describeTimeZone(tz, now)

  // useCallback 稳定 load，否则每次渲染都生成新引用，会导致 useEffect 无限重跑 + 重复请求
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await api.get<AppSettings>('/api/settings')
      form.setFieldsValue(s)
      // 记录「服务端已落库的值」作为未保存改动的比对基线。
      // 基线取「服务端值 + 表单 store 合并」：setFieldsValue 之后 store 里还留有
      // 条件渲染卸载的字段（如切到 cloud 后被卸载的本地模型字段），
      // 若基线只用服务端值，两者结构不同 → 刚进页面就被判为「有未保存改动」。
      savedSnapshotRef.current = mergeSettingsPayload(form.getFieldsValue(true), s)
      persistThemeLocals(s)
      applyNetworkProxy(s)
      applyTrayDisplay(s)
    } catch (e) {
      form.setFieldsValue(DEFAULT_SETTINGS)
      savedSnapshotRef.current = DEFAULT_SETTINGS as unknown as Record<string, unknown>
      persistThemeLocals(DEFAULT_SETTINGS)
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => {
    load()
  }, [load])

  /**
   * 未保存改动的拦截。
   *
   * ## 要解决什么
   *
   * 用户实测报障的另一半：改完云端参数后**离开设置页去 AI Agent 页**看一眼，
   * 回来发现参数全没了、模型后端又显示「本地」。
   *
   * 机制：设置页卸载时表单状态一并销毁；重新进入时 `load()` 用**服务端旧值**
   * `form.setFieldsValue(s)` 覆盖 —— 于是用户改的东西看起来像「被系统恢复」。
   * 而用户之所以敢直接切走，是因为页面上**没有任何提示**告诉他「这些改动还没保存」。
   *
   * ## 为什么不用 useBlocker
   *
   * `useBlocker` 需要 data router（`createBrowserRouter` / `RouterProvider`），
   * 本项目用的是 `HashRouter` + `<Routes>`（声明式模式），用它会直接抛错。
   *
   * ## 为什么不用 isFieldsTouched
   *
   * `isFieldsTouched()` 只反映「用户碰过哪个字段」，不反映「当前值与服务端值是否不同」。
   * 用户碰了又改回原值时它仍为 true，会误报「有未保存改动」。
   * 故用**与服务端值逐字段比对**的方式判断：以最近一次落库的值为基线，
   * 当前表单值与之不同才算「有未保存改动」。
   */
  /** 当前表单值是否与服务端已落库的值不同（有未保存改动） */
  const hasUnsavedChanges = useCallback(() => {
    const baseline = savedSnapshotRef.current
    if (!baseline) return false
    try {
      return !deepEqual(form.getFieldsValue(true), baseline)
    } catch {
      return false
    }
  }, [form])

  /**
   * 关闭应用 / 刷新页面时拦一道。
   *
   * 只拦「应用整体关闭或页面刷新」——Electron 应用里这对应用户误关窗口。
   * 站内路由切换拦不住（HashRouter 无拦截能力），故对站内切换靠**就近的保存按钮**
   * 与「AI Agent 区块」的显著提示来降低误操作概率。
   */
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return
      e.preventDefault()
      // 传统写法：赋值 returnValue 才会触发浏览器的「离开此页面？」提示
      e.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedChanges])

  /**
   * 拉取本机已安装的 Ollama 模型（供模型输入框下拉用）。
   *
   * 进设置页就拉一次：下拉里直接就是本机真实装了的模型，用户不用手打
   * （手打最容易写成同 base 但不同 tag 的名字，如本机装 qwen2.5:3b 却填 qwen2.5:7b，
   * 而 Ollama 按完整名找模型 → 探活显示正常、真正调用 404）。
   *
   * 失败不算错误：Ollama 没启动时下拉为空并给出提示，用户照样可以手输模型名。
   */
  const loadOllamaModels = useCallback(async () => {
    try {
      const res = await api.get<{ ok: boolean; models?: string[] }>('/api/ai-agent/models')
      setOllamaModels(res.models || [])
    } catch {
      setOllamaModels([])
    }
  }, [])

  useEffect(() => {
    void loadOllamaModels()
  }, [loadOllamaModels])

  /**
   * 保存设置。
   *
   * 走 antd 的 `onFinish` / `onFinishFailed` 而非手写 `validateFields()`：
   * 手写版本在校验失败时会 reject，若漏了 catch 就是**静默失败** —— 用户改了设置点保存，
   * 页面只在远处某个字段显示一行红字（且那字段多半与本次改动无关），
   * 看起来就像「改了没生效、又被系统恢复」。这正是「AI Agent 开关与视觉模型改了存不进去」
   * 的真实观感：根因是 SMTP 三件套无条件必填，校验整表失败 → 连请求都没发出。
   *
   * `scrollToFirstError` 让 antd 自动滚到第一处出错项，失败必可见。
   */
  const handleFinish = async (values: AppSettings) => {
    setSaving(true)
    try {
      // 合并全量 store：条件渲染卸载的字段（如 backend 切到 cloud 后本地模型字段被卸载）
      // 不在 validateFields() 的返回值里，只发返回值等于让服务端用默认值把它们抹掉
      // —— 用户切走再切回来会发现「自己改的又被恢复了」。
      const payload = mergeSettingsPayload(form.getFieldsValue(true), values)
      const res = await api.put<{ ok: boolean; settings: AppSettings }>('/api/settings', payload)
      // 主题 / 国家 / 语言即时生效：写入 localStorage 并通知 App 层重读
      persistThemeLocals(res.settings)
      window.dispatchEvent(new Event('roxy-theme-change'))
      applyNetworkProxy(res.settings)
      applyTrayDisplay(res.settings)
      // 已落库 → 刷新「未保存改动」的比对基线，否则保存完仍被判为有未保存改动。
      // 基线要用「服务端值 + 表单 store 合并」的结果，而不是只用 res.settings：
      // 服务端返回的是 merged（含默认值补齐），而表单 store 里还有条件渲染卸载的字段
      // （如 backend 切到 cloud 后被卸载的本地模型字段），两者结构不同，直接比会一直判为「有改动」。
      savedSnapshotRef.current = mergeSettingsPayload(form.getFieldsValue(true), res.settings)
      message.success(t('settings.saved'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** 校验未通过：明确告诉用户「本次修改没有保存」，并给出出错项数量 */
  const handleFinishFailed = (info: { errorFields: { name: (string | number)[]; errors: string[] }[] }) => {
    message.error(t('settings.saveValidationFailed', { count: info.errorFields.length }))
  }

  /**
   * 从 AI Agent 区块就近触发的保存。
   *
   * 走的是**与主保存按钮完全相同**的提交路径（`form.submit()` → antd 的 onFinish），
   * 而不是自己拼 PUT：
   * - 校验必须一起跑，否则这里就成了「绕过校验的后门」—— 比如把 Key 填进地址栏
   *   在主按钮上会被拦下，在这里却能存进去
   * - 失败提示、滚动定位到第一个出错项的行为也一并复用
   *
   * `form.submit()` 而非 `form.validateFields()`：前者走 antd 的原生提交事件，
   * 会触发 onFinish / onFinishFailed 两条既定路径，失败时的滚动定位与提示都自动生效。
   */
  const submitFormNow = useCallback(() => {
    form.submit()
  }, [form])

  /**
   * SMTP 三件套的**条件必填**。
   *
   * SMTP 是可选功能（仅「团队空间 → 邮箱邀请成员」用到），服务端 team.ts 也是用
   * 运行时守卫允许它未配置。此前这里挂的是无条件 `required`，而三者的默认值是空串——
   * antd 的 validateFields() 校验的是**整张表**，任一字段不过整次保存就被拒
   * （连 api.put 都不会发出），于是「没配 SMTP」的用户**一个设置都存不进去**：
   * 改了 AI Agent 开关与视觉模型，点保存没反应，重新进页面又变回原值。
   *
   * 改成：三件套全空 = 不启用（放行）；填了任一项 = 三项必填。
   */
  const smtpTripleRule = (field: SmtpTripleField) => (_rule: unknown, value: unknown) => {
    const smtp = (form.getFieldValue('smtp') as SmtpConfigLike) || {}
    const missing = missingSmtpFields(smtp)
    if (missing.length === 0 || !missing.includes(field)) return Promise.resolve()
    return Promise.reject(new Error(t(SMTP_REQUIRED_KEY[field])))
  }

  /** SMTP 端口同理：没配 SMTP 时端口填什么都不该拦下保存 */
  const smtpPortRule = (_rule: unknown, value: unknown) => {
    const smtp = (form.getFieldValue('smtp') as SmtpConfigLike) || {}
    if (!smtpConfigured(smtp)) return Promise.resolve()
    return value === undefined || value === null || value === ''
      ? Promise.reject(new Error(t('settings.smtpPortRequired')))
      : Promise.resolve()
  }

  // Webhook 事件下拉选项：全部事件 + 各分组（分组值为关键词，命中规则见 webhookShouldFire）
  const webhookEventOptions = useMemo(() => {
    const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return [
      { value: '*', label: t('webhook.eventAll') },
      ...WEBHOOK_EVENT_GROUPS.map((g) => ({
        label: t(`webhook.group.${g.key}`),
        options: g.events.map((e) => ({
          value: e,
          label: humanize(e)
        }))
      }))
    ]
  }, [t])

  // Webhook「发送测试」：用当前表单里的配置单发一次，反馈投递结果
  const sendWebhookTest = async (idx: number) => {
    const wh = form.getFieldValue(['webhooks', idx]) as WebhookConfig | undefined
    if (!wh || !wh.url) {
      message.warning(t('webhook.urlRequired'))
      return
    }
    setTestingId(idx)
    try {
      const res = await api.post<{ ok: boolean; status: number; error?: string }>('/api/webhooks/test', { webhook: wh })
      if (res.ok && res.status >= 200 && res.status < 300) {
        message.success(t('webhook.testOk', { status: res.status }))
      } else {
        message.error(t('webhook.testFail', { status: res.status || '-', error: res.error || '' }))
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTestingId(null)
    }
  }

  // SMTP 配置测试：用当前表单里的配置单发一封测试邮件，反馈投递结果
  const testSmtp = async () => {
    const smtp = (form.getFieldValue('smtp') as Record<string, unknown>) || {}
    if (!smtp.host || !smtp.port) {
      message.warning(t('settings.smtpNotConfigured'))
      return
    }
    const email = testSmtpEmail.trim()
    if (!email) {
      message.warning(t('settings.smtpTestEmailRequired'))
      return
    }
    setTestingSmtp(true)
    try {
      const res = await api.post<{ ok: boolean; error?: string }>('/api/team/invites/test', { smtp, email })
      if (res.ok) message.success(t('settings.smtpTestSent'))
      else message.error(t('settings.smtpTestFailed', { error: res.error || '' }))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTestingSmtp(false)
    }
  }

  // 全空间快照：把整个团队空间导出为单个 JSON（环境 + 代理 + RPA + 扩展引用）
  const exportSnapshot = async () => {
    try {
      const res = await apiFetch('/api/snapshot/export', {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {}
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        return message.error((d as { message?: string }).message || t('snapshot.exportFailed'))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `roxy-snapshot-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      message.success(t('snapshot.exported'))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 全空间快照导入：先预演差异、用户确认后再真正写库。
  // 为什么要有预演：导入并非总是无损的——同名代理连接信息不同会被保留不覆盖、
  // 环境引用的扩展在当前团队不存在会被丢弃、代理池缺项会让环境导入成「无代理」。
  // 这些以前只能在导入**之后**从日志里零散看到，那时数据已经写进去了。
  const importSnapshot = async (file: File) => {
    try {
      const text = await readTextFile(file)
      const data = JSON.parse(text) as Record<string, unknown>
      const pre = await api.post<{ diff: SnapshotDiff; warnings?: string[] }>('/api/snapshot/preview', data)
      const d = pre.diff
      setPendingImport({ file, data, diff: d, warnings: pre.warnings || [] })
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 用户在预览弹窗里点了「确认导入」
  const confirmImport = async () => {
    if (!pendingImport) return
    const { data, diff } = pendingImport
    setImporting(true)
    try {
      const res = await api.post<{
        profiles: number
        proxiesCreated: number
        rpaCreated: number
        proxiesSkipped: number
        groupsCreated: number
        warnings?: string[]
        diff?: SnapshotDiff
      }>('/api/snapshot/import', data)
      message.success(
        t('snapshot.importSuccess', {
          profiles: res.profiles,
          proxies: res.proxiesCreated,
          rpa: res.rpaCreated
        })
      )
      // 导入后如实地把「实际发生的情况」讲清楚，而不是只报三个成功数字：
      // 用户最需要知道的正是这些被跳过的部分。
      const notes = [...(res.warnings || []), ...(res.diff?.notes || [])]
      if (res.proxiesSkipped > 0 || notes.length) {
        Modal.info({
          title: t('snapshot.importReport'),
          content: (
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                {t('snapshot.importSkipped', { proxies: res.proxiesSkipped, groups: res.groupsCreated })}
              </Typography.Paragraph>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {[...new Set(notes)].map((n, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{n}</li>
                ))}
              </ul>
            </div>
          ),
          okText: t('common.confirm')
        })
      }
      setPendingImport(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  const checkAi = async () => {
    setChecking(true)
    try {
      // 用表单当前值（可能未保存）做检测，避免选了云端却按已保存的旧后端探活
      const aiAgentForm = (form.getFieldValue('aiAgent') as Record<string, unknown>) || {}
      const s = await api.post<{ reachable: boolean; modelPulled: boolean; model?: string; error?: string; models?: string[]; backend?: 'local' | 'cloud'; visionModel?: string; visionReachable?: boolean; visionError?: string; errorKind?: string; visionErrorKind?: string; visionSupports?: boolean }>('/api/ai-agent/status', { aiAgent: aiAgentForm })
      setAiStatus(s)
      // 探活响应自带本机模型清单，顺带刷新下拉候选（用户可能刚 pull 了新模型）
      if (s.models?.length) setOllamaModels(s.models)
      if (!s.reachable) message.warning(s.error || t('aiAgent.statusUnreachable'))
      else if (s.error) message.warning(s.error)
      else message.success(s.backend === 'cloud' ? t('aiAgent.statusCloudReachable') : t('aiAgent.statusReachable'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  // 状态文案：优先展示服务端回传的具体错误；两端（本地 / 云端）共用，
  // 同时覆盖「文本模型」与「视觉模型」两类失败，避免视觉模型填错却显示正常。
  const renderAiStatus = () => {
    if (!aiStatus) return null
    const ok = aiStatus.reachable && !aiStatus.error
    const text = !aiStatus.reachable
      ? (aiStatus.error || t('aiAgent.statusUnreachable'))
      : aiStatus.error
        ? aiStatus.error
        : t(aiStatus.backend === 'cloud' ? 'aiAgent.statusCloudReachable' : 'aiAgent.statusReachable')
    return (
      <Typography.Paragraph type={ok ? 'success' : 'warning'} style={{ marginTop: 0 }}>
        {text}
      </Typography.Paragraph>
    )
  }

  // 自动更新状态展示：检查 / 可用 / 下载中 / 已下载 / 错误 各态对应不同交互
  const renderUpdateStatus = (s: UpdaterStatus | null) => {
    if (!s) return null
    switch (s.state) {
      case 'dev':
        return <Tag>{t('update.dev')}</Tag>
      case 'checking':
        return <Tag color="processing">{t('update.checking')}</Tag>
      case 'latest':
        return <Tag color="success">{t('update.latest')}（{s.version}）</Tag>
      case 'available':
        return (
          <Button
            type="link"
            onClick={async () => {
              const r = await window.roxy?.downloadUpdate?.()
              if (r && !r.ok) message.error(r.error || t('update.error'))
            }}
          >
            {t('update.available')} {s.version} → {t('update.download')}
          </Button>
        )
      case 'downloading':
        return <Tag color="processing">{t('update.downloading')} {s.percent}%</Tag>
      case 'downloaded':
        return (
          <Button type="primary" onClick={() => window.roxy?.quitAndInstall?.()}>
            {t('update.downloaded')} · {t('update.installNow')}
          </Button>
        )
      case 'error':
        return <Tag color="error">{t('update.error')}{s.message ? `：${s.message}` : ''}</Tag>
      default:
        return null
    }
  }

  return (
    <>
      <Card title={t('settings.title')} loading={loading}>
      <Typography.Paragraph type="secondary">{t('settings.desc')}</Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={DEFAULT_SETTINGS}
        style={{ maxWidth: 560 }}
        onFinish={handleFinish}
        onFinishFailed={handleFinishFailed}
        scrollToFirstError
      >
        <Divider>{t('settings.sectionFp')}</Divider>
        <Form.Item
          name="defaultFingerprintOs"
          label={t('settings.defaultOs')}
          extra={t('settings.defaultOsExtra')}
        >
          <Select
            options={[
              { value: 'windows', label: 'Windows' },
              { value: 'macos', label: 'macOS' },
              { value: 'linux', label: 'Linux' }
            ]}
          />
        </Form.Item>
        <Space size="large" style={{ display: 'flex' }}>
          <Form.Item
            name="defaultWindowWidth"
            label={t('settings.windowWidth')}
            rules={[{ required: true }]}
          >
            <InputNumber min={320} max={4096} addonAfter={t('common.px')} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            name="defaultWindowHeight"
            label={t('settings.windowHeight')}
            rules={[{ required: true }]}
          >
            <InputNumber min={240} max={4096} addonAfter={t('common.px')} style={{ width: 160 }} />
          </Form.Item>
        </Space>

        <Divider>{t('settings.sectionUi')}</Divider>
        <Form.Item name="country" label={t('settings.country')} extra={t('settings.countryExtra')}>
          <Select
            showSearch
            optionFilterProp="filter"
            options={COUNTRIES.map((c) => ({
              value: c.code,
              // 同时能按中文名、英文名、国家码搜索
              filter: `${c.name} ${c.nameEn} ${c.code}`,
              label: `${c.name} · ${c.nameEn}`
            }))}
            onChange={(code: string) => {
              // 切换国家自动带出该国常用语言（用户仍可在下方单独覆盖）
              form.setFieldValue('language', countryLanguage(code))
            }}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 16 }}>
          {countryTimezone(country)} · {t('settings.localTime', { time: tzInfo.localTime })} ·{' '}
          <Tag>{t('settings.utcOffset', { offset: tzInfo.offsetText })}</Tag>
          {tzInfo.dst && <Tag color="orange">{t('settings.dst')}</Tag>}
        </Typography.Paragraph>

        <Form.Item name="language" label={t('settings.language')} extra={t('settings.languageExtra')}>
          <Select
            options={LOCALES.map((l) => ({
              value: l.code,
              label: `${l.nativeName} · ${l.englishName}`
            }))}
            onChange={(code) => setLocale(code)}
          />
        </Form.Item>

        <Form.Item name="theme" label={t('settings.theme')} extra={t('settings.themeExtra')}>
          <Select
            options={[
              { value: 'light', label: t('theme.light') },
              { value: 'dark', label: t('theme.dark') },
              { value: 'auto', label: t('theme.auto') }
            ]}
          />
        </Form.Item>
        <Form.Item name="searchEngine" label={t('settings.searchEngine')} extra={t('settings.searchEngineExtra')}>
          <Select
            style={{ maxWidth: 280 }}
            options={SEARCH_ENGINES.map((e) => ({ value: e.value, label: e.label }))}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.theme !== cur.theme}>
          {({ getFieldValue }) =>
            getFieldValue('theme') === 'auto' ? (
              <Space size="large" style={{ display: 'flex' }}>
                <Form.Item
                  name="autoDayStart"
                  label={t('settings.dayStart')}
                  rules={[
                    { required: true },
                    { type: 'number', min: 0, max: 23, message: t('settings.hourRange') }
                  ]}
                  extra={`${t('settings.dayStartExtra')}（${findCountry(country)?.name || ''} ${t('settings.localTime', { time: tzInfo.localTime })}）`}
                >
                  <InputNumber min={0} max={23} addonAfter={t('common.hour')} style={{ width: 140 }} />
                </Form.Item>
                <Form.Item
                  name="autoNightStart"
                  label={t('settings.nightStart')}
                  rules={[
                    { required: true },
                    { type: 'number', min: 0, max: 23, message: t('settings.hourRange') },
                    {
                      validator: (_rule, value) =>
                        value > getFieldValue('autoDayStart')
                          ? Promise.resolve()
                          : Promise.reject(new Error(t('settings.nightAfterDay')))
                    }
                  ]}
                  extra={t('settings.nightStartExtra')}
                >
                  <InputNumber min={0} max={23} addonAfter={t('common.hour')} style={{ width: 140 }} />
                </Form.Item>
              </Space>
            ) : null
          }
        </Form.Item>

        <Divider>{t('settings.sectionProxy')}</Divider>
        <Space size="large" style={{ display: 'flex' }}>
          <Form.Item
            name="proxyCheckTimeout"
            label={t('settings.proxyTimeout')}
            rules={[{ required: true }]}
          >
            <InputNumber min={3} max={60} addonAfter={t('common.seconds')} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            name="proxyCheckInterval"
            label={t('settings.proxyInterval')}
            rules={[{ required: true }]}
            extra={t('settings.proxyIntervalExtra')}
          >
            <InputNumber min={0} max={1440} addonAfter={t('common.minutes')} style={{ width: 160 }} />
          </Form.Item>
        </Space>

        {/* 代理故障自愈：与巡检配套。默认关闭——自动改环境 IP 属于「用户不可见的
            重大变更」，必须由用户显式选择加入，而非默认替他做决定。 */}
        <Form.Item
          name="proxyHealEnabled"
          label={t('proxyHeal.enable')}
          valuePropName="checked"
          extra={t('proxyHeal.enableExtra')}
        >
          <Switch />
        </Form.Item>
        {Form.useWatch('proxyHealEnabled', form) && (
          <Form.Item
            name="proxyHealThreshold"
            label={t('proxyHeal.threshold')}
            rules={[{ required: true }]}
            extra={t('proxyHeal.thresholdExtra')}
          >
            <InputNumber min={1} max={10} addonAfter={t('proxyHeal.times')} style={{ width: 160 }} />
          </Form.Item>
        )}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('proxyHeal.rulesTitle')}
          description={t('proxyHeal.rules')}
        />

        <Divider>{t('expiryAlert.section')}</Divider>

        {/* 到期预警：与巡检配套。默认开启（每天一次 / 提前 7 天）——
            代理与环境到期是「用户看不见但会突然失效」的事，属于典型的应该主动告知，
            与「自动改环境 IP」这类用户不可见的重大变更性质不同，故不默认关闭。 */}
        <Form.Item
          name="expiryAlertIntervalH"
          label={t('expiryAlert.interval')}
          rules={[{ required: true }]}
          extra={t('expiryAlert.intervalExtra')}
        >
          <InputNumber min={0} max={720} addonAfter={t('expiryAlert.hours')} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item
          name="expiryAlertDays"
          label={t('expiryAlert.days')}
          rules={[{ required: true }]}
          extra={t('expiryAlert.daysExtra')}
        >
          <InputNumber min={1} max={90} addonAfter={t('expiryAlert.daysUnit')} style={{ width: 160 }} />
        </Form.Item>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('expiryAlert.rulesTitle')}
          description={t('expiryAlert.rules')}
        />

        <Divider>{t('settings.sectionLog')}</Divider>
        <Form.Item
          name="logRetentionDays"
          label={t('settings.logRetention')}
          rules={[{ required: true }]}
          extra={t('settings.logRetentionExtra')}
        >
          <InputNumber min={7} max={3650} addonAfter={t('common.days')} style={{ width: 160 }} />
        </Form.Item>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('settings.logRetentionNote')} />

        <Form.Item
          name="maxConcurrentWindows"
          label={t('settings.maxConcurrentWindows')}
          rules={[{ required: true }]}
          extra={t('settings.maxConcurrentWindowsExtra')}
        >
          <InputNumber min={0} max={50} addonAfter={t('settings.windowUnit')} style={{ width: 170 }} />
        </Form.Item>

        <Divider>{t('security.section')}</Divider>
        <Typography.Paragraph type="secondary">{t('security.desc')}</Typography.Paragraph>
        {/* 必须 wrap：三个 InputNumber 各 170px + extra 说明文字，
            自然宽度约 768px，而设置页可用宽度只有 560px。
            不换行时 flex 压缩每一项，label 被压到 2 行。 */}
        <Space size="large" style={{ display: 'flex' }} wrap>
          <Form.Item
            name="rateLimitPerMin"
            label={t('security.rateLimit')}
            rules={[{ required: true }]}
            extra={t('security.rateLimitExtra')}
          >
            <InputNumber min={0} max={10000} addonAfter={t('security.perMin')} style={{ width: 170 }} />
          </Form.Item>
          <Form.Item
            name="loginLockoutThreshold"
            label={t('security.lockThreshold')}
            rules={[{ required: true }]}
            extra={t('security.lockThresholdExtra')}
          >
            <InputNumber min={0} max={100} addonAfter={t('security.times')} style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="loginLockoutMinutes" label={t('security.lockMinutes')} rules={[{ required: true }]}>
            <InputNumber min={1} max={1440} addonAfter={t('common.minutes')} style={{ width: 170 }} />
          </Form.Item>
        </Space>
        <Alert type="info" showIcon message={t('security.note')} />

        <Divider>{t('settings.sectionNetwork')}</Divider>
        <Form.Item name="networkMode" label={t('settings.networkMode')} extra={t('settings.networkModeExtra')}>
          <Select
            style={{ width: 220 }}
            options={[
              { value: 'system', label: t('settings.networkSystem') },
              { value: 'custom', label: t('settings.networkCustom') }
            ]}
          />
        </Form.Item>
        {networkMode === 'custom' && (
          <Space wrap size={12}>
            <Form.Item name="customProxyType" label={t('settings.proxyType')}>
              <Select
                style={{ width: 110 }}
                options={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'https', label: 'HTTPS' },
                  { value: 'socks5', label: 'SOCKS5' }
                ]}
              />
            </Form.Item>
            <Form.Item name="customProxyHost" label={t('settings.proxyHost')} rules={[{ required: true }]}>
              <Input placeholder="127.0.0.1" style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="customProxyPort" label={t('settings.proxyPort')} rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} style={{ width: 110 }} />
            </Form.Item>
            <Form.Item name="customProxyUsername" label={t('settings.proxyUser')}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="customProxyPassword" label={t('settings.proxyPass')}>
              <Input.Password style={{ width: 140 }} />
            </Form.Item>
          </Space>
        )}

        <Form.Item name="trayDisplay" label={t('settings.trayDisplay')} extra={t('settings.trayDisplayExtra')}>
          <Select
            style={{ width: 220 }}
            options={[
              { value: 'icon', label: t('settings.trayIcon') },
              { value: 'name', label: t('settings.trayName') }
            ]}
          />
        </Form.Item>

        <Divider>{t('settings.smtpSection')}</Divider>
        <Typography.Paragraph type="secondary">{t('settings.smtpDesc')}</Typography.Paragraph>
        <Space size="large" style={{ display: 'flex' }}>
          <Form.Item name={['smtp', 'host']} label={t('settings.smtpHost')} rules={[{ validator: smtpTripleRule('host') }]}>
            <Input placeholder="smtp.example.com" style={{ width: 260 }} />
          </Form.Item>
          <Form.Item name={['smtp', 'port']} label={t('settings.smtpPort')} rules={[{ validator: smtpPortRule }]}>
            <InputNumber min={1} max={65535} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name={['smtp', 'secure']} label={t('settings.smtpSecure')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Space>
        <Space size="large" style={{ display: 'flex' }}>
          <Form.Item name={['smtp', 'user']} label={t('settings.smtpUser')} rules={[{ validator: smtpTripleRule('user') }]}>
            <Input style={{ width: 240 }} placeholder="invite@your-domain.com" />
          </Form.Item>
          <Form.Item name={['smtp', 'pass']} label={t('settings.smtpPass')} rules={[{ validator: smtpTripleRule('pass') }]}>
            <Input.Password style={{ width: 240 }} placeholder="授权码 / 密码" />
          </Form.Item>
        </Space>
        <Space size="large" style={{ display: 'flex' }}>
          <Form.Item name={['smtp', 'from']} label={t('settings.smtpFrom')} extra={t('settings.smtpFromExtra')}>
            <Input style={{ width: 240 }} placeholder="invite@your-domain.com" />
          </Form.Item>
          <Form.Item name={['smtp', 'rejectUnauthorized']} label={t('settings.smtpRejectUnauthorized')} valuePropName="checked" extra={t('settings.smtpRejectExtra')}>
            <Switch />
          </Form.Item>
        </Space>
        <Form.Item>
          <Space>
            <Input
              placeholder={t('settings.smtpTestEmail')}
              value={testSmtpEmail}
              onChange={(e) => setTestSmtpEmail(e.target.value)}
              style={{ width: 260 }}
            />
            <Button loading={testingSmtp} onClick={testSmtp}>
              {t('settings.smtpTest')}
            </Button>
          </Space>
        </Form.Item>

        <Divider>{t('aiAgent.section')}</Divider>
        <Form.Item name={['aiAgent', 'enabled']} label={t('aiAgent.enabled')} extra={t('aiAgent.enabledExtra')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name={['aiAgent', 'backend']} label={t('aiAgent.backend')} extra={t('aiAgent.backendExtra')}>
          <Select
            style={{ width: 280 }}
            options={[
              { value: 'local', label: t('aiAgent.backendLocal') },
              { value: 'cloud', label: t('aiAgent.backendCloud') }
            ]}
          />
        </Form.Item>
        {backend === 'local' && (
          <>
            <Space wrap size={12}>
              {/* 模型输入框用 AutoComplete：下拉列出本机**实际已安装**的模型，
                  同时保留自由输入（用户可能想填尚未 pull 的模型名）。
                  之前是纯 Input，用户只能手打 —— 很容易写成同 base 但不同 tag 的名字
                  （如本机装的是 qwen2.5:3b，却填了 qwen2.5:7b），
                  而 Ollama 按完整名找模型 → 探活显示正常、真正调用 404。 */}
              <Form.Item name={['aiAgent', 'localModel']} label={t('aiAgent.localModel')} extra={t('aiAgent.localModelExtra')}>
                <AutoComplete
                  style={{ width: 220 }}
                  options={ollamaModels.map((m) => ({ value: m }))}
                  placeholder="qwen2.5:7b"
                  // notFoundContent 必须恒为非空字符串：rc-select 里有
                  // `emptyListContent = !notFoundContent && emptyOptions` —— 选项为空且
                  // notFoundContent 为空时**禁止展开下拉**，那 onOpenChange 就永远不触发，
                  // 形成「下拉开不了 → 加载不到模型 → 还是开不了」的死锁。
                  notFoundContent={t('aiAgent.modelsNotFound')}
                  // 不能按输入框内容过滤：模型名是**完整标识符**而不是搜索词。
                  // 输入框里本来就有值（当前配置的模型名），一过滤就把候选全滤没了 ——
              // 下拉里会显示「未检测到已安装模型」，而本机明明装了 4 个。
              // 所以恒定显示全部已装模型，让用户从列表里挑。
                  filterOption={() => true}
                />
              </Form.Item>
              <Form.Item name={['aiAgent', 'localVisionModel']} label={t('aiAgent.visionModel')} extra={t('aiAgent.visionModelExtra')}>
                <AutoComplete
                  style={{ width: 220 }}
                  options={ollamaModels.map((m) => ({ value: m }))}
                  placeholder="minicpm-v:latest"
                  notFoundContent={t('aiAgent.modelsNotFound')}
                  filterOption={() => true}
                />
              </Form.Item>
            </Space>
            {/* 「检测连接」单独成行：放进上面那个 Space 里，窄窗口下换行后会紧贴下方的
                「保存设置」，两个按钮上下挨在一起（见报障截图）。放进 Form.Item 以获得
                与其它表单项一致的标准行距（上下各 24px）。 */}
            <Form.Item>
              <Button loading={checking} onClick={checkAi}>
                {t('aiAgent.check')}
              </Button>
            </Form.Item>
            {renderAiStatus()}
          </>
        )}
        {backend === 'cloud' && (
          <>
            <Space wrap size={12}>
              <Form.Item name={['aiAgent', 'cloudProvider']} label={t('aiAgent.cloudProvider')}>
                <Select
                  style={{ width: 160 }}
                  options={[
                    { value: 'deepseek', label: 'DeepSeek' },
                    { value: 'qwen', label: 'Qwen' },
                    { value: 'glm', label: 'GLM' },
                    { value: 'openai', label: 'OpenAI' }
                  ]}
                />
              </Form.Item>
              {/* 「API 地址」做形状校验：用户实测把 API Key 误填进了这一栏，
                  该值会被拼成 `sk-xxx/chat/completions` 这种非法 URL，
                  之后每次调用都失败，而报错是厂商的 DNS/连接错误 —— 完全看不出是填错栏位。
                  这里在**保存那一刻**就拦下来并点名说「这看起来是 API Key」。 */}
              <Form.Item
                name={['aiAgent', 'cloudBaseUrl']}
                label={t('aiAgent.cloudBaseUrl')}
                extra={t('aiAgent.cloudBaseUrlExtra')}
                rules={[
                  {
                    validator: (_rule, value) => {
                      const r = checkCloudBaseUrl(String(value ?? ''))
                      if (r.ok) return Promise.resolve()
                      return Promise.reject(new Error(t(r.problem === 'looksLikeKey' ? 'aiAgent.cloudBaseUrlLooksLikeKey' : 'aiAgent.cloudBaseUrlInvalid')))
                    }
                  }
                ]}
              >
                <Input style={{ width: 260 }} placeholder="https://api.deepseek.com/v1" />
              </Form.Item>
              <Form.Item name={['aiAgent', 'cloudModel']} label={t('aiAgent.cloudModel')} extra={t('aiAgent.cloudModelExtra')}>
                <Input style={{ width: 200 }} placeholder="deepseek-v4-flash" />
              </Form.Item>
              <Form.Item name={['aiAgent', 'cloudVisionModel']} label={t('aiAgent.cloudVisionModel')} extra={t('aiAgent.cloudVisionModelExtra')}>
                <Input style={{ width: 220 }} placeholder="deepseek-v4-flash-vision-exp / gpt-4o" />
              </Form.Item>
              {/* 云端模式必须有 Key：没 Key 必然 401。与其等到调用时报错，不如在保存时拦下。
                  注意是「云端模式下必填」而非无条件必填 —— 切回本地后它被卸载，不该拦整表保存。 */}
              <Form.Item
                name={['aiAgent', 'cloudApiKey']}
                label={t('aiAgent.cloudApiKey')}
                extra={t('aiAgent.cloudApiKeyExtra')}
                rules={[{ required: true, message: t('aiAgent.cloudApiKeyRequired') }]}
              >
                <Input.Password style={{ width: 260 }} placeholder="sk-..." />
              </Form.Item>
            </Space>
            {/* 就近的保存入口：主「保存设置」按钮在**整张表单的最末尾**（要滚过
                快照备份、AI 自动任务、Webhook、通知等所有区块），而 AI Agent 配置在表单中部。
                用户在这里改完参数，屏幕上的「保存设置」根本不在视野内 → 很容易改完直接
                切走，切走时未提交 → 回 AI Agent 页还是旧值、再回设置页被 load() 覆盖成旧值，
                观感就是「存不进去、还变回去了」。
                故在 AI Agent 区块内给一个就近的保存按钮，保存范围与主按钮一致（整表提交）。 */}
            <Form.Item>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void submitFormNow()}>
                {t('aiAgent.saveNow')}
              </Button>
              <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                {t('aiAgent.saveNowHint')}
              </Typography.Text>
            </Form.Item>
          </>
        )}

        <Divider>{t('snapshot.backupSection')}</Divider>
        <Form.Item name="snapshotBackupEnabled" label={t('snapshot.backupEnable')} valuePropName="checked" extra={t('snapshot.backupEnableExtra')}>
          <Switch />
        </Form.Item>
        <Form.Item name="snapshotBackupDir" label={t('snapshot.backupDir')} extra={t('snapshot.backupDirExtra')}>
          <Input placeholder={t('snapshot.backupDirPlaceholder')} style={{ width: 480 }} />
        </Form.Item>
        <Form.Item name="snapshotBackupIntervalH" label={t('snapshot.backupInterval')} extra={t('snapshot.backupIntervalExtra')} rules={[{ required: true }]}>
          <InputNumber min={1} max={8760} addonAfter={t('common.hours')} style={{ width: 180 }} />
        </Form.Item>

        <Divider>{t('aiAuto.section')}</Divider>
        <Typography.Paragraph type="secondary">{t('aiAuto.desc')}</Typography.Paragraph>
        <Form.List name="aiAutoTasks">
          {(_fields, { add, remove }) => (
              <>
                {_fields.length === 0 && (
                  <Typography.Paragraph type="secondary">{t('aiAuto.noTasks')}</Typography.Paragraph>
                )}
                {_fields.map((field) => {
                  const task = (form.getFieldValue(['aiAutoTasks', field.name]) as AiAutoTask) || ({} as AiAutoTask)
                  return (
                    <Card
                      key={field.key}
                      size="small"
                      style={{ marginBottom: 12 }}
                      title={task.name || t('aiAuto.untitled')}
                      extra={
                        <Space>
                          <Tag color={task.enabled ? 'green' : 'default'}>{task.enabled ? t('aiAuto.enabled') : t('aiAuto.disabled')}</Tag>
                          <Button size="small" icon={<EditOutlined />} onClick={() => openTaskEditor(field.name)}>
                            {t('aiAuto.edit')}
                          </Button>
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                        </Space>
                      }
                    >
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>
                        {task.instruction || '-'}
                      </Typography.Paragraph>
                      <Space size="small" wrap>
                        <Tag>{t('aiAuto.envCount', { n: task.envIds?.length || 0 })}</Tag>
                        <Tag>{t('aiAuto.interval', { n: task.intervalMin || 0 })}</Tag>
                        {task.saveRpa && <Tag color="blue">{t('aiAuto.saveRpa')}</Tag>}
                      </Space>
                    </Card>
                  )
                })}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() =>
                    add({ id: genTaskId(), name: '', instruction: '', envIds: [], intervalMin: 60, enabled: true, saveRpa: true, maxSteps: 0 })
                  }
                >
                  {t('aiAuto.add')}
                </Button>
              </>
            )}
          </Form.List>
        <Typography.Paragraph type="warning" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('aiAuto.notRunningHint')}
        </Typography.Paragraph>

        <Modal
          open={!!editing?.open}
          title={t('aiAuto.edit')}
          okText={t('settings.save')}
          onOk={onTaskOk}
          onCancel={() => setEditing(null)}
        >
          <Form form={taskForm} layout="vertical">
            <Form.Item name="name" label={t('aiAuto.name')} rules={[{ required: true }]}>
              <Input placeholder={t('aiAuto.name')} />
            </Form.Item>
            <Form.Item name="instruction" label={t('aiAuto.instruction')} rules={[{ required: true }]}>
              <Input.TextArea rows={3} placeholder={t('aiAuto.instructionPlaceholder')} />
            </Form.Item>
            <Form.Item name="envIds" label={t('aiAuto.envIds')}>
              <Select
                mode="multiple"
                allowClear
                placeholder={t('aiAuto.envIds')}
                style={{ width: '100%' }}
                options={profiles.map((p) => ({ value: p.id, label: `#${p.id} ${p.name}` }))}
              />
            </Form.Item>
            <Space wrap size="large">
              <Form.Item name="intervalMin" label={t('aiAuto.intervalMin')} rules={[{ required: true }]}>
                <InputNumber min={1} max={10080} addonAfter={t('common.minutes')} style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name="maxSteps" label={t('aiAuto.maxSteps')} extra={t('aiAuto.maxStepsExtra')}>
                <InputNumber min={0} max={100} style={{ width: 140 }} />
              </Form.Item>
            </Space>
            <Space wrap size="large">
              <Form.Item name="enabled" label={t('aiAuto.enabled')} valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item name="saveRpa" label={t('aiAuto.saveRpa')} valuePropName="checked" extra={t('aiAuto.saveRpaExtra')}>
                <Switch />
              </Form.Item>
            </Space>
          </Form>
        </Modal>

        <Divider>{t('webhook.section')}</Divider>
        <Typography.Paragraph type="secondary">{t('webhook.desc')}</Typography.Paragraph>
        <Form.List name="webhooks">
          {(_fields, { add, remove }) => (
            <>
              {_fields.length === 0 && (
                <Typography.Paragraph type="secondary">{t('webhook.noHooks')}</Typography.Paragraph>
              )}
              {_fields.map((field) => {
                const wh = (form.getFieldValue(['webhooks', field.name]) as WebhookConfig) || ({} as WebhookConfig)
                return (
                  <Card
                    key={field.key}
                    size="small"
                    style={{ marginBottom: 12 }}
                    title={wh.name || t('webhook.untitled')}
                    extra={
                      <Space>
                        <Tag color={wh.enabled ? 'green' : 'default'}>{wh.enabled ? t('webhook.enabled') : t('webhook.disabled')}</Tag>
                        <Button size="small" loading={testingId === field.name} icon={<NotificationOutlined />} onClick={() => sendWebhookTest(field.name)}>
                          {t('webhook.test')}
                        </Button>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                      </Space>
                    }
                  >
                    <Form.Item name={[field.name, 'id']} hidden>
                      <Input />
                    </Form.Item>
                    <Form.Item name={[field.name, 'name']} label={t('webhook.name')} rules={[{ required: true }]}>
                      <Input placeholder={t('webhook.namePlaceholder')} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'url']} label={t('webhook.url')} rules={[{ required: true }, { type: 'url', message: t('webhook.urlInvalid') }]}>
                      <Input placeholder="https://example.com/webhook" />
                    </Form.Item>
                    <Form.Item name={[field.name, 'secret']} label={t('webhook.secret')} extra={t('webhook.secretExtra')}>
                      <Input.Password placeholder={t('webhook.secretPlaceholder')} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'enabled']} label={t('webhook.enabled')} valuePropName="checked">
                      <Switch />
                    </Form.Item>
                    <Form.Item name={[field.name, 'events']} label={t('webhook.events')} extra={t('webhook.eventsExtra')}>
                      <Select
                        mode="multiple"
                        allowClear
                        placeholder={t('webhook.eventsPlaceholder')}
                        style={{ width: '100%' }}
                        options={webhookEventOptions}
                      />
                    </Form.Item>
                  </Card>
                )
              })}
              <Button
                type="dashed"
                block
                icon={<PlusOutlined />}
                onClick={() => add({ id: genWebhookId(), name: '', url: '', secret: '', enabled: true, events: ['*'] })}
              >
                {t('webhook.add')}
              </Button>
            </>
          )}
        </Form.List>

        <Divider>{t('notif.setting.section')}</Divider>
        <Typography.Paragraph type="secondary">{t('notif.setting.desc')}</Typography.Paragraph>
        <Form.Item
          name="desktopNotifyEnabled"
          label={t('notif.setting.enable')}
          extra={t('notif.setting.enableExtra')}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        {/* 关闭总开关时隐藏分类勾选：露出一个不生效的配置只会让人误以为已订阅 */}
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.desktopNotifyEnabled !== cur.desktopNotifyEnabled}>
          {({ getFieldValue }) =>
            getFieldValue('desktopNotifyEnabled') ? (
              <Form.Item name="desktopNotifyEvents" label={t('notif.setting.events')} extra={t('notif.setting.eventsExtra')}>
                <Checkbox.Group
                  options={NOTIFY_CATEGORIES.map((c) => ({ value: c, label: t(`notif.cat.${c}`) }))}
                />
              </Form.Item>
            ) : null
          }
        </Form.Item>
        <Form.Item>
          <Button icon={<NotificationOutlined />} loading={testingNotify} onClick={() => void sendNotifyTest()}>
            {t('notif.setting.test')}
          </Button>
        </Form.Item>

        {/*
          保存栏 **吸底固定**（position: sticky）。
          原因：这张表单很长（指纹 / 外观 / 网络 / AI Agent / 快照 / 自动任务 / Webhook /
          通知 …），而主保存按钮原本在**表单最末尾**。用户在中部（比如 AI Agent 区）
          改完参数，屏幕上的「保存设置」根本不在视野内 → 很容易改完直接切走，
          未提交 → 回 AI Agent 页看到旧值、再回设置页被 load() 覆盖，
          观感就是「存不进去、还变回去了」。
          吸底后按钮在**任何滚动位置**都可见，不再依赖用户滚到最底。
        */}
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 5,
            marginTop: 24,
            padding: '12px 0 8px',
            // 用 antd token 取色，自动适配深浅色主题（不自己判断主题，避免与全局主题逻辑脱节）
            background: token.colorBgContainer,
            borderTop: `1px solid ${token.colorBorderSecondary}`
          }}
        >
          <Space size={12} wrap>
            {/* htmlType="submit"：交给 antd 的表单提交流程统一处理校验与失败提示，
                避免手写 validateFields() 时校验失败被静默吞掉 */}
            <Button type="primary" icon={<SaveOutlined />} loading={saving} htmlType="submit">
              {t('settings.save')}
            </Button>
            {/* 有未保存改动时给出显式提示：这是「改了没生效」最容易被误读成
                「系统把配置恢复回去」的地方，明确告知「改动还在，没保存」。
                组件已在 useWatch 的订阅下随任意字段变化重渲染，故这里直接判定即可。 */}
            {hasUnsavedChanges() && (
              <Tag color="warning">{t('settings.unsavedChanges')}</Tag>
            )}
          </Space>
        </div>
      </Form>

      {/* 调试端口（CDP）：独立 Card 而非塞进上面的表单 ——
          它与普通设置不同：需重启应用生效、配置写在本地文件（app ready 前读不到 DB），
          单独成卡能让「需重启」这件事在视觉上就与常规设置区分开 */}
      <Card
        style={{ marginTop: 16 }}
        title={
          <Space>
            <span>{t('cdp.section')}</span>
            {cdpInfo?.enabled ? <Tag color="green">{t('cdp.activePort')} {cdpInfo.port}</Tag> : <Tag>{t('cdp.notEnabled')}</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button size="small" onClick={loadCdp}>{t('cdp.refresh')}</Button>
            {/* 文案**不能**用 t('settings.save')（"保存设置"）——它与上方主表单的保存按钮
                完全同名同形，而 CDP 保存只写调试端口配置（PUT /api/cdp），**不提交表单**。
                用户在设置页改完别的东西（含 AI Agent 的云端后端）后若误点这个按钮，
                只会看到"已保存"的提示，实际改动一个都没存 —— 表现为「改了配置回到 AI Agent
                页还是旧值、再回设置页又变回原样」，且零 DB 写入痕迹（PUT /api/cdp 只补写
                cdpEnabled/cdpPort 两个键，不碰 aiAgent）。故用独立文案「保存调试端口」。 */}
            <Button size="small" type="primary" loading={savingCdp} onClick={saveCdp}>{t('cdp.saveOnly')}</Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">{t('cdp.desc')}</Typography.Paragraph>

        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Switch checked={cdpEnabled} onChange={setCdpEnabled} />
            <span>{t('cdp.enable')}</span>
            <InputNumber
              min={1024}
              max={40000}
              value={cdpPort}
              onChange={(v) => setCdpPort(Number(v) || DEFAULT_CDP_PORT)}
              disabled={!cdpEnabled}
              addonBefore={t('cdp.port')}
            />
          </Space>

          {cdpEnabled && (
            <Typography.Text type="warning">
              <SafetyOutlined /> {t('cdp.restartTip')}
            </Typography.Text>
          )}

          {/* 只在已启用且已重启（拿到实际端口）时展示连接信息 */}
          {cdpInfo?.enabled && cdpInfo.endpoint && (
            <>
              <Space wrap>
                <Typography.Text strong>{t('cdp.endpoint')}</Typography.Text>
                <Typography.Text code copyable={{ text: cdpInfo.endpoint }}>
                  {cdpInfo.endpoint}
                </Typography.Text>
              </Space>
              <Typography.Paragraph>
                <Typography.Text strong>{t('cdp.usage')}</Typography.Text>
              </Typography.Paragraph>
              <pre
                style={{
                  background: 'var(--color-background-tertiary)',
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 12,
                  margin: 0,
                  overflowX: 'auto'
                }}
              >
{`// Playwright
${cdpInfo.usage.playwright}

// Puppeteer
${cdpInfo.usage.puppeteer}`}
              </pre>
            </>
          )}

          {/* 已启用时列出「已打开环境 → target」，这是外部工具区分环境的依据 */}
          {cdpInfo?.enabled && (
            <div>
              <Typography.Text strong>{t('cdp.targets')}</Typography.Text>
              {cdpInfo.targetsError ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
                  {cdpInfo.targetsError}
                </Typography.Paragraph>
              ) : cdpInfo.targets.length === 0 ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
                  {t('cdp.noTargets')}
                </Typography.Paragraph>
              ) : (
                <Table
                  style={{ marginTop: 8 }}
                  size="small"
                  pagination={false}
                  rowKey="id"
                  dataSource={cdpInfo.targets}
                  columns={[
                    {
                      title: t('cdp.targets'),
                      dataIndex: 'profileId',
                      render: (v: number | null) => (v === null ? <Tag>{t('cdp.targetUnbound')}</Tag> : <Tag color="blue">#{v}</Tag>)
                    },
                    { title: 'targetId', dataIndex: 'id', render: (v: string) => <Typography.Text code>{v.slice(0, 12)}…</Typography.Text> },
                    { title: 'URL', dataIndex: 'url', ellipsis: true }
                  ]}
                />
              )}
            </div>
          )}

          <Alert type="warning" showIcon message={t('cdp.securityWarning')} />
        </Space>
      </Card>

      {/* 关于（对标官方「内核版本」）：纯展示，不进表单 */}
      <Divider>{t('settings.sectionAbout')}</Divider>
      <Space wrap size={[8, 8]}>
        <Tag color="blue">{t('settings.aboutApp')} v{versions?.app ?? '-'}</Tag>
        <Tag color="geekblue">Chromium {versions?.chrome ?? '-'}</Tag>
        <Tag>Electron {versions?.electron ?? '-'}</Tag>
        <Tag>Node.js {versions?.node ?? '-'}</Tag>
        <Tag>V8 {versions?.v8 ?? '-'}</Tag>
        <Tag>{versions ? `${versions.platform}/${versions.arch}` : '-'}</Tag>
      </Space>
      </Card>

      {/* 全空间快照：把整个团队空间打包成单个 JSON，便于迁移 / 整机备份 */}
      <Card title={<span><DatabaseOutlined /> {t('snapshot.title')}</span>} style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary">{t('snapshot.desc')}</Typography.Paragraph>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={exportSnapshot}>
            {t('snapshot.export')}
          </Button>
          <Upload
            accept="application/json,.json"
            showUploadList={false}
            beforeUpload={(file) => {
              importSnapshot(file)
              return false
            }}
          >
            <Button icon={<UploadOutlined />}>{t('snapshot.import')}</Button>
          </Upload>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('snapshot.importExtra')}
        </Typography.Paragraph>
      </Card>

      {/* 快照导入预演：展示这次导入会发生什么，确认后才真正写库 */}
      <Modal
        open={!!pendingImport}
        title={t('snapshot.previewTitle', { file: pendingImport?.file.name || '' })}
        onCancel={() => setPendingImport(null)}
        onOk={confirmImport}
        okText={t('snapshot.previewConfirm')}
        cancelText={t('common.cancel')}
        confirmLoading={importing}
        width={720}
        destroyOnClose
      >
        {pendingImport && (
          <SnapshotDiffView diff={pendingImport.diff} warnings={pendingImport.warnings} />
        )}
      </Modal>

      {/* 登录二次验证（2FA / TOTP） */}
      <Card title={<span><SafetyOutlined /> 登录二次验证（2FA / TOTP）</span>} style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary">
          启用后，每次登录除密码外还需输入验证器 App（Google Authenticator / 1Password / Authy 等）生成的 6 位动态码。
        </Typography.Paragraph>
        <Space wrap>
          <Tag color={twoFaEnabled ? 'green' : 'default'}>{twoFaEnabled ? '已启用' : '未启用'}</Tag>
          {!twoFaEnabled ? (
            <Button icon={<LockOutlined />} loading={twoFaBusy} onClick={startTwoFaSetup}>
              启用二次验证
            </Button>
          ) : (
            <Button danger loading={twoFaBusy} onClick={() => { setDisableCode(''); setDisableOpen(true) }}>
              关闭二次验证
            </Button>
          )}
        </Space>
        <Modal
          open={setupOpen}
          title={<span><QrcodeOutlined /> 启用二次验证</span>}
          okText="确认启用"
          confirmLoading={twoFaBusy}
          onOk={confirmTwoFaSetup}
          onCancel={() => setSetupOpen(false)}
        >
          <Typography.Paragraph>用验证器 App 扫描下方二维码，或手动输入密钥：</Typography.Paragraph>
          {setupQr && <img src={setupQr} alt="2fa-qr" style={{ width: 200, height: 200, marginBottom: 12 }} />}
          <Typography.Paragraph copyable={{ text: setupSecret }} style={{ marginBottom: 12 }}>
            <code>{setupSecret}</code>
          </Typography.Paragraph>
          <Typography.Text>输入验证器显示的 6 位动态码</Typography.Text>
          <Input
            value={setupCode}
            onChange={(e) => setSetupCode(e.target.value)}
            maxLength={6}
            placeholder="000000"
            style={{ marginTop: 8, width: 200 }}
          />
        </Modal>
        <Modal
          open={disableOpen}
          title="关闭二次验证"
          okText="确认关闭"
          confirmLoading={twoFaBusy}
          onOk={confirmTwoFaDisable}
          onCancel={() => setDisableOpen(false)}
        >
          <Typography.Paragraph>请输入验证器当前的 6 位动态码以关闭：</Typography.Paragraph>
          <Input
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            maxLength={6}
            placeholder="000000"
            style={{ marginTop: 8, width: 200 }}
          />
        </Modal>
      </Card>

    </>
  )
}
