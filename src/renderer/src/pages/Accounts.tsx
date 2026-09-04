import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Select, Typography } from 'antd'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import type { AccountDTO, ProfileDTO } from '@shared/types'

const PLATFORMS = ['Amazon', 'Facebook', 'Instagram', 'TikTok', 'eBay', 'Etsy', 'Walmart', 'Shopee', 'Google', '其他']

interface Row extends AccountDTO {}

export default function Accounts() {
  const [list, setList] = useState<Row[]>([])
  const [profiles, setProfiles] = useState<ProfileDTO[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([api.get<Row[]>('/api/accounts'), api.get<ProfileDTO[]>('/api/profiles')])
      setList(a)
      setProfiles(p)
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
      if (editing) await api.put(`/api/accounts/${editing.id}`, values)
      else await api.post('/api/accounts', values)
      message.success('已保存')
      setOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<Row> = [
    { title: '所属环境', dataIndex: 'profileName', render: (v) => v || '-' },
    { title: '平台', dataIndex: 'platform', width: 110, render: (v) => (v ? <Tag color="processing">{v}</Tag> : '-') },
    { title: '账号', dataIndex: 'username' },
    {
      title: '密码',
      dataIndex: 'password',
      render: (v) => <Input.Password value={v} size="small" bordered={false as never} style={{ width: 140 }} readOnly />
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v) => v || '-' },
    {
      title: '操作',
      width: 120,
      render: (_, r) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(r)
              form.setFieldsValue(r)
              setOpen(true)
            }}
          />
          <Popconfirm title="删除该账号？" onConfirm={async () => { await api.del(`/api/accounts/${r.id}`); load() }}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Card
      title="账号中心"
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
            添加账号
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        将各平台的账号密码保存到对应的浏览器环境中，免去多账号逐一记录的负担；环境成员无需互传密码即可协作。
      </Typography.Paragraph>
      <Table rowKey="id" size="middle" columns={columns} dataSource={list} pagination={{ pageSize: 10 }} />
      <Modal title={editing ? '编辑账号' : '添加账号'} open={open} onOk={save} onCancel={() => setOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="profileId" label="所属环境" rules={[{ required: true, message: '请选择环境' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择浏览器环境"
              options={profiles.map((p) => ({ value: p.id, label: `#${p.seq} ${p.name}` }))}
            />
          </Form.Item>
          <Form.Item name="platform" label="平台">
            <Select allowClear placeholder="选择平台" options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
          </Form.Item>
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '必填' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="密码">
            <Input.Password />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
