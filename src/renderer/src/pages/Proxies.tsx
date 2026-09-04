import { useCallback, useEffect, useState } from 'react'
import {
  Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Select, InputNumber, Typography
} from 'antd'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'
import type { ProxyDTO } from '@shared/types'

const emptyForm = { name: '', type: 'http', host: '', port: 1080, username: '', password: '', remark: '' }

export default function Proxies() {
  const [list, setList] = useState<ProxyDTO[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ProxyDTO | null>(null)
  const [form] = Form.useForm()
  const [checking, setChecking] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      setList(await api.get<ProxyDTO[]>('/api/proxies'))
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    const values = await form.validateFields()
    try {
      if (editing) await api.put(`/api/proxies/${editing.id}`, values)
      else await api.post('/api/proxies', values)
      message.success('已保存')
      setOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const check = async (id: number) => {
    setChecking(id)
    try {
      const p = await api.post<ProxyDTO>(`/api/proxies/${id}/check`)
      if (p.status === 'active') message.success(`代理可用 · 出口 IP ${p.exitIp} · ${p.country} · 延迟 ${p.latency}ms`)
      else message.error('代理不可用（连接失败或超时）')
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setChecking(null)
    }
  }

  const columns: ColumnsType<ProxyDTO> = [
    { title: '名称', dataIndex: 'name' },
    { title: '协议', dataIndex: 'type', width: 80, render: (v) => <Tag color="blue">{String(v).toUpperCase()}</Tag> },
    {
      title: '地址',
      dataIndex: 'host',
      render: (_, r) => (
        <Typography.Text copyable={{ text: `${r.host}:${r.port}` }}>
          {r.host}:{r.port}
        </Typography.Text>
      )
    },
    { title: '出口 IP', dataIndex: 'exitIp', width: 130, render: (v) => v || '-' },
    { title: '地区', dataIndex: 'country', width: 100, render: (v) => (v ? <Tag color="geekblue">{v}</Tag> : '-') },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v) =>
        v === 'active' ? <Tag color="success">可用</Tag> : v === 'invalid' ? <Tag color="error">失效</Tag> : <Tag>未检测</Tag>
    },
    {
      title: '延迟',
      dataIndex: 'latency',
      width: 80,
      render: (v) => (v != null ? `${v}ms` : '-')
    },
    {
      title: '最后检测',
      dataIndex: 'lastCheckAt',
      width: 150,
      render: (v) => (v ? dayjs(v).format('MM-DD HH:mm') : '-')
    },
    {
      title: '操作',
      width: 200,
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
              form.setFieldsValue(r)
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
      title="代理 IP 管理"
      extra={
        <Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null)
              form.resetFields()
              setOpen(true)
            }}
          >
            添加代理
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        支持 HTTP / HTTPS / SOCKS5 协议。检测会通过该代理访问 ip-api.com，返回出口 IP、地区与延迟；绑定到环境后，环境窗口的所有流量都走此代理。
      </Typography.Paragraph>
      <Table rowKey="id" size="middle" columns={columns} dataSource={list} pagination={{ pageSize: 10 }} />
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
        </Form>
      </Modal>
    </Card>
  )
}
