import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Card, Table, Button, Input, Select, Space, Tag, Tooltip, Switch, Typography, Popconfirm, Modal, Form, message, Upload
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, SearchOutlined, PlayCircleOutlined, PoweroffOutlined,
  EditOutlined, DeleteOutlined, CopyOutlined, FolderAddOutlined, MoreOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ImportOutlined, ExportOutlined, ThunderboltOutlined
} from '@ant-design/icons'
import { downloadText, readTextFile, nowStamp } from '../utils/download'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'
import ProfileForm from '../components/ProfileForm'
import type { ProfileDTO, GroupDTO, ProxyDTO, ExtensionDTO } from '@shared/types'

export default function Environments() {
  const [list, setList] = useState<ProfileDTO[]>([])
  const [groups, setGroups] = useState<GroupDTO[]>([])
  const [proxies, setProxies] = useState<ProxyDTO[]>([])
  const [extensions, setExtensions] = useState<ExtensionDTO[]>([])
  const [keyword, setKeyword] = useState('')
  const [groupId, setGroupId] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [syncMode, setSyncMode] = useState(false)
  const [windows, setWindows] = useState<{ id: number; title: string }[]>([])
  const [syncIds, setSyncIds] = useState<number[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [editing, setEditing] = useState<ProfileDTO | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [groupForm] = Form.useForm()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (keyword) params.set('keyword', keyword)
      if (groupId) params.set('groupId', String(groupId))
      const [p, g, x, e] = await Promise.all([
        api.get<ProfileDTO[]>(`/api/profiles?${params.toString()}`),
        api.get<GroupDTO[]>('/api/groups'),
        api.get<ProxyDTO[]>('/api/proxies'),
        api.get<ExtensionDTO[]>('/api/extensions')
      ])
      setList(p)
      setGroups(g)
      setProxies(x)
      setExtensions(e)
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [keyword, groupId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    pollRef.current = setInterval(load, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [load])

  const openProfile = async (id: number) => {
    try {
      await api.post(`/api/profiles/${id}/open`)
      message.success('窗口已打开')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const closeProfile = async (id: number) => {
    try {
      await api.post(`/api/profiles/${id}/close`)
      message.success('窗口已关闭')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const remove = async (id: number) => {
    try {
      await api.del(`/api/profiles/${id}`)
      message.success('已删除')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 下发同步配置；ids 为空数组 = 同步到全部已打开窗口 */
  const pushSync = async (enabled: boolean, ids: number[]) => {
    await api.post('/api/sync', { enabled, ids })
  }

  const toggleSync = async (checked: boolean) => {
    setSyncMode(checked)
    localStorage.setItem('roxy_sync', checked ? '1' : '0')
    try {
      await pushSync(checked, syncIds)
      message.info(
        checked
          ? syncIds.length
            ? `轨迹级同步已开启：将同步到 ${syncIds.length} 个指定窗口`
            : '轨迹级同步已开启：键鼠轨迹 / 滚动 / 输入将同步到全部已打开窗口'
          : '窗口同步已关闭'
      )
    } catch {
      message.error('设置失败')
    }
  }

  const changeSyncIds = async (ids: number[]) => {
    setSyncIds(ids)
    if (!syncMode) return
    try {
      await pushSync(true, ids)
    } catch {
      message.error('同步范围设置失败')
    }
  }

  useEffect(() => {
    setSyncMode(localStorage.getItem('roxy_sync') === '1')
  }, [])

  // 打开中的窗口列表（用于选择同步对象），同步开启时才轮询
  useEffect(() => {
    if (!syncMode) {
      setWindows([])
      return
    }
    const fetchWindows = async () => {
      try {
        setWindows(await api.get<{ id: number; title: string }[]>('/api/windows'))
      } catch {
        /* 忽略轮询失败 */
      }
    }
    fetchWindows()
    const timer = setInterval(fetchWindows, 3000)
    return () => clearInterval(timer)
  }, [syncMode])

  // ===== 批量能力 =====
  const exportProfiles = async () => {
    try {
      const data = await api.get<unknown[]>('/api/profiles/export')
      downloadText(JSON.stringify(data, null, 2), `roxy-profiles-${nowStamp()}.json`)
      message.success(`已导出 ${data.length} 个环境（含完整指纹配置）`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const doImport = async () => {
    if (!importText.trim()) {
      message.warning('请粘贴 JSON 内容')
      return
    }
    try {
      const parsed = JSON.parse(importText)
      const items = Array.isArray(parsed) ? parsed : parsed.items
      const res = await api.post<{ created: number }>('/api/profiles/import', { items })
      message.success(`成功导入 ${res.created} 个环境`)
      setImportOpen(false)
      setImportText('')
      load()
    } catch (e) {
      message.error(`导入失败：${(e as Error).message}`)
    }
  }

  const pickImportFile = async (file: File) => {
    try {
      setImportText(await readTextFile(file))
    } catch (e) {
      message.error((e as Error).message)
    }
    return false
  }

  const randomizeSelected = async () => {
    try {
      const res = await api.post<{ updated: number }>('/api/profiles/batch-randomize', { ids: selected.map(Number) })
      message.success(`已为 ${res.updated} 个环境重新生成指纹（运行中的环境已跳过）`)
      setSelected([])
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const duplicate = async (id: number) => {
    try {
      const res = await api.post<{ migratedAccounts: number }>(`/api/profiles/${id}/duplicate`)
      message.success(`已复制环境，迁移 ${res.migratedAccounts} 个账号资料`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<ProfileDTO> = [
    { title: '序号', dataIndex: 'seq', width: 70 },
    {
      title: '环境名称',
      dataIndex: 'name',
      render: (_, r) => (
        <Space>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
          {r.platform && <Tag color="processing">{r.platform}</Tag>}
        </Space>
      )
    },
    { title: '分组', dataIndex: 'groupName', width: 100, render: (v) => v || <Typography.Text type="secondary">-</Typography.Text> },
    {
      title: '指纹',
      dataIndex: 'fingerprint',
      width: 210,
      render: (fp: ProfileDTO['fingerprint']) => (
        <Tooltip title={fp.userAgent}>
          <Space size={4} wrap>
            <Tag>{fp.os === 'mac' ? 'macOS' : 'Windows'}</Tag>
            <Tag color="geekblue">{fp.timezone.split('/').pop()}</Tag>
            <Tag color="purple">{fp.languages[0]}</Tag>
          </Space>
        </Tooltip>
      )
    },
    {
      title: '代理',
      dataIndex: 'proxyName',
      width: 160,
      render: (v, r) =>
        v ? (
          <Tooltip title={`${r.proxyInfo?.type.toUpperCase()} ${r.proxyInfo?.host}:${r.proxyInfo?.port}`}>
            <Tag color="green">{v}</Tag>
          </Tooltip>
        ) : (
          <Tag>直连</Tag>
        )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v) =>
        v === 'running' ? (
          <Tag icon={<PlayCircleOutlined />} color="success">运行中</Tag>
        ) : (
          <Tag icon={<CheckCircleOutlined />}>未打开</Tag>
        )
    },
    {
      title: '最后打开',
      dataIndex: 'lastOpenedAt',
      width: 150,
      render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-')
    },
    {
      title: '操作',
      width: 200,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'running' ? (
            <Button size="small" danger icon={<PoweroffOutlined />} onClick={() => closeProfile(r.id)}>
              关闭
            </Button>
          ) : (
            <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => openProfile(r.id)}>
              打开
            </Button>
          )}
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); setFormOpen(true) }} />
          <Tooltip title="复制环境（含账号资料迁移）">
            <Button size="small" icon={<CopyOutlined />} onClick={() => duplicate(r.id)} />
          </Tooltip>
          <Popconfirm title="确定删除该环境？" onConfirm={() => remove(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  const addGroup = async () => {
    const values = await groupForm.validateFields()
    await api.post('/api/groups', values)
    message.success('分组已创建')
    setGroupModalOpen(false)
    groupForm.resetFields()
    load()
  }

  return (
    <div>
      <Card
        title="环境管理 — 浏览器指纹环境"
        extra={
          <Space wrap>
            <Tooltip title="同步鼠标轨迹（贝塞尔插值）、按下/抬起、滚轮、键盘、输入、滚动到其它环境窗口">
              <span>轨迹级同步</span>
            </Tooltip>
            <Switch checked={syncMode} onChange={toggleSync} checkedChildren="开" unCheckedChildren="关" />
            {syncMode && (
              <Select
                mode="multiple"
                allowClear
                placeholder="全部已打开窗口"
                style={{ minWidth: 260 }}
                value={syncIds}
                onChange={changeSyncIds}
                options={windows.map((w) => ({ value: w.id, label: w.title }))}
                maxTagCount={2}
              />
            )}
          </Space>
        }
      >
        <Space style={{ marginBottom: 16 }} wrap>
          <Input
            placeholder="搜索名称 / 备注 / 平台"
            prefix={<SearchOutlined />}
            style={{ width: 240 }}
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            placeholder="全部分组"
            allowClear
            style={{ width: 160 }}
            value={groupId}
            onChange={setGroupId}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            新建环境
          </Button>
          <Button icon={<FolderAddOutlined />} onClick={() => setGroupModalOpen(true)}>
            新建分组
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Button icon={<ExportOutlined />} onClick={exportProfiles}>
            导出
          </Button>
          {selected.length > 0 && (
            <>
              <Button
                icon={<ThunderboltOutlined />}
                onClick={randomizeSelected}
              >
                批量重随机指纹 ({selected.length})
              </Button>
              <Button
                icon={<PlayCircleOutlined />}
                onClick={() => {
                  list.filter((p) => selected.includes(p.id) && p.status !== 'running').forEach((p) => openProfile(p.id))
                  setSelected([])
                }}
              >
                批量打开 ({selected.length})
              </Button>
              <Button
                danger
                icon={<PoweroffOutlined />}
                onClick={() => {
                  list.filter((p) => selected.includes(p.id) && p.status === 'running').forEach((p) => closeProfile(p.id))
                  setSelected([])
                }}
              >
                批量关闭
              </Button>
            </>
          )}
        </Space>
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={list}
          rowSelection={{ selectedRowKeys: selected, onChange: setSelected }}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个环境` }}
        />
      </Card>

      <ProfileForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={load}
        initial={editing}
        groups={groups}
        proxies={proxies}
        extensions={extensions}
      />

      <Modal title="新建分组" open={groupModalOpen} onOk={addGroup} onCancel={() => setGroupModalOpen(false)}>
        <Form form={groupForm} layout="vertical">
          <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请输入分组名称' }]}>
            <Input placeholder="例如：Amazon 店铺组" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="导入环境"
        open={importOpen}
        onOk={doImport}
        onCancel={() => setImportOpen(false)}
        okText="开始导入"
        width={640}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          支持从本工具导出的 JSON 导入（含完整指纹配置）；也可只给 name / platform，系统会自动生成随机指纹。
        </Typography.Paragraph>
        <Upload accept=".json" beforeUpload={pickImportFile} showUploadList={false}>
          <Button icon={<ImportOutlined />} style={{ marginBottom: 12 }}>
            选择 JSON 文件
          </Button>
        </Upload>
        <Input.TextArea
          rows={10}
          placeholder='例如：[{"name":"Amazon 店 01","platform":"Amazon"}]'
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
      </Modal>
    </div>
  )
}
