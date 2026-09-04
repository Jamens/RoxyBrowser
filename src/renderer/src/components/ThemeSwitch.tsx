import { Segmented } from 'antd'
import { SunOutlined, MoonOutlined, ClockCircleOutlined } from '@ant-design/icons'

const OPTIONS = [
  { label: '白天', value: 'light', icon: <SunOutlined /> },
  { label: '黑夜', value: 'dark', icon: <MoonOutlined /> },
  { label: '自动', value: 'auto', icon: <ClockCircleOutlined /> }
]

// 主题开关：白天 / 黑夜 / 自动（按时间 7:00-18:00 白天，其余黑夜）
// 状态持久化在 localStorage('roxy_theme')，App 层监听 roxy-theme-change 实时套用
export default function ThemeSwitch() {
  const mode = localStorage.getItem('roxy_theme') || 'auto'
  const onChange = (value: string) => {
    localStorage.setItem('roxy_theme', value)
    window.dispatchEvent(new Event('roxy-theme-change'))
  }
  return (
    <Segmented
      value={mode}
      onChange={onChange}
      options={OPTIONS}
      // 紧凑模式，避免占用过多标题栏空间
      style={{ marginRight: 16 }}
    />
  )
}
