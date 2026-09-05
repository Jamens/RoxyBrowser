import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Button, Space, Tag, Popconfirm, Modal, Form, Input, Select, Typography, Upload } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, ImportOutlined, ExportOutlined, CopyOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import { downloadText, readTextFile, nowStamp } from '../utils/download'
import type { AccountDTO, ProfileDTO } from '@shared/types'

const PLATFORMS = ['Amazon', 'Facebook', 'Instagram', 'TikTok', 'eBay', 'Etsy', 'Walmart', 'Shopee', 'Google', '其他']

interface Row extends AccountDTO {}

// 行内一键复制按钮：复制凭据到剪贴板，不落日志、不影响数据
function CopyBtn({ text, label }: { text?: string; label: string }) {
  const { message } = useAppCtx()
  return (
    <Button
      type="text"
      size="small"
      icon={<CopyOutlined />}
      title={`复制${label}`}
      onClick={(e) => {
        e.stopPropagation()
        const v = text ?? ''
        if (!v) return message.warning(`没有可复制的${label}`)
        navigator.clipboard
          .writeText(v)
          .then(() => message.success(`${label}已复制`))
          .catch(() => message.error('复制失败，请检查浏览器剪贴板权限'))
      }}
    />
  )
}

export default function Accounts() {
  const { message } = useAppCtx()
  const [list, setList] = useState<Row[]>([])
  const [profiles, setProfiles] = useState<ProfileDTO[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form] = Form.useForm()
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importProfile, setImportProfile] = useState<number | undefined>()

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

  const doImport = async () => {
    if (!importProfile) {
      message.warning('请选择导入目标环境')
      return
    }
    if (!importText.trim()) {
      message.warning('请粘贴账号列表')
      return
    }
    try {
      const res = await api.post<{ imported: number; failed: string[] }>('/api/accounts/import', {
        text: importText,
        profileId: importProfile
      })
      if (res.imported) message.success(`成功导入 ${res.imported} 条账号`)
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

  const exportAccounts = async () => {
    try {
      const res = await api.get<{ text: string; count: number }>('/api/accounts/export')
      if (!res.count) return message.warning('暂无账号可导出')
      downloadText(res.text, `roxy-accounts-${nowStamp()}.csv`, 'text/plain;charset=utf-8')
      message.success(`已导出 ${res.count} 条账号`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<Row> = [
    { title: '所属环境', dataIndex: 'profileName', render: (v) => v || '-' },
    { title: '平台', dataIndex: 'platform', width: 110, render: (v) => (v ? <Tag color="processing">{v}</Tag> : '-') },
    {
      title: '账号',
      dataIndex: 'username',
      render: (v) => (
        <Space size={4}>
          <span>{v || '-'}</span>
          <CopyBtn text={v} label="账号" />
        </Space>
      )
    },
    {
      title: '密码',
      dataIndex: 'password',
      render: (v) => (
        <Space size={4}>
          <Input.Password value={v} size="small" bordered={false as never} style={{ width: 140 }} readOnly />
          <CopyBtn text={v} label="密码" />
        </Space>
      )
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
          <Button icon={<ImportOutlined />} onClick={() => { setImportProfile(undefined); setImportText(''); setImportOpen(true) }}>
            批量导入
          </Button>
          <Button icon={<ExportOutlined />} onClick={exportAccounts}>
            导出
          </Button>
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

      <Modal
        title="批量导入账号"
        open={importOpen}
        onOk={doImport}
        onCancel={() => setImportOpen(false)}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="导入目标环境" required extra="格式 B（仅「平台,账号,密码[,备注]」）的账号将归属到此环境">
            <Select
              placeholder="选择浏览器环境"
              value={importProfile}
              onChange={(v) => setImportProfile(v)}
              showSearch
              optionFilterProp="label"
              options={profiles.map((p) => ({ value: p.id, label: `#${p.seq} ${p.name}` }))}
            />
          </Form.Item>
          <Form.Item
            label="账号列表"
            required
            extra="每行一条。格式 A：#序号|环境名,平台,账号,密码,备注（自动匹配环境）。格式 B：平台,账号,密码[,备注]"
          >
            <Input.TextArea
              rows={8}
              placeholder={'Amazon,amazon01,pass123,主账号\n#1001|Amazon US Store 01,Amazon,amazon02,pass456,备用'}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          </Form.Item>
          <Upload beforeUpload={pickFile} showUploadList={false} accept=".txt,.csv">
            <Button icon={<ImportOutlined />}>从文件选择</Button>
          </Upload>
        </Form>
      </Modal>
    </Card>
  )
}
