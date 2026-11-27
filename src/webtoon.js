import { filenameStem } from "./io.js"

/**
 * Finds clean horizontal cut positions (in image pixels) along flat/empty gutters
 * so long webtoon/manhwa strips are sliced without cutting through speech bubbles or artwork.
 */
export function findSmartSliceCuts(
  pixels,
  width,
  height,
  { targetHeight = 1600, minSliceHeight = 500, searchWindow = 320 } = {},
) {
  if (!pixels || width <= 0 || height <= 0) return []
  const target = Math.max(200, Math.round(Number(targetHeight) || 1600))
  const minH = Math.max(100, Math.min(target, Math.round(Number(minSliceHeight) || Math.round(target * 0.45))))
  if (height <= target + minH * 0.35) {
    return [{ top: 0, bottom: height, height }]
  }

  // Compute per-row edge + variance energy (flat gutters have energy near 0).
  const strideX = Math.max(1, Math.floor(width / 256))
  const rowEnergy = new Float32Array(height)
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4
    let prevLuma = -1
    let diffSum = 0
    let lumaSum = 0
    let lumaSqSum = 0
    let samples = 0
    for (let x = 0; x < width; x += strideX) {
      const o = rowOff + x * 4
      const luma = (pixels[o] * 77 + pixels[o + 1] * 150 + pixels[o + 2] * 29) >> 8
      if (prevLuma >= 0) diffSum += Math.abs(luma - prevLuma)
      prevLuma = luma
      lumaSum += luma
      lumaSqSum += luma * luma
      samples++
    }
    if (samples > 1) {
      const mean = lumaSum / samples
      const variance = Math.max(0, lumaSqSum / samples - mean * mean)
      const avgEdge = diffSum / (samples - 1)
      rowEnergy[y] = avgEdge * 2.0 + Math.sqrt(variance)
    }
  }

  // 5-row vertical smoothing so a 1px horizontal line gap inside text is not treated as a gutter.
  const smooth = new Float32Array(height)
  for (let y = 0; y < height; y++) {
    let sum = 0
    let count = 0
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy
      if (ny >= 0 && ny < height) {
        sum += rowEnergy[ny]
        count++
      }
    }
    smooth[y] = sum / Math.max(1, count)
  }

  const slices = []
  let top = 0
  const window = Math.max(32, Math.round(Number(searchWindow) || Math.round(target * 0.25)))

  while (top < height) {
    const remaining = height - top
    if (remaining <= target + minH * 0.35) {
      slices.push({ top, bottom: height, height: remaining })
      break
    }
    const ideal = top + target
    const lo = Math.max(top + minH, ideal - window)
    const hi = Math.min(height - minH, ideal + window)
    if (hi <= lo) {
      const cut = Math.min(height, ideal)
      slices.push({ top, bottom: cut, height: cut - top })
      top = cut
      continue
    }
    let bestY = ideal
    let bestScore = Infinity
    for (let y = lo; y <= hi; y++) {
      // Combine gutter energy with a tiny tie-breaker preferring proximity to ideal height.
      const distPenalty = (Math.abs(y - ideal) / Math.max(1, window)) * 0.35
      const score = smooth[y] + distPenalty
      if (score < bestScore) {
        bestScore = score
        bestY = y
      }
    }
    slices.push({ top, bottom: bestY, height: bestY - top })
    top = bestY
  }

  return slices
}

/**
 * Smart-slices a single tall webtoon page into clean PNG Files along detected empty gutters.
 */
