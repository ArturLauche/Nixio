const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function pixelLuma(pixels, offset) {
  const r = pixels[offset]
  const g = pixels[offset + 1]
  const b = pixels[offset + 2]
  const a = pixels[offset + 3] ?? 255
  const luma = (r * 54 + g * 183 + b * 19) / 256
  return a === 255 ? luma : (luma * a + 255 * (255 - a)) / 255
}

export function detectBubbleRect(
  pixels,
  width,
  height,
  clickX,
  clickY,
  { minLuma = 185, tolerance = 45, maxAreaFraction = .25, minPixels = 80, insetRatio = .08 } = {},
) {
  if (!pixels || width < 8 || height < 8) return null
  const sx = clamp(Math.floor(clickX * width), 0, width - 1)
  const sy = clamp(Math.floor(clickY * height), 0, height - 1)
  const seedOffset = (sy * width + sx) * 4
  const seedLuma = pixelLuma(pixels, seedOffset)
  if (seedLuma < minLuma) return null

  const seedR = pixels[seedOffset]
  const seedG = pixels[seedOffset + 1]
  const seedB = pixels[seedOffset + 2]
  const maxPixels = Math.max(minPixels, Math.floor(width * height * maxAreaFraction))
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(maxPixels + 4)

  let head = 0
  let tail = 0
  const startIndex = sy * width + sx
  visited[startIndex] = 1
  queue[tail++] = startIndex

  let minX = sx
  let maxX = sx
  let minY = sy
  let maxY = sy
  let count = 0
  let bordersHit = 0

  while (head < tail) {
    const index = queue[head++]
    count++
    if (count > maxPixels) return null

    const x = index % width
    const y = (index - x) / width
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (x === 0) bordersHit |= 1
    if (x === width - 1) bordersHit |= 2
    if (y === 0) bordersHit |= 4
    if (y === height - 1) bordersHit |= 8

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ]
    for (const next of neighbors) {
      if (next < 0 || visited[next]) continue
      const off = next * 4
      const luma = pixelLuma(pixels, off)
      if (luma < minLuma) continue
      if (
        Math.abs(pixels[off] - seedR) > tolerance ||
        Math.abs(pixels[off + 1] - seedG) > tolerance ||
        Math.abs(pixels[off + 2] - seedB) > tolerance
      ) continue
      visited[next] = 1
      if (tail >= queue.length) return null
      queue[tail++] = next
    }
  }

  const borderCount = ((bordersHit & 1) ? 1 : 0) + ((bordersHit & 2) ? 1 : 0) + ((bordersHit & 4) ? 1 : 0) + ((bordersHit & 8) ? 1 : 0)
  if (count < minPixels) return null
  if (borderCount >= 2 && count > width * height * .12) return null

  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  if (bw < 10 || bh < 10) return null

  const insetX = bw * insetRatio
  const insetY = bh * insetRatio
  const left = clamp((minX + insetX) / width, 0, .97)
  const top = clamp((minY + insetY) / height, 0, .97)
  const right = clamp((maxX + 1 - insetX) / width, left + .03, 1)
  const bottom = clamp((maxY + 1 - insetY) / height, top + .03, 1)
  return {
    x: left,
    y: top,
    w: Math.min(right - left, 1 - left),
    h: Math.min(bottom - top, 1 - top),
  }
}

