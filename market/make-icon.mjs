#!/usr/bin/env node
// 生成市场卡片用的 180×180 PNG 图标（纯 node，无依赖）。
//
// 为什么不用 icon.svg：awesome-dsh-plugin 的收录规则只接受 GitHub 托管的位图
// （png/jpg/jpeg/webp），SVG 会被拒绝，所以仓库里需要一张 PNG。
//
// 用法：node market/make-icon.mjs [--out assets/icon-180.png] [--size 180]

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const size = Number(arg('size', '180'))
const out = resolve(process.cwd(), arg('out', 'assets/icon-180.png'))
const SS = 4 // 超采样倍数，用来做抗锯齿
const W = size * SS

// ---------------------------------------------------------------------------
// 画布：RGBA，先按 SS 倍画，再降采样
// ---------------------------------------------------------------------------

const canvas = new Float32Array(W * W * 3)
for (let y = 0; y < W; y++) {
  // 竖向渐变：#0f172a → #1e293b
  const t = y / (W - 1)
  const r = 15 + (30 - 15) * t
  const g = 23 + (41 - 23) * t
  const b = 42 + (59 - 42) * t
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    canvas[i] = r
    canvas[i + 1] = g
    canvas[i + 2] = b
  }
}

function blend(x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= W || y >= W || alpha <= 0) return
  const i = (y * W + x) * 3
  const a = Math.min(1, alpha)
  canvas[i] = canvas[i] * (1 - a) + rgb[0] * a
  canvas[i + 1] = canvas[i + 1] * (1 - a) + rgb[1] * a
  canvas[i + 2] = canvas[i + 2] * (1 - a) + rgb[2] * a
}

const WHITE = [255, 255, 255]

function fillRect(x0, y0, x1, y1, rgb, alpha = 1) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) blend(x, y, rgb, alpha)
  }
}

function fillRoundRect(x0, y0, x1, y1, radius, rgb, alpha = 1) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x1 - radius)
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y1 - radius)
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= radius * radius) blend(x, y, rgb, alpha)
    }
  }
}

function fillCircle(cx, cy, r, rgb, alpha = 1) {
  for (let y = Math.floor(cy - r); y < Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x < Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= r * r) blend(x, y, rgb, alpha)
    }
  }
}

function fillTriangle(ax, ay, bx, by, cx, cy, rgb, alpha = 1) {
  const minX = Math.floor(Math.min(ax, bx, cx))
  const maxX = Math.ceil(Math.max(ax, bx, cx))
  const minY = Math.floor(Math.min(ay, by, cy))
  const maxY = Math.ceil(Math.max(ay, by, cy))
  const edge = (x0, y0, x1, y1, px, py) => (px - x0) * (y1 - y0) - (py - y0) * (x1 - x0)
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = edge(ax, ay, bx, by, px, py)
      const w1 = edge(bx, by, cx, cy, px, py)
      const w2 = edge(cx, cy, ax, ay, px, py)
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        blend(x, y, rgb, alpha)
      }
    }
  }
}

// 圆角底板（比画布小一圈，四周留透明边）
const pad = W * 0.055
fillRoundRect(pad, pad, W - pad, W - pad, W * 0.21, [15, 23, 42])

// 图形：一个指向右的箭头 + 两条收缩的横线（“上下文被压缩后交给下一个会话”）
const arrowY = W * 0.4
fillCircle(W * 0.18, arrowY, W * 0.035, WHITE, 0.5)
fillRect(W * 0.21, arrowY - W * 0.045, W * 0.62, arrowY + W * 0.045, WHITE)
fillTriangle(W * 0.6, arrowY - W * 0.16, W * 0.84, arrowY, W * 0.6, arrowY + W * 0.16, WHITE)

fillRoundRect(W * 0.21, W * 0.62, W * 0.79, W * 0.655, W * 0.018, WHITE, 0.75)
fillRoundRect(W * 0.21, W * 0.7, W * 0.62, W * 0.735, W * 0.018, WHITE, 0.45)

// ---------------------------------------------------------------------------
// 降采样 → PNG
// ---------------------------------------------------------------------------

const rgba = Buffer.alloc(size * size * 4)
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    let r = 0
    let g = 0
    let b = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 3
        r += canvas[i]
        g += canvas[i + 1]
        b += canvas[i + 2]
      }
    }
    const n = SS * SS
    const o = (y * size + x) * 4
    rgba[o] = Math.round(r / n)
    rgba[o + 1] = Math.round(g / n)
    rgba[o + 2] = Math.round(b / n)
    // 圆角外是纯透明的（底板之外的角落保持 alpha=0）
    const px = x + 0.5
    const py = y + 0.5
    const inset = W * 0.055 / SS
    const radius = W * 0.21 / SS
    const cx = Math.min(Math.max(px, inset + radius), size - inset - radius)
    const cy = Math.min(Math.max(py, inset + radius), size - inset - radius)
    const inside =
      px >= inset && py >= inset && px <= size - inset && py <= size - inset &&
      (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius
    rgba[o + 3] = inside ? 255 : 0
  }
}

// CRC32（PNG 每个 chunk 都要）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0)
ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0 // deflate
ihdr[11] = 0 // adaptive filtering
ihdr[12] = 0 // no interlace

// 每行前面加一个 filter byte（0 = None）
const raw = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0
  rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`icon: ${out} (${size}×${size}, ${png.length} bytes)`)