export async function smartSlicePageImage(page, { targetHeight = 1600 } = {}) {
  const img = page?.image
  const width = img?.naturalWidth ?? 0
  const height = img?.naturalHeight ?? 0
  if (!width || !height) throw new Error("Trang không có ảnh hợp lệ để cắt.")

  // Downscale horizontally for fast gutter detection if image is very wide.
  const probeScale = Math.min(1, 512 / width)
  const probeW = Math.max(16, Math.round(width * probeScale))
  const probeH = Math.max(16, Math.round(height * probeScale))
  const probeCanvas = document.createElement("canvas")
  probeCanvas.width = probeW
  probeCanvas.height = probeH
  const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true })
  probeCtx.drawImage(img, 0, 0, probeW, probeH)
  const probePixels = probeCtx.getImageData(0, 0, probeW, probeH).data

  const probeSlices = findSmartSliceCuts(probePixels, probeW, probeH, {
    targetHeight: Math.round(targetHeight * probeScale),
    minSliceHeight: Math.round(Math.max(300, targetHeight * 0.4) * probeScale),
    searchWindow: Math.round(Math.max(120, targetHeight * 0.25) * probeScale),
  })
  if (probeSlices.length <= 1) return []

  const stem = filenameStem(page.name || "webtoon")
  const files = []
  let prevBottom = 0
  for (let i = 0; i < probeSlices.length; i++) {
    const isLast = i === probeSlices.length - 1
    const top = prevBottom
    const bottom = isLast ? height : Math.min(height, Math.max(top + 16, Math.round(probeSlices[i].bottom / probeScale)))
    const sliceH = bottom - top
    prevBottom = bottom
    if (sliceH <= 0) continue

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = sliceH
    const ctx = canvas.getContext("2d")
    ctx.drawImage(img, 0, top, width, sliceH, 0, 0, width, sliceH)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("Không thể mã hóa mảnh ảnh đã cắt.")
    const num = String(i + 1).padStart(2, "0")
    files.push(new File([blob], `${stem}-${num}.png`, { type: "image/png" }))
  }
  return files
}

/**
 * Stitches a sequence of pages vertically into one or more PNG Files (auto-chunking safely
 * below Nixio's 28 MP single-image limit).
 */
export async function stitchPagesVertically(pages, { maxPixels = 25_000_000, background = "#ffffff" } = {}) {
  if (!Array.isArray(pages) || pages.length < 2) {
    throw new Error("Cần chọn ít nhất 2 trang để ghép dọc.")
  }
  const targetWidth = Math.max(...pages.map((p) => p.image?.naturalWidth ?? 0))
  if (!targetWidth) throw new Error("Không tìm thấy kích thước ảnh hợp lệ để ghép.")

  const scaledHeights = pages.map((p) => {
    const w = p.image.naturalWidth
    const h = p.image.naturalHeight
    return Math.max(1, Math.round((h * targetWidth) / w))
  })

  // Partition into chunks that stay within maxPixels and canvas height limit (16384px).
  const maxChunkHeight = Math.min(16000, Math.floor(maxPixels / targetWidth))
  const chunks = []
  let current = []
  let currentH = 0
  for (let i = 0; i < pages.length; i++) {
    const sh = scaledHeights[i]
    if (current.length && currentH + sh > maxChunkHeight) {
      chunks.push({ items: current, height: currentH })
      current = []
      currentH = 0
    }
    current.push({ page: pages[i], height: sh })
    currentH += sh
  }
  if (current.length) chunks.push({ items: current, height: currentH })

  const baseStem = filenameStem(pages[0].name || "webtoon")
  const files = []
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    const canvas = document.createElement("canvas")
    canvas.width = targetWidth
    canvas.height = chunk.height
    const ctx = canvas.getContext("2d")
    ctx.fillStyle = background
    ctx.fillRect(0, 0, targetWidth, chunk.height)
    let y = 0
    for (const item of chunk.items) {
      ctx.drawImage(item.page.image, 0, y, targetWidth, item.height)
      y += item.height
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("Không thể tạo ảnh sau khi ghép dọc.")
    const suffix = chunks.length > 1 ? `-ghep-${String(c + 1).padStart(2, "0")}` : "-ghep"
    files.push(new File([blob], `${baseStem}${suffix}.png`, { type: "image/png" }))
  }
  return files
}
