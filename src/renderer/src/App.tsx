import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
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
  const [themeMode, setThemeMode] = useState<string>(() => localStorage.getItem('roxy_theme') || 'auto')
  // 自动模式下用于触发重算的时钟（仅在 auto 时更新）
  const [, setTick] = useState(0)

  useEffect(() => {
    const handler = () => setThemeMode(localStorage.getItem('roxy_theme') || 'auto')
    window.addEventListener('roxy-theme-change', handler)
    // 自动模式每分钟重算一次，确保跨过 7:00 / 18:00 边界时自动切换
    const timer = setInterval(() => {
      if ((localStorage.getItem('roxy_theme') || 'auto') === 'auto') setTick((t) => t + 1)
    }, 60_000)
    return () => {
      window.removeEventListener('roxy-theme-change', handler)
      clearInterval(timer)
    }
  }, [])

  // 自动模式：7:00（含）至 18:00（不含）为白天，其余为黑夜
  const isDark =
    themeMode === 'dark' ||
    (themeMode === 'auto' && !(new Date().getHours() >= 7 && new Date().getHours() < 18))

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
