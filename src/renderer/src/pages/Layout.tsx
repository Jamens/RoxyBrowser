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
import { api, getToken, clearToken, setToken } from '../api'
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
  const { message } = useAppCtx()
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
      .catch(() => {
        clearToken()
        navigate('/login')
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
    clearToken()
    message.success(t('layout.logoutSuccess'))
    navigate('/login')
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
