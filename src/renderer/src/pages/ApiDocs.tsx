import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Typography, Alert } from 'antd'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, CopyOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api, API_BASE } from '../api'
import type { TokenDTO } from '@shared/types'

export default function ApiDocs() {
  const [list, setList] = useState<TokenDTO[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    try {
      setList(await api.get<TokenDTO[]>('/api/tokens'))
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    const values = await form.validateFields()
    await api.post('/api/tokens', values)
    message.success('令牌已创建')
    setOpen(false)
    form.resetFields()
    load()
  }

  const columns: ColumnsType<TokenDTO> = [
    { title: '名称', dataIndex: 'name' },
    {
      title: '令牌',
      dataIndex: 'token',
      render: (v) => (
        <Typography.Text copyable={{ text: v }} code>
          {v}
        </Typography.Text>
      )
    },
    { title: '创建时间', dataIndex: 'createdAt', render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    {
      title: '操作',
      width: 90,
      render: (_, r) => (
        <Popconfirm title="删除该令牌？" onConfirm={async () => { await api.del(`/api/tokens/${r.id}`); load() }}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      )
    }
  ]

  const curl = (path: string, body?: string) =>
    `curl -X ${body ? 'POST' : 'GET'} "${API_BASE}/api/v1${path}" \\\n  -H "Authorization: Bearer <你的令牌>" \\\n  -H "Content-Type: application/json"${body ? ` \\\n  -d '${body}'` : ''}`

  return (
    <Card
      title="自动化 API"
      extra={
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            创建令牌
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        message="通过 API 集成你的自定义工具与脚本"
        description="自动化 API 与 RoxyBrowser Clone 客户端同源运行，可对接调度器、测试执行器等工具，从创建环境到打开窗口全生命周期脚本化。"
        style={{ marginBottom: 16 }}
      />
      <Table rowKey="id" size="middle" columns={columns} dataSource={list} pagination={false} style={{ marginBottom: 24 }} />

      <Typography.Title level={5}>接口文档</Typography.Title>
      <Typography.Paragraph type="secondary">
        所有请求携带请求头 <Typography.Text code>Authorization: Bearer {'<令牌>'}</Typography.Text>，基础地址 <Typography.Text code>{API_BASE}</Typography.Text>
      </Typography.Paragraph>

      {[
        { title: 'GET /api/v1/profiles — 环境列表', code: curl('/profiles') },
        {
          title: 'POST /api/v1/profiles — 创建环境',
          code: curl('/profiles', '{"name":"API创建的环境","platform":"Amazon","fingerprint":{"os":"windows"}}')
        },
        { title: 'GET /api/v1/profiles/{id} — 查询单个环境', code: curl('/profiles/1') },
        {
          title: 'PUT /api/v1/profiles/{id} — 更新环境',
          code: curl('/profiles/1', '{"name":"新名字","startUrl":"https://example.com","proxyId":3}')
        },
        { title: 'DELETE /api/v1/profiles/{id} — 删除环境（含关联账号/Cookie）', code: `curl -X DELETE "${API_BASE}/api/v1/profiles/1" \\\n  -H "Authorization: Bearer <你的令牌>"` },
        { title: 'POST /api/v1/profiles/{id}/open — 打开环境窗口', code: curl('/profiles/1/open') },
        { title: 'POST /api/v1/profiles/{id}/close — 关闭环境窗口', code: curl('/profiles/1/close') },
        { title: 'GET /api/v1/proxies — 代理列表', code: curl('/proxies') },
        {
          title: 'POST /api/v1/proxies — 创建代理',
          code: curl('/proxies', '{"name":"my-proxy","type":"http","host":"1.2.3.4","port":8080,"username":"u","password":"p"}')
        },
        { title: 'PUT /api/v1/proxies/{id} — 更新代理', code: curl('/proxies/1', '{"name":"new-name","port":8899}') },
        { title: 'DELETE /api/v1/proxies/{id} — 删除代理', code: `curl -X DELETE "${API_BASE}/api/v1/proxies/1" \\\n  -H "Authorization: Bearer <你的令牌>"` },
        { title: 'POST /api/v1/proxies/allocate — 从 IP 池分配代理', code: curl('/proxies/allocate', '{"profileId":1,"country":"US"}') },
        { title: 'POST /api/v1/proxies/check — 检测代理连通性', code: curl('/proxies/check', '{"id":1}') },
        {
          title: 'POST /api/v1/fingerprint/random — 生成随机指纹',
          code: curl('/fingerprint/random', '{"os":"mac"}')
        },
        { title: 'GET /api/v1/accounts — 账号列表', code: curl('/accounts') },
        {
          title: 'POST /api/v1/accounts — 创建账号',
          code: curl('/accounts', '{"profileId":1,"platform":"Amazon","username":"buyer01","password":"secret"}')
        },
        { title: 'PUT /api/v1/accounts/{id} — 更新账号', code: curl('/accounts/1', '{"password":"new-secret"}') },
        { title: 'DELETE /api/v1/accounts/{id} — 删除账号', code: `curl -X DELETE "${API_BASE}/api/v1/accounts/1" \\\n  -H "Authorization: Bearer <你的令牌>"` }
      ].map((item) => (
        <div key={item.title} style={{ marginBottom: 16 }}>
          <Typography.Text strong>{item.title}</Typography.Text>
          <pre
            style={{
              background: '#0d1117',
              color: '#c9d1d9',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              overflow: 'auto'
            }}
          >
            {item.code}
          </pre>
        </div>
      ))}

      <Modal title="创建 API 令牌" open={open} onOk={create} onCancel={() => setOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="令牌名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：自动化脚本" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
