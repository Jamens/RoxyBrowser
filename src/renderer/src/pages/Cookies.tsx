import { useCallback, useEffect, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Popconfirm,
  message,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  DatePicker,
  Typography,
  Empty,
  Upload
} from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, ImportOutlined, ExportOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'
import { downloadText, readTextFile, nowStamp } from '../utils/download'
import type { CookieDTO, ProfileDTO } from '@shared/types'

const SAME_SITES = [
  { value: 'unspecified', label: '未指定 (Unspecified)' },
  { value: 'no_restriction', label: '不限制 (None)' },
  { value: 'lax', label: 'Lax' },
  { value: 'strict', label: 'Strict' }
]

interface Row extends CookieDTO {}

export default function Cookies() {
  const [profiles, setProfiles] = useState<ProfileDTO[]>([])
  const [profileId, setProfileId] = useState<number | undefined>()
  const [list, setList] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form] = Form.useForm()

  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')

  const loadProfiles = useCallback(async () => {
    try {
      const p = await api.get<ProfileDTO[]>('/api/profiles')
      setProfiles(p)
      // 默认选中第一个非模板环境
      setProfileId((cur) => cur ?? p.find((x) => !x.isTemplate)?.id ?? p[0]?.id)
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  const loadCookies = useCallback(async () => {
    if (!profileId) {
      setList([])
      return
    }
    setLoading(true)
    try {
      const c = await api.get<Row[]>(`/api/cookies?profileId=${profileId}`)
      setList(c)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    loadCookies()
  }, [loadCookies])

  const save = async () => {
    const values = await form.validateFields()
    try {
      const payload = {
        ...values,
        profileId,
        expirationDate: values.expirationDate ? dayjs(values.expirationDate).toISOString() : null
      }
      if (editing) await api.put(`/api/cookies/${editing.id}`, payload)
      else await api.post('/api/cookies', payload)
      message.success('已保存')
      setOpen(false)
      loadCookies()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const doImport = async () => {
    if (!profileId) return message.warning('请先选择环境')
    if (!importText.trim()) return message.warning('请粘贴 Cookie 文本')
    try {
      const res = await api.post<{ imported: number; failed: string[] }>('/api/cookies/import', {
        profileId,
        text: importText
      })
      if (res.imported) message.success(`成功导入 ${res.imported} 条 Cookie`)
      if (res.failed.length) message.warning(`${res.failed.length} 行无法识别：${res.failed.slice(0, 2).join(' / ')}`)
      setImportOpen(false)
      setImportText('')
      loadCookies()
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

  const exportCookies = async () => {
    if (!profileId) return message.warning('请先选择环境')
    try {
      const res = await api.get<{ text: string; count: number }>(`/api/cookies/export?profileId=${profileId}`)
      if (!res.count) return message.warning('该环境暂无 Cookie 可导出')
      downloadText(res.text, `roxy-cookies-${nowStamp()}.txt`, 'text/plain;charset=utf-8')
      message.success(`已导出 ${res.count} 条 Cookie`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const clearAll = async () => {
    if (!profileId) return
    try {
      await api.del(`/api/cookies?profileId=${profileId}`)
      message.success('已清空该环境全部 Cookie')
      loadCookies()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const applyNow = async () => {
    if (!profileId) return
    try {
      const res = await api.post<{ applied: number }>('/api/cookies/apply', { profileId })
      message.success(`已立即注入 ${res.applied} 条 Cookie 到运行中的窗口`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<Row> = [
    { title: '域名', dataIndex: 'domain', width: 180, ellipsis: true, render: (v) => v || '-' },
    { title: '名称', dataIndex: 'name', width: 160, ellipsis: true, render: (v) => v || '-' },
    {
      title: '值',
      dataIndex: 'value',
      ellipsis: true,
      render: (v) => <Input.Password value={v} size="small" bordered={false as never} style={{ width: 180 }} readOnly />
    },
    { title: '路径', dataIndex: 'path', width: 70, render: (v) => v || '/' },
    {
      title: '属性',
      width: 170,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.secure && <Tag color="green">Secure</Tag>}
          {r.httpOnly && <Tag color="purple">HttpOnly</Tag>}
          {r.sameSite !== 'unspecified' && <Tag>{r.sameSite}</Tag>}
          {!r.hostOnly && <Tag color="blue">含子域</Tag>}
        </Space>
      )
    },
    {
      title: '过期时间',
      dataIndex: 'expirationDate',
      width: 150,
      render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : <Typography.Text type="secondary">会话级</Typography.Text>)
    },
    {
      title: '操作',
      width: 110,
      render: (_, r) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(r)
              form.setFieldsValue({ ...r, expirationDate: r.expirationDate ? dayjs(r.expirationDate) : null })
              setOpen(true)
            }}
          />
          <Popconfirm title="删除该 Cookie？" onConfirm={async () => { await api.del(`/api/cookies/${r.id}`); loadCookies() }}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Card
      title="Cookie 管理"
      extra={
        <Space>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择浏览器环境"
            style={{ width: 220 }}
            value={profileId}
            onChange={(v) => setProfileId(v)}
            options={profiles.map((p) => ({ value: p.id, label: `#${p.seq} ${p.name}` }))}
          />
          <Button icon={<ImportOutlined />} disabled={!profileId} onClick={() => { setImportText(''); setImportOpen(true) }}>
            批量导入
          </Button>
          <Button icon={<ExportOutlined />} disabled={!profileId} onClick={exportCookies}>
            导出
          </Button>
          <Popconfirm title="清空该环境全部 Cookie？" onConfirm={clearAll}>
            <Button danger icon={<DeleteOutlined />} disabled={!profileId}>清空</Button>
          </Popconfirm>
          <Button type="primary" icon={<PlusOutlined />} disabled={!profileId} onClick={() => { setEditing(null); form.resetFields(); setOpen(true) }}>
            添加 Cookie
          </Button>
          <Button icon={<ReloadOutlined />} onClick={loadCookies}>刷新</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Cookie 按环境隔离存储，环境打开时会自动注入到对应浏览器窗口，确保首屏即带登录态；也可在环境运行中点击「立即应用」热更新。支持从浏览器插件 / 抓包工具导出的 Netscape、Set-Cookie、JSON 格式批量导入。
      </Typography.Paragraph>
      {profileId ? (
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={list}
          locale={{ emptyText: <Empty description="该环境暂无 Cookie，点击「添加 Cookie」或「批量导入」" /> }}
          pagination={{ pageSize: 10 }}
        />
      ) : (
        <Empty description="请先在右上角选择一个浏览器环境" />
      )}

      <Modal title={editing ? '编辑 Cookie' : '添加 Cookie'} open={open} onOk={save} onCancel={() => setOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ path: '/', sameSite: 'unspecified', secure: false, httpOnly: false, hostOnly: true }}>
          <Form.Item name="domain" label="域名 (Domain)" rules={[{ required: true, message: '必填，如 .example.com 或 example.com' }]}>
            <Input placeholder=".example.com（带点表示含子域）" />
          </Form.Item>
          <Space size="large" style={{ display: 'flex' }}>
            <Form.Item name="name" label="名称 (Name)" rules={[{ required: true, message: '必填' }]} style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="path" label="路径 (Path)" style={{ width: 160 }}>
              <Input />
            </Form.Item>
          </Space>
          <Form.Item name="value" label="值 (Value)" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space size="large" style={{ display: 'flex' }}>
            <Form.Item name="sameSite" label="同站点策略 (SameSite)" style={{ width: 200 }}>
              <Select options={SAME_SITES} />
            </Form.Item>
            <Form.Item name="expirationDate" label="过期时间（留空=会话级）" style={{ flex: 1 }}>
              <DatePicker showTime style={{ width: '100%' }} placeholder="选择过期时间" />
            </Form.Item>
          </Space>
          <Space size="large">
            <Form.Item name="secure" label="Secure" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="httpOnly" label="HttpOnly" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="hostOnly" label="仅主机 (不含子域)" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal title="批量导入 Cookie" open={importOpen} onOk={doImport} onCancel={() => setImportOpen(false)} destroyOnClose width={640}>
        <Form layout="vertical">
          <Form.Item label="当前环境" extra={`将导入到「${profiles.find((p) => p.id === profileId)?.name || ''}」`}>
            <Input value={profiles.find((p) => p.id === profileId)?.name || ''} disabled />
          </Form.Item>
          <Form.Item
            label="Cookie 文本"
            required
            extra="支持三种格式：① Netscape（tab 分隔 7 列）② Set-Cookie（name=value; Domain=...; Path=...; Expires=...; Secure; HttpOnly）③ EditThisCookie / 导出 JSON 数组"
          >
            <Input.TextArea
              rows={10}
              placeholder={'.example.com\tTRUE\t/\tFALSE\t1893456000\tsessionid\tabc123\nname=value; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=Lax'}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          </Form.Item>
          <Upload beforeUpload={pickFile} showUploadList={false} accept=".txt,.json,.cookie">
            <Button icon={<ImportOutlined />}>从文件选择</Button>
          </Upload>
        </Form>
      </Modal>

      {profileId && (
        <Button type="link" icon={<ThunderboltOutlined />} style={{ paddingLeft: 0, marginTop: 8 }} onClick={applyNow}>
          立即应用到运行中的窗口（未打开则下次打开时自动注入）
        </Button>
      )}
    </Card>
  )
}
