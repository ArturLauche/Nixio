import { filenameStem } from "./io.js"

// Chromium/WebKit reject canvases wider or taller than 16384px. Keep the vertical
// budget below that hard cap so the largest generated strip still rasterizes.
const MAX_CANVAS_WIDTH = 16_384
const MAX_CANVAS_HEIGHT = 16_000
const DEFAULT_MAX_PIXELS = 25_000_000
// Splitting beyond this many strips means the pages are pathologically tall or differ
// wildly in width; stop before encoding hundreds of canvases.
const MAX_STITCH_CHUNKS = 32
// Gutter detection runs on a probe that is bounded in both dimensions so very
// tall/narrow pages never allocate an image-sized canvas.
const PROBE_MAX_WIDTH = 512
const PROBE_MAX_HEIGHT = 4096
const MIN_SLICE_SOURCE_PX = 16
// Algorithmic floors in the units of the supplied pixel buffer. They are deliberately
// small so callers working in downscaled probe pixels keep their requested heights.
const MIN_TARGET_ROWS = 4
const MIN_SLICE_ROWS = 2
const MIN_WINDOW_ROWS = 2

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function imageSize(page) {
  const width = Math.floor(Number(page?.image?.naturalWidth))
  const height = Math.floor(Number(page?.image?.naturalHeight))
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : null
}

/**
 * Finds clean horizontal cut positions (in image pixels) along flat/empty gutters
 * so long webtoon/manhwa strips are sliced without cutting through speech bubbles or artwork.
 *
 * `targetHeight`, `minSliceHeight` and `searchWindow` are interpreted in pixels of the
 * supplied buffer, so callers may pass values already scaled for a smaller probe.
 */
export function findSmartSliceCuts(
  pixels,
  width,
  height,
  { targetHeight = 1600, minSliceHeight = 500, searchWindow = 320 } = {},
) {
  if (!pixels || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return []
  if (pixels.length < width * height * 4) return []
  const target = Math.max(MIN_TARGET_ROWS, Math.round(positiveNumber(targetHeight, 1600)))
  const minH = Math.min(
    target,
    Math.max(MIN_SLICE_ROWS, Math.round(positiveNumber(minSliceHeight, Math.round(target * 0.45)))),
  )
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
  const window = Math.max(MIN_WINDOW_ROWS, Math.round(positiveNumber(searchWindow, Math.round(target * 0.25))))

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
 *
 * Detection uses a bounded probe; requested heights stay in original image units and are
 * converted to probe rows before the cut search so wide pages are not sliced too tall.
 */
export async function smartSlicePageImage(page, { targetHeight = 1600 } = {}) {
  const img = page?.image
  const width = Math.floor(Number(img?.naturalWidth))
  const height = Math.floor(Number(img?.naturalHeight))
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Trang không có ảnh hợp lệ để cắt.")
  }
  const requestedTarget = Number(targetHeight)
  const target = Math.max(1, Math.round(Number.isFinite(requestedTarget) && requestedTarget > 0 ? requestedTarget : 1600))

  // Bound the probe on both axes; track the real vertical ratio when the page is taller
  // than the cap (the horizontal ratio may also exceed 1 for degenerate narrow pages).
  const probeW = Math.max(16, Math.min(width, PROBE_MAX_WIDTH))
  const probeH = Math.min(PROBE_MAX_HEIGHT, Math.max(16, Math.round((height * probeW) / width)))
  const scaleY = probeH / height
  const probeCanvas = document.createElement("canvas")
  probeCanvas.width = probeW
  probeCanvas.height = probeH
  const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true })
  probeCtx.drawImage(img, 0, 0, probeW, probeH)
  const probePixels = probeCtx.getImageData(0, 0, probeW, probeH).data

  const probeSlices = findSmartSliceCuts(probePixels, probeW, probeH, {
    targetHeight: Math.max(1, Math.round(target * scaleY)),
    minSliceHeight: Math.max(1, Math.round(Math.max(300, target * 0.4) * scaleY)),
    searchWindow: Math.max(1, Math.round(Math.max(120, target * 0.25) * scaleY)),
  })
  if (probeSlices.length <= 1) return []

  // Map probe cuts back to source rows. Kept cuts are strictly increasing, so source
  // coverage stays contiguous, and slivers are merged instead of emitting tiny files.
  const cuts = []
  let prevBottom = 0
  for (let i = 0; i < probeSlices.length; i++) {
    const isLast = i === probeSlices.length - 1
    const mapped = isLast ? height : Math.round(probeSlices[i].bottom / scaleY)
    const bottom = Math.min(height, Math.max(prevBottom, mapped))
    if (bottom <= prevBottom) continue
    if (!isLast && bottom - prevBottom < MIN_SLICE_SOURCE_PX) continue
    cuts.push(bottom)
    prevBottom = bottom
  }
  if (cuts.length > 1 && height - cuts[cuts.length - 2] < MIN_SLICE_SOURCE_PX) cuts.splice(cuts.length - 2, 1)
  if (cuts.length <= 1) return []

  const stem = filenameStem(page.name || "webtoon")
  const files = []
  let top = 0
  for (const bottom of cuts) {
    const sliceH = bottom - top
    if (sliceH <= 0) continue

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = sliceH
    const ctx = canvas.getContext("2d")
    ctx.drawImage(img, 0, top, width, sliceH, 0, 0, width, sliceH)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("Không thể mã hóa mảnh ảnh đã cắt.")
    const num = String(files.length + 1).padStart(2, "0")
    files.push(new File([blob], `${stem}-${num}.png`, { type: "image/png" }))
    top = bottom
  }
  return files
}

