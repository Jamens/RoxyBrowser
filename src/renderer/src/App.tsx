import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
import { useIsDark } from './theme'
import Login from './pages/Login'
import AppLayout from './pages/Layout'
import Environments from './pages/Environments'
import Templates from './pages/Templates'
import Proxies from './pages/Proxies'
import Accounts from './pages/Accounts'
import Team from './pages/Team'
import Logs from './pages/Logs'
import ApiDocs from './pages/ApiDocs'
import Settings from './pages/Settings'
import BrowserTab from './pages/BrowserTab'

export default function App() {
  const isDark = useIsDark()
  const algorithm = isDark ? theme.darkAlgorithm : undefined

  return (
    <ConfigProvider theme={{ algorithm }}>
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
