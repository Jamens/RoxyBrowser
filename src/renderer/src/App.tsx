import { useLayoutEffect } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme, App as AntdApp } from 'antd'
import { useIsDark } from './theme'
import { I18nProvider, useI18n } from './i18n'
import { antdLocaleFor } from './i18n/antdLocale'
import Login from './pages/Login'
import AppLayout from './pages/Layout'
import Environments from './pages/Environments'
import Templates from './pages/Templates'
import Proxies from './pages/Proxies'
import Accounts from './pages/Accounts'
import Cookies from './pages/Cookies'
import Extensions from './pages/Extensions'
import Rpa from './pages/Rpa'
import Team from './pages/Team'
import Logs from './pages/Logs'
import ApiDocs from './pages/ApiDocs'
import Settings from './pages/Settings'
import BrowserTab from './pages/BrowserTab'

export default function App() {
  // I18nProvider 必须包在外层，AppShell 才能通过 useI18n 拿到当前语言，
  // 再把对应的 antd 语言包喂给 ConfigProvider
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  )
}

function AppShell() {
  const { locale } = useI18n()
  const isDark = useIsDark()
  const algorithm = isDark ? theme.darkAlgorithm : undefined
  // 主色随明暗微调：浅色用标准蓝 #1677ff，暗色用更亮的 #4096ff 提升对比
  const colorPrimary = isDark ? '#4096ff' : '#1677ff'

  // 在 <html> 上标记当前主题，便于纯 CSS 做主题相关的微调（如暗色下更重的卡片阴影）。
  // 用 useLayoutEffect 在首帧绘制前同步设置，避免暗色下首屏先闪一下浅色（首进暗黑模式的关键）。
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  return (
    <ConfigProvider
      locale={antdLocaleFor(locale)}
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
      {/*
        antd <App> 提供两样关键东西：
        1) 全局样式 reset（含 color-scheme），让暗色下首屏各类控件正确套用算法；
        2) 通过 App.useApp() 拿到「跟随主题」的 message / modal / notification 实例。
        不包这一层时，静态 message.xxx 会渲染成浅色——这正是「暗黑模式下部分 UI 效果没显示」的根因。
      */}
      <AntdApp style={{ height: '100%' }}>
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
              <Route path="/extensions" element={<Extensions />} />
              <Route path="/rpa" element={<Rpa />} />
              <Route path="/team" element={<Team />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/api" element={<ApiDocs />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntdApp>
    </ConfigProvider>
  )
}
