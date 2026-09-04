import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Select, Typography, Descriptions } from 'antd'
import { UserAddOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'

interface Member {
  id: number
  userId: number
  role: string
  username: string
  nickname: string
  createdAt: string
}

interface TeamInfo {
  team: { id: number; name: string; createdAt: string }
  members: Member[]
}

export default function Team() {
  const [info, setInfo] = useState<TeamInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<TeamInfo>('/api/team'))
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const addMember = async () => {
    const values = await form.validateFields()
    try {
      await api.post('/api/team/members', values)
      message.success('成员已添加')
      setOpen(false)
      form.resetFields()
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const changeRole = async (m: Member, role: string) => {
    await api.put(`/api/team/members/${m.id}`, { role })
    message.success('角色已更新')
    load()
  }

  const columns: ColumnsType<Member> = [
    { title: '用户名', dataIndex: 'username' },
    { title: '昵称', dataIndex: 'nickname' },
    {
      title: '角色',
      dataIndex: 'role',
      width: 160,
      render: (v, r) =>
        v === 'owner' ? (
          <Tag color="gold">所有者</Tag>
        ) : (
          <Select
            size="small"
            value={v}
            style={{ width: 110 }}
            onChange={(role) => changeRole(r, role)}
            options={[
              { value: 'admin', label: '管理员' },
              { value: 'member', label: '成员' }
            ]}
          />
        )
    },
    { title: '加入时间', dataIndex: 'createdAt', render: (v) => dayjs(v).format('YYYY-MM-DD') },
    {
      title: '操作',
      width: 90,
      render: (_, r) =>
        r.role !== 'owner' && (
          <Popconfirm title="移除该成员？" onConfirm={async () => { await api.del(`/api/team/members/${r.id}`); load() }}>
            <Button size="small" danger icon={<DeleteOutlined />}>移除</Button>
          </Popconfirm>
        )
    }
  ]

  return (
    <Card
      title="团队空间"
      extra={
        <Space>
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setOpen(true)}>
            邀请 / 添加成员
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      {info && (
        <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="团队名称">{info.team?.name}</Descriptions.Item>
          <Descriptions.Item label="成员数">{info.members.length}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{dayjs(info.team?.createdAt).format('YYYY-MM-DD')}</Descriptions.Item>
        </Descriptions>
      )}
      <Typography.Paragraph type="secondary">
        基于角色的权限管理：所有者与管理员可管理成员和环境配置，普通成员可使用环境执行日常运营。所有操作均记录在操作日志中并标注操作人，便于责任追溯。
      </Typography.Paragraph>
      <Table rowKey="id" size="middle" columns={columns} dataSource={info?.members || []} pagination={false} />
      <Modal title="邀请 / 添加成员" open={open} onOk={addMember} onCancel={() => setOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="用户名（已注册用户直接加入，新用户自动创建账号）" rules={[{ required: true }]}>
            <Input placeholder="成员用户名" />
          </Form.Item>
          <Form.Item name="password" label="登录密码（新用户必填）">
            <Input.Password placeholder="新用户初始密码" />
          </Form.Item>
          <Form.Item name="nickname" label="昵称（可选）">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="member">
            <Select
              options={[
                { value: 'admin', label: '管理员' },
                { value: 'member', label: '成员' }
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
