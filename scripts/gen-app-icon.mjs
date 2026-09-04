// 生成应用图标：resources/icon.png (256x256) 与 resources/icon.ico（Windows 安装包/任务栏用）
// 纯 Node 实现，无第三方依赖
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

function crcTable() {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}
const CRC_TABLE = crcTable()
function crc32(buf) {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(size, pixelFn) {
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const o = 1 + x * 4
      row[o] = r
      row[o + 1] = g
      row[o + 2] = b
      row[o + 3] = a
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const SIZE = 256
const BG_TOP = [59, 122, 255]
const BG_BOTTOM = [26, 62, 168]
const FG = [255, 255, 255]

function roundedRectAlpha(x, y, size, radius) {
  const rx = Math.min(x, size - 1 - x)
  const ry = Math.min(y, size - 1 - y)
  if (rx >= radius || ry >= radius) return 255
  const dx = radius - rx
  const dy = radius - ry
  return Math.sqrt(dx * dx + dy * dy) <= radius ? 255 : 0
}

// 蓝渐变圆角底 + 白色地球（外圈 + 两条经线 + 赤道）
function pixel(x, y) {
  const alpha = roundedRectAlpha(x, y, SIZE, 56)
  const t = y / (SIZE - 1)
  const bg = [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
  ]
  const cx = (SIZE - 1) / 2
  const cy = (SIZE - 1) / 2
  const r = SIZE * 0.3
  const dx = x - cx
  const dy = y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  const w = SIZE * 0.012
  let onStroke = Math.abs(dist - r) < w * 1.4 || Math.abs(dy) < w && dist <= r // 外圈 + 赤道
  // 两条经线（椭圆）
  for (const k of [0.42, 0.72]) {
    const a = r * k
    if (a > 0.001) {
      const v = (dx * dx) / (a * a) + (dy * dy) / (r * r)
      if (Math.abs(v - 1) < 0.035 && dist <= r) onStroke = true
    }
  }
  return onStroke ? [FG[0], FG[1], FG[2], alpha] : [bg[0], bg[1], bg[2], alpha]
}

const png = encodePng(SIZE, pixel)

// PNG → ICO（ICO 允许内嵌 PNG 数据）
const icoHeader = Buffer.alloc(6)
icoHeader.writeUInt16LE(0, 0)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0 // 256 用 0 表示
entry[1] = 0
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12)
const ico = Buffer.concat([icoHeader, entry, png])

const outDir = join(process.cwd(), 'resources')
mkdirSync(dirname(outDir), { recursive: true })
writeFileSync(join(outDir, 'icon.png'), png)
writeFileSync(join(outDir, 'icon.ico'), ico)
console.log(`icon.png ${png.length} bytes / icon.ico ${ico.length} bytes → ${outDir}`)