/**
 * Plans bounded vertical stitch chunks: every chunk stays within the canvas dimension
 * cap and the configured pixel budget, and a page taller than one chunk is split into
 * balanced, contiguous source bands instead of being forced into one oversized canvas.
 */
export function planVerticalStitch(pages, { maxPixels = DEFAULT_MAX_PIXELS } = {}) {
  if (!Array.isArray(pages) || pages.length < 2) {
    throw new Error("Cần chọn ít nhất 2 trang để ghép dọc.")
  }
  const requestedPixels = Number(maxPixels)
  if (!Number.isFinite(requestedPixels) || requestedPixels < 1) {
    throw new Error("Giới hạn điểm ảnh khi ghép dọc không hợp lệ.")
  }
  const pixelLimit = Math.floor(requestedPixels)

  const sources = pages.map((page) => {
    const size = imageSize(page)
    if (!size) throw new Error("Trang không có kích thước ảnh hợp lệ để ghép.")
    return { page, ...size }
  })

  // Preserve the legacy common width, but cap it at the canvas limit and downscale
  // proportionally when a source is wider than any canvas can be.
  const sourceWidth = sources.reduce((widest, source) => Math.max(widest, source.width), 0)
  const width = Math.min(sourceWidth, MAX_CANVAS_WIDTH)
  if (width > pixelLimit) {
    throw new Error(`Giới hạn điểm ảnh (${pixelLimit} px) nhỏ hơn chiều rộng ảnh ghép (${width} px).`)
  }
  const rowLimit = Math.min(MAX_CANVAS_HEIGHT, Math.floor(pixelLimit / width))
  const scaledRows = sources.reduce(
    (total, source) => total + Math.max(1, Math.round((source.height * width) / source.width)),
    0,
  )
  if (Math.ceil(scaledRows / rowLimit) > MAX_STITCH_CHUNKS) {
    throw tooManyStitchChunks(Math.ceil(scaledRows / rowLimit))
  }

  const pieces = []
  for (const source of sources) {
    const totalHeight = Math.max(1, Math.round((source.height * width) / source.width))
    const parts = Math.ceil(totalHeight / rowLimit)
    for (let part = 0; part < parts; part++) {
      const destTop = Math.floor((totalHeight * part) / parts)
      const destBottom = Math.floor((totalHeight * (part + 1)) / parts)
      const sourceTop = Math.floor((source.height * destTop) / totalHeight)
      const sourceBottom = Math.floor((source.height * destBottom) / totalHeight)
      pieces.push({
        page: source.page,
        sourceY: sourceTop,
        sourceWidth: source.width,
        sourceHeight: Math.max(1, sourceBottom - sourceTop),
        height: destBottom - destTop,
      })
    }
  }

  const chunks = []
  let current = []
  let currentHeight = 0
  for (const piece of pieces) {
    if (current.length && currentHeight + piece.height > rowLimit) {
      chunks.push({ height: currentHeight, items: current })
      current = []
      currentHeight = 0
    }
    current.push({ ...piece, destY: currentHeight })
    currentHeight += piece.height
  }
  if (current.length) chunks.push({ height: currentHeight, items: current })
  if (chunks.length > MAX_STITCH_CHUNKS) throw tooManyStitchChunks(chunks.length)

  return { width, rowLimit, chunks }
}

function tooManyStitchChunks(count) {
  return new Error(
    `Cần ${count} mảnh ghép, vượt giới hạn ${MAX_STITCH_CHUNKS} mảnh. Hãy chọn các trang có chiều rộng gần nhau hoặc ghép ít trang hơn.`,
  )
}

/**
 * Stitches a sequence of pages vertically into one or more PNG Files. Every chunk is
 * bounded by the 16384px canvas dimension and the configured pixel budget; pages that
 * cannot fit one chunk are split into balanced bands without changing aspect ratio.
 */
export async function stitchPagesVertically(
  pages,
  { maxPixels = DEFAULT_MAX_PIXELS, background = "#ffffff" } = {},
) {
  const { width, chunks } = planVerticalStitch(pages, { maxPixels })
  const baseStem = filenameStem(pages[0].name || "webtoon")
  const files = []
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = chunk.height
    const ctx = canvas.getContext("2d")
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, chunk.height)
    for (const item of chunk.items) {
      ctx.drawImage(
        item.page.image,
        0,
        item.sourceY,
        item.sourceWidth,
        item.sourceHeight,
        0,
        item.destY,
        width,
        item.height,
      )
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("Không thể tạo ảnh sau khi ghép dọc.")
    const suffix = chunks.length > 1 ? `-ghep-${String(c + 1).padStart(2, "0")}` : "-ghep"
    files.push(new File([blob], `${baseStem}${suffix}.png`, { type: "image/png" }))
  }
  return files
}
