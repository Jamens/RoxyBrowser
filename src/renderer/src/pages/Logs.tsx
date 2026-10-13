import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Card, Table, Input, Tag, Typography, Space, Switch, Dropdown, Button, message, Tabs, Alert,
  Statistic, Row, Col, Popconfirm, Select, Checkbox
} from 'antd'
import type { ArchivedLogDTO, ArchiveStatsDTO, ArchiveOutcomeDTO } from '@shared/types'
import { SearchOutlined, DownloadOutlined, ExperimentOutlined, RollbackOutlined } from '@ant-design/icons'
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
  agent_failed: 'red',
  // 自动化 API（v1）令牌调用：由 v1 审计中间件统一记录
  api_create_profile: 'green',
  api_update_profile: 'blue',
  api_delete_profile: 'red',
  api_open_profile: 'cyan',
  api_close_profile: 'default',
  api_create_proxy: 'green',
  api_update_proxy: 'blue',
  api_delete_proxy: 'red',
  api_allocate_proxy: 'geekblue',
  api_check_proxy: 'default',
  api_create_account: 'green',
  api_update_account: 'blue',
  api_delete_account: 'red',
  api_create_cookie: 'green',
  api_update_cookie: 'blue',
  api_delete_cookie: 'red',
  api_import_cookie: 'orange',
  api_export_cookie: 'orange',
  api_apply_cookie: 'default',
  api_run_rpa: 'purple',
  api_random_fingerprint: 'default'
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
  switch_team: '切换团队',
  transfer_profile: '转移环境',
  screenshot_profile: '环境截图',
  // 自动化 API（v1）令牌调用；操作人显示为 api:<令牌名>
  api_create_profile: 'API 创建环境',
  api_update_profile: 'API 修改环境',
  api_delete_profile: 'API 删除环境',
  api_open_profile: 'API 打开环境',
  api_close_profile: 'API 关闭环境',
  api_create_proxy: 'API 添加代理',
  api_update_proxy: 'API 修改代理',
  api_delete_proxy: 'API 删除代理',
  api_allocate_proxy: 'API 分配代理',
  api_check_proxy: 'API 检测代理',
  api_create_account: 'API 添加账号',
  api_update_account: 'API 修改账号',
  api_delete_account: 'API 删除账号',
  api_create_cookie: 'API 新增 Cookie',
  api_update_cookie: 'API 修改 Cookie',
  api_delete_cookie: 'API 删除 Cookie',
  api_import_cookie: 'API 导入 Cookie',
  api_export_cookie: 'API 导出 Cookie',
  api_apply_cookie: 'API 应用 Cookie',
  api_run_rpa: 'API 运行 RPA',
  api_random_fingerprint: 'API 生成指纹'
}

export default function Logs() {
  const { t } = useI18n()
  const [list, setList] = useState<LogDTO[]>([])
  const [keyword, setKeyword] = useState('')
  const [onlySensitive, setOnlySensitive] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null)
  // 归档概览：用于 Tab 标签上的条数与「近 N 天」文案
  const [retentionDays, setRetentionDays] = useState(90)
  const [archiveCount, setArchiveCount] = useState(0)

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

  // 归档概览单独取：与日志列表不同的接口，轮询频率可低得多
  const loadStats = useCallback(async () => {
    try {
      const s = await api.get<ArchiveStatsDTO>('/api/logs/archive/stats')
      setRetentionDays(s.retentionDays)
      setArchiveCount(s.archiveCount)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    load()
    loadStats()
    const t = setInterval(load, 10000)
    const t2 = setInterval(loadStats, 60000)
    return () => {
      clearInterval(t)
      clearInterval(t2)
    }
  }, [load, loadStats])

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
          {/* 必须用 !! 转成布尔再判断：`sensitive` 是 MySQL tinyint，取回是数字
              0/1，而 `0 && <Tag/>` 的结果是数字 0 本身（不是 false）——React 会把它
              当合法 child 渲染成文本「0」，于是每个非敏感操作的标签右边都多个 0。 */}
          {!!r.sensitive && <Tag color="red">敏感</Tag>}
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
      <Tabs
        defaultActiveKey="hot"
        items={[
          {
            key: 'hot',
            label: `近 ${retentionDays} 天（${list.length}）`,
            children: (
              <>
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
              </>
            )
          },
          { key: 'archive', label: `归档区（${archiveCount}）`, children: <ArchivePanel onReverted={load} /> }
        ]}
      />
    </Card>
  )
}

/**
 * 归档区面板：查看已归档的整月日志、手动触发归档、按批次撤销。
 *
 * 设计取向：**默认安全**。手动归档的按钮是「试运行」，要真执行必须二次确认并
 * 明确勾选——归档虽非删除，但搬走数据会影响热区列表与导出，用户容易误点。
 */
