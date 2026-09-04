import { useEffect, useState } from 'react'
import { Drawer, Form, Input, Select, InputNumber, Switch, Button, Tabs, Space, Typography, message, Tag } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { api } from '../api'
import type { ProfileDTO, Fingerprint, GroupDTO, ProxyDTO, ExtensionDTO } from '@shared/types'
import { getTimezoneOffsetMinutes } from '@shared/fingerprint'

const PLATFORMS = [
  'Amazon', 'Facebook', 'Instagram', 'TikTok', 'eBay', 'Etsy', 'Walmart', 'Shopee',
  'AliExpress', 'Google', 'Twitter/X', 'LinkedIn', 'Pinterest', '其他'
]

const TIMEZONES = [
  'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver', 'America/Sao_paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Warsaw',
  'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Bangkok',
  'Australia/Sydney', 'Asia/Dubai', 'Africa/Johannesburg'
]

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  initial: ProfileDTO | null
  isTemplate?: boolean
  groups: GroupDTO[]
  proxies: ProxyDTO[]
  extensions: ExtensionDTO[]
}

export default function ProfileForm({ open, onClose, onSaved, initial, isTemplate, groups, proxies, extensions }: Props) {
  const [form] = Form.useForm()
  const [fp, setFp] = useState<Fingerprint | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      form.resetFields()
      if (initial) {
        form.setFieldsValue({
          name: initial.name,
          groupId: initial.groupId ?? undefined,
          platform: initial.platform || undefined,
          startUrl: initial.startUrl,
          remark: initial.remark,
          proxyId: initial.proxyId ?? undefined
        })
        form.setFieldValue('extensions', initial.extensions ?? [])
        setFp(initial.fingerprint)
      } else {
        setFp(null)
      }
    }
  }, [open, initial, form])

  const randomize = async () => {
    const f = await api.post<Fingerprint>('/api/fingerprint/random', { os: fp?.os })
    setFp(f)
  }

  const setFpField = (key: keyof Fingerprint, value: unknown) => {
    setFp((prev) => {
      if (!prev) return prev
      const next = { ...prev, [key]: value } as Fingerprint
      if (key === 'timezone') next.tzOffset = getTimezoneOffsetMinutes(String(value))
      if (key === 'os') {
        // 切换 OS 时同步 platform / UA
        next.platform = value === 'mac' ? 'MacIntel' : 'Win32'
        if (value === 'mac' && prev.userAgent.includes('Windows')) {
          next.userAgent = prev.userAgent.replace(
            /\(Macintosh; Intel Mac OS X [^)]+\)/,
            '(Macintosh; Intel Mac OS X 10_15_7)'
          ).replace(/\(Windows[^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
        } else if (value === 'windows' && !prev.userAgent.includes('Windows')) {
          next.userAgent = prev.userAgent.replace(
            /\(Macintosh; Intel Mac OS X [^)]+\)/,
            '(Windows NT 10.0; Win64; x64)'
          )
        }
      }
      return next
    })
  }

  const save = async () => {
    const values = await form.validateFields()
    if (!fp) {
      message.warning('指纹信息未就绪')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: values.name,
        groupId: values.groupId ?? null,
        platform: values.platform || '',
        startUrl: values.startUrl || '',
        remark: values.remark || '',
        proxyId: values.proxyId ?? null,
        extensions: Array.isArray(values.extensions) ? values.extensions : [],
        isTemplate: !!isTemplate && !initial,
        fingerprint: { ...fp, tzOffset: getTimezoneOffsetMinutes(fp.timezone) }
      }
      if (initial) {
        await api.put(`/api/profiles/${initial.id}`, payload)
        message.success('保存成功')
      } else {
        await api.post('/api/profiles', payload)
        message.success(isTemplate ? '模板创建成功' : '环境创建成功')
      }
      onSaved()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!fp) return null

  return (
    <Drawer
      title={initial ? (isTemplate ? '编辑模板' : '编辑环境') : isTemplate ? '新建窗口模板' : '新建浏览器环境'}
      width={640}
      open={open}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      <Tabs
        items={[
          {
            key: 'base',
            label: '基本信息',
            children: (
              <Form form={form} layout="vertical" initialValues={{ startUrl: 'https://www.baidu.com' }}>
                <Form.Item name="name" label="环境名称" rules={[{ required: true, message: '请输入名称' }]}>
                  <Input placeholder="例如：Amazon 美国店 01" />
                </Form.Item>
                {!isTemplate && (
                  <Form.Item name="groupId" label="所属分组">
                    <Select allowClear placeholder="选择分组" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
                  </Form.Item>
                )}
                <Form.Item name="platform" label="运营平台">
                  <Select allowClear placeholder="选择平台" options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
                </Form.Item>
                {!isTemplate && (
                  <Form.Item name="startUrl" label="起始页 URL">
                    <Input placeholder="打开窗口后首先访问的网址" />
                  </Form.Item>
                )}
                <Form.Item name="remark" label="备注">
                  <Input.TextArea rows={2} placeholder="备注信息（如店铺名、运营人员）" />
                </Form.Item>
                <Form.Item name="extensions" label="启用扩展" extra="勾选的扩展会在打开此环境窗口时自动加载">
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="不启用任何扩展"
                    options={extensions.map((e) => ({ value: e.id, label: `${e.name}${e.version ? ' v' + e.version : ''}` }))}
                  />
                </Form.Item>
              </Form>
            )
          },
          {
            key: 'fp',
            label: '指纹配置',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Button type="primary" icon={<ThunderboltOutlined />} onClick={randomize}>
                    一键随机指纹
                  </Button>
                  <Typography.Text type="secondary">按操作系统生成一整套真实、一致的指纹参数</Typography.Text>
                </Space>
                <Form layout="vertical">
                  <Form.Item label="操作系统">
                    <Select
                      value={fp.os}
                      style={{ width: 200 }}
                      onChange={(v) => setFpField('os', v)}
                      options={[
                        { value: 'windows', label: 'Windows' },
                        { value: 'mac', label: 'macOS' }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label="User Agent">
                    <Input.TextArea
                      rows={2}
                      value={fp.userAgent}
                      onChange={(e) => setFpField('userAgent', e.target.value)}
                    />
                  </Form.Item>
                  <Space size="middle" style={{ display: 'flex' }} wrap>
                    <Form.Item label="Navigator Platform" style={{ marginBottom: 0 }}>
                      <Input value={fp.platform} style={{ width: 160 }} onChange={(e) => setFpField('platform', e.target.value)} />
                    </Form.Item>
                    <Form.Item label="CPU 核心" style={{ marginBottom: 0 }}>
                      <InputNumber min={1} max={64} value={fp.hardwareConcurrency} onChange={(v) => setFpField('hardwareConcurrency', v || 4)} />
                    </Form.Item>
                    <Form.Item label="内存 (GB)" style={{ marginBottom: 0 }}>
                      <InputNumber min={1} max={64} value={fp.deviceMemory} onChange={(v) => setFpField('deviceMemory', v || 8)} />
                    </Form.Item>
                  </Space>
                  <Form.Item label="语言（Language 列表）" style={{ marginTop: 16 }}>
                    <Select
                      mode="tags"
                      value={fp.languages}
                      onChange={(v) => setFpField('languages', v)}
                      placeholder="如 en-US、en"
                      tokenSeparators={[',', ' ']}
                    />
                  </Form.Item>
                  <Form.Item label="时区">
                    <Select
                      showSearch
                      value={fp.timezone}
                      onChange={(v) => setFpField('timezone', v)}
                      options={TIMEZONES.map((t) => ({ value: t, label: t }))}
                    />
                  </Form.Item>
                  <Space size="middle" style={{ display: 'flex' }} wrap>
                    <Form.Item label="屏幕宽" style={{ marginBottom: 0 }}>
                      <InputNumber min={800} max={7680} value={fp.screenWidth} onChange={(v) => setFpField('screenWidth', v || 1920)} />
                    </Form.Item>
                    <Form.Item label="屏幕高" style={{ marginBottom: 0 }}>
                      <InputNumber min={600} max={4320} value={fp.screenHeight} onChange={(v) => setFpField('screenHeight', v || 1080)} />
                    </Form.Item>
                  </Space>
                  <div style={{ marginTop: 16 }}>
                    <Form.Item label="WebGL 显卡信息" style={{ marginBottom: 8 }}>
                      <Input value={fp.webglVendor} onChange={(e) => setFpField('webglVendor', e.target.value)} placeholder="Vendor" />
                    </Form.Item>
                    <Input value={fp.webglRenderer} onChange={(e) => setFpField('webglRenderer', e.target.value)} placeholder="Renderer" />
                  </div>
                  <Space size="large" style={{ marginTop: 20 }}>
                    <Form.Item label="Canvas 噪声" style={{ marginBottom: 0 }} valuePropName="checked">
                      <Switch checked={fp.canvasNoise} onChange={(v) => setFpField('canvasNoise', v)} />
                    </Form.Item>
                    <Form.Item label="Audio 噪声" style={{ marginBottom: 0 }} valuePropName="checked">
                      <Switch checked={fp.audioNoise} onChange={(v) => setFpField('audioNoise', v)} />
                    </Form.Item>
                    <Form.Item label="WebRTC" style={{ marginBottom: 0 }}>
                      <Select
                        value={fp.webrtc}
                        style={{ width: 140 }}
                        onChange={(v) => setFpField('webrtc', v)}
                        options={[
                          { value: 'disable', label: '禁用（防泄漏）' },
                          { value: 'real', label: '真实' }
                        ]}
                      />
                    </Form.Item>
                  </Space>
                  <div style={{ marginTop: 20 }}>
                    <Typography.Text type="secondary">
                      当前指纹摘要：
                    </Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <Tag color="blue">{fp.platform}</Tag>
                      <Tag color="geekblue">{fp.timezone}</Tag>
                      <Tag color="purple">{fp.languages.join(', ')}</Tag>
                      <Tag>{fp.screenWidth}×{fp.screenHeight}</Tag>
                      <Tag color="cyan">CPU {fp.hardwareConcurrency} 核</Tag>
                      <Tag color="cyan">RAM {fp.deviceMemory}GB</Tag>
                    </div>
                  </div>
                </Form>
              </div>
            )
          },
          {
            key: 'proxy',
            label: '代理配置',
            children: (
              <Form layout="vertical">
                <Form.Item label="绑定代理 IP" extra="每个环境绑定独立代理，实现 IP 层防关联">
                  <Select
                    value={form.getFieldValue('proxyId')}
                    placeholder="不使用代理（直连）"
                    allowClear
                    onChange={(v) => form.setFieldValue('proxyId', v)}
                    options={proxies.map((p) => ({
                      value: p.id,
                      label: `${p.name} (${p.type.toUpperCase()} ${p.host}:${p.port}${p.country ? ' · ' + p.country : ''}${p.status === 'active' ? ' ✓' : ''})`
                    }))}
                  />
                </Form.Item>
                <Typography.Text type="secondary">
                  没有可用代理？请先到「代理 IP」页面添加并检测代理，再回到这里绑定。
                </Typography.Text>
              </Form>
            )
          }
        ]}
      />
    </Drawer>
  )
}
