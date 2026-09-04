import { useState } from 'react'
import { Card, Tabs, Form, Input, Button, message } from 'antd'
import { UserOutlined, LockOutlined, GlobalOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'
import { useT } from '../i18n'

export default function Login() {
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
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #1d2b64 0%, #4b6bff 60%, #6a8dff 100%)'
      }}
    >
      <div style={{ width: 400, textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 34, color: '#fff', fontWeight: 700, letterSpacing: 1 }}>
          <GlobalOutlined /> RoxyBrowser Clone
        </div>
        <div style={{ color: 'rgba(255,255,255,0.75)', marginTop: 8 }}>{t('app.tagline')}</div>
      </div>
      <Card style={{ width: 400, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <Tabs
          centered
          items={[
            {
              key: 'login',
              label: t('login.tab'),
              children: (
                <Form form={form} layout="vertical" onFinish={doLogin} initialValues={{ username: 'admin', password: '123456' }}>
                  <Form.Item
                    name="username"
                    rules={[{ required: true, message: t('login.usernameRequired') }]}
                  >
                    <Input
                      prefix={<UserOutlined />}
                      placeholder={t('login.usernamePlaceholder')}
                      size="large"
                    />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    rules={[{ required: true, message: t('login.passwordRequired') }]}
                  >
                    <Input.Password
                      prefix={<LockOutlined />}
                      placeholder={t('login.passwordPlaceholder')}
                      size="large"
                    />
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
                  <Form.Item
                    name="username"
                    rules={[{ required: true, message: t('login.usernameRequired') }]}
                  >
                    <Input prefix={<UserOutlined />} placeholder={t('login.username')} size="large" />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    rules={[{ required: true, message: t('login.passwordRequired') }]}
                  >
                    <Input.Password
                      prefix={<LockOutlined />}
                      placeholder={t('login.password')}
                      size="large"
                    />
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
    </div>
  )
}
