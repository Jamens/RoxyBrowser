import net from 'node:net'
import tls from 'node:tls'

// 依赖零三方库的 SMTP 发送器：基于 Node 内置 net / tls 手搓 SMTP 会话。
// 支持 465 隐式 TLS 与 587 STARTTLS 两种常见接入方式，以及 AUTH LOGIN / AUTH PLAIN。
// 仅做「发一封 HTML 邮件」的最小实现，足以支撑「邮箱邀请成员」场景。

export interface SmtpConfig {
  host: string
  port: number
  /** true = 465 隐式 TLS；false = 明文连接后 STARTTLS（587 常用） */
  secure: boolean
  user: string
  pass: string
  /** 发件人邮箱（同时作为信封 MAIL FROM） */
  from: string
  /** 自签 / 内网证书常需关闭校验 */
  rejectUnauthorized?: boolean
}

export interface SmtpSendResult {
  ok: boolean
  code?: number
  error?: string
}

const DEFAULT_TIMEOUT = 20000

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

/**
 * 判断缓冲区的 SMTP 响应是否已完整：多行响应以 "NNN-..." 续行、"NNN 文本"（空格分隔）结束。
 * 取最后一段完整的状态行，若以 "代码 文本"（空格）而非 "代码-文本"（短横）结尾，即视为结束。
 */
function isValidResponse(buf: string): boolean {
  const lines = buf.split('\r\n')
  let last = ''
  for (const l of lines) {
    if (l.length >= 3 && /^\d{3}/.test(l)) last = l
  }
  if (!last) return false
  return /^\d{3} /.test(last)
}

class SmtpSession {
  private socket: net.Socket | tls.TLSSocket
  private buf = ''
  private waiters: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = []
  private failed = false
  private timeoutMs: number

  constructor(socket: net.Socket | tls.TLSSocket, timeoutMs = DEFAULT_TIMEOUT) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.bind()
  }

  private bind() {
    this.socket.setTimeout(this.timeoutMs)
    this.socket.on('data', (d: Buffer) => this.onData(d))
    this.socket.on('error', (e: Error) => this.fail(e))
    this.socket.on('close', () => this.fail(new Error('SMTP 连接已关闭')))
    this.socket.on('timeout', () => this.fail(new Error('SMTP 连接超时')))
  }

  private onData(d: Buffer) {
    this.buf += d.toString('utf8')
    if (isValidResponse(this.buf)) {
      const full = this.buf
      this.buf = ''
      const w = this.waiters.shift()
      if (w) w.resolve(full)
    }
  }

  private fail(e: Error) {
    if (this.failed) return
    this.failed = true
    while (this.waiters.length) {
      const w = this.waiters.shift()!
      w.reject(e)
    }
  }

  /** 读下一条完整响应（用于开局欢迎语、DATA 结束响应等不需要发命令时） */
  read(): Promise<string> {
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  /** 发送一行命令并等待响应 */
  send(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.socket.write(cmd + '\r\n')
    })
  }

  /** 仅写入原始数据，不等响应（用于 DATA 正文） */
  writeRaw(s: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(s, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** STARTTLS 后把底层 socket 换成 TLS socket，并重新绑定事件 */
  swapSocket(next: tls.TLSSocket) {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
    this.socket.removeAllListeners('timeout')
    this.socket = next
    this.bind()
  }

  close() {
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
  }
}

function connect(
  host: string,
  port: number,
  secure: boolean,
  rejectUnauthorized: boolean
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(e)
    if (secure) {
      const t = tls.connect({ host, port, rejectUnauthorized }, () => resolve(t))
      t.on('error', onErr)
      return
    }
    const n = net.connect({ host, port }, () => resolve(n))
    n.on('error', onErr)
  })
}

function firstCode(resp: string): number {
  const m = resp.match(/^(\d{3})/)
  return m ? parseInt(m[1], 10) : 0
}

