import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Card, Table, Button, Space, Select, Input, InputNumber, Switch, Tag, Modal, Form, Popconfirm, Typography, Descriptions, Empty, Tooltip
} from 'antd'
import {
  ReloadOutlined, VideoCameraOutlined, StopOutlined, CaretRightOutlined,
  EditOutlined, DeleteOutlined, EyeOutlined, MinusCircleOutlined, PlusOutlined,
  UploadOutlined, DownloadOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api, API_BASE, getToken } from '../api'
import type { ProfileDTO, RpaScriptDTO, RpaStep } from '@shared/types'
import { varsToArray, arrayToVars } from '@shared/rpa'
import { useAppCtx } from '../hooks/useApp'
import { countryTimezone } from '@shared/countries'
import { formatDateTimeInZone } from '@shared/timezone'

/** 步骤可读化描述 */
function stepText(s: RpaStep): string {
  switch (s.type) {
    case 'navigate':
      return `打开 ${s.url}`
    case 'click':
      return `点击 ${s.sel || `(相对位置 ${Math.round(s.rx * 100)}%, ${Math.round(s.ry * 100)}%)`}`
    case 'input':
      return `输入「${s.value.length > 24 ? s.value.slice(0, 24) + '…' : s.value}」→ ${s.sel}`
    case 'change':
      return `选择「${s.value}」→ ${s.sel}`
    case 'scroll':
      return `滚动到 (${s.x}, ${s.y})`
    case 'wait':
      return `等待 ${s.ms}ms`
    default:
      return JSON.stringify(s)
  }
}

