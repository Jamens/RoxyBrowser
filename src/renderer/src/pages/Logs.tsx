import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, Table, Input, Tag, Typography, Space, Switch, Dropdown, Button, message } from 'antd'
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api, getToken, API_BASE } from '../api'
import type { LogDTO } from '@shared/types'
import { countryTimezone } from '@shared/countries'
import { formatDateTimeInZone } from '@shared/timezone'
import { downloadText, nowStamp } from '../utils/download'
import { useI18n } from '../i18n'

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
  clone_template: 'geekblue',
  agent_start: 'purple',
  agent_done: 'green',
  agent_failed: 'red'
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
  clone_template: '套用模板',
  agent_start: 'AI 执行开始',
  agent_done: 'AI 执行完成',
  agent_failed: 'AI 执行失败',
  switch_team: '切换团队'
}

export default function Logs() {
  const { t } = useI18n()
  const [list, setList] = useState<LogDTO[]>([])
  const [keyword, setKeyword] = useState('')
  const [onlySensitive, setOnlySensitive] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null)

  // 导出当前筛选条件下的操作日志（CSV / JSON）。带 Bearer 头取回文件文本后本地下载，
  // 避免把令牌拼进 URL（防泄漏），文件名取自响应头的 Content-Disposition。
  const exportLogs = useCallback(
    async (format: 'csv' | 'json') => {
      try {
        setExporting(format)
        const params = new URLSearchParams()
        params.set('format', format)
        if (keyword) params.set('keyword', keyword)
        if (onlySensitive) params.set('sensitive', '1')
        const res = await fetch(`${API_BASE}/api/logs/export?${params.toString()}`, {
          headers: { Authorization: `Bearer ${getToken()}` }
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error((data as { message?: string }).message || `导出失败 (${res.status})`)
        }
        const text = await res.text()
        const cd = res.headers.get('Content-Disposition') || ''
        const m = cd.match(/filename="?([^";]+)"?/)
        const filename = m?.[1] || `operation-logs-${nowStamp()}.${format}`
        const mime = format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
        downloadText(text, filename, mime)
        message.success(t('logs.exported'))
      } catch (e) {
        message.error((e as Error).message || t('logs.exportFailed'))
      } finally {
        setExporting(null)
      }
    },
    [keyword, onlySensitive]
  )

  const exportMenu = useMemo(
    () => ({
      items: [
        { key: 'csv', label: t('logs.exportCsv') },
        { key: 'json', label: t('logs.exportJson') }
      ],
      onClick: ({ key }: { key: string }) => void exportLogs(key as 'csv' | 'json')
    }),
    [exportLogs]
  )

  const shown = useMemo(
    () => (onlySensitive ? list.filter((l) => l.sensitive) : list),
    [list, onlySensitive]
  )

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
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 200,
      // 数据库存的是 UTC，这里按用户所选国家（设置页）的本地时区展示，
      // 避免「我明明 19:42 操作，日志却显示 11:39」的错位。
      render: (v: string) => {
        const tz = countryTimezone(localStorage.getItem('roxy_country'))
        return (
          <Space direction="vertical" size={0}>
            <span>{formatDateTimeInZone(v, tz)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {tz}
            </Typography.Text>
          </Space>
        )
      }
    },
    { title: '操作人', dataIndex: 'username', width: 120 },
    {
      title: '操作',
      dataIndex: 'action',
      width: 130,
      render: (v, r) => (
        <Space size={4}>
          <Tag color={ACTION_COLORS[v] || 'default'}>{ACTION_LABELS[v] || v}</Tag>
          {r.sensitive && <Tag color="red">敏感</Tag>}
        </Space>
      )
    },
    { title: '详情', dataIndex: 'detail', ellipsis: true }
  ]

  return (
    <Card title="操作日志">
      <Typography.Paragraph type="secondary">
        团队空间内所有关键操作（创建 / 修改 / 删除 / 打开环境等）都会记录操作人身份与时间，便于多人共用工作区时的责任追溯与权限管理。
      </Typography.Paragraph>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索操作人 / 动作 / 详情"
          prefix={<SearchOutlined />}
          style={{ width: 280 }}
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Space size={6}>
          <Switch checked={onlySensitive} onChange={setOnlySensitive} />
          <Typography.Text>只看敏感操作</Typography.Text>
        </Space>
        <Dropdown menu={exportMenu} disabled={exporting !== null}>
          <Button icon={<DownloadOutlined />} loading={exporting !== null}>
            {t('logs.export')}
          </Button>
        </Dropdown>
      </Space>
      <Table rowKey="id" size="middle" columns={columns} dataSource={shown} pagination={{ pageSize: 15 }} />
    </Card>
  )
}
