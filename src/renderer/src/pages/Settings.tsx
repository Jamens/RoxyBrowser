import { useEffect, useState } from 'react'
import { Card, Form, Select, InputNumber, Button, Space, Typography, message, Divider } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { api } from '../api'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

export default function Settings() {
  const [form] = Form.useForm<AppSettings>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const s = await api.get<AppSettings>('/api/settings')
      form.setFieldsValue(s)
    } catch (e) {
      form.setFieldsValue(DEFAULT_SETTINGS)
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const res = await api.put<{ ok: boolean; settings: AppSettings }>('/api/settings', values)
      // 主题即时生效：写入 localStorage 并通知 App 层重读
      localStorage.setItem('roxy_theme', res.settings.theme)
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
        <Form.Item name="theme" label="主题" extra="跟随系统将随操作系统明暗自动切换">
          <Select
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' }
            ]}
          />
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
