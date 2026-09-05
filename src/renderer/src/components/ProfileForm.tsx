import { useEffect, useRef, useState } from 'react'
import { Drawer, Form, Input, Select, InputNumber, Switch, Button, Tabs, Space, Typography, Tag, Spin } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import { ThunderboltOutlined } from '@ant-design/icons'
import { api } from '../api'
import type { ProfileDTO, AccountDTO, Fingerprint, GroupDTO, ProxyDTO, ExtensionDTO, OSKind, FingerprintPresetDTO } from '@shared/types'
import { osLabel } from '@shared/types'
import { getTimezoneOffsetMinutes, defaultFingerprint, randomFonts } from '@shared/fingerprint'

const PLATFORMS = [
  'Amazon', 'Facebook', 'Instagram', 'TikTok', 'eBay', 'Etsy', 'Walmart', 'Shopee',
  'AliExpress', 'Google', 'Twitter/X', 'LinkedIn', 'Pinterest', '其他'
]

// 平台 → 站点首页，用于「从已有账号带入」时回填起始页 URL（仅作便捷默认值，可改）
const PLATFORM_HOMEPAGES: Record<string, string> = {
  Amazon: 'https://www.amazon.com',
  Facebook: 'https://www.facebook.com',
  Instagram: 'https://www.instagram.com',
  TikTok: 'https://www.tiktok.com',
  eBay: 'https://www.ebay.com',
  Etsy: 'https://www.etsy.com',
  Walmart: 'https://www.walmart.com',
  Shopee: 'https://shopee.com',
  AliExpress: 'https://www.aliexpress.com',
  Google: 'https://www.google.com',
  'Twitter/X': 'https://x.com',
  LinkedIn: 'https://www.linkedin.com',
  Pinterest: 'https://www.pinterest.com'
}

const TIMEZONES = [
  'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver', 'America/Sao_paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Warsaw',
  'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Bangkok',
  'Australia/Sydney', 'Asia/Dubai', 'Africa/Johannesburg'
]

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  initial: ProfileDTO | null
  isTemplate?: boolean
  groups: GroupDTO[]
  proxies: ProxyDTO[]
  extensions: ExtensionDTO[]
}

