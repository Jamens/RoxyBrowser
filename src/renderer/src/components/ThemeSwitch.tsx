import { useEffect, useState } from 'react'
import { Segmented } from 'antd'
import { SunOutlined, MoonOutlined, ClockCircleOutlined } from '@ant-design/icons'

const OPTIONS = [
  { label: '白天', value: 'light', icon: <SunOutlined /> },
  { label: '黑夜', value: 'dark', icon: <MoonOutlined /> },
  { label: '自动', value: 'auto', icon: <ClockCircleOutlined /> }
]

// 主题开关：白天 / 黑夜 / 自动（按时间 7:00-18:00 白天，其余黑夜）
// 状态持久化在 localStorage('roxy_theme')，App 层监听 roxy-theme-change 实时套用
// 注：本组件自带 state + 事件监听，确保点击后立即更新选中指示——
// 否则当 auto 与 dark/light 解析出相同 isDark 时，父层不重渲染会导致指示卡住。
export default function ThemeSwitch() {
  const [mode, setMode] = useState<string>(() => localStorage.getItem('roxy_theme') || 'auto')

  useEffect(() => {
    const handler = () => setMode(localStorage.getItem('roxy_theme') || 'auto')
    window.addEventListener('roxy-theme-change', handler)
    return () => window.removeEventListener('roxy-theme-change', handler)
  }, [])

  const onChange = (value: string) => {
    localStorage.setItem('roxy_theme', value)
    window.dispatchEvent(new Event('roxy-theme-change'))
  }

  return (
    <Segmented value={mode} onChange={onChange} options={OPTIONS} style={{ marginRight: 16 }} />
  )
}
