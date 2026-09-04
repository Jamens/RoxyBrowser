import { useState } from 'react'
import { Card, Tabs, Form, Input, Button, message } from 'antd'
import { UserOutlined, LockOutlined, GlobalOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'

export default function Login() {
  const [form] = Form.useForm()
  const [regForm] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

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
      message.success('注册成功')
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
        <div style={{ color: 'rgba(255,255,255,0.75)', marginTop: 8 }}>指纹浏览器 · 跨境电商多账号防关联</div>
      </div>
      <Card style={{ width: 400, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <Tabs
          centered
          items={[
            {
              key: 'login',
              label: '登录',
              children: (
                <Form form={form} layout="vertical" onFinish={doLogin} initialValues={{ username: 'admin', password: '123456' }}>
                  <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                    <Input prefix={<UserOutlined />} placeholder="用户名（默认 admin）" size="large" />
                  </Form.Item>
                  <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                    <Input.Password prefix={<LockOutlined />} placeholder="密码（默认 123456）" size="large" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                    登 录
                  </Button>
                </Form>
              )
            },
            {
              key: 'register',
              label: '注册',
              children: (
                <Form form={regForm} layout="vertical" onFinish={doRegister}>
                  <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                    <Input prefix={<UserOutlined />} placeholder="用户名" size="large" />
                  </Form.Item>
                  <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                    <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
                  </Form.Item>
                  <Form.Item name="nickname">
                    <Input placeholder="昵称（可选）" size="large" />
                  </Form.Item>
                  <Form.Item name="teamName">
                    <Input placeholder="团队空间名称（可选）" size="large" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                    注册并创建团队空间
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
