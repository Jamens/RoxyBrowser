import { useEffect, useState } from 'react'
import { Layout, Menu, Dropdown, Space, Typography, message, theme } from 'antd'
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
  SettingOutlined
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { api, getToken, clearToken } from '../api'
import ThemeSwitch from '../components/ThemeSwitch'
import { useIsDark } from '../theme'

const { Sider, Header, Content } = Layout

const MENUS = [
  { key: '/envs', icon: <AppstoreOutlined />, label: '环境管理' },
  { key: '/templates', icon: <ChromeOutlined />, label: '窗口模板' },
  { key: '/proxies', icon: <GlobalOutlined />, label: '代理 IP' },
  { key: '/accounts', icon: <KeyOutlined />, label: '账号中心' },
  { key: '/team', icon: <TeamOutlined />, label: '团队空间' },
  { key: '/logs', icon: <FileTextOutlined />, label: '操作日志' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
  { key: '/api', icon: <ApiOutlined />, label: '自动化 API' }
]

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [me, setMe] = useState<{ username: string; nickname: string; role: string } | null>(null)
  const { token } = theme.useToken()
  const isDark = useIsDark()

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
  }, [navigate])

  const logout = () => {
    clearToken()
    message.success('已退出登录')
    navigate('/login')
  }

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={210} theme={isDark ? 'dark' : 'light'} style={{ background: token.colorBgLayout }}>
        <div style={{ padding: '20px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <GlobalOutlined style={{ fontSize: 26, color: '#5b8cff' }} />
          <div>
            <div style={{ color: token.colorText, fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>RoxyBrowser</div>
            <div style={{ color: token.colorTextSecondary, fontSize: 11 }}>指纹浏览器 Clone</div>
          </div>
        </div>
        <Menu
          theme={isDark ? 'dark' : 'light'}
          mode="inline"
          selectedKeys={[location.pathname]}
          items={MENUS}
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
          <ThemeSwitch />
          <Dropdown
            menu={{
              items: [
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: '退出登录',
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
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
