import { useEffect, useState, Suspense } from 'react'
import { Layout, Menu, Dropdown, Space, Typography, theme, Spin } from 'antd'
import { useAppCtx } from '../hooks/useApp'
import {
  GlobalOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  KeyOutlined,
  TeamOutlined,
  FileTextOutlined,
  ApiOutlined,
  LogoutOutlined,
  DesktopOutlined,
  ChromeOutlined,
  SettingOutlined,
  SnippetsOutlined,
  AppstoreAddOutlined,
  VideoCameraOutlined,
  DashboardOutlined,
  RobotOutlined,
  DownOutlined,
  SwapOutlined
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { api, getToken, clearToken, setToken, ApiError } from '../api'
import ThemeSwitch from '../components/ThemeSwitch'
import SystemStats from '../components/SystemStats'
import ErrorBoundary from '../components/ErrorBoundary'
import { useIsDark } from '../theme'
import { useI18n, type TranslateFn } from '../i18n'

type TeamItem = { id: number; name: string; role: string; isCurrent: boolean }

const { Sider, Header, Content } = Layout

// 菜单项随语言动态生成，故做成函数而非常量（模块级常量拿不到 t）
const buildMenus = (t: TranslateFn) => [
  { key: '/dashboard', icon: <DashboardOutlined />, label: t('nav.dashboard') },
  { key: '/envs', icon: <AppstoreOutlined />, label: t('nav.envs') },
  { key: '/templates', icon: <ChromeOutlined />, label: t('nav.templates') },
  { key: '/proxies', icon: <GlobalOutlined />, label: t('nav.proxies') },
  { key: '/accounts', icon: <KeyOutlined />, label: t('nav.accounts') },
  { key: '/cookies', icon: <SnippetsOutlined />, label: t('nav.cookies') },
  { key: '/extensions', icon: <AppstoreAddOutlined />, label: t('nav.extensions') },
  { key: '/rpa', icon: <VideoCameraOutlined />, label: t('nav.rpa') },
  { key: '/ai-agent', icon: <RobotOutlined />, label: t('nav.aiAgent') },
  { key: '/team', icon: <TeamOutlined />, label: t('nav.team') },
  { key: '/logs', icon: <FileTextOutlined />, label: t('nav.logs') },
  { key: '/settings', icon: <SettingOutlined />, label: t('nav.settings') },
  { key: '/api', icon: <ApiOutlined />, label: t('nav.api') }
]

export default function AppLayout() {
  const { message, modal } = useAppCtx()
  const navigate = useNavigate()
  const location = useLocation()
  const [me, setMe] = useState<{ username: string; nickname: string; role: string } | null>(null)
  const [teams, setTeams] = useState<TeamItem[]>([])
  const [switching, setSwitching] = useState(false)
  const { token } = theme.useToken()
  const isDark = useIsDark()
  const { t } = useI18n()

  const loadTeams = () => {
    api
      .get<TeamItem[]>('/api/auth/teams')
      .then(setTeams)
      .catch(() => setTeams([]))
  }

  useEffect(() => {
    if (!getToken()) {
      navigate('/login')
      return
    }
    api
      .get<{ username: string; nickname: string; role: string }>('/api/auth/me')
      .then(setMe)
      .catch((e: unknown) => {
        // **只对真正的会话失效退出登录**，不能一律 clearToken + 跳登录页。
        //
        // 事故记录：此前这里是裸 `.catch(() => { clearToken(); navigate('/login') })`，
        // 于是**任何**失败都会被当成认证失败——包括限流（429）。
        // 而 429 在本项目里极易触发：全站轮询密集（环境页 3 秒 + 5 秒两次轮询），
        // 默认限额只有 120 次/分钟。频繁切菜单时请求量叠加，撞限流后
        // 用户的登录态就被清了，表现为「点着点着突然退出登录」，
        // 却完全看不出跟限流有关。
        //
        // 现在：401（令牌被拒绝）才退出；429 / 网络错误等临时故障保留登录态，
        // 只提示一次，不打断用户操作。
        if (e instanceof ApiError && e.isSessionExpired) {
          clearToken()
          navigate('/login')
          return
        }
        if (e instanceof ApiError && e.isRateLimited) {
          message.warning(t('layout.rateLimitedHint', { sec: e.retryAfterSec ?? 3 }))
          return
        }
        // 其他错误（网络抖动、服务端 500）：登录态未必失效，保持现状不动作，
        // 避免因一次偶发失败把用户踢出登录
        console.warn('[layout] 加载用户信息失败（已保留登录态）:', e)
      })
    loadTeams()
  }, [navigate])

  // 切换团队：后端校验成员关系后用新 teamId 重发令牌，并关闭旧团队运行中的环境窗口。
  // 这里只负责换本地令牌 + 整页 reload，reload 后所有数据自然归属新团队。
  const switchTeam = async (teamId: number) => {
    try {
      setSwitching(true)
      const res = await api.post<{ token: string }>('/api/auth/switch-team', { teamId })
      setToken(res.token)
      const next = teams.find((x) => x.id === teamId)
      message.success(next ? t('team.switched', { name: next.name }) : t('team.switchedShort'))
      window.location.reload()
    } catch (e) {
      message.error((e as Error).message || t('team.switchFailed'))
      setSwitching(false)
    }
  }

  const logout = () => {
    // 顺序很关键：必须**先发请求再清本地令牌**。
    // clearToken() 之后请求就不再带 Authorization 头，服务端鉴权会失败，
    // 撤销也就不会执行——恰好是这个功能要修的那个洞。
    const done = () => {
      clearToken()
      message.success(t('layout.logoutSuccess'))
      navigate('/login')
    }
    api.post('/api/auth/logout').then(done).catch(() => {
      // 服务端不可达时仍要完成本地登出（用户视角一致）；
      // 只是「本设备会话失效」这次没生效，下次登录会重新签发令牌。
      done()
    })
  }

  const logoutAll = async () => {
    modal.confirm({
      title: t('layout.logoutAllConfirm'),
      content: t('layout.logoutAllDesc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.post('/api/auth/logout-all')
        } finally {
          // 服务端已递增 tokenVersion，本机令牌也已失效；
          // 无论请求是否成功都要清本地，否则下次请求会 401 循环。
          clearToken()
          navigate('/login', { replace: true })
        }
      }
    })
  }

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={210} theme={isDark ? 'dark' : 'light'} style={{ background: token.colorBgLayout }}>
        <div style={{ padding: '20px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <GlobalOutlined style={{ fontSize: 26, color: '#5b8cff' }} />
          <div>
            <div style={{ color: token.colorText, fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>
              {t('app.brand')}
            </div>
            <div style={{ color: token.colorTextSecondary, fontSize: 11 }}>{t('app.subtitle')}</div>
          </div>
        </div>
        <Menu
          theme={isDark ? 'dark' : 'light'}
          mode="inline"
          selectedKeys={[location.pathname]}
          items={buildMenus(t)}
          onClick={({ key }) => navigate(key)}
          style={{ background: 'transparent', border: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            padding: '0 24px'
          }}
        >
          <SystemStats isDark={isDark} />
          <ThemeSwitch />
          {teams.length > 0 && (
            <Dropdown
              trigger={['click']}
              disabled={switching}
              menu={{
                items: teams.map((tm) => ({
                  key: String(tm.id),
                  label: tm.isCurrent ? `${tm.name}（${t('team.current')}）` : tm.name,
                  disabled: tm.isCurrent,
                  onClick: () => void switchTeam(tm.id)
                }))
              }}
            >
              <Space style={{ cursor: 'pointer', padding: '0 8px' }}>
                <SwapOutlined />
                <Typography.Text>{teams.find((x) => x.isCurrent)?.name || t('team.switch')}</Typography.Text>
                <DownOutlined style={{ fontSize: 10 }} />
              </Space>
            </Dropdown>
          )}
          <Dropdown
            menu={{
              items: [
                {
                  key: 'logout-all',
                  icon: <DesktopOutlined />,
                  label: t('layout.logoutAll'),
                  onClick: logoutAll
                },
                { type: 'divider' as const },
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: t('layout.logout'),
                  onClick: logout
                }
              ]
            }}
          >
            <Space style={{ cursor: 'pointer' }}>
              <Typography.Text strong>{me?.nickname || me?.username || '...'}</Typography.Text>
              <Typography.Text type="secondary">（{me?.role || ''}）</Typography.Text>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ padding: 20, overflow: 'auto', background: token.colorBgLayout }}>
          <ErrorBoundary key={location.pathname}>
            {/*
              Suspense 下沉到 Content 内：懒加载页面 chunk 拉取期间只兜底右侧内容区，
              侧边栏/顶栏保持挂载不再整树卸载（配合 body 主题背景，消除切页白闪）。
            */}
            <Suspense
              fallback={
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  <Spin size="large" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </Content>
      </Layout>
    </Layout>
  )
}
