import { useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
import { useIsDark } from './theme'
import Login from './pages/Login'
import AppLayout from './pages/Layout'
import Environments from './pages/Environments'
import Templates from './pages/Templates'
import Proxies from './pages/Proxies'
import Accounts from './pages/Accounts'
import Cookies from './pages/Cookies'
import Team from './pages/Team'
import Logs from './pages/Logs'
import ApiDocs from './pages/ApiDocs'
import Settings from './pages/Settings'
import BrowserTab from './pages/BrowserTab'

export default function App() {
  const isDark = useIsDark()
  const algorithm = isDark ? theme.darkAlgorithm : undefined
  // 主色随明暗微调：浅色用标准蓝 #1677ff，暗色用更亮的 #4096ff 提升对比
  const colorPrimary = isDark ? '#4096ff' : '#1677ff'

  // 在 <html> 上标记当前主题，便于纯 CSS 做主题相关的微调（如暗色下更重的卡片阴影）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  return (
    <ConfigProvider
      theme={{
        algorithm,
        token: { colorPrimary, borderRadius: 8 },
        components: {
          Menu: {
            // 选中项高亮跟随主色：背景为主色淡染，文字/左侧 accent 为主色
            itemSelectedBg: isDark ? 'rgba(64,150,255,0.18)' : 'rgba(22,119,255,0.10)',
            itemSelectedColor: colorPrimary,
            // 菜单项统一圆角，视觉更柔和
            itemBorderRadius: 8
          }
        }
      }}
    >
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/browser" element={<BrowserTab />} />
          <Route path="/" element={<AppLayout />}>
            <Route index element={<Navigate to="/envs" replace />} />
            <Route path="/envs" element={<Environments />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/proxies" element={<Proxies />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/cookies" element={<Cookies />} />
            <Route path="/team" element={<Team />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/api" element={<ApiDocs />} />
          </Route>
        </Routes>
      </HashRouter>
    </ConfigProvider>
  )
}
