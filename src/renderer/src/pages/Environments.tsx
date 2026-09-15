import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Card, Table, Button, Input, InputNumber, Select, Space, Tag, Tooltip, Switch, Typography, Popconfirm, Modal, Form, Upload, Drawer, Empty, Progress
} from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { useI18n } from '../i18n'
import {
  PlusOutlined, ReloadOutlined, SearchOutlined, PlayCircleOutlined, PoweroffOutlined,
  EditOutlined, DeleteOutlined, CopyOutlined, FolderAddOutlined, MoreOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ImportOutlined, ExportOutlined, ThunderboltOutlined, SwapOutlined, RestOutlined, UndoOutlined, ApiOutlined,
  SafetyCertificateOutlined, ShareAltOutlined
} from '@ant-design/icons'
import type { HealthReport } from '@shared/healthcheck'
import { downloadText, readTextFile, nowStamp } from '../utils/download'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'
import ProfileForm from '../components/ProfileForm'
import type { ProfileDTO, GroupDTO, ProxyDTO, ExtensionDTO } from '@shared/types'
import { osLabel } from '@shared/types'

// 体检项中文标签（后端只回 key 与「设定值/实测值」，展示名放前端）
const HEALTH_LABELS: Record<string, string> = {
  userAgent: 'User Agent',
  platform: '平台 Platform',
  languages: '语言 Languages',
  screen: '屏幕分辨率',
  timezone: '时区 Timezone',
  tzOffset: '时区偏移 UTC',
  webgl: 'WebGL 显卡',
  uaData: 'UA-CH（userAgentData）',
  hardwareConcurrency: 'CPU 核心数',
  deviceMemory: '内存 deviceMemory',
  doNotTrack: 'Do Not Track',
  touch: '触摸能力',
  canvasNoise: 'Canvas 噪声',
  audioNoise: 'Audio 噪声',
  webrtc: 'WebRTC',
  fonts: '字体防泄漏'
}

// 一致性红绿灯：四件套是否自洽（不自洽是关联高危信号）
const CONSISTENCY_LABELS: Record<string, string> = {
  tzVsProxy: '时区 ↔ 代理出口国家',
  langVsTz: '语言 ↔ 时区国家',
  uaVsOs: 'UA 平台 ↔ 设定系统'
}

/** 伪装度配色：≥90 绿 / ≥70 黄 / 其余红 */
const scoreColor = (s: number) => (s >= 90 ? '#52c41a' : s >= 70 ? '#faad14' : '#ff4d4f')

