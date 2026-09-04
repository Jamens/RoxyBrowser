import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Input, Tag, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'
import type { LogDTO } from '@shared/types'

const ACTION_COLORS: Record<string, string> = {
  create_profile: 'green',
  update_profile: 'blue',
  delete_profile: 'red',
  open_profile: 'cyan',
  close_profile: 'default',
  create_proxy: 'green',
  update_proxy: 'blue',
  delete_proxy: 'red',
  create_account: 'green',
  add_member: 'purple',
  create_token: 'orange',
  clone_template: 'geekblue'
}
const ACTION_LABELS: Record<string, string> = {
  create_profile: '创建环境',
  update_profile: '修改环境',
  delete_profile: '删除环境',
  open_profile: '打开环境',
  close_profile: '关闭环境',
  create_proxy: '添加代理',
  update_proxy: '修改代理',
  delete_proxy: '删除代理',
  create_account: '添加账号',
  add_member: '添加成员',
  update_member: '修改成员',
  remove_member: '移除成员',
  create_token: '创建令牌',
  clone_template: '套用模板'
}

export default function Logs() {
  const [list, setList] = useState<LogDTO[]>([])
  const [keyword, setKeyword] = useState('')

  const load = useCallback(async () => {
    try {
      setList(await api.get<LogDTO[]>(`/api/logs${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`))
    } catch {
      /* ignore */
    }
  }, [keyword])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  const columns: ColumnsType<LogDTO> = [
    { title: '时间', dataIndex: 'createdAt', width: 170, render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
    { title: '操作人', dataIndex: 'username', width: 120 },
    {
      title: '操作',
      dataIndex: 'action',
      width: 110,
      render: (v) => <Tag color={ACTION_COLORS[v] || 'default'}>{ACTION_LABELS[v] || v}</Tag>
    },
    { title: '详情', dataIndex: 'detail', ellipsis: true }
  ]

  return (
    <Card title="操作日志">
      <Typography.Paragraph type="secondary">
        团队空间内所有关键操作（创建 / 修改 / 删除 / 打开环境等）都会记录操作人身份与时间，便于多人共用工作区时的责任追溯与权限管理。
      </Typography.Paragraph>
      <Input
        placeholder="搜索操作人 / 动作 / 详情"
        prefix={<SearchOutlined />}
        style={{ width: 280, marginBottom: 16 }}
        allowClear
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      <Table rowKey="id" size="middle" columns={columns} dataSource={list} pagination={{ pageSize: 15 }} />
    </Card>
  )
}
