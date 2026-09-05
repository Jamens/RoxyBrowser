import { useState } from 'react'
import { ConfigProvider, theme, Card, Tabs, Form, Input, Button } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useAppCtx } from '../hooks/useApp'
import { useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'
import { useT } from '../i18n'
import LoginVisual from '../components/LoginVisual'

export default function Login() {
  const { message } = useAppCtx()
  const [form] = Form.useForm()
  const [regForm] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const t = useT()

  const doLogin = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      const res = await api.post<{ token: string }>('/api/auth/login', values)
      setToken(res.token)
      navigate('/')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const doRegister = async (values: { username: string; password: string; nickname?: string; teamName?: string }) => {
    setLoading(true)
    try {
      const res = await api.post<{ token: string }>('/api/auth/register', values)
      setToken(res.token)
      message.success(t('login.registerSuccess'))
      navigate('/')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrap">
      <LoginVisual />
      <div className="login-main">
        {/* 登录卡片强制浅色主题：卡片是白色底，若跟随全局暗色算法，输入框会变成黑底 + 浅灰字（看不见），
            与白卡严重冲突。此处用独立 light ConfigProvider 让表单控件始终浅色，与白卡自洽。 */}
        <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#2b5cff', borderRadius: 8 } }}>
        <Card className="login-card" style={{ width: 400 }}>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#1f2b4d' }}>
              <UserOutlined /> {t('app.brand')}
            </div>
          </div>
          <Tabs
            centered
            items={[
              {
                key: 'login',
                label: t('login.tab'),
                children: (
                  <Form form={form} layout="vertical" onFinish={doLogin} initialValues={{ username: 'admin', password: '123456' }}>
                    <Form.Item name="username" rules={[{ required: true, message: t('login.usernameRequired') }]}>
                      <Input prefix={<UserOutlined />} placeholder={t('login.usernamePlaceholder')} size="large" />
                    </Form.Item>
                    <Form.Item name="password" rules={[{ required: true, message: t('login.passwordRequired') }]}>
                      <Input.Password prefix={<LockOutlined />} placeholder={t('login.passwordPlaceholder')} size="large" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                      {t('login.submit')}
                    </Button>
                  </Form>
                )
              },
              {
                key: 'register',
                label: t('login.registerTab'),
                children: (
                  <Form form={regForm} layout="vertical" onFinish={doRegister}>
                    <Form.Item name="username" rules={[{ required: true, message: t('login.usernameRequired') }]}>
                      <Input prefix={<UserOutlined />} placeholder={t('login.username')} size="large" />
                    </Form.Item>
                    <Form.Item name="password" rules={[{ required: true, message: t('login.passwordRequired') }]}>
                      <Input.Password prefix={<LockOutlined />} placeholder={t('login.password')} size="large" />
                    </Form.Item>
                    <Form.Item name="nickname">
                      <Input placeholder={t('login.nicknamePlaceholder')} size="large" />
                    </Form.Item>
                    <Form.Item name="teamName">
                      <Input placeholder={t('login.teamNamePlaceholder')} size="large" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                      {t('login.registerSubmit')}
                    </Button>
                  </Form>
                )
              }
            ]}
          />
        </Card>
        </ConfigProvider>
      </div>
    </div>
  )
}
