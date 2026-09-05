import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Result, Button, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

interface Props {
  children: ReactNode
}
interface State {
  hasError: boolean
  message: string
}

/**
 * 页面级错误边界：任何一个子页面渲染崩溃时，只在这里显示兜底，
 * 不会把整个 React 树（含左侧导航 AppLayout）一起带崩。
 * 配合 AppLayout 里 <ErrorBoundary key={location.pathname}> 使用，
 * 路由切换时边界会自动重置。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[ErrorBoundary] 页面渲染异常：', error, info)
  }

  private backToEnv = () => {
    window.location.hash = '#/envs'
  }

  render() {
    if (this.state.hasError) {
      return (
        <Result
          status="error"
          title="页面渲染出错"
          subTitle={
            <Typography.Paragraph style={{ maxWidth: 560, margin: '0 auto' }}>
              <Typography.Text type="secondary">该页面在渲染时抛出异常，已隔离以免整个应用崩溃。错误信息：</Typography.Text>
              <br />
              <Typography.Text code>{this.state.message}</Typography.Text>
            </Typography.Paragraph>
          }
          extra={[
            <Button type="primary" icon={<ReloadOutlined />} onClick={this.backToEnv} key="back">
              返回环境列表
            </Button>
          ]}
        />
      )
    }
    return this.props.children
  }
}
