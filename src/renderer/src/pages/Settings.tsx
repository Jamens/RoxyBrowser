import { useCallback, useEffect, useState } from 'react'
import { Card, Form, Select, InputNumber, Button, Space, Typography, message, Divider } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { api } from '../api'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

// 主题与自动时段同步进 localStorage，供渲染层 resolveDark 同步读取（与主题逻辑一致）
function persistThemeLocals(s: AppSettings) {
  localStorage.setItem('roxy_theme', s.theme)
  localStorage.setItem('roxy_auto_day_start', String(s.autoDayStart))
  localStorage.setItem('roxy_auto_night_start', String(s.autoNightStart))
}

export default function Settings() {
  const [form] = Form.useForm<AppSettings>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

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
      // 主题即时生效：写入 localStorage 并通知 App 层重读
      persistThemeLocals(res.settings)
      window.dispatchEvent(new Event('roxy-theme-change'))
      message.success('设置已保存')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="系统设置" loading={loading}>
      <Typography.Paragraph type="secondary">
        全局默认配置。修改后保存立即对新建环境、代理检测、主题等生效。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={DEFAULT_SETTINGS} style={{ maxWidth: 520 }}>
        <Divider>指纹与窗口</Divider>
        <Form.Item
          name="defaultFingerprintOs"
          label="默认指纹操作系统"
          extra="新建环境随机生成指纹时使用的操作系统"
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
          <Form.Item name="defaultWindowWidth" label="默认窗口宽度" rules={[{ required: true }]}>
            <InputNumber min={320} max={4096} addonAfter="px" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="defaultWindowHeight" label="默认窗口高度" rules={[{ required: true }]}>
            <InputNumber min={240} max={4096} addonAfter="px" style={{ width: 160 }} />
          </Form.Item>
        </Space>

        <Divider>界面</Divider>
        <Form.Item
          name="theme"
          label="主题"
          extra="自动：按下方设定的时段在白天/黑夜间自动切换；也可在右上角随时手动切换"
        >
          <Select
            options={[
              { value: 'light', label: '白天（浅色）' },
              { value: 'dark', label: '黑夜（深色）' },
              { value: 'auto', label: '自动（按时间）' }
            ]}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.theme !== cur.theme}>
          {({ getFieldValue }) =>
            getFieldValue('theme') === 'auto' ? (
              <Space size="large" style={{ display: 'flex' }}>
                <Form.Item
                  name="autoDayStart"
                  label="自动·白天起始"
                  rules={[{ required: true }, { type: 'number', min: 0, max: 23, message: '0-23' }]}
                  extra="含该小时起进入白天"
                >
                  <InputNumber min={0} max={23} addonAfter="时" style={{ width: 140 }} />
                </Form.Item>
                <Form.Item
                  name="autoNightStart"
                  label="自动·黑夜起始"
                  rules={[
                    { required: true },
                    { type: 'number', min: 0, max: 23, message: '0-23' },
                    {
                      validator: (_rule, value) =>
                        value > getFieldValue('autoDayStart')
                          ? Promise.resolve()
                          : Promise.reject(new Error('黑夜起始须晚于白天起始'))
                    }
                  ]}
                  extra="含该小时起进入黑夜"
                >
                  <InputNumber min={0} max={23} addonAfter="时" style={{ width: 140 }} />
                </Form.Item>
              </Space>
            ) : null
          }
        </Form.Item>

        <Divider>代理</Divider>
        <Space size="large" style={{ display: 'flex' }}>
          <Form.Item name="proxyCheckTimeout" label="代理检测超时" rules={[{ required: true }]}>
            <InputNumber min={3} max={60} addonAfter="秒" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            name="proxyCheckInterval"
            label="定时巡检间隔"
            rules={[{ required: true }]}
            extra="0 表示关闭自动巡检"
          >
            <InputNumber min={0} max={1440} addonAfter="分钟" style={{ width: 160 }} />
          </Form.Item>
        </Space>

        <Divider>日志</Divider>
        <Form.Item name="logRetentionDays" label="操作日志保留天数" rules={[{ required: true }]}>
          <InputNumber min={7} max={3650} addonAfter="天" style={{ width: 160 }} />
        </Form.Item>

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            保存设置
          </Button>
        </Form.Item>
      </Form>
    </Card>
  )
}