export function detectBubbleOnImage(image, clickX, clickY, options) {
  const natW = image?.naturalWidth ?? 0
  const natH = image?.naturalHeight ?? 0
  if (!natW || !natH) return null
  const scale = Math.min(1, 640 / Math.max(natW, natH))
  const width = Math.max(8, Math.round(natW * scale))
  const height = Math.max(8, Math.round(natH * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  return detectBubbleRect(pixels, width, height, clickX, clickY, options)
}

function rectIoU(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  const areaA = a.w * a.h
  const areaB = b.w * b.h
  return inter / Math.max(1e-9, Math.min(areaA, areaB))
}

export function detectAllBubbles(
  pixels,
  width,
  height,
  {
    minLuma = 195,
    tolerance = 40,
    minAreaFraction = 0.0025,
    maxAreaFraction = 0.22,
    minPixels = 100,
    minSolidRatio = 0.42,
    insetRatio = 0.08,
    maxBubbles = 24,
    direction = "rtl",
  } = {},
) {
  if (!pixels || width < 16 || height < 16) return []
  const totalPixels = width * height
  const minCount = Math.max(minPixels, Math.floor(totalPixels * minAreaFraction))
  const maxCount = Math.max(minCount, Math.floor(totalPixels * maxAreaFraction))
  const visited = new Uint8Array(totalPixels)
  const queue = new Int32Array(totalPixels)
  const candidates = []

  for (let start = 0; start < totalPixels; start++) {
    if (visited[start]) continue
    const seedOff = start * 4
    if (pixelLuma(pixels, seedOff) < minLuma) {
      visited[start] = 1
      continue
    }
    const seedR = pixels[seedOff]
    const seedG = pixels[seedOff + 1]
    const seedB = pixels[seedOff + 2]

    let head = 0
    let tail = 0
    visited[start] = 1
    queue[tail++] = start

    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    let count = 0
    let bordersHit = 0

    while (head < tail) {
      const idx = queue[head++]
      count++
      const x = idx % width
      const y = (idx - x) / width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x === 0) bordersHit |= 1
      if (x === width - 1) bordersHit |= 2
      if (y === 0) bordersHit |= 4
      if (y === height - 1) bordersHit |= 8

      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x + 1 < width ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y + 1 < height ? idx + width : -1,
      ]
      for (const next of neighbors) {
        if (next < 0 || visited[next]) continue
        const off = next * 4
        if (pixelLuma(pixels, off) < minLuma) continue
        if (
          Math.abs(pixels[off] - seedR) > tolerance ||
          Math.abs(pixels[off + 1] - seedG) > tolerance ||
          Math.abs(pixels[off + 2] - seedB) > tolerance
        ) continue
        visited[next] = 1
        queue[tail++] = next
      }
    }

    if (count < minCount || count > maxCount) continue
    const borderCount =
      ((bordersHit & 1) ? 1 : 0) +
      ((bordersHit & 2) ? 1 : 0) +
      ((bordersHit & 4) ? 1 : 0) +
      ((bordersHit & 8) ? 1 : 0)
    if (borderCount >= 2 && count > totalPixels * 0.08) continue
    if (borderCount >= 1 && count > totalPixels * 0.14) continue

    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    if (bw < 14 || bh < 14) continue
    const aspect = bw / bh
    if (aspect < 0.2 || aspect > 4.5) continue
    const solidity = count / (bw * bh)
    if (solidity < minSolidRatio) continue

    const insetX = bw * insetRatio
    const insetY = bh * insetRatio
    const left = clamp((minX + insetX) / width, 0, 0.97)
    const top = clamp((minY + insetY) / height, 0, 0.97)
    const right = clamp((maxX + 1 - insetX) / width, left + 0.03, 1)
    const bottom = clamp((maxY + 1 - insetY) / height, top + 0.03, 1)
    candidates.push({
      x: left,
      y: top,
      w: Math.min(right - left, 1 - left),
      h: Math.min(bottom - top, 1 - top),
      area: count,
    })
  }

  // Deduplicate strongly overlapping regions (keep larger area first).
  candidates.sort((a, b) => b.area - a.area)
  const kept = []
  for (const cand of candidates) {
    if (kept.some((existing) => rectIoU(existing, cand) > 0.45)) continue
    kept.push({ x: cand.x, y: cand.y, w: cand.w, h: cand.h })
    if (kept.length >= maxBubbles) break
  }

  // Sort in manga reading order: top-to-bottom bands (band = 0.12), then RTL or LTR.
  const rtl = direction !== "ltr"
  kept.sort((a, b) => {
    const cyA = a.y + a.h / 2
    const cyB = b.y + b.h / 2
    if (Math.abs(cyA - cyB) > 0.12) return cyA - cyB
    const cxA = a.x + a.w / 2
    const cxB = b.x + b.w / 2
    return rtl ? cxB - cxA : cxA - cxB
  })
  return kept
}

export function detectAllBubblesOnImage(image, options) {
  const natW = image?.naturalWidth ?? 0
  const natH = image?.naturalHeight ?? 0
  if (!natW || !natH) return []
  const scale = Math.min(1, 640 / Math.max(natW, natH))
  const width = Math.max(16, Math.round(natW * scale))
  const height = Math.max(16, Math.round(natH * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  return detectAllBubbles(pixels, width, height, options)
}