function buildMessage(from: string, to: string[], subject: string, html: string): string {
  const date = new Date().toUTCString()
  const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@roxybrowser>`
  const subjectEnc = `=?UTF-8?B?${b64(subject)}?=`
  const bodyB64 = b64(html)
  // base64 按 76 列换行，符合邮件规范且避免超长行被服务器拒收
  const wrapped = bodyB64.replace(/(.{76})/g, '$1\r\n')
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${subjectEnc}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapped
  ]
  return lines.join('\r\n')
}

/** 点 Stuffing：正文里以 "." 开头的行前补一个点，避免被当作 DATA 结束符 */
function dotStuff(s: string): string {
  return s
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? '.' + l : l))
    .join('\r\n')
}

export async function sendSmtpMail(
  cfg: SmtpConfig,
  to: string | string[],
  subject: string,
  html: string
): Promise<SmtpSendResult> {
  const recipients = Array.isArray(to) ? to : [to]
  if (recipients.length === 0) return { ok: false, error: '收件人为空' }
  if (!cfg.host || !cfg.port) return { ok: false, error: 'SMTP 服务器未配置' }
  const rejectUnauthorized = cfg.rejectUnauthorized !== false
  const helo = 'localhost'
  const from = cfg.from || cfg.user
  let session: SmtpSession | null = null
  let socket: net.Socket | tls.TLSSocket
  try {
    socket = await connect(cfg.host, cfg.port, cfg.secure, rejectUnauthorized)
    session = new SmtpSession(socket)
    await session.read() // 220 欢迎语
    let resp = await session.send(`EHLO ${helo}`)
    if (firstCode(resp) !== 250) return { ok: false, code: firstCode(resp), error: 'EHLO 失败' }
    const canStarttls = /STARTTLS/i.test(resp)
    const canAuthPlain = /AUTH(?:[ =]|\s)PLAIN/i.test(resp)
    const canAuthLogin = /AUTH(?:[ =]|\s)LOGIN/i.test(resp)

    if (!cfg.secure && canStarttls) {
      resp = await session.send('STARTTLS')
      if (firstCode(resp) !== 220) return { ok: false, code: firstCode(resp), error: 'STARTTLS 失败' }
      const upgraded = tls.connect(
        { socket: socket as net.Socket, host: cfg.host, rejectUnauthorized },
        () => {}
      )
      await new Promise<void>((resolve, reject) => {
        upgraded.once('secureConnect', () => resolve())
        upgraded.once('error', reject)
      })
      session.swapSocket(upgraded)
      resp = await session.send(`EHLO ${helo}`)
      if (firstCode(resp) !== 250) return { ok: false, code: firstCode(resp), error: 'STARTTLS 后 EHLO 失败' }
    }

    // 仅在提供了账号密码时尝试认证
    if (cfg.user && cfg.pass) {
      if (canAuthPlain) {
        const token = b64(`\u0000${cfg.user}\u0000${cfg.pass}`)
        resp = await session.send(`AUTH PLAIN ${token}`)
        if (firstCode(resp) !== 235) return { ok: false, code: firstCode(resp), error: 'AUTH PLAIN 认证失败' }
      } else if (canAuthLogin) {
        resp = await session.send('AUTH LOGIN')
        if (firstCode(resp) !== 334) return { ok: false, code: firstCode(resp), error: 'AUTH LOGIN 失败' }
        resp = await session.send(b64(cfg.user))
        if (firstCode(resp) !== 334) return { ok: false, code: firstCode(resp), error: '用户名被拒绝' }
        resp = await session.send(b64(cfg.pass))
        if (firstCode(resp) !== 235) return { ok: false, code: firstCode(resp), error: '密码被拒绝' }
      }
      // 不支持认证时不报错（部分开放中继），由后续 MAIL/RCPT 决定成败
    }

    resp = await session.send(`MAIL FROM:<${from}>`)
    if (firstCode(resp) !== 250) return { ok: false, code: firstCode(resp), error: '发件人被拒绝' }
    for (const r of recipients) {
      resp = await session.send(`RCPT TO:<${r}>`)
      if (firstCode(resp) !== 250) return { ok: false, code: firstCode(resp), error: `收件人 ${r} 被拒绝` }
    }
    resp = await session.send('DATA')
    if (firstCode(resp) !== 354) return { ok: false, code: firstCode(resp), error: 'DATA 指令失败' }
    const message = dotStuff(buildMessage(from, recipients, subject, html))
    await session.writeRaw(message + '\r\n.\r\n')
    resp = await session.read() // 250 投递结果
    if (firstCode(resp) !== 250) return { ok: false, code: firstCode(resp), error: '邮件投递失败' }
    try {
      await session.send('QUIT')
    } catch {
      /* ignore */
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    session?.close()
  }
}
