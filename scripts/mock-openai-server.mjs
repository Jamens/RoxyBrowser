// OpenAI 兼容 mock 服务：用于验证云端 BYOK 链路的真实行为。
//
// 目的：复现「探活通过但实际调用失败」这类盲区 ——
//
// 1. **文本模型探活**发的是纯文本 "hi"。纯文本模型必然通过。
// 2. **视觉模型探活**必须发一张真图，否则纯文本模型也能通过（应用侧的修复）。
// 3. `max_tokens` 参数在部分模型（如 OpenAI 推理系列）上不被支持，
//    只认 `max_completion_tokens`。
// 4. 厂商错误响应体形态各异，需要看应用有没有把关键信息透出来。
// 5. **MIME 与字节不符**：data URL 声明 image/jpeg 但字节其实是 PNG 时，
//    真实厂商会拒收（OpenAI 系尤其严格），mock 也要复现这个行为。
//
// 用法：node scripts/mock-openai-server.mjs [port]

import http from 'node:http'
import { INVALID_KEY } from './lib/fake-credentials.mjs'

const PORT = Number(process.argv[2] || 4599)

const TINY_IMAGE =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

const state = { requests: [] }

/** 从 data URL 里解出声明的 MIME 与字节的**真实**格式 */
function inspectDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(String(url || ''))
  if (!m) return null
  const mime = m[1]
  const bytes = Buffer.from(m[2], 'base64')
  // PNG 魔数 89 50 4E 47；JPEG 魔数 FF D8 FF
  const real =
    bytes[0] === 0x89 && bytes[1] === 0x50
      ? 'image/png'
      : bytes[0] === 0xff && bytes[1] === 0xd8
        ? 'image/jpeg'
        : 'unknown'
  return { mime, real, bytes }
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let json = {}
    try {
      json = JSON.parse(body || '{}')
    } catch {
      /* ignore */
    }
    const model = json.model || ''
    const content = json.messages?.[json.messages.length - 1]?.content
    const hasImage = Array.isArray(content) && content.some((p) => p?.type === 'image_url')
    // 取真实图片的 data URL（用于校验 MIME 与字节是否一致）
    const imgPart = Array.isArray(content) ? content.find((p) => p?.type === 'image_url') : undefined
    const imgInfo = imgPart ? inspectDataUrl(imgPart.image_url?.url) : null
    state.requests.push({
      model,
      hasImage,
      maxTokens: json.max_tokens,
      maxCompletionTokens: json.max_completion_tokens,
      imageMime: imgInfo?.mime || null,
      imageRealMime: imgInfo?.real || null,
      stream: json.stream,
      keys: Object.keys(json)
    })

    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    // 模拟厂商：data URL 声明的 MIME 与字节真实格式不符 → 拒收。
    // 这是真实存在的坑：探活图是 PNG 字节，若按 jpeg 声明，OpenAI 系直接 400。
    if (imgInfo && imgInfo.mime !== imgInfo.real) {
      return send(400, {
        error: {
          message: `Invalid image format: declared ${imgInfo.mime} but the data is ${imgInfo.real}.`,
          type: 'invalid_request_error',
          code: 'invalid_image_format'
        }
      })
    }

    // 模拟厂商：文本模型收到 image_url 会报 400（这是真实行为，如 DeepSeek/GLM 文本模型）
    if (hasImage && !model.includes('vision')) {
      return send(400, {
        error: {
          message: `The model \`${model}\` does not support image input.`,
          type: 'invalid_request_error',
          code: 'model_not_support_image'
        }
      })
    }

    // 模拟厂商：某些模型不支持 max_tokens（如 OpenAI 推理系列要求 max_completion_tokens）
    if (model.includes('reasoner') && json.max_tokens !== undefined) {
      return send(400, {
        error: {
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: 'invalid_request_error',
          code: 'unsupported_parameter'
        }
      })
    }

    // 模拟厂商：余额不足
    if (model.includes('nofund')) {
      return send(402, {
        error: { message: 'insufficient balance', type: 'billing_error' }
      })
    }

    // 模拟厂商：Key 无效
    // INVALID_KEY 来自 scripts/lib/fake-credentials.mjs（运行时拼装，源码不留完整密钥字面量）
    if (model.includes('badkey') || (req.headers.authorization || '') === `Bearer ${INVALID_KEY}`) {
      return send(401, {
        error: { message: 'Invalid API key provided', type: 'authentication_error' }
      })
    }

    // 正常返回
    return send(200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: hasImage ? '{"action":"navigate","reason":"看到搜索框"}' : 'ok'
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock openai server: http://127.0.0.1:${PORT}/v1`)
})

// 供测试脚本读取已收到的请求
process.on('SIGTERM', () => {
  console.log(JSON.stringify(state.requests))
  process.exit(0)
})
