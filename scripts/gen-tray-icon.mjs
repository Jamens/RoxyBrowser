// 生成托盘图标（纯 Node，无第三方依赖）：resources/tray.png 64x64
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

const SIZE = 64
const BG = [45, 108, 255] // 品牌蓝
const FG = [255, 255, 255]

// 简单光栅：圆角矩形底色 + 白色经纬环（地球意象）
function roundedAlpha(x, y, radius) {
  const rx = Math.min(x, SIZE - 1 - x)
  const ry = Math.min(y, SIZE - 1 - y)
  if (rx >= radius || ry >= radius) return 255
  const dx = radius - rx
  const dy = radius - ry
  const d = Math.sqrt(dx * dx + dy * dy)
  return d <= radius ? 255 : 0
}

const cx = (SIZE - 1) / 2
const cy = (SIZE - 1) / 2
const outer = 21
const inner = 8
const ringW = 2.4

const rows = []
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4) // filter type + RGBA
  for (let x = 0; x < SIZE; x++) {
    const o = 1 + x * 4
    const alpha = roundedAlpha(x, y, 12)
    const dx = x - cx
    const dy = y - cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    // 白色圆环：|dist - r| < ringW/2
    const onRing =
      Math.abs(dist - outer) < ringW / 2 ||
      Math.abs(dist - inner) < ringW / 2 ||
      (Math.abs(Math.abs(dy) - Math.sqrt(Math.max(outer * outer - dx * dx, 0))) < 1.2 && Math.abs(dx) < outer)
    const c = onRing ? FG : BG
    row[o] = c[0]
    row[o + 1] = c[1]
    row[o + 2] = c[2]
    row[o + 3] = alpha
  }
  rows.push(row)
}

const raw = Buffer.concat(rows)
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const idat = deflateSync(raw, { level: 9 })

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crcBuf])
}

let table = null
function crc32(buf) {
  if (!table) {
    table = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const out = join(process.cwd(), 'resources', 'tray.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('tray.png 生成完成:', out, png.length, 'bytes')
