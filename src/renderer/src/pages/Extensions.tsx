import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Table, Button, Modal, Tabs, Input, Space, Typography, Popconfirm, Spin } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { PlusOutlined, DeleteOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api, API_BASE } from '../api'
import type { ExtensionDTO } from '@shared/types'

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

export default function Extensions() {
  const { message } = useAppCtx()
  const [list, setList] = useState<ExtensionDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<'local' | 'upload'>('local')
  const [localPath, setLocalPath] = useState('')
  const [uploading, setUploading] = useState(false)
  const dirRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<ExtensionDTO[]>('/api/extensions')
      setList(data)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (addOpen && dirRef.current) dirRef.current.setAttribute('webkitdirectory', '')
  }, [addOpen])

  const addByLocal = async () => {
    if (!localPath.trim()) {
      message.warning('请输入本地已解压扩展目录的绝对路径')
      return
    }
    try {
      const ext = await api.post<ExtensionDTO>('/api/extensions', { localPath: localPath.trim() })
      message.success(`已添加扩展「${ext.name}」`)
      setAddOpen(false)
      setLocalPath('')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const handleDirChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || !fileList.length) return
    setUploading(true)
    try {
      const files: { path: string; data: string }[] = []
      for (const file of Array.from(fileList)) {
        const buf = await file.arrayBuffer()
        files.push({ path: (file as File & { webkitRelativePath: string }).webkitRelativePath, data: arrayBufferToBase64(buf) })
      }
      if (!files.length) {
        message.warning('未选择到任何文件')
        return
      }
      const ext = await api.post<ExtensionDTO>('/api/extensions', { files })
      message.success(`已添加扩展「${ext.name}」（共 ${files.length} 个文件）`)
      setAddOpen(false)
      load()
    } catch (err) {
      message.error((err as Error).message)
    } finally {
      setUploading(false)
      if (dirRef.current) dirRef.current.value = ''
    }
  }

  const remove = async (id: number) => {
    try {
      await api.del(`/api/extensions/${id}`)
      message.success('已删除')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns: ColumnsType<ExtensionDTO> = [
    {
      title: '图标',
      dataIndex: 'id',
      width: 64,
      render: (id: number) => (
        <img
          src={`${API_BASE}/api/extensions/${id}/icon`}
          alt=""
          width={28}
          height={28}
          style={{ objectFit: 'contain', borderRadius: 4 }}
          onError={(ev) => {
            ;(ev.currentTarget as HTMLImageElement).style.visibility = 'hidden'
          }}
        />
      )
    },
    { title: '名称', dataIndex: 'name', render: (v) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: '版本', dataIndex: 'version', width: 90, render: (v) => v || <Typography.Text type="secondary">-</Typography.Text> },
    {
      title: '描述',
      dataIndex: 'description',
      render: (v) => v || <Typography.Text type="secondary">-</Typography.Text>
    },
    {
      title: '添加时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString()
    },
    {
      title: '操作',
      width: 100,
      render: (_, r) => (
        <Popconfirm title="确定删除该扩展？" description="环境将不再加载它" onConfirm={() => remove(r.id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      )
    }
  ]

  return (
    <div>
      <Card
        title="扩展管理 — 浏览器插件"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
              添加扩展
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          扩展以「解压后的扩展目录」形式存储并加载（Electron 不支持 .crx 打包格式）。添加后，在「环境管理 → 编辑环境 → 启用扩展」中按环境勾选，打开窗口时即自动加载。
        </Typography.Paragraph>
        <Spin spinning={loading}>
          <Table rowKey="id" size="middle" loading={loading} columns={columns} dataSource={list} pagination={false} />
        </Spin>
      </Card>

      <Modal
        title="添加扩展"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        footer={addMode === 'local' ? undefined : null}
        onOk={addMode === 'local' ? addByLocal : undefined}
        okText="添加"
        confirmLoading={uploading}
      >
        <Tabs
          activeKey={addMode}
          onChange={(k) => setAddMode(k as 'local' | 'upload')}
          items={[
            {
              key: 'local',
              label: '本地路径',
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Typography.Text>填入本机已解压扩展目录的绝对路径（含 manifest.json）：</Typography.Text>
                  <Input
                    placeholder="例如：C:\\Users\\me\\Desktop\\my-extension"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    onPressEnter={addByLocal}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    可直接指向 Chrome 用户数据目录下的扩展文件夹（如 …\Chrome\User Data\Default\Extensions\xxxx\1.0.0）。
                  </Typography.Text>
                </Space>
              )
            },
            {
              key: 'upload',
              label: '上传目录',
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Typography.Text>选择本地已解压的扩展文件夹（文件夹本身，不是 .crx）：</Typography.Text>
                  <Button icon={<FolderOpenOutlined />} loading={uploading} onClick={() => dirRef.current?.click()}>
                    选择目录并上传
                  </Button>
                  <input ref={dirRef} type="file" multiple style={{ display: 'none' }} onChange={handleDirChange} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    上传后服务端会解析 manifest.json 并保存到应用数据目录。
                  </Typography.Text>
                </Space>
              )
            }
          ]}
        />
      </Modal>
    </div>
  )
}
