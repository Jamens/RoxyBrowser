import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, Table, Button, Space, Tag, Popconfirm, Modal, Form, Input, Select, Typography, Upload, Tooltip, Alert } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, ImportOutlined, ExportOutlined, CopyOutlined, DownloadOutlined, LinkOutlined, StarOutlined, StarFilled, SearchOutlined } from '@ant-design/icons'
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
  // 当前用户角色：member 不可查看明文密码 / 导出（对标官方 3.8.9 账号权限管理）
  const [role, setRole] = useState('owner')
  const isMember = role === 'member'

  // 列表检索：关键词（平台/账号/备注）+ 所属环境 + 平台筛选
  const [keyword, setKeyword] = useState('')
  const [profileFilter, setProfileFilter] = useState<number | undefined>()
  const [platformFilter, setPlatformFilter] = useState<string | undefined>()

  // 收藏（本地 localStorage，不落库、不加数据库列，符合规则 #24）：记录用户常驻关注的账号 ID
  const STAR_KEY = 'roxy_starred_accounts'
  const [starred, setStarred] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(STAR_KEY)
      const arr = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(arr) ? (arr.filter((x) => typeof x === 'number') as number[]) : []
    } catch {
      return []
    }
  })
  const [onlyStarred, setOnlyStarred] = useState(false)
  const toggleStar = (id: number) => {
    setStarred((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      try {
        localStorage.setItem(STAR_KEY, JSON.stringify(next))
      } catch {
        /* 忽略存储异常（如隐私模式） */
      }
      return next
    })
  }
  // 回收站/删除后，收藏集里可能残留已不存在的账号 ID，按当前列表裁剪，保持整洁
  useEffect(() => {
    setStarred((prev) => {
      const valid = prev.filter((id) => list.some((a) => a.id === id))
      if (valid.length === prev.length) return prev
      try {
        localStorage.setItem(STAR_KEY, JSON.stringify(valid))
      } catch {
        /* ignore */
      }
      return valid
    })
  }, [list])

  // 批量关联环境：选中多个账号 → 统一绑定到某个目标环境
  const [selectedAcc, setSelectedAcc] = useState<number[]>([])
  const [assocOpen, setAssocOpen] = useState(false)
  const [assocProfile, setAssocProfile] = useState<number | undefined>()
  const [assocLoading, setAssocLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (keyword) params.set('keyword', keyword)
      if (profileFilter) params.set('profileId', String(profileFilter))
      if (platformFilter) params.set('platform', platformFilter)
      const [a, p, me] = await Promise.all([
        api.get<Row[]>(`/api/accounts?${params.toString()}`),
        api.get<ProfileDTO[]>('/api/profiles'),
        api.get<{ role: string }>('/api/auth/me')
      ])
      setList(a)
      setProfiles(p)
      setRole(me.role)
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [keyword, profileFilter, platformFilter])

  // 收藏为客户端二次过滤：开启「仅看收藏」时按收藏集筛选，与后端 keyword/环境/平台筛选叠加
  const viewList = useMemo(() => {
    if (!onlyStarred) return list
    const set = new Set(starred)
    return list.filter((a) => set.has(a.id))
  }, [list, onlyStarred, starred])

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

  // 标准导入模板（对标官方模板批量导入）：表头 + 注释说明 + 两种格式示例；
  // 后端解析时会自动跳过表头（「环境,…」/「平台,…」开头）与 ; 注释行
  const downloadTemplate = () => {
    const tpl = [
      '; RoxyBrowser 账号导入模板',
      '; 每行一条账号，支持两种格式：',
      ';   格式A（带环境，自动匹配归属）：#环境序号|环境名,平台,账号,密码,备注',
      ';   格式B（归属到弹窗所选环境）：平台,账号,密码,备注',
      '; 以 ; 开头的行与第一行表头会被自动跳过',
      '环境,平台,账号,密码,备注',
      '#1001|Amazon US Store 01,Amazon,demo@example.com,pass123,示例行（可删除）',
      'Amazon,demo2@example.com,pass456,格式B示例（归属到所选环境）'
    ].join('\n')
    downloadText(tpl, 'roxy-accounts-template.csv', 'text/plain;charset=utf-8')
    message.success('模板已下载，填写后再上传或粘贴')
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

  const batchAssociate = async () => {
    if (!selectedAcc.length) {
      message.warning('请先勾选账号')
      return
    }
    if (assocProfile === undefined) {
      message.warning('请选择目标环境')
      return
    }
    setAssocLoading(true)
    try {
      const res = await api.post<{ updated: number }>('/api/accounts/batch-associate', {
        accountIds: selectedAcc,
        profileId: assocProfile
      })
      message.success(`已将 ${res.updated} 个账号关联到所选环境`)
      setAssocOpen(false)
      setAssocProfile(undefined)
      setSelectedAcc([])
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setAssocLoading(false)
    }
  }

  const columns: ColumnsType<Row> = [
    {
      title: '',
      key: 'star',
      width: 44,
      fixed: 'left',
      render: (_, r) => (
        <Button
          type="text"
          size="small"
          aria-label={starred.includes(r.id) ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation()
            toggleStar(r.id)
          }}
        >
          {starred.includes(r.id) ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />}
        </Button>
      )
    },
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
      render: (v, r) =>
        r.passwordMasked ? (
          <Typography.Text type="secondary">无权限查看</Typography.Text>
        ) : (
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
          <Tooltip title={isMember ? '仅管理员可导出账号' : ''}>
            <Button icon={<ExportOutlined />} onClick={exportAccounts} disabled={isMember}>
              导出
            </Button>
          </Tooltip>
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
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          placeholder="搜索平台 / 账号 / 备注"
          prefix={<SearchOutlined />}
          style={{ width: 220 }}
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Select
          placeholder="全部环境"
          allowClear
          style={{ width: 180 }}
          value={profileFilter}
          onChange={setProfileFilter}
          showSearch
          optionFilterProp="label"
          options={profiles.map((p) => ({ value: p.id, label: `#${p.seq} ${p.name}` }))}
        />
        <Select
          placeholder="全部平台"
          allowClear
          style={{ width: 150 }}
          value={platformFilter}
          onChange={setPlatformFilter}
          options={PLATFORMS.map((p) => ({ value: p, label: p }))}
        />
        <Button
          icon={onlyStarred ? <StarFilled /> : <StarOutlined />}
          type={onlyStarred ? 'primary' : 'default'}
          onClick={() => setOnlyStarred((v) => !v)}
        >
          仅看收藏{starred.length ? ` (${starred.length})` : ''}
        </Button>
      </Space>
      {selectedAcc.length > 0 && (
        <Space style={{ marginBottom: 12 }}>
          <Typography.Text>已选 {selectedAcc.length} 个账号</Typography.Text>
          <Button type="primary" icon={<LinkOutlined />} onClick={() => setAssocOpen(true)}>
            批量关联环境
          </Button>
          <Button onClick={() => setSelectedAcc([])}>取消选择</Button>
        </Space>
      )}
      <Table
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={viewList}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 960 }}
        rowSelection={{ selectedRowKeys: selectedAcc, onChange: (keys) => setSelectedAcc(keys as number[]) }}
      />
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
          <Form.Item name="password" label="密码" extra={isMember ? '成员角色不可查看/修改密码' : undefined}>
            <Input.Password disabled={isMember} placeholder={isMember ? '无权限' : undefined} />
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
            extra="每行一条。格式 A：#序号|环境名,平台,账号,密码,备注（自动匹配环境）。格式 B：平台,账号,密码[,备注]。模板表头与 ; 注释行会自动跳过"
          >
            <Input.TextArea
              rows={8}
              placeholder={'Amazon,amazon01,pass123,主账号\n#1001|Amazon US Store 01,Amazon,amazon02,pass456,备用'}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          </Form.Item>
          <Space>
            <Upload beforeUpload={pickFile} showUploadList={false} accept=".txt,.csv">
              <Button icon={<ImportOutlined />}>从文件选择</Button>
            </Upload>
            <Button icon={<DownloadOutlined />} onClick={downloadTemplate}>
              下载模板
            </Button>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="批量关联环境"
        open={assocOpen}
        onOk={batchAssociate}
        confirmLoading={assocLoading}
        onCancel={() => setAssocOpen(false)}
        okText="确认关联"
        destroyOnClose
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message={`将为选中的 ${selectedAcc.length} 个账号统一设置所属环境`}
          description="关联后这些账号的密码不展示给环境成员之外的协作方（成员角色本就看不到明文密码）。"
        />
        <Form layout="vertical">
          <Form.Item label="目标环境" required extra="选中的账号将统一绑定到该环境（一个账号只能属于一个环境）">
            <Select
              placeholder="选择浏览器环境"
              value={assocProfile}
              onChange={(v) => setAssocProfile(v)}
              showSearch
              optionFilterProp="label"
              options={profiles.map((p) => ({ value: p.id, label: `#${p.seq} ${p.name}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
