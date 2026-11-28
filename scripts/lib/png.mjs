import { deflateSync, inflateSync } from "node:zlib"

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 }

let crcTable

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let value = n
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[n] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([header, body, checksum])
}

export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("PNG dimensions must be positive integers.")
  }
  if (!data || data.length !== width * height * 4) throw new Error("PNG input must be RGBA8 pixels.")
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    rows[row] = 0
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(rows, row + 1)
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function paeth(left, up, corner) {
  const estimate = left + up - corner
  const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]
  const smallest = Math.min(...distances)
  return smallest === distances[0] ? left : smallest === distances[1] ? up : corner
}

export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(signature)) throw new Error("Not a PNG file.")
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const parts = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("latin1", offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8) throw new Error("Only 8-bit PNG files are supported.")
      if (body[12] !== 0) throw new Error("Interlaced PNG files are not supported.")
      colorType = body[9]
    } else if (type === "IDAT") parts.push(body)
    else if (type === "IEND") break
  }
  const channels = channelsByColorType[colorType]
  if (!channels) throw new Error("Unsupported PNG color type " + colorType + ".")
  if (!width || !height) throw new Error("PNG header is missing.")
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data is truncated.")
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const source = y * (stride + 1) + 1
    const target = y * stride
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? rows[target + i - channels] : 0
      const up = y > 0 ? rows[target - stride + i] : 0
      const corner = i >= channels && y > 0 ? rows[target - stride + i - channels] : 0
      const value = raw[source + i]
      rows[target + i] = filter === 0 ? value
        : filter === 1 ? value + left
        : filter === 2 ? value + up
        : filter === 3 ? value + ((left + up) >> 1)
        : filter === 4 ? value + paeth(left, up, corner)
        : (() => { throw new Error("Unknown PNG filter " + filter + ".") })()
    }
  }
  const data = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channels
    const target = pixel * 4
    if (channels === 1) data.set([rows[source], rows[source], rows[source], 255], target)
    else if (channels === 2) data.set([rows[source], rows[source], rows[source], rows[source + 1]], target)
    else if (channels === 3) data.set([rows[source], rows[source + 1], rows[source + 2], 255], target)
    else data.set(rows.subarray(source, source + 4), target)
  }
  return { width, height, data }
}
