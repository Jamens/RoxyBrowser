import { useCallback, useEffect, useState } from 'react'
import { Card, Table, Button, Space, Tag, Popconfirm, Modal, Form, Input, Select, Typography, Descriptions, Avatar, Upload, UploadProps, Radio, Checkbox } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { UserAddOutlined, ReloadOutlined, DeleteOutlined, UploadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { api } from '../api'

interface Member {
  id: number
  userId: number
  role: string
  username: string
  nickname: string
  createdAt: string
}

/** 可邀请的已有成员（系统内已存在、尚未加入本团队） */
interface Candidate {
  id: number
  username: string
  nickname: string
}

interface TeamInfo {
  team: { id: number; name: string; icon?: string | null; createdAt: string }
  members: Member[]
}

// 团队图标限制：原始文件 ≤ 2MB；像素边长超过 256 时自动等比压缩，避免 base64 过大撑爆存储
const MAX_ICON_BYTES = 2 * 1024 * 1024
const MAX_ICON_EDGE = 256

/** 读取图片，超过 maxEdge 时等比压缩，返回 data URL 与是否发生过压缩 */
function compressImage(file: File, maxEdge: number): Promise<{ dataUrl: string; compressed: boolean }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => {
      const src = String(reader.result)
      const img = new Image()
      img.onerror = () => reject(new Error('图片解析失败，请换一张'))
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
        if (scale === 1) return resolve({ dataUrl: src, compressed: false })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('当前环境不支持图片压缩'))
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve({ dataUrl: canvas.toDataURL('image/png'), compressed: true })
      }
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}