export default function Rpa() {
  const { message } = useAppCtx()
  const [scripts, setScripts] = useState<RpaScriptDTO[]>([])
  const [profiles, setProfiles] = useState<ProfileDTO[]>([])
  const [loading, setLoading] = useState(false)

  // 录制
  const [recProfileId, setRecProfileId] = useState<number | undefined>()
  const [recording, setRecording] = useState(false)
  const [recCount, setRecCount] = useState(0)
  const [saveOpen, setSaveOpen] = useState(false)
  const [pendingSteps, setPendingSteps] = useState<RpaStep[]>([])
  const [saveForm] = Form.useForm()

  // 回放
  const [runScript, setRunScript] = useState<RpaScriptDTO | null>(null)
  const [runProfileId, setRunProfileId] = useState<number | undefined>()
  // 回放时传入的变量覆盖值（编辑弹窗里配的默认值可在这里改）
  const [runVars, setRunVars] = useState<Record<string, string>>({})
  // 导入文件用的隐藏 input
  const importInputRef = useRef<HTMLInputElement | null>(null)

  // 查看
  const [viewScript, setViewScript] = useState<RpaScriptDTO | null>(null)

  // 编辑名称/备注
  const [editScript, setEditScript] = useState<RpaScriptDTO | null>(null)
  const [editForm] = Form.useForm()

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, p] = await Promise.all([api.get<RpaScriptDTO[]>('/api/rpa'), api.get<ProfileDTO[]>('/api/profiles')])
      setScripts(s)
      setProfiles(p.filter((x) => x.status !== undefined))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 录制期间轮询环境列表（了解运行状态），并实时拉取已录制步骤数，
  // 让用户明确看到「操作正在被记录」，避免录完不知道脚本去哪了。
  useEffect(() => {
    if (!recording) return
    setRecCount(0)
    const timer = setInterval(async () => {
      try {
        const p = await api.get<ProfileDTO[]>('/api/profiles')
        setProfiles(p)
      } catch {
        /* ignore */
      }
      try {
        const st = await api.get<{ recording: boolean; count: number }>(
          `/api/rpa/record/status?profileId=${recProfileId}`
        )
        setRecCount(st.count)
      } catch {
        /* ignore */
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [recording, recProfileId])

  const startRecord = async () => {
    if (!recProfileId) return message.warning('请选择要录制的环境')
    try {
      await api.post('/api/rpa/record/start', { profileId: recProfileId })
      setRecording(true)
      message.success('录制已开始：在环境窗口中正常操作，点击/输入/滚动/页面跳转都会被记录')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const stopRecord = async () => {
    if (!recProfileId) return
    try {
      const res = await api.post<{ steps: RpaStep[] }>('/api/rpa/record/stop', { profileId: recProfileId })
      setRecording(false)
      if (!res.steps.length) {
        message.warning('未录到任何操作步骤（仅页面跳转 / 空操作会被丢弃）')
        return
      }
      setPendingSteps(res.steps)
      saveForm.resetFields()
      setSaveOpen(true)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveScript = async () => {
    const values = await saveForm.validateFields()
    try {
      await api.post('/api/rpa', { name: values.name, remark: values.remark || '', steps: pendingSteps })
      message.success(`脚本已保存（${pendingSteps.length} 步）`)
      setSaveOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const run = async () => {
    if (!runScript || !runProfileId) return message.warning('请选择回放的环境')
    try {
      const payload: Record<string, unknown> = { profileId: runProfileId }
      if (Object.keys(runVars).length) payload.variables = runVars
      const res = await api.post<{ started: boolean; steps: number }>(`/api/rpa/${runScript.id}/run`, payload)
      message.success(`开始回放「${runScript.name}」（${res.steps} 步），执行结果见操作日志`)
      setRunScript(null)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 导出单个脚本为 JSON 文件（走 blob 下载，绕过 api 的 JSON 解析）
  const exportScript = async (r: RpaScriptDTO) => {
    try {
      const res = await fetch(`${API_BASE}/api/rpa/export/${r.id}`, {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {}
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        return message.error((d as { message?: string }).message || '导出失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `rpa-${r.id}-${r.name}.json`
      a.click()
      URL.revokeObjectURL(url)
      message.success(`已导出「${r.name}」`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 从文件导入脚本（读取 JSON 后 POST /api/rpa/import）
  const importScript = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const res = await api.post<{ ok: boolean; created: number[] }>('/api/rpa/import', parsed)
      if (res.created?.length) {
        message.success(`已导入 ${res.created.length} 个脚本`)
        load()
      } else {
        message.warning('文件中没有可导入的脚本')
      }
    } catch (e) {
      message.error((e as Error).message || '导入失败：文件格式不正确')
    }
  }

  const remove = async (id: number) => {
    try {
      await api.del(`/api/rpa/${id}`)
      message.success('已删除')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveEdit = async () => {
    if (!editScript) return
    const values = await editForm.validateFields()
    try {
      await api.put(`/api/rpa/${editScript.id}`, {
        name: values.name,
        remark: values.remark || '',
        variables: arrayToVars(values.variables),
        scheduleEnabled: !!values.scheduleEnabled,
        scheduleIntervalMin: values.scheduleIntervalMin ?? 30,
        scheduleProfileId: values.scheduleProfileId ?? null
      })
      message.success('已更新')
      setEditScript(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<RpaScriptDTO> = [
    { title: '脚本名称', dataIndex: 'name', width: 200, render: (v, r) => (<Space><span style={{ fontWeight: 600 }}>{v}</span><Tag>{r.steps.length} 步</Tag></Space>) },
    { title: '备注', dataIndex: 'remark', width: 200, ellipsis: true, render: (v) => v || <Typography.Text type="secondary">-</Typography.Text> },
    {
      title: '步骤摘要',
      dataIndex: 'steps',
      width: 300,
      render: (steps: RpaStep[]) => {
        const kinds = [...new Set(steps.map((s) => s.type))]
        const label: Record<string, string> = {
          navigate: '跳转', click: '点击', input: '输入', change: '选择', scroll: '滚动', wait: '等待'
        }
        return (
          <Space size={4} wrap>
            {kinds.map((k) => (
              <Tag key={k} color={k === 'navigate' ? 'geekblue' : k === 'input' ? 'purple' : 'default'}>
                {label[k] || k} ×{steps.filter((s) => s.type === k).length}
              </Tag>
            ))}
          </Space>
        )
      }
    },
    { title: '更新时间', dataIndex: 'updatedAt', width: 160, render: (v) => formatDateTimeInZone(v, countryTimezone(localStorage.getItem('roxy_country')), false) },
    {
      title: '定时',
      width: 160,
      render: (_, r) =>
        r.scheduleEnabled ? (
          <Space direction="vertical" size={0}>
            <Tag color="green">已开启</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              每 {r.scheduleIntervalMin} 分钟 · {profiles.find((p) => p.id === r.scheduleProfileId)?.name ?? '-'}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        )
    },
    {
      title: '操作',
      width: 240,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="primary" ghost icon={<CaretRightOutlined />} onClick={() => { setRunScript(r); setRunProfileId(undefined); setRunVars(r.variables || {}) }}>
            回放
          </Button>
          <Tooltip title="查看步骤明细">
            <Button size="small" icon={<EyeOutlined />} onClick={() => setViewScript(r)} />
          </Tooltip>
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditScript(r); editForm.setFieldsValue({ name: r.name, remark: r.remark, scheduleEnabled: !!r.scheduleEnabled, scheduleIntervalMin: r.scheduleIntervalMin ?? 30, scheduleProfileId: r.scheduleProfileId ?? undefined, variables: varsToArray(r.variables || {}) }) }} />
          <Tooltip title="导出脚本 JSON">
            <Button size="small" icon={<DownloadOutlined />} onClick={() => exportScript(r)} />
          </Tooltip>
          <Popconfirm title="确定删除该脚本？" onConfirm={() => remove(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  // 回放弹窗变量覆盖：提取为 const 避免 TS 在 .map 闭包里丢失 null 收窄
  const runScriptVars = runScript?.variables || {}
  const runScriptVarKeys = Object.keys(runScriptVars)

  return (
    <div>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) importScript(f)
          e.target.value = ''
        }}
      />
      <Card
        title="RPA 脚本 — 录制与回放"
        extra={
          <Space>
            <Button icon={<UploadOutlined />} onClick={() => importInputRef.current?.click()}>
              导入
            </Button>
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Space style={{ marginBottom: 16 }} wrap>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择要录制的环境（需已打开）"
            style={{ minWidth: 260 }}
            value={recProfileId}
            onChange={setRecProfileId}
            disabled={recording}
            options={profiles.map((p) => ({
              value: p.id,
              label: `${p.name}${p.status === 'running' ? '（运行中）' : ''}`
            }))}
          />
          {recording ? (
            <Button danger icon={<StopOutlined />} onClick={stopRecord}>
              停止录制
            </Button>
          ) : (
            <Button type="primary" icon={<VideoCameraOutlined />} onClick={startRecord}>
              开始录制
            </Button>
          )}
          {recording && <Tag color="red" icon={<VideoCameraOutlined />}>录制中…（点击 / 输入 / 滚动 / 跳转均在记录）</Tag>}
          {recording && <Tag color="gold">已录制 {recCount} 步</Tag>}
        </Space>

        <Table
          rowKey="id"
          size="middle"
          scroll={{ x: 1260 }}
          loading={loading}
          columns={columns}
          dataSource={scripts}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个脚本` }}
          locale={{ emptyText: <Empty description="暂无脚本 — 选择一个环境点击「开始录制」，把重复操作固化成脚本" /> }}
        />
      </Card>

      {/* 保存录制 */}
      <Modal
        title="保存录制脚本"
        open={saveOpen}
        onOk={saveScript}
        onCancel={() => setSaveOpen(false)}
        okText="保存"
        width={520}
      >
        <Form form={saveForm} layout="vertical">
          <Form.Item name="name" label="脚本名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：每日登录签到" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input placeholder="可选" />
          </Form.Item>
          <Typography.Text type="secondary">共 {pendingSteps.length} 步：</Typography.Text>
          <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 8, background: 'var(--ant-color-fill-quaternary, #fafafa)', padding: 8, borderRadius: 6 }}>
            {pendingSteps.map((s, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: '20px' }}>
                {i + 1}. {stepText(s)}
              </div>
            ))}
          </div>
        </Form>
      </Modal>

      {/* 回放 */}
      <Modal
        title={`回放「${runScript?.name ?? ''}」`}
        open={!!runScript}
        onOk={run}
        onCancel={() => setRunScript(null)}
        okText="开始回放"
        width={520}
      >
        <Descriptions column={1} size="small" style={{ marginBottom: 12 }}>
          <Descriptions.Item label="步骤数">{runScript?.steps.length}</Descriptions.Item>
        </Descriptions>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择回放的环境（需已打开）"
          style={{ width: '100%' }}
          value={runProfileId}
          onChange={setRunProfileId}
          options={profiles.map((p) => ({
            value: p.id,
            label: `${p.name}${p.status === 'running' ? '（运行中）' : ''}`
          }))}
        />
        {runScriptVarKeys.length ? (
          <div style={{ marginTop: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              变量覆盖（留空则用脚本默认值）
            </Typography.Text>
            {runScriptVarKeys.map((k) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <Typography.Text style={{ width: 120, fontSize: 12 }} ellipsis>
                  {`{{${k}}}`}
                </Typography.Text>
                <Input
                  style={{ flex: 1 }}
                  placeholder={runScriptVars[k]}
                  value={runVars[k] ?? ''}
                  onChange={(e) => setRunVars((v) => ({ ...v, [k]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
          回放在后台执行（每步间隔约 1 秒），结果会写入操作日志；回放期间请勿操作该窗口。
        </Typography.Paragraph>
      </Modal>

      {/* 查看步骤 */}
      <Modal
        title={`步骤明细 — ${viewScript?.name ?? ''}`}
        open={!!viewScript}
        footer={null}
        onCancel={() => setViewScript(null)}
        width={640}
      >
        {viewScript?.steps.map((s, i) => (
          <div key={i} style={{ fontSize: 12, lineHeight: '22px' }}>
            <Tag color={s.type === 'navigate' ? 'geekblue' : undefined}>{i + 1}</Tag>
            {stepText(s)}
          </div>
        ))}
      </Modal>

      {/* 编辑 */}
      <Modal
        title="编辑脚本信息"
        open={!!editScript}
        onOk={saveEdit}
        onCancel={() => setEditScript(null)}
        okText="保存"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="脚本名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
          <Form.List name="variables">
            {(_fields, { add, remove }) => (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  变量：步骤里用 <Typography.Text code>{'{{变量名}}'}</Typography.Text> 引用，回放时替换为对应值（账号密码等可参数化复用）
                </Typography.Text>
                {_fields.map(({ key, name, ...rest }) => (
                  <Space key={key} align="baseline" style={{ display: 'flex', marginTop: 8 }}>
                    <Form.Item {...rest} name={[name, 'key']} rules={[{ required: true, message: '变量名' }]} style={{ marginBottom: 0 }}>
                      <Input placeholder="变量名" />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'value']} style={{ marginBottom: 0 }}>
                      <Input placeholder="值" />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(name)} />
                  </Space>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()} style={{ marginTop: 8 }}>
                  添加变量
                </Button>
              </div>
            )}
          </Form.List>
          <Form.Item
            name="scheduleEnabled"
            label="定时执行"
            valuePropName="checked"
            tooltip="开启后，调度器每隔设定分钟，在目标环境处于运行态时自动回放本脚本；环境未运行则跳过本轮并写日志"
          >
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.scheduleEnabled !== cur.scheduleEnabled}>
            {({ getFieldValue }) =>
              getFieldValue('scheduleEnabled') ? (
                <Space direction="vertical" style={{ display: 'flex' }}>
                  <Form.Item name="scheduleIntervalMin" label="执行间隔（分钟）" rules={[{ required: true, message: '请输入执行间隔' }]}>
                    <InputNumber min={1} max={525600} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="scheduleProfileId" label="目标环境" rules={[{ required: true, message: '请选择目标环境' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="选择执行环境（需处于运行态才会执行）"
                      style={{ width: '100%' }}
                      options={profiles.map((p) => ({ value: p.id, label: `${p.name}${p.status === 'running' ? '（运行中）' : ''}` }))}
                    />
                  </Form.Item>
                </Space>
              ) : null
            }
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