export default function ProfileForm({ open, onClose, onSaved, initial, isTemplate, groups, proxies, extensions }: Props) {
  const { message } = useAppCtx()
  const [form] = Form.useForm()
  const [fp, setFp] = useState<Fingerprint | null>(null)
  const [saving, setSaving] = useState(false)
  const [presets, setPresets] = useState<FingerprintPresetDTO[]>([])
  // 「从已有账号带入」：拉取账号列表，供新建环境时回填平台 / 起始页
  const [accounts, setAccounts] = useState<AccountDTO[]>([])
  // 当前激活的 Tab（保存校验失败时回切到「基本信息」让必填项红框可见）
  const [tabKey, setTabKey] = useState<string>('base')
  // 当前选中的预设 id。之前这里写死 value={null}，等于把 Select 钉成空值——
  // onChange 照样触发（指纹会写到下面各字段），但框自己永远显示 placeholder，
  // 用户看到的就是「选了没填进去」。
  const [presetId, setPresetId] = useState<string | undefined>(undefined)
  // 用户是否已经手动指定过指纹（选预设 / 随机 / 改字段）。新建环境会异步拉一套
  // 随机指纹，这个标记用来防止那次异步结果把用户先选好的指纹覆盖掉。
  const userPickedRef = useRef(false)

  useEffect(() => {
    if (open && !presets.length) {
      api.get<FingerprintPresetDTO[]>('/api/fingerprint/presets').then(setPresets).catch(() => {
        /* 预设加载失败不影响手工配置 */
      })
    }
  }, [open, presets.length])

  // 新建环境时拉取账号列表，供「从已有账号带入」回填平台 / 起始页
  useEffect(() => {
    if (!open || initial) return
    let cancelled = false
    api
      .get<AccountDTO[]>('/api/accounts')
      .then((a) => {
        if (!cancelled) setAccounts(a)
      })
      .catch(() => {
        /* 账号列表加载失败不影响建环境 */
      })
    return () => {
      cancelled = true
    }
  }, [open, initial])

  useEffect(() => {
    if (open) {
      form.resetFields()
      setPresetId(undefined)
      userPickedRef.current = false
      if (initial) {
        form.setFieldsValue({
          name: initial.name,
          groupId: initial.groupId ?? undefined,
          platform: initial.platform || undefined,
          startUrl: initial.startUrl,
          remark: initial.remark,
          proxyId: initial.proxyId ?? undefined
        })
        form.setFieldValue('extensions', initial.extensions ?? [])
        setFp(initial.fingerprint)
      } else {
        // 新建：必须先生成一套指纹。否则 fp 为 null 时抽屉内没有任何内容可渲染，
        // 而「一键随机指纹」与预设选择器都在抽屉内部——等于用户永远无法创建环境。
        setFp(null)
        let cancelled = false
        api
          .post<Fingerprint>('/api/fingerprint/random', {})
          .then((f) => {
            // 用户在结果返回前先选了预设 / 点了随机，就不要再覆盖
            if (!cancelled && !userPickedRef.current) setFp(f)
          })
          .catch(() => {
            // 接口异常时退回本地生成，保证表单仍能打开
            if (!cancelled && !userPickedRef.current) setFp(defaultFingerprint())
          })
        return () => {
          cancelled = true
        }
      }
    }
    return undefined
  }, [open, initial, form])

  // 套用预设：写入指纹 + 记住选中的是哪一套，让下拉框把名字显示出来
  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    userPickedRef.current = true
    setPresetId(id)
    setFp(p.fingerprint)
    message.success(`已套用预设「${p.name}」`)
  }

  const randomize = async () => {
    const f = await api.post<Fingerprint>('/api/fingerprint/random', { os: fp?.os })
    userPickedRef.current = true
    // 随机出来的不再是任何一套预设，清掉选中态，避免下拉框显示的名字名不副实
    setPresetId(undefined)
    setFp(f)
  }

  const setFpField = (key: keyof Fingerprint, value: unknown) => {
    // 手工改动任一字段后，指纹就不再等于那套预设了，同步清掉选中态
    setPresetId(undefined)
    userPickedRef.current = true
    setFp((prev) => {
      if (!prev) return prev
      const next = { ...prev, [key]: value } as Fingerprint
      if (key === 'timezone') next.tzOffset = getTimezoneOffsetMinutes(String(value))
      if (key === 'os') {
        // 切换 OS 时同步 platform / UA
        next.platform = value === 'mac' ? 'MacIntel' : 'Win32'
        // 桌面端切 OS 时整套字体也按新 OS 重新取（移动端走整条随机接口，已含字体）
        next.fonts = randomFonts(value as OSKind)
        if (value === 'mac' && prev.userAgent.includes('Windows')) {
          next.userAgent = prev.userAgent.replace(
            /\(Macintosh; Intel Mac OS X [^)]+\)/,
            '(Macintosh; Intel Mac OS X 10_15_7)'
          ).replace(/\(Windows[^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
        } else if (value === 'windows' && !prev.userAgent.includes('Windows')) {
          next.userAgent = prev.userAgent.replace(
            /\(Macintosh; Intel Mac OS X [^)]+\)/,
            '(Windows NT 10.0; Win64; x64)'
          )
        }
      }
      return next
    })
  }

  const save = async () => {
    let values: Awaited<ReturnType<typeof form.validateFields>>
    try {
      values = await form.validateFields()
    } catch (err) {
      // antd 校验失败：err.errorFields 携带各未通过字段的中文报错（如「请输入名称」）。
      // 用户可能在「指纹配置」页直接保存而漏填「基本信息」的必填项——这里给出友好提示并
      // 回切到基本信息页，让红框可见，而不是把 rejection 漏成「点了没反应、也没提示」。
      const ve = err as { errorFields?: Array<{ errors?: string[] }> }
      if (ve.errorFields && ve.errorFields.length) {
        setTabKey('base')
        const tips = ve.errorFields.map((f) => (f.errors && f.errors[0]) || '').filter(Boolean)
        message.error(tips.length ? `请先完善必填信息：${tips.join('；')}` : '请先完善必填信息')
      } else {
        message.error((err as Error)?.message || '表单校验未通过')
      }
      return
    }
    if (!fp) {
      message.warning('指纹信息未就绪')
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: values.name,
        groupId: values.groupId ?? null,
        platform: values.platform || '',
        startUrl: values.startUrl || '',
        remark: values.remark || '',
        proxyId: values.proxyId ?? null,
        extensions: Array.isArray(values.extensions) ? values.extensions : [],
        isTemplate: !!isTemplate && !initial,
        fingerprint: { ...fp, tzOffset: getTimezoneOffsetMinutes(fp.timezone) }
      }
      if (initial) {
        await api.put(`/api/profiles/${initial.id}`, payload)
        message.success('保存成功')
      } else {
        await api.post('/api/profiles', payload)
        message.success(isTemplate ? '模板创建成功' : '环境创建成功')
      }
      onSaved()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      title={initial ? (isTemplate ? '编辑模板' : '编辑环境') : isTemplate ? '新建窗口模板' : '新建浏览器环境'}
      width={640}
      open={open}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} disabled={!fp} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      {/* 指纹生成中（或生成失败）时给个加载态，避免抽屉一片空白被当成「没反应」。
          注意：antd 的 Spin tip 仅在「包裹子元素」时才会渲染，裸 Spin 不显示文字，
          所以这里把提示文字单独写出来。 */}
      {!fp ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 260,
            gap: 12
          }}
        >
          <Spin size="large" />
          <Typography.Text type="secondary">正在生成指纹…</Typography.Text>
        </div>
      ) : (
        <Tabs
          activeKey={tabKey}
          onChange={(k) => setTabKey(k)}
        items={[
          {
            key: 'base',
            label: '基本信息',
            children: (
              <Form form={form} layout="vertical" initialValues={{ startUrl: 'https://www.baidu.com' }}>
                {accounts.length > 0 && (
                  <Form.Item
                    label="从已有账号带入"
                    extra="选中账号后自动回填「运营平台」与「起始页 URL」；账号名 / 密码仍在「账号中心」管理（列表内点复制按钮可取）。"
                  >
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="选择账号以带入平台 / 起始页"
                      onChange={(id?: number) => {
                        const acc = accounts.find((a) => a.id === id)
                        if (!acc) return
                        if (acc.platform) form.setFieldValue('platform', acc.platform)
                        const home = PLATFORM_HOMEPAGES[acc.platform]
                        if (home) form.setFieldValue('startUrl', home)
                        message.success(`已带入「${acc.username}」的平台信息`)
                      }}
                      options={accounts.map((a) => ({
                        value: a.id,
                        label: `#${a.profileName || '未绑定环境'} · ${a.platform || '未设平台'} · @${a.username}`
                      }))}
                    />
                  </Form.Item>
                )}
                <Form.Item name="name" label="环境名称" rules={[{ required: true, message: '请输入名称' }]}>
                  <Input placeholder="例如：Amazon 美国店 01" />
                </Form.Item>
                {!isTemplate && (
                  <Form.Item name="groupId" label="所属分组">
                    <Select allowClear placeholder="选择分组" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
                  </Form.Item>
                )}
                <Form.Item name="platform" label="运营平台">
                  <Select allowClear placeholder="选择平台" options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
                </Form.Item>
                {!isTemplate && (
                  <Form.Item name="startUrl" label="起始页 URL">
                    <Input placeholder="打开窗口后首先访问的网址" />
                  </Form.Item>
                )}
                <Form.Item name="remark" label="备注">
                  <Input.TextArea rows={2} placeholder="备注信息（如店铺名、运营人员）" />
                </Form.Item>
                <Form.Item name="extensions" label="启用扩展" extra="勾选的扩展会在打开此环境窗口时自动加载">
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="不启用任何扩展"
                    options={extensions.map((e) => ({ value: e.id, label: `${e.name}${e.version ? ' v' + e.version : ''}` }))}
                  />
                </Form.Item>
              </Form>
            )
          },
          {
            key: 'fp',
            label: '指纹配置',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="选择指纹预设"
                    style={{ minWidth: 260 }}
                    value={presetId}
                    onChange={(id?: string) => {
                      if (id) return applyPreset(id)
                      // allowClear 清空：只是不再标记为这套预设，指纹本身保留
                      setPresetId(undefined)
                      userPickedRef.current = true
                    }}
                    // 下拉里带出规格说明（options 上的 description 字段 antd 不会渲染，
                    // 必须自己画）。label 保持纯文本，否则 optionFilterProp="label" 搜索会失效。
                    optionRender={(opt) => (
                      <div>
                        <div>{opt.label}</div>
                        <div style={{ fontSize: 11, opacity: 0.55 }}>
                          {presets.find((p) => p.id === opt.value)?.description}
                        </div>
                      </div>
                    )}
                    options={presets.map((p) => ({
                      value: p.id,
                      label: p.name
                    }))}
                  />
                  <Button type="primary" icon={<ThunderboltOutlined />} onClick={randomize}>
                    一键随机指纹
                  </Button>
                  <Typography.Text type="secondary">预设 = 各字段一致的成品组合；随机 = 按设备池整套生成</Typography.Text>
                </Space>
                <Form layout="vertical">
                  <Form.Item label="操作系统">
                    <Select
                      value={fp.os}
                      style={{ width: 200 }}
                      onChange={(v) => {
                        // 移动端设备池与桌面差异大（UA/平台/GPU/触摸/像素比联动），
                        // 切到 Android/iOS 时整套重新生成，避免手工拼出不一致的指纹
                        if (v === 'android' || v === 'ios') {
                          api
                            .post<Fingerprint>('/api/fingerprint/random', { os: v })
                            .then((f) => {
                              userPickedRef.current = true
                              setPresetId(undefined)
                              setFp(f)
                            })
                            .catch(() => message.error('生成失败'))
                        } else {
                          setFpField('os', v)
                        }
                      }}
                      options={(['windows', 'mac', 'android', 'ios'] as OSKind[]).map((o) => ({ value: o, label: osLabel(o) }))}
                    />
                  </Form.Item>
                  <Form.Item label="User Agent">
                    <Input.TextArea
                      rows={2}
                      value={fp.userAgent}
                      onChange={(e) => setFpField('userAgent', e.target.value)}
                    />
                  </Form.Item>
                  <Space size="middle" style={{ display: 'flex' }} wrap>
                    <Form.Item label="Navigator Platform" style={{ marginBottom: 0 }}>
                      <Input value={fp.platform} style={{ width: 160 }} onChange={(e) => setFpField('platform', e.target.value)} />
                    </Form.Item>
                    <Form.Item label="CPU 核心" style={{ marginBottom: 0 }}>
                      <InputNumber min={1} max={64} value={fp.hardwareConcurrency} onChange={(v) => setFpField('hardwareConcurrency', v || 4)} />
                    </Form.Item>
                    <Form.Item label="内存 (GB)" style={{ marginBottom: 0 }}>
                      <InputNumber min={1} max={64} value={fp.deviceMemory} onChange={(v) => setFpField('deviceMemory', v || 8)} />
                    </Form.Item>
                  </Space>
                  <Form.Item label="语言（Language 列表）" style={{ marginTop: 16 }}>
                    <Select
                      mode="tags"
                      value={fp.languages}
                      onChange={(v) => setFpField('languages', v)}
                      placeholder="如 en-US、en"
                      tokenSeparators={[',', ' ']}
                    />
                  </Form.Item>
                  <Form.Item label="字体列表" style={{ marginTop: 16 }} extra="伪造的已安装字体，防御字体枚举指纹；随机环境按 OS 取基础集 + 随机子集，可手工增减">
                    <Select
                      mode="tags"
                      value={fp.fonts}
                      onChange={(v) => setFpField('fonts', v)}
                      placeholder="字体名称"
                      tokenSeparators={[',']}
                    />
                  </Form.Item>
                  <Form.Item label="时区">
                    <Select
                      showSearch
                      value={fp.timezone}
                      onChange={(v) => setFpField('timezone', v)}
                      options={TIMEZONES.map((t) => ({ value: t, label: t }))}
                    />
                  </Form.Item>
                  <Space size="middle" style={{ display: 'flex' }} wrap>
                    <Form.Item label="屏幕宽" style={{ marginBottom: 0 }}>
                      <InputNumber min={320} max={7680} value={fp.screenWidth} onChange={(v) => setFpField('screenWidth', v || 1920)} />
                    </Form.Item>
                    <Form.Item label="屏幕高" style={{ marginBottom: 0 }}>
                      <InputNumber min={480} max={4320} value={fp.screenHeight} onChange={(v) => setFpField('screenHeight', v || 1080)} />
                    </Form.Item>
                  </Space>
                  <div style={{ marginTop: 16 }}>
                    <Form.Item label="WebGL 显卡信息" style={{ marginBottom: 8 }}>
                      <Input value={fp.webglVendor} onChange={(e) => setFpField('webglVendor', e.target.value)} placeholder="Vendor" />
                    </Form.Item>
                    <Input value={fp.webglRenderer} onChange={(e) => setFpField('webglRenderer', e.target.value)} placeholder="Renderer" />
                  </div>
                  <Space size="large" style={{ marginTop: 20 }}>
                    <Form.Item label="Canvas 噪声" style={{ marginBottom: 0 }} valuePropName="checked">
                      <Switch checked={fp.canvasNoise} onChange={(v) => setFpField('canvasNoise', v)} />
                    </Form.Item>
                    <Form.Item label="Audio 噪声" style={{ marginBottom: 0 }} valuePropName="checked">
                      <Switch checked={fp.audioNoise} onChange={(v) => setFpField('audioNoise', v)} />
                    </Form.Item>
                    <Form.Item label="WebRTC" style={{ marginBottom: 0 }}>
                      <Select
                        value={fp.webrtc}
                        style={{ width: 140 }}
                        onChange={(v) => setFpField('webrtc', v)}
                        options={[
                          { value: 'disable', label: '禁用（防泄漏）' },
                          { value: 'real', label: '真实' }
                        ]}
                      />
                    </Form.Item>
                  </Space>
                  <div style={{ marginTop: 20 }}>
                    <Typography.Text type="secondary">
                      当前指纹摘要：
                    </Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <Tag color="blue">{fp.platform}</Tag>
                      <Tag color="geekblue">{fp.timezone}</Tag>
                      <Tag color="purple">{fp.languages.join(', ')}</Tag>
                      <Tag>{fp.screenWidth}×{fp.screenHeight}</Tag>
                      <Tag color="cyan">CPU {fp.hardwareConcurrency} 核</Tag>
                      <Tag color="cyan">RAM {fp.deviceMemory}GB</Tag>
                      <Tag color="gold">{fp.fonts.length} 字体</Tag>
                    </div>
                  </div>
                </Form>
              </div>
            )
          },
          {
            key: 'proxy',
            label: '代理配置',
            children: (
              <Form layout="vertical">
                <Form.Item label="绑定代理 IP" extra="每个环境绑定独立代理，实现 IP 层防关联">
                  <Select
                    value={form.getFieldValue('proxyId')}
                    placeholder="不使用代理（直连）"
                    allowClear
                    onChange={(v) => form.setFieldValue('proxyId', v)}
                    options={proxies.map((p) => ({
                      value: p.id,
                      label: `${p.name} (${p.type.toUpperCase()} ${p.host}:${p.port}${p.country ? ' · ' + p.country : ''}${p.status === 'active' ? ' ✓' : ''})`
                    }))}
                  />
                </Form.Item>
                <Typography.Text type="secondary">
                  没有可用代理？请先到「代理 IP」页面添加并检测代理，再回到这里绑定。
                </Typography.Text>
              </Form>
            )
          }
        ]}
        />
      )}
    </Drawer>
  )
}