export default function Team() {
  const { message } = useAppCtx()
  const [info, setInfo] = useState<TeamInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  // 邀请方式：create = 新建账号；pick = 勾选系统内已有成员；email = 邮箱邀请（发邮件 + 令牌）
  const [inviteMode, setInviteMode] = useState<'create' | 'pick' | 'email'>('create')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [picked, setPicked] = useState<number[]>([])
  // 邮箱邀请相关
  const [emailText, setEmailText] = useState('')
  const [emailRole, setEmailRole] = useState<'admin' | 'member'>('member')
  const [sending, setSending] = useState(false)
  const [invites, setInvites] = useState<{ id: number; email: string; role: string; expiresAt: string }[]>([])

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<TeamInfo>('/api/team'))
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])

  // 加载待接受的邮箱邀请（仅管理员可见）
  const loadInvites = useCallback(async () => {
    try {
      const list = await api.get<{ id: number; email: string; role: string; expiresAt: string }[]>('/api/team/invites')
      setInvites(Array.isArray(list) ? list : [])
    } catch {
      setInvites([])
    }
  }, [])

  useEffect(() => {
    load()
    loadInvites()
  }, [load, loadInvites])

  // 打开邀请弹窗时拉取「可邀请的已有成员」
  const openInvite = async () => {
    setInviteMode('create')
    setPicked([])
    setEmailText('')
    setEmailRole('member')
    form.resetFields()
    try {
      setCandidates(await api.get<Candidate[]>('/api/team/candidates'))
    } catch {
      setCandidates([])
    }
    setOpen(true)
  }

  // 邮箱邀请：解析多邮箱、调后端发信
  const sendEmailInvite = async () => {
    const emails = emailText
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (emails.length === 0) {
      message.warning('请填写至少一个邮箱')
      return
    }
    setSending(true)
    try {
      const res = await api.post<{ ok: boolean; sent: string[]; failed: { email: string; error: string }[] }>('/api/team/invites', {
        emails,
        role: emailRole
      })
      const okCount = res.sent?.length || 0
      const failCount = res.failed?.length || 0
      if (failCount === 0) {
        message.success(`已向 ${okCount} 个邮箱发送邀请`)
      } else {
        message.warning(`成功 ${okCount} 个，失败 ${failCount} 个：${res.failed.map((f) => `${f.email}(${f.error})`).join('；')}`)
      }
      setOpen(false)
      loadInvites()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  // 撤销邀请
  const revokeInvite = async (id: number) => {
    try {
      await api.del(`/api/team/invites/${id}`)
      message.success('已撤销邀请')
      loadInvites()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const addMember = async () => {
    // 勾选已有成员：批量加入本团队
    if (inviteMode === 'pick') {
      if (picked.length === 0) {
        message.warning('请选择要邀请的成员')
        return
      }
      try {
        const res = await api.post<{ ok: boolean; added: number }>('/api/team/members/batch', { userIds: picked })
        message.success(`已邀请 ${res.added} 位成员`)
        setOpen(false)
        load()
      } catch (e) {
        message.error((e as Error).message)
      }
      return
    }
    const values = await form.validateFields()
    try {
      await api.post('/api/team/members', values)
      message.success('成员已添加')
      setOpen(false)
      form.resetFields()
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const changeRole = async (m: Member, role: string) => {
    await api.put(`/api/team/members/${m.id}`, { role })
    message.success('角色已更新')
    load()
  }

  // 团队图标：前端转 base64(data URL) 直接存库，不走文件上传通道
  const beforeUploadIcon: NonNullable<UploadProps['beforeUpload']> = async (file) => {
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件（JPG / PNG / WebP 等）')
      return false
    }
    if (file.size > MAX_ICON_BYTES) {
      message.error(`图标不能超过 2MB，当前 ${(file.size / 1024 / 1024).toFixed(2)}MB，请压缩后再上传`)
      return false
    }
    try {
      const { dataUrl, compressed } = await compressImage(file, MAX_ICON_EDGE)
      // 压缩后仍过大（极少数高噪声图）则拒绝，避免写入超长字段
      if (dataUrl.length > 2 * 1024 * 1024) {
        message.error('压缩后仍然过大，请换一张更小的图片')
        return false
      }
      await api.put('/api/team', { icon: dataUrl })
      message.success(compressed ? `团队图标已更新（原图较大，已自动压缩到 ${MAX_ICON_EDGE}px）` : '团队图标已更新')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
    return false // 阻止 antd 自动上传
  }

  const removeIcon = async () => {
    try {
      await api.put('/api/team', { icon: '' })
      message.success('已移除团队图标')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<Member> = [
    { title: '用户名', dataIndex: 'username' },
    { title: '昵称', dataIndex: 'nickname' },
    {
      title: '角色',
      dataIndex: 'role',
      width: 160,
      render: (v, r) =>
        v === 'owner' ? (
          <Tag color="gold">所有者</Tag>
        ) : (
          <Select
            size="small"
            value={v}
            style={{ width: 110 }}
            onChange={(role) => changeRole(r, role)}
            options={[
              { value: 'admin', label: '管理员' },
              { value: 'member', label: '成员' }
            ]}
          />
        )
    },
    { title: '加入时间', dataIndex: 'createdAt', render: (v) => dayjs(v).format('YYYY-MM-DD') },
    {
      title: '操作',
      width: 90,
      render: (_, r) =>
        r.role !== 'owner' && (
          <Popconfirm title="移除该成员？" onConfirm={async () => { await api.del(`/api/team/members/${r.id}`); load() }}>
            <Button size="small" danger icon={<DeleteOutlined />}>移除</Button>
          </Popconfirm>
        )
    }
  ]

  return (
    <Card
      title="团队空间"
      extra={
        <Space>
          <Button type="primary" icon={<UserAddOutlined />} onClick={openInvite}>
            邀请 / 添加成员
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      {info && (
        <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="团队名称">{info.team?.name}</Descriptions.Item>
          <Descriptions.Item label="成员数">{info.members.length}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{dayjs(info.team?.createdAt).format('YYYY-MM-DD')}</Descriptions.Item>
          <Descriptions.Item label="团队图标">
            <Space>
              <Avatar size={40} src={info.team?.icon || undefined} style={info.team?.icon ? undefined : { backgroundColor: '#1677ff', fontSize: 18 }}>
                {!info.team?.icon ? info.team?.name?.[0] || 'T' : null}
              </Avatar>
              <Upload showUploadList={false} accept="image/*" beforeUpload={beforeUploadIcon}>
                <Button size="small" icon={<UploadOutlined />}>上传图标</Button>
              </Upload>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                支持 JPG / PNG / WebP，单个文件 ≤ 2MB；边长超过 {MAX_ICON_EDGE}px 会自动等比压缩
              </Typography.Text>
              {info.team?.icon && (
                <Popconfirm title="移除团队图标？" onConfirm={removeIcon}>
                  <Button size="small" danger icon={<DeleteOutlined />}>移除</Button>
                </Popconfirm>
              )}
            </Space>
          </Descriptions.Item>
        </Descriptions>
      )}
      <Typography.Paragraph type="secondary">
        基于角色的权限管理：所有者与管理员可管理成员和环境配置，普通成员可使用环境执行日常运营。所有操作均记录在操作日志中并标注操作人，便于责任追溯。
      </Typography.Paragraph>
      <Table rowKey="id" size="middle" columns={columns} dataSource={info?.members || []} pagination={false} />
      {invites.length > 0 && (
        <Card size="small" title="邮箱邀请记录（待接受）" style={{ marginTop: 16 }}>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={invites}
            columns={[
              { title: '邮箱', dataIndex: 'email' },
              {
                title: '角色',
                dataIndex: 'role',
                render: (v: string) => (v === 'admin' ? '管理员' : '成员')
              },
              { title: '过期时间', dataIndex: 'expiresAt', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
              {
                title: '操作',
                width: 90,
                render: (_: unknown, r: { id: number }) => (
                  <Popconfirm title="撤销该邀请？" onConfirm={() => revokeInvite(r.id)}>
                    <Button size="small" danger>撤销</Button>
                  </Popconfirm>
                )
              }
            ]}
          />
        </Card>
      )}
      <Modal
        title="邀请 / 添加成员"
        open={open}
        onOk={() => {
          if (inviteMode === 'pick') addMember()
          else if (inviteMode === 'email') sendEmailInvite()
          else addMember()
        }}
        confirmLoading={sending}
        onCancel={() => setOpen(false)}
        destroyOnClose
        okText={
          inviteMode === 'pick'
            ? `邀请（${picked.length}）`
            : inviteMode === 'email'
              ? '发送邀请邮件'
              : '确定'
        }
      >
        <Radio.Group
          value={inviteMode}
          onChange={(e) => setInviteMode(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          style={{ marginBottom: 16 }}
          options={[
            { value: 'create', label: '新建账号' },
            { value: 'pick', label: `勾选已有成员（${candidates.length}）` },
            { value: 'email', label: '邮箱邀请' }
          ]}
        />
        {inviteMode === 'email' ? (
          <>
            <Form.Item label="邀请邮箱（多个用换行 / 逗号 / 分号分隔，最多 50 个）" required>
              <Input.TextArea
                rows={4}
                value={emailText}
                onChange={(e) => setEmailText(e.target.value)}
                placeholder="alice@example.com&#10;bob@example.com"
              />
            </Form.Item>
            <Form.Item label="角色" required>
              <Select
                value={emailRole}
                onChange={(v) => setEmailRole(v)}
                options={[
                  { value: 'admin', label: '管理员' },
                  { value: 'member', label: '成员' }
                ]}
              />
            </Form.Item>
            <Typography.Text type="secondary">
              收件人将通过邮件收到邀请链接，点击后设置账号并加入本团队。需先在「设置 → 邮件 SMTP」配置发信服务器。
            </Typography.Text>
          </>
        ) : inviteMode === 'pick' ? (
          candidates.length === 0 ? (
            <Typography.Text type="secondary">暂无可邀请的已有成员（系统内账号均已在本团队中）</Typography.Text>
          ) : (
            <Checkbox.Group style={{ width: '100%' }} value={picked} onChange={(v) => setPicked(v as number[])}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {candidates.map((c) => (
                  <Checkbox key={c.id} value={c.id}>
                    {c.username}
                    {c.nickname ? `（${c.nickname}）` : ''}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          )
        ) : (
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="用户名（已注册用户直接加入，新用户自动创建账号）" rules={[{ required: true }]}>
            <Input placeholder="成员用户名" />
          </Form.Item>
          <Form.Item name="password" label="登录密码（新用户必填）">
            <Input.Password placeholder="新用户初始密码" />
          </Form.Item>
          <Form.Item name="nickname" label="昵称（可选）">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="member">
            <Select
              options={[
                { value: 'admin', label: '管理员' },
                { value: 'member', label: '成员' }
              ]}
            />
          </Form.Item>
        </Form>
        )}
      </Modal>
    </Card>
  )
}