export default function Environments() {
  const { message } = useAppCtx()
  const { t } = useI18n()
  const [list, setList] = useState<ProfileDTO[]>([])
  const [groups, setGroups] = useState<GroupDTO[]>([])
  const [proxies, setProxies] = useState<ProxyDTO[]>([])
  const [extensions, setExtensions] = useState<ExtensionDTO[]>([])
  const [keyword, setKeyword] = useState('')
  const [groupId, setGroupId] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [batchGroup, setBatchGroup] = useState<number | undefined>()
  const [batchProxy, setBatchProxy] = useState<number | undefined>()
  const [syncMode, setSyncMode] = useState(false)
  const [windows, setWindows] = useState<{ id: number; title: string }[]>([])
  const [syncIds, setSyncIds] = useState<number[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [editing, setEditing] = useState<ProfileDTO | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [groupForm] = Form.useForm()
  const [quickCreating, setQuickCreating] = useState(false)
  // 环境体检报告
  const [healthOpen, setHealthOpen] = useState(false)
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthName, setHealthName] = useState('')
  // 环境克隆工厂（以某环境为母本批量派生，指纹微抖动）
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneSrc, setCloneSrc] = useState<ProfileDTO | null>(null)
  const [cloneCount, setCloneCount] = useState(5)
  const [cloneName, setCloneName] = useState('')
  const [cloneAccounts, setCloneAccounts] = useState(false)
  const [cloneLoading, setCloneLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 环境转移到其他团队（跨团队分享）：把环境及其 Cookie / 账号归属改写到目标团队。
  // 操作人必须同时是两团队的成员，可复用团队切换器打通的 /api/auth/teams 接口拉取可选目标。
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferSrc, setTransferSrc] = useState<ProfileDTO | null>(null)
  const [transferTarget, setTransferTarget] = useState<number | undefined>()
  const [transferTeams, setTransferTeams] = useState<{ id: number; name: string }[]>([])
  const [transferLoading, setTransferLoading] = useState(false)

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

  // 环境克隆工厂：以某个环境为母本批量派生 N 个副本。
  // 副本继承「行为一致」的字段（系统 / UA / 语言 / 时区），抖动「指纹各异」的字段
  // （分辨率 / CPU / 内存 / 显卡 / 字体），避免批量号共用同一套设备特征被一锅端。
  const openClone = () => {
    if (selected.length !== 1) {
      message.warning('请先勾选 1 个作为母本的环境')
      return
    }
    const p = list.find((x) => x.id === selected[0])
    if (!p) return
    setCloneSrc(p)
    setCloneName(p.name)
    setCloneCount(5)
    setCloneAccounts(false)
    setCloneOpen(true)
  }

  const submitClone = async () => {
    if (!cloneSrc) return
    setCloneLoading(true)
    try {
      const res = await api.post<{ created: number }>(`/api/profiles/${cloneSrc.id}/duplicate-batch`, {
        count: cloneCount,
        namePrefix: cloneName,
        copyAccounts: cloneAccounts
      })
      message.success(`已克隆 ${res.created} 个环境（指纹已微抖动）`)
      setCloneOpen(false)
      setSelected([])
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCloneLoading(false)
    }
  }

  // 环境体检：把「设定指纹」与「窗口内实测回读值」对撞，输出伪装度分与一致性红绿灯。
  // 必须在窗口运行时执行——注入是否真的生效，只有在真实页面上下文里才读得准。
  const runHealthCheck = async (r: ProfileDTO) => {
    if (r.status !== 'running') {
      message.warning('请先打开该环境窗口，再执行体检')
      return
    }
    setHealthName(r.name)
    setHealthReport(null)
    setHealthLoading(true)
    setHealthOpen(true)
    try {
      setHealthReport(await api.post<HealthReport>(`/api/profiles/${r.id}/healthcheck`, {}))
    } catch (e) {
      message.error((e as Error).message)
      setHealthOpen(false)
    } finally {
      setHealthLoading(false)
    }
  }

  // 手动切换线路（对标官方）：从 IP 池换一条「不同的」可用代理，旧线路自动释放回池
  const switchLine = async (r: ProfileDTO) => {
    try {
      const res = await api.post<{ proxy: { name: string }; running: boolean }>(`/api/profiles/${r.id}/switch-line`, {})
      if (res.running) {
        message.warning(`已切换到新线路「${res.proxy.name}」；环境运行中，重启后生效`)
      } else {
        message.success(`已切换到新线路「${res.proxy.name}」`)
      }
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

  const quickCreate = async () => {
    try {
      setQuickCreating(true)
      const p = await api.post<ProfileDTO>('/api/profiles/quick-create', {})
      message.success(`已快速创建「${p.name}」，正在打开窗口…`)
      await api.post(`/api/profiles/${p.id}/open`)
      message.success('窗口已打开')
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setQuickCreating(false)
    }
  }

  const remove = async (id: number) => {
    try {
      await api.del(`/api/profiles/${id}`)
      message.success('已移入回收站（可恢复）')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // ===== 回收站（软删除恢复 / 彻底删除）=====
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashList, setTrashList] = useState<{ id: number; name: string; seq: number; platform: string; deletedAt: string }[]>([])
  const [trashLoading, setTrashLoading] = useState(false)

  const loadTrash = useCallback(async () => {
    setTrashLoading(true)
    try {
      setTrashList(await api.get('/api/profiles/trash'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTrashLoading(false)
    }
  }, [])

  const openTrash = () => {
    setTrashOpen(true)
    loadTrash()
  }

  const restore = async (id: number) => {
    try {
      await api.post(`/api/profiles/${id}/restore`)
      message.success('已恢复')
      loadTrash()
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const purge = async (id: number) => {
    try {
      await api.del(`/api/profiles/${id}/purge`)
      message.success('已彻底删除')
      loadTrash()
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
      // 兼容三种形态：数组、{ items: [...] } 批量、整环境单对象导出（含 name 字段）
      const single = parsed && !Array.isArray(parsed) && !parsed.items && parsed.name
      const body = single ? parsed : { items: Array.isArray(parsed) ? parsed : parsed.items }
      const res = await api.post<{ created: number }>('/api/profiles/import', body)
      message.success(`成功导入 ${res.created} 个环境`)
      setImportOpen(false)
      setImportText('')
      load()
    } catch (e) {
      message.error(`导入失败：${(e as Error).message}`)
    }
  }

  /** 整环境迁移：导出单个环境为文件（含指纹 / 分组 / 代理 / 账号 / Cookie / 扩展名） */
  const exportProfile = async (id: number, name: string) => {
    try {
      const data = await api.get<unknown>(`/api/profiles/export/${id}`)
      const safe = (name || `profile-${id}`).replace(/[\\/:*?"<>|]/g, '_')
      downloadText(JSON.stringify(data, null, 2), `roxy-profile-${safe}.json`)
      message.success(`已导出「${name}」整环境配置`)
    } catch (e) {
      message.error((e as Error).message)
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

  // 批量移动分组
  const batchMoveGroup = async () => {
    if (batchGroup === undefined) {
      message.warning('请选择目标分组')
      return
    }
    try {
      const res = await api.post<{ updated: number }>('/api/profiles/batch', {
        ids: selected.map(Number),
        action: 'moveGroup',
        groupId: batchGroup
      })
      message.success(`已移动 ${res.updated} 个环境到分组`)
      setSelected([])
      setBatchGroup(undefined)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 批量绑定代理
  const batchBindProxy = async () => {
    if (batchProxy === undefined) {
      message.warning('请选择目标代理')
      return
    }
    try {
      const res = await api.post<{ updated: number }>('/api/profiles/batch', {
        ids: selected.map(Number),
        action: 'bindProxy',
        proxyId: batchProxy
      })
      message.success(`已为 ${res.updated} 个环境绑定代理（运行中的已跳过）`)
      setSelected([])
      setBatchProxy(undefined)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 批量删除（进回收站，可恢复）
  const batchDelete = async () => {
    try {
      const res = await api.post<{ updated: number }>('/api/profiles/batch', {
        ids: selected.map(Number),
        action: 'delete'
      })
      message.success(`已移入回收站 ${res.updated} 个环境（可恢复）`)
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

  // 打开转移弹窗：拉取「我所属的团队」并排除当前团队作为目标候选
  const openTransfer = async (r: ProfileDTO) => {
    try {
      const teams = await api.get<{ id: number; name: string; isCurrent: boolean }[]>('/api/auth/teams')
      const candidates = teams.filter((tm) => !tm.isCurrent)
      if (!candidates.length) {
        message.info(t('env.noOtherTeam'))
        return
      }
      setTransferSrc(r)
      setTransferTeams(candidates)
      setTransferTarget(undefined)
      setTransferOpen(true)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const submitTransfer = async () => {
    if (!transferSrc || transferTarget === undefined) return
    setTransferLoading(true)
    try {
      const target = transferTeams.find((tm) => tm.id === transferTarget)
      await api.post(`/api/profiles/${transferSrc.id}/transfer`, { teamId: transferTarget })
      message.success(t('env.transferred', { team: target?.name || transferTarget }))
      setTransferOpen(false)
      setTransferSrc(null)
      setTransferTarget(undefined)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTransferLoading(false)
    }
  }

  const columns: ColumnsType<ProfileDTO> = [
    { title: '序号', dataIndex: 'seq', width: 70 },
    {
      title: '环境名称',
      dataIndex: 'name',
      width: 180,
      render: (_, r) => (
        <Space>
          <span
            style={{ fontWeight: 600, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={r.name}
          >
            {r.name}
          </span>
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
            <Tag>{osLabel(fp.os)}</Tag>
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
      width: 160,
      render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-')
    },
    {
      title: '操作',
      width: 276,
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
          <Popconfirm
            title="切换线路"
            description="从 IP 池分配一条不同的可用代理替换当前绑定"
            onConfirm={() => switchLine(r)}
          >
            <Tooltip title="手动切换线路（一键换 IP）">
              <Button size="small" icon={<SwapOutlined />} />
            </Tooltip>
          </Popconfirm>
          <Tooltip title="环境体检：伪装度评分 + 一致性红绿灯（需先打开环境）">
            <Button size="small" icon={<SafetyCertificateOutlined />} onClick={() => runHealthCheck(r)} />
          </Tooltip>
          <Tooltip title="导出整环境配置（含指纹 / 代理 / 账号 / Cookie / 扩展）">
            <Button size="small" icon={<ExportOutlined />} onClick={() => exportProfile(r.id, r.name)} />
          </Tooltip>
          <Tooltip title="复制环境（含账号资料迁移）">
            <Button size="small" icon={<CopyOutlined />} onClick={() => duplicate(r.id)} />
          </Tooltip>
          <Tooltip title={t('env.transfer')}>
            <Button size="small" icon={<ShareAltOutlined />} onClick={() => openTransfer(r)} />
          </Tooltip>
          <Popconfirm title="删除后进入回收站，可随时恢复。确定删除该环境？" onConfirm={() => remove(r.id)}>
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
          <Button icon={<ThunderboltOutlined />} loading={quickCreating} onClick={quickCreate}>
            快速创建
          </Button>
          <Button icon={<FolderAddOutlined />} onClick={() => setGroupModalOpen(true)}>
            新建分组
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load()}>
            刷新
          </Button>
          <Button icon={<RestOutlined />} onClick={openTrash}>
            回收站
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Button icon={<ExportOutlined />} onClick={exportProfiles}>
            导出
          </Button>
          {selected.length > 0 && (
            <>
              <Select
                placeholder="移动到分组"
                allowClear
                style={{ width: 150 }}
                value={batchGroup}
                onChange={setBatchGroup}
                options={groups.map((g) => ({ value: g.id, label: g.name }))}
              />
              <Button icon={<SwapOutlined />} onClick={batchMoveGroup}>
                移动 ({selected.length})
              </Button>
              <Select
                placeholder="绑定代理"
                allowClear
                style={{ width: 160 }}
                value={batchProxy}
                onChange={setBatchProxy}
                options={proxies.map((x) => ({ value: x.id, label: `${x.name}（${x.host}:${x.port}）` }))}
              />
              <Button icon={<ApiOutlined />} onClick={batchBindProxy}>
                绑定 ({selected.length})
              </Button>
              <Button
                icon={<ThunderboltOutlined />}
                onClick={randomizeSelected}
              >
                批量重随机指纹 ({selected.length})
              </Button>
              <Tooltip
                title={
                  selected.length === 1
                    ? '以该环境为母本批量克隆：行为一致（系统/UA/语言/时区）、指纹各异（分辨率/CPU/内存/显卡/字体）'
                    : '请先勾选 1 个作为母本的环境'
                }
              >
                <Button icon={<CopyOutlined />} onClick={openClone} disabled={selected.length !== 1}>
                  克隆工厂
                </Button>
              </Tooltip>
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
              <Popconfirm
                title="批量删除后进入回收站，可随时恢复。确定？"
                onConfirm={batchDelete}
              >
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selected.length})
                </Button>
              </Popconfirm>
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
          scroll={{ x: 1170 }}
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
          支持本工具导出的 JSON：整环境单对象导出文件、批量导出数组、或 {`{ items: [...] }`}；也可只给 name / platform，系统会自动生成随机指纹。
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

      {/* 回收站：软删除的环境可恢复或彻底删除（彻底删除将清理关联账号与 Cookie） */}
      <Drawer
        title="回收站"
        width={520}
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
      >
        {trashLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <ReloadOutlined spin style={{ fontSize: 20 }} />
          </div>
        ) : !trashList.length ? (
          <Empty description="回收站是空的" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            dataSource={trashList}
            pagination={false}
            columns={[
              { title: '环境', dataIndex: 'name', key: 'name', ellipsis: true },
              { title: '平台', dataIndex: 'platform', key: 'platform', width: 90, ellipsis: true },
              {
                title: '删除时间',
                dataIndex: 'deletedAt',
                key: 'deletedAt',
                width: 150,
                render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm')
              },
              {
                title: '操作',
                key: 'actions',
                width: 170,
                render: (_: unknown, r: { id: number; name: string }) => (
                  <Space>
                    <Button size="small" icon={<UndoOutlined />} onClick={() => restore(r.id)}>
                      恢复
                    </Button>
                    <Popconfirm
                      title="彻底删除不可恢复"
                      description={`将同时删除「${r.name}」关联的账号与 Cookie，确定？`}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => purge(r.id)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        彻底删除
                      </Button>
                    </Popconfirm>
                  </Space>
                )
              }
            ]}
          />
        )}
      </Drawer>

      {/* 环境体检报告：伪装度分（设定值 vs 窗口实测值逐项对撞）+ 一致性红绿灯 */}
      <Drawer
        title={`环境体检报告 — ${healthName}`}
        width={760}
        open={healthOpen}
        onClose={() => setHealthOpen(false)}
      >
        {healthLoading && <Empty description="正在环境窗口内采集指纹…" />}
        {!healthLoading && !healthReport && <Empty description="暂无报告" />}
        {!healthLoading && healthReport && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ textAlign: 'center', minWidth: 96 }}>
                <div style={{ fontSize: 12, color: '#888' }}>伪装度</div>
                <div style={{ fontSize: 38, fontWeight: 500, color: scoreColor(healthReport.score), lineHeight: 1.25 }}>
                  {healthReport.score}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <Progress percent={healthReport.score} strokeColor={scoreColor(healthReport.score)} showInfo={false} />
                <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                  按「设定指纹 vs 窗口实测值」逐项加权得出，仅统计适用项。检测于{' '}
                  {dayjs(healthReport.checkedAt).format('YYYY-MM-DD HH:mm:ss')}
                </div>
              </div>
            </div>

            <Typography.Title level={5} style={{ marginTop: 20 }}>
              一致性检查（关联高危信号）
            </Typography.Title>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={healthReport.consistency}
              columns={[
                { title: '检查项', dataIndex: 'key', width: 190, render: (v: string) => CONSISTENCY_LABELS[v] || v },
                { title: '期望', dataIndex: 'expected', ellipsis: true },
                { title: '实际', dataIndex: 'actual', ellipsis: true },
                {
                  title: '状态',
                  width: 96,
                  render: (_: unknown, r) =>
                    r.skipped ? <Tag>未检测</Tag> : r.ok ? <Tag color="success">一致</Tag> : <Tag color="error">不一致</Tag>
                }
              ]}
            />

            <Typography.Title level={5} style={{ marginTop: 24 }}>
              逐项对撞（设定值 / 实测值）
            </Typography.Title>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={healthReport.items}
              columns={[
                { title: '检查项', dataIndex: 'key', width: 160, render: (v: string) => HEALTH_LABELS[v] || v },
                { title: '设定值', dataIndex: 'expected', ellipsis: true },
                { title: '实测值', dataIndex: 'actual', ellipsis: true },
                {
                  title: '状态',
                  width: 88,
                  render: (_: unknown, r) =>
                    r.weight === 0 ? <Tag>不适用</Tag> : r.ok ? <Tag color="success">正常</Tag> : <Tag color="error">不符</Tag>
                }
              ]}
            />
            <div style={{ fontSize: 12, color: '#888', marginTop: 16 }}>
              实测值取自环境窗口内真实读取（含原型函数是否被改写），因此能反映指纹注入是否真的生效，而不只是配置是否保存成功。
            </div>
          </div>
        )}
      </Drawer>

      {/* 环境克隆工厂：以母本批量派生副本，指纹微抖动 */}
      <Modal
        title={`克隆工厂 — 以「${cloneSrc?.name || ''}」为母本`}
        open={cloneOpen}
        onOk={submitClone}
        onCancel={() => setCloneOpen(false)}
        okText="开始克隆"
        cancelText="取消"
        confirmLoading={cloneLoading}
      >
        <div style={{ marginBottom: 14 }}>
          <div style={{ marginBottom: 6 }}>数量（1–50）</div>
          <InputNumber
            min={1}
            max={50}
            value={cloneCount}
            onChange={(v) => setCloneCount(Number(v) || 1)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ marginBottom: 6 }}>名称前缀</div>
          <Input
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            placeholder="留空则用母本名称，副本依次编号"
          />
        </div>
        <div>
          <Switch checked={cloneAccounts} onChange={setCloneAccounts} /> 同时复制账号资料（账号密码一并复制）
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 16, lineHeight: 1.7 }}>
          每个副本<strong>继承</strong>系统、UA、语言、时区、平台（行为一致），
          但分辨率、CPU 核数、内存、显卡、字体与 Canvas·Audio 噪声各不相同（指纹各异），
          因此批量号不会因共用同一套设备特征而被一锅端。
          <br />
          不会复制 Cookie（登录态复制过去等于主动制造关联），也不继承代理绑定，需另行分配。
        </div>
      </Modal>

      {/* 环境转移到其他团队：跨团队分享，关联 Cookie / 账号一并迁移 */}
      <Modal
        title={t('env.transferTitle')}
        open={transferOpen}
        onOk={submitTransfer}
        onCancel={() => setTransferOpen(false)}
        okText={t('env.transfer')}
        cancelText={t('common.cancel')}
        confirmLoading={transferLoading}
        okButtonProps={{ disabled: transferTarget === undefined }}
      >
        <div style={{ marginBottom: 8 }}>{t('env.transferConfirm')}</div>
        <div style={{ marginBottom: 6 }}>{t('env.transferTo')}</div>
        <Select
          style={{ width: '100%' }}
          placeholder={t('env.transferTo')}
          value={transferTarget}
          onChange={setTransferTarget}
          options={transferTeams.map((tm) => ({ value: tm.id, label: tm.name }))}
        />
        <div style={{ fontSize: 12, color: '#888', marginTop: 12, lineHeight: 1.7 }}>
          {t('env.transferHint')}
        </div>
      </Modal>
    </div>
  )
}
