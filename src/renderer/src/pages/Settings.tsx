import { useCallback, useEffect, useState, useRef } from 'react'
import { Card, Form, Select, InputNumber, Input, Button, Space, Typography, Tag, Divider, Switch, Upload } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { SaveOutlined, DownloadOutlined, UploadOutlined, DatabaseOutlined } from '@ant-design/icons'
import { api, API_BASE, getToken } from '../api'
import { readTextFile } from '../utils/download'
import { DEFAULT_SETTINGS, SEARCH_ENGINES, type AppSettings } from '@shared/types'
import { COUNTRIES, countryLanguage, countryTimezone, findCountry } from '@shared/countries'
import { LOCALES } from '@shared/locales'
import { describeTimeZone } from '@shared/timezone'
import { useI18n, LOCALE_CHANGE_EVENT } from '../i18n'

// 主题、自动时段、国家与语言同步进 localStorage，供渲染层 resolveDark / i18n 同步读取
// （theme.ts 与 i18n 都在模块级同步读取，不能依赖 React 状态或异步请求）
// 把客户端出网代理交给主进程套用到默认 session（system 模式时主进程会恢复系统代理）。
// 放组件外：load 的 useCallback 依赖数组保持不变，避免每次渲染生成新引用导致请求重跑。
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

function persistThemeLocals(s: AppSettings) {
  localStorage.setItem('roxy_theme', s.theme)
  localStorage.setItem('roxy_auto_day_start', String(s.autoDayStart))
  localStorage.setItem('roxy_auto_night_start', String(s.autoNightStart))
  localStorage.setItem('roxy_country', s.country)
  localStorage.setItem('roxy_language', s.language)
  window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT))
}

export default function Settings() {
  const { message } = useAppCtx()
  const [form] = Form.useForm<AppSettings>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [aiStatus, setAiStatus] = useState<{ reachable: boolean; modelPulled: boolean; model?: string; error?: string; models?: string[]; backend?: 'local' | 'cloud'; visionModel?: string; visionReachable?: boolean; visionError?: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const { t, setLocale } = useI18n()

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
      persistThemeLocals(s)
      applyNetworkProxy(s)
      applyTrayDisplay(s)
    } catch (e) {
      form.setFieldsValue(DEFAULT_SETTINGS)
      persistThemeLocals(DEFAULT_SETTINGS)
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const res = await api.put<{ ok: boolean; settings: AppSettings }>('/api/settings', values)
      // 主题 / 国家 / 语言即时生效：写入 localStorage 并通知 App 层重读
      persistThemeLocals(res.settings)
      window.dispatchEvent(new Event('roxy-theme-change'))
      applyNetworkProxy(res.settings)
      applyTrayDisplay(res.settings)
      message.success(t('settings.saved'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // 全空间快照：把整个团队空间导出为单个 JSON（环境 + 代理 + RPA + 扩展引用）
  const exportSnapshot = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/snapshot/export`, {
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

  // 全空间快照：导入单个 JSON 文件，恢复到当前团队（代理按名复用，环境重新生成）
  const importSnapshot = async (file: File) => {
    try {
      const text = await readTextFile(file)
      const data = JSON.parse(text)
      const res = await api.post<{ profiles: number; proxiesCreated: number; rpaCreated: number; proxiesSkipped: number }>(
        '/api/snapshot/import',
        data
      )
      message.success(
        t('snapshot.importSuccess', {
          profiles: res.profiles,
          proxies: res.proxiesCreated,
          rpa: res.rpaCreated
        })
      )
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const checkAi = async () => {
    setChecking(true)
    try {
      // 用表单当前值（可能未保存）做检测，避免选了云端却按已保存的旧后端探活
      const aiAgentForm = (form.getFieldValue('aiAgent') as Record<string, unknown>) || {}
      const s = await api.post<{ reachable: boolean; modelPulled: boolean; model?: string; error?: string; models?: string[]; backend?: 'local' | 'cloud'; visionModel?: string; visionReachable?: boolean; visionError?: string }>('/api/ai-agent/status', { aiAgent: aiAgentForm })
      setAiStatus(s)
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

  return (
    <>
      <Card title={t('settings.title')} loading={loading}>
      <Typography.Paragraph type="secondary">{t('settings.desc')}</Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={DEFAULT_SETTINGS} style={{ maxWidth: 560 }}>
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

        <Divider>{t('settings.sectionLog')}</Divider>
        <Form.Item
          name="logRetentionDays"
          label={t('settings.logRetention')}
          rules={[{ required: true }]}
        >
          <InputNumber min={7} max={3650} addonAfter={t('common.days')} style={{ width: 160 }} />
        </Form.Item>

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
              <Form.Item name={['aiAgent', 'localModel']} label={t('aiAgent.localModel')} extra={t('aiAgent.localModelExtra')}>
                <Input style={{ width: 220 }} placeholder="qwen2.5:7b" />
              </Form.Item>
              <Form.Item name={['aiAgent', 'localVisionModel']} label={t('aiAgent.visionModel')} extra={t('aiAgent.visionModelExtra')}>
                <Input style={{ width: 220 }} placeholder="minicpm-v:latest" />
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
            <Form.Item name={['aiAgent', 'cloudBaseUrl']} label={t('aiAgent.cloudBaseUrl')}>
              <Input style={{ width: 260 }} placeholder="https://api.deepseek.com/v1" />
            </Form.Item>
            <Form.Item name={['aiAgent', 'cloudModel']} label={t('aiAgent.cloudModel')}>
              <Input style={{ width: 200 }} placeholder="deepseek-chat" />
            </Form.Item>
            <Form.Item name={['aiAgent', 'cloudVisionModel']} label={t('aiAgent.cloudVisionModel')} extra={t('aiAgent.cloudVisionModelExtra')}>
              <Input style={{ width: 220 }} placeholder="gpt-4o / qwen-vl-max / glm-4v" />
            </Form.Item>
            <Form.Item name={['aiAgent', 'cloudApiKey']} label={t('aiAgent.cloudApiKey')}>
              <Input.Password style={{ width: 260 }} placeholder="sk-..." />
            </Form.Item>
          </Space>
        )}

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            {t('settings.save')}
          </Button>
        </Form.Item>
      </Form>

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
    </>
  )
}
