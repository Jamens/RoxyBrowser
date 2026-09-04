import { useCallback, useEffect, useState } from 'react'
import { Card, Form, Select, InputNumber, Button, Space, Typography, Tag, message, Divider } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { api } from '../api'
import { DEFAULT_SETTINGS, SEARCH_ENGINES, type AppSettings } from '@shared/types'
import { COUNTRIES, countryLanguage, countryTimezone, findCountry } from '@shared/countries'
import { LOCALES } from '@shared/locales'
import { describeTimeZone } from '@shared/timezone'
import { useI18n, LOCALE_CHANGE_EVENT } from '../i18n'

// 主题、自动时段、国家与语言同步进 localStorage，供渲染层 resolveDark / i18n 同步读取
// （theme.ts 与 i18n 都在模块级同步读取，不能依赖 React 状态或异步请求）
function persistThemeLocals(s: AppSettings) {
  localStorage.setItem('roxy_theme', s.theme)
  localStorage.setItem('roxy_auto_day_start', String(s.autoDayStart))
  localStorage.setItem('roxy_auto_night_start', String(s.autoNightStart))
  localStorage.setItem('roxy_country', s.country)
  localStorage.setItem('roxy_language', s.language)
  window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT))
}

export default function Settings() {
  const [form] = Form.useForm<AppSettings>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const { t, setLocale } = useI18n()

  // 让「当地时间 / UTC 偏移 / 是否夏令时」每 30 秒自刷新一次
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  const country = Form.useWatch('country', form) || DEFAULT_SETTINGS.country
  const tz = countryTimezone(country)
  const tzInfo = describeTimeZone(tz, now)

  // useCallback 稳定 load，否则每次渲染都生成新引用，会导致 useEffect 无限重跑 + 重复请求
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await api.get<AppSettings>('/api/settings')
      form.setFieldsValue(s)
      persistThemeLocals(s)
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
      message.success(t('settings.saved'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
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

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            {t('settings.save')}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  )
}