function ArchivePanel({ onReverted }: { onReverted: () => void }) {
  const [stats, setStats] = useState<ArchiveStatsDTO | null>(null)
  const [rows, setRows] = useState<ArchivedLogDTO[]>([])
  const [months, setMonths] = useState<string[]>([])
  const [month, setMonth] = useState<string | undefined>()
  const [batchId, setBatchId] = useState<string | undefined>()
  const [running, setRunning] = useState(false)
  const [confirmReal, setConfirmReal] = useState(false)

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (month) qs.set('month', month)
      if (batchId) qs.set('batchId', batchId)
      qs.set('limit', '500')
      const [s, list] = await Promise.all([
        api.get<ArchiveStatsDTO>('/api/logs/archive/stats'),
        api.get<ArchivedLogDTO[]>(`/api/logs/archive?${qs.toString()}`)
      ])
      setStats(s)
      setRows(list)
      // 月份下拉来自实际返回的数据，避免给出无记录的月份选项
      const seen = new Set<string>()
      for (const r of list) if (r.month) seen.add(r.month)
      setMonths([...seen].sort().reverse())
      if (month && !seen.has(month)) setMonth(undefined)
    } catch {
      /* ignore */
    }
  }, [month, batchId])

  useEffect(() => {
    load()
  }, [load])

  /** 执行归档：dryRun=true 先看范围，确认无误后再真跑 */
  const runArchive = useCallback(
    async (dryRun: boolean) => {
      setRunning(true)
      try {
        const r = await api.post<ArchiveOutcomeDTO>('/api/logs/archive/run', { dryRun })
        if (dryRun) {
          message.info(r.reason)
        } else if (r.moved > 0) {
          message.success(r.reason)
          setConfirmReal(false)
        } else {
          message.info(r.reason)
        }
        await load()
      } catch (e) {
        message.error(`归档失败：${(e as Error).message}`)
      } finally {
        setRunning(false)
      }
    },
    [load]
  )

  const revert = useCallback(
    async (bid: string) => {
      try {
        const r = await api.post<{ reverted: number }>('/api/logs/archive/revert', { batchId: bid })
        message.success(`已退回 ${r.reverted} 条到热区`)
        setBatchId(undefined)
        await load()
        onReverted()
      } catch (e) {
        message.error(`撤销失败：${(e as Error).message}`)
      }
    },
    [load, onReverted]
  )

  const cols: ColumnsType<ArchivedLogDTO> = [
    { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => v.replace('T', ' ').slice(0, 19) },
    { title: '操作人', dataIndex: 'username', width: 110 },
    {
      title: '操作',
      dataIndex: 'action',
      width: 130,
      // 与热区保持一致：sensitive 是 tinyint 数字，必须 !! 转布尔，否则渲染出「0」
      render: (v: string, r: ArchivedLogDTO) => (
        <Space size={4}>
          <Tag color={ACTION_COLORS[v] || 'default'}>{ACTION_LABELS[v] || v}</Tag>
          {!!r.sensitive && <Tag color="red">敏感</Tag>}
        </Space>
      )
    },
    { title: '详情', dataIndex: 'detail', ellipsis: true },
    {
      title: '所属月份',
      dataIndex: 'month',
      width: 100,
      render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text>
    }
  ]

  const batches = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of rows) if (r.batchId) seen.set(r.batchId, (seen.get(r.batchId) || 0) + 1)
    return [...seen.entries()].map(([bid, count]) => ({ bid, count }))
  }, [rows])

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={
          <>
            超过保留期（当前 {stats?.retentionDays ?? 90} 天）的日志会按<b>自然月</b>整月搬入归档区，<b>不会删除</b>。
            归档每天凌晨 3:10 自动执行，也可在此手动触发。
          </>
        }
      />
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Statistic title="热区（近期）" value={stats?.hotCount ?? 0} />
        </Col>
        <Col span={6}>
          <Statistic title="归档区" value={stats?.archiveCount ?? 0} />
        </Col>
        <Col span={6}>
          <Statistic title="最老的热区记录" value={stats?.oldestHot ? stats.oldestHot.slice(0, 10) : '—'} valueStyle={{ fontSize: 18 }} />
        </Col>
        <Col span={6}>
          <Statistic title="最老的归档记录" value={stats?.oldestArchive ? stats.oldestArchive.slice(0, 10) : '—'} valueStyle={{ fontSize: 18 }} />
        </Col>
      </Row>

      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ExperimentOutlined />} loading={running} onClick={() => runArchive(true)}>
          试运行（看归档范围）
        </Button>
        <Popconfirm
          title="确认执行归档？"
          description="会把过期的整月日志搬入归档区。数据不会删除，但会移出热区列表。"
          okText="执行"
          cancelText="取消"
          onConfirm={() => runArchive(false)}
          disabled={!confirmReal}
        >
          <Button danger type="primary" loading={running} disabled={!confirmReal}>
            执行归档
          </Button>
        </Popconfirm>
        <Checkbox checked={confirmReal} onChange={(e) => setConfirmReal(e.target.checked)}>
          我已确认范围无误
        </Checkbox>
        <Select
          allowClear
          placeholder="按月份筛选"
          style={{ width: 130 }}
          value={month}
          onChange={setMonth}
          options={months.map((m) => ({ value: m, label: m }))}
        />
        <Select
          allowClear
          placeholder="按批次筛选"
          style={{ width: 220 }}
          value={batchId}
          onChange={setBatchId}
          options={batches.map((b) => ({ value: b.bid, label: `${b.bid}（${b.count} 条）` }))}
        />
        {batchId && (
          <Popconfirm
            title="撤销该批次归档？"
            description="归档记录会被退回热区列表。"
            okText="撤销"
            cancelText="取消"
            onConfirm={() => revert(batchId)}
          >
            <Button icon={<RollbackOutlined />}>撤销当前批次</Button>
          </Popconfirm>
        )}
      </Space>

      <Table
        rowKey="id"
        size="middle"
        columns={cols}
        dataSource={rows}
        loading={false}
        pagination={{ pageSize: 15 }}
        locale={{ emptyText: '归档区暂无记录（超过保留期的日志会自动搬入这里）' }}
      />
    </div>
  )
}
