import { useState } from 'react'
import { ConfigProvider, theme, Card, Tabs, Form, Input, Button } from 'antd'
import { UserOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons'
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
  // 登录二次验证（2FA）：密码通过后若后端返回挑战令牌，则进入动态码输入步骤
  const [challengeToken, setChallengeToken] = useState<string | null>(null)

  const doLogin = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      const res = await api.post<{ token?: string; twoFactorRequired?: boolean; challengeToken?: string }>(
        '/api/auth/login',
        values
      )
      if (res.twoFactorRequired && res.challengeToken) {
        setChallengeToken(res.challengeToken)
        return
      }
      setToken(res.token!)
      navigate('/')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 登录第二步：挑战令牌 + 动态码换取正式令牌
  const verifyTwoFa = async (values: { code: string }) => {
    if (!challengeToken) return
    setLoading(true)
    try {
      const res = await api.post<{ token: string }>('/api/auth/2fa/verify', {
        challengeToken,
        code: values.code
      })
      setToken(res.token)
      setChallengeToken(null)
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
          {challengeToken ? (
            <Form layout="vertical" onFinish={verifyTwoFa}>
              <div style={{ textAlign: 'center', marginBottom: 14, color: '#1f2b4d', fontWeight: 600, fontSize: 16 }}>
                请输入验证器 App 中的 6 位动态码
              </div>
              <Form.Item
                name="code"
                rules={[
                  { required: true, message: '请输入动态码' },
                  { pattern: /^\d{6}$/, message: '动态码为 6 位数字' }
                ]}
              >
                <Input prefix={<SafetyOutlined />} placeholder="000000" maxLength={6} size="large" inputMode="numeric" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                验证并登录
              </Button>
              <Button type="link" block size="small" onClick={() => setChallengeToken(null)}>
                返回
              </Button>
            </Form>
          ) : (
            <>
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
            </>
          )}
        </Card>
        </ConfigProvider>
      </div>
    </div>
  )
}
