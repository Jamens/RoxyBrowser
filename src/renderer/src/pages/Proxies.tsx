import { useCallback, useEffect, useState } from 'react'
import {
  Card, Table, Button, Space, Tag, Popconfirm, Modal, Form, Input, Select, InputNumber, Typography, Upload,
  Row, Col, Statistic, DatePicker
} from 'antd'
import { useAppCtx } from '../hooks/useApp'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, SafetyCertificateOutlined,
  ImportOutlined, ExportOutlined, ApiOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'
import { downloadText, readTextFile, nowStamp } from '../utils/download'
import type { ProxyDTO } from '@shared/types'

const emptyForm = { name: '', type: 'http', host: '', port: 1080, username: '', password: '', remark: '' }

interface PoolStats {
  total: number
  active: number
  available: number
  inUse: number
  expired: number
  invalid: number
  unknown: number
  byCountry: { country: string; total: number; available: number }[]
}

interface ProfileBrief {
  id: number
  name: string
  platform: string
}

export default function Proxies() {
  const { message } = useAppCtx()
  const [list, setList] = useState<ProxyDTO[]>([])
  const [stats, setStats] = useState<PoolStats | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ProxyDTO | null>(null)
  const [form] = Form.useForm()
  const [checking, setChecking] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')

  const [allocOpen, setAllocOpen] = useState(false)
  const [allocProfile, setAllocProfile] = useState<number | undefined>()
  const [allocCountry, setAllocCountry] = useState('')
  const [allocating, setAllocating] = useState(false)
  const [profiles, setProfiles] = useState<ProfileBrief[]>([])

  const load = useCallback(async () => {
    try {
      const [proxies, st] = await Promise.all([
        api.get<ProxyDTO[]>('/api/proxies'),
        api.get<PoolStats>('/api/proxies/pool-stats')
      ])
      setList(proxies)
      setStats(st)
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openAllocate = async () => {
    try {
      const ps = await api.get<ProfileBrief[]>('/api/profiles')
      setProfiles(ps.map((p) => ({ id: p.id, name: p.name, platform: p.platform })))
    } catch (e) {
      message.error((e as Error).message)
    }
    setAllocProfile(undefined)
    setAllocCountry('')
    setAllocOpen(true)
  }

  const doAllocate = async () => {
    if (!allocProfile) {
      message.warning('请选择要分配代理的环境')
      return
    }
    setAllocating(true)
    try {
      const res = await api.post<{ proxy: ProxyDTO; reused: boolean }>('/api/proxies/allocate', {
        profileId: allocProfile,
        country: allocCountry || undefined
      })
      message.success(
        `已为环境分配代理「${res.proxy.name}」· 出口 ${res.proxy.exitIp || '-'}` + (res.reused ? '（池中无空闲代理，已复用）' : '')
      )
      setAllocOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setAllocating(false)
    }
  }

  const save = async () => {
    const values = await form.validateFields()
    const payload: Record<string, unknown> = { ...values }
    if (payload.expiresAt && dayjs.isDayjs(payload.expiresAt)) payload.expiresAt = payload.expiresAt.toISOString()
    try {
      if (editing) await api.put(`/api/proxies/${editing.id}`, payload)
      else await api.post('/api/proxies', payload)
      message.success('已保存')
      setOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const doImport = async () => {
    if (!importText.trim()) {
      message.warning('请粘贴代理列表')
      return
    }
    try {
      const res = await api.post<{ imported: number; failed: string[] }>('/api/proxies/import', { text: importText })
      if (res.imported) message.success(`成功导入 ${res.imported} 条代理`)
      if (res.failed.length) message.warning(`${res.failed.length} 行格式无法识别：${res.failed.slice(0, 3).join(' / ')}`)
      setImportOpen(false)
      setImportText('')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const pickFile = async (file: File) => {
    try {
      setImportText(await readTextFile(file))
    } catch (e) {
      message.error((e as Error).message)
    }
    return false
  }

  const exportProxies = async () => {
    try {
      const res = await api.get<{ text: string; count: number }>('/api/proxies/export')
      if (!res.count) return message.warning('暂无代理可导出')
      downloadText(res.text, `roxy-proxies-${nowStamp()}.txt`, 'text/plain;charset=utf-8')
      message.success(`已导出 ${res.count} 条代理`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const check = async (id: number) => {
    setChecking(id)
    try {
      const p = await api.post<ProxyDTO>(`/api/proxies/${id}/check`)
      if (p.status === 'active')
        message.success(
          `代理可用 · 出口 ${p.exitIp} · ${p.country || '-'}${p.region ? '/' + p.region : ''}${p.isp ? ' · ' + p.isp : ''} · ${p.latency}ms`
        )
      else message.error('代理不可用（连接失败或超时）')
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setChecking(null)
    }
  }

  const poolStatusTag = (v?: string, fallback?: string) => {
    const map: Record<string, [string, string]> = {
      available: ['success', '可用'],
      'in-use': ['blue', '占用'],
      expired: ['warning', '已过期'],
      invalid: ['error', '失效'],
      unknown: ['default', '未检测']
    }
    const [c, t] = map[v || ''] || ['default', fallback || '未知']
    return <Tag color={c}>{t}</Tag>
  }

  const columns: ColumnsType<ProxyDTO> = [
    { title: '名称', dataIndex: 'name', width: 140, ellipsis: true },
    { title: '协议', dataIndex: 'type', width: 80, render: (v) => <Tag color="blue">{String(v).toUpperCase()}</Tag> },
    {
      title: '地址',
      dataIndex: 'host',
      width: 160,
      ellipsis: true,
      render: (_, r) => (
        <Typography.Text copyable={{ text: `${r.host}:${r.port}` }} ellipsis>
          {r.host}:{r.port}
        </Typography.Text>
      )
    },
    { title: '出口 IP', dataIndex: 'exitIp', width: 130, ellipsis: true, render: (v) => v || '-' },
    {
      title: '地区',
      key: 'region',
      width: 150,
      ellipsis: true,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            {r.country && <Tag color="geekblue">{r.country}</Tag>}
            {r.region && <Typography.Text type="secondary">{r.region}</Typography.Text>}
          </Space>
          {(r.city || r.isp) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.city}
              {r.isp ? ` · ${r.isp}` : ''}
            </Typography.Text>
          )}
        </Space>
      )
    },
    {
      title: '池状态',
      dataIndex: 'poolStatus',
      width: 90,
      render: (v, r) => poolStatusTag(v, r.status)
    },
    { title: '用量', dataIndex: 'usageCount', width: 90, ellipsis: true, render: (v) => (v ? `${v} 环境` : '-') },
    {
      title: '延迟',
      dataIndex: 'latency',
      width: 80,
      render: (v) => (v != null ? `${v}ms` : '-')
    },
    {
      title: '到期',
      dataIndex: 'expiresAt',
      width: 100,
      render: (v) => (v ? dayjs(v).format('YY-MM-DD') : '长期')
    },
    {
      title: '最后检测',
      dataIndex: 'lastCheckAt',
      width: 120,
      render: (v) => (v ? dayjs(v).format('MM-DD HH:mm') : '-')
    },
    {
      title: '操作',
      width: 210,
      render: (_, r) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<SafetyCertificateOutlined />}
            loading={checking === r.id}
            onClick={() => check(r.id)}
          >
            检测
          </Button>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(r)
              form.setFieldsValue({ ...r, expiresAt: r.expiresAt ? dayjs(r.expiresAt) : null })
              setOpen(true)
            }}
          />
          <Popconfirm title="删除该代理？" onConfirm={async () => { await api.del(`/api/proxies/${r.id}`); load() }}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Card
      title="代理 IP 池"
      extra={
        <Space>
          <Button type="primary" icon={<ApiOutlined />} onClick={openAllocate}>
            分配到环境
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null)
              form.resetFields()
              form.setFieldsValue(emptyForm)
              setOpen(true)
            }}
          >
            添加代理
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            批量导入
          </Button>
          <Button icon={<ExportOutlined />} onClick={exportProxies}>
            导出
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small">
            <Statistic title="代理总数" value={stats?.total ?? '-'} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="可用" value={stats?.available ?? '-'} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="已占用" value={stats?.inUse ?? '-'} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="已过期" value={stats?.expired ?? '-'} valueStyle={{ color: '#faad14' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="失效" value={stats?.invalid ?? '-'} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="地区数" value={stats?.byCountry.length ?? '-'} />
          </Card>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary">
        支持 HTTP / HTTPS / SOCKS5 协议，检测后会自动记录出口 IP、国家 / 地区 / 城市 / 运营商。绑定到环境后，环境窗口流量全部走此代理。「分配到环境」可从 IP 池一键挑选空闲代理并绑定，支持按地区筛选。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={list}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 1350 }}
      />

      <Modal title={editing ? '编辑代理' : '添加代理'} open={open} onOk={save} onCancel={() => setOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={emptyForm}>
          <Form.Item name="name" label="名称">
            <Input placeholder="例如：美国住宅 IP 01" />
          </Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="type" label="协议" initialValue="http">
              <Select
                style={{ width: 120 }}
                options={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'https', label: 'HTTPS' },
                  { value: 'socks5', label: 'SOCKS5' }
                ]}
              />
            </Form.Item>
            <Form.Item name="host" label="主机" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="IP 或域名" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={1} max={65535} style={{ width: 110 }} />
            </Form.Item>
          </Space>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="username" label="用户名（可选）">
              <Input style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="password" label="密码（可选）">
              <Input.Password style={{ width: 200 }} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
          {editing && (
            <Form.Item name="expiresAt" label="到期时间（可选，留空表示长期有效）">
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title="从 IP 池分配到环境"
        open={allocOpen}
        onOk={doAllocate}
        onCancel={() => setAllocOpen(false)}
        confirmLoading={allocating}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="选择环境" required>
            <Select
              placeholder="请选择要绑定代理的环境"
              value={allocProfile}
              onChange={(v) => setAllocProfile(v)}
              showSearch
              optionFilterProp="label"
              options={profiles.map((p) => ({ value: p.id, label: `${p.name}${p.platform ? `（${p.platform}）` : ''}` }))}
            />
          </Form.Item>
          <Form.Item label="地区筛选（可选）" extra="只从指定国家的代理中分配，例如：United States / China">
            <Input
              placeholder="国家名，留空表示不限地区"
              value={allocCountry}
              onChange={(e) => setAllocCountry(e.target.value)}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            系统会优先挑选未被占用的空闲代理；若池中无空闲代理，将复用已占用代理。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </Card>
  )
}
