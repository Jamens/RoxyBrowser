import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Button, Space, Tag, Typography, Popconfirm, message } from 'antd'
import { PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, CopyOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import ProfileForm from '../components/ProfileForm'
import type { ProfileDTO, GroupDTO, ProxyDTO } from '@shared/types'
import { osLabel } from '@shared/types'

export default function Templates() {
  const [list, setList] = useState<ProfileDTO[]>([])
  const [groups, setGroups] = useState<GroupDTO[]>([])
  const [proxies, setProxies] = useState<ProxyDTO[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProfileDTO | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, g, x] = await Promise.all([
        api.get<ProfileDTO[]>('/api/profiles?templates=1'),
        api.get<GroupDTO[]>('/api/groups'),
        api.get<ProxyDTO[]>('/api/proxies')
      ])
      setList(p)
      setGroups(g)
      setProxies(x)
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const clone = async (tpl: ProfileDTO) => {
    const name = window.prompt('新环境名称：', `${tpl.name} 环境副本`)
    if (!name) return
    try {
      await api.post(`/api/profiles/${tpl.id}/clone`, { name })
      message.success(`已从模板创建环境「${name}」`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const remove = async (id: number) => {
    await api.del(`/api/profiles/${id}`)
    message.success('已删除')
    load()
  }

  const columns: ColumnsType<ProfileDTO> = [
    { title: '模板名称', dataIndex: 'name', render: (v, r) => <Space><b>{v}</b>{r.platform && <Tag color="processing">{r.platform}</Tag>}</Space> },
    {
      title: '指纹配置',
      dataIndex: 'fingerprint',
      render: (fp: ProfileDTO['fingerprint']) => (
        <Space size={4} wrap>
          <Tag>{osLabel(fp.os)}</Tag>
          <Tag color="geekblue">{fp.timezone.split('/').pop()}</Tag>
          <Tag color="purple">{fp.languages[0]}</Tag>
          <Tag color="cyan">{fp.screenWidth}×{fp.screenHeight}</Tag>
        </Space>
      )
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v) => v || '-' },
    {
      title: '操作',
      width: 220,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="primary" icon={<CopyOutlined />} onClick={() => clone(r)}>
            从模板创建环境
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); setFormOpen(true) }} />
          <Popconfirm title="删除该模板？" onConfirm={() => remove(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Card
      title="窗口模板"
      extra={
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true) }}>
            新建模板
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        模板是一套预设的指纹 + 起始页 + 平台配置，点击「从模板创建环境」可一键生成配置一致的浏览器环境，确保环境设置的完美一致性。
      </Typography.Paragraph>
      <Table rowKey="id" size="middle" columns={columns} dataSource={list} pagination={{ pageSize: 10 }} />
      <ProfileForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={load}
        initial={editing}
        isTemplate
        groups={groups}
        proxies={proxies}
        extensions={[]}
      />
    </Card>
  )
}
