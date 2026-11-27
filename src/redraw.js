import { cleanupRectangle, maskCleanup, nativeMaskCleanup } from "./cleanup.js"
const luma = (pixels, index) => (pixels[index] * 54 + pixels[index + 1] * 183 + pixels[index + 2] * 19) / 256

function estimatePaper(pixels, width, height, inner) {
  let sampled = 0
  let bright = 0
  let red = 0, green = 0, blue = 0
  const rows = new Uint32Array(height)
  const columns = new Uint32Array(width)
  const darkRows = new Uint32Array(height)
  const darkColumns = new Uint32Array(width)
  const darkSamples = []
  const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 1200)))
  const sample = (x, y) => {
    const index = (y * width + x) * 4
    if (pixels[index + 3] < 240) return
    sampled++
    rows[y]++
    columns[x]++
    if (luma(pixels, index) < 160) {
      darkRows[y]++
      darkColumns[x]++
      darkSamples.push([x, y])
      return
    }
    bright++
    red += pixels[index]
    green += pixels[index + 1]
    blue += pixels[index + 2]
  }
  for (let y = 0; y < height; y += stride) {
    if (y >= inner.top && y < inner.bottom) {
      for (let x = 0; x < inner.left; x += stride) sample(x, y)
      for (let x = inner.right; x < width; x += stride) sample(x, y)
    } else {
      for (let x = 0; x < width; x += stride) sample(x, y)
    }
  }
  if (sampled < 8 || bright / sampled < .8) return null
  // Straight panel borders can cross the sample area. Scattered dark pixels suggest texture.
  const scattered = darkSamples.filter(([x, y]) =>
    (rows[y] < 5 || darkRows[y] / rows[y] < .65) &&
    (columns[x] < 5 || darkColumns[x] / columns[x] < .65)).length
  if (scattered / sampled > .05) return null
  return [red / bright, green / bright, blue / bright]
}

function cleanupPatch(image, rect, mode = "auto") {
  const { naturalWidth, naturalHeight } = image
  const left = Math.max(0, Math.floor(rect.x * naturalWidth))
  const top = Math.max(0, Math.floor(rect.y * naturalHeight))
  const right = Math.min(naturalWidth, Math.ceil((rect.x + rect.w) * naturalWidth))
  const bottom = Math.min(naturalHeight, Math.ceil((rect.y + rect.h) * naturalHeight))
  const width = right - left
  const height = bottom - top
  if (width < 2 || height < 2 || width * height > Math.min(1_250_000, naturalWidth * naturalHeight * .32)) return null

  const margin = mode === "content-aware"
    ? Math.max(16, Math.min(48, Math.ceil(Math.min(width, height) * .35)))
    : Math.max(3, Math.min(24, Math.ceil(Math.min(width, height) * .18)))
  const sampleX = Math.max(0, left - margin)
  const sampleY = Math.max(0, top - margin)
  const sampleWidth = Math.min(naturalWidth, right + margin) - sampleX
  const sampleHeight = Math.min(naturalHeight, bottom + margin) - sampleY
  const source = document.createElement("canvas")
  source.width = sampleWidth
  source.height = sampleHeight
  const context = source.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, -sampleX, -sampleY)
  const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight)
  const inner = { left: left - sampleX, top: top - sampleY, right: right - sampleX, bottom: bottom - sampleY }
  const useCanvas = () => {
    const result = cleanupPaper(context, data, sampleWidth, sampleHeight, inner)
    return result ? createPatch(result, left, top) : null
  }
  if (mode === "content-aware" && globalThis.khungThoaiDesktop?.native && sampleWidth * sampleHeight <= 1_600_000) {
    return globalThis.khungThoaiDesktop
      .native(
        "content_aware_cleanup",
        { width: sampleWidth, height: sampleHeight, inner },
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      .then((response) => {
        const bytes = response?.data
        if (!ArrayBuffer.isView(bytes) || bytes.byteLength !== width * height * 4) return null
        return createPatch(new ImageData(new Uint8ClampedArray(bytes), width, height), left, top)
      })
      .catch(() => null)
  }
  const redraw = globalThis.khungThoaiDesktop?.redrawTexture
  if (!redraw || sampleWidth * sampleHeight > 1_600_000) return useCanvas()
  return redraw({ width: sampleWidth, height: sampleHeight, inner, pixels: data })
    .then((bytes) => {
      if (bytes === undefined) return useCanvas()
      if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.byteLength !== width * height * 4) return null
      return createPatch(new ImageData(new Uint8ClampedArray(bytes), width, height), left, top)
    })
    .catch(() => null)
}

function cleanupPaper(context, data, sampleWidth, sampleHeight, inner) {
  const paper = estimatePaper(data, sampleWidth, sampleHeight, inner)
  if (!paper) return null
  const width = inner.right - inner.left
  const height = inner.bottom - inner.top
  const background = luma(paper, 0)
  const result = context.createImageData(width, height)
  let changed = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = ((inner.top + y) * sampleWidth + inner.left + x) * 4
      if (data[offset + 3] < 240 || background - luma(data, offset) < 36) continue
      const out = (y * width + x) * 4
      result.data.set(paper, out)
      result.data[out + 3] = 255
      changed++
    }
  }
  if (!changed || changed > width * height * .48) return null
  return result
}

function createPatch(result, left, top) {
  const patch = document.createElement("canvas")
  patch.width = result.width
  patch.height = result.height
  patch.getContext("2d").putImageData(result, 0, 0)
  return { patch, left, top }
}

const cachedRedraw = new Map()
const emptyLayout = { patches: [], pending: null }
let desktopQueue = Promise.resolve()

export function redrawLayout(page, { cancellable = true } = {}) {
  const boxes = page.boxes.filter((box) => box.cleanup)
  const rectangles = boxes.map(cleanupRectangle)
  if (!rectangles.length) return emptyLayout
  const signature = JSON.stringify(
    rectangles.map(({ x, y, w, h }, index) => [
      x, y, w, h, boxes[index].cleanupMode ?? "auto", boxes[index].cleanupStrokes, boxes[index].cleanupExpand,
    ]),
  )
  const cached = cachedRedraw.get(page.image)
  if (cached?.signature === signature) {
    if (!cancellable) cached.cancellable = false
    return cached
  }
  const modes = boxes.map((box) => box.cleanupMode ?? "auto")
  const masks = boxes.map((box) => ({ cleanupStrokes: structuredClone(box.cleanupStrokes), cleanupExpand: box.cleanupExpand }))
  if (cached?.cancellable && cached.pending) cached.superseded = true
  // Schedule native samples serially and keep the initial canvas paint independent of native I/O.
  const layout = { signature, patches: [], pending: null, cancellable, superseded: false }
  if (globalThis.khungThoaiDesktop) {
    const task = desktopQueue.then(async () => {
      try {
        for (const [index, rectangle] of rectangles.entries()) {
          if (layout.superseded && layout.cancellable) return
          const patch = await cleanupPatch(page.image, rectangle, modes[index])
          if (layout.superseded && layout.cancellable) return
          if (patch) layout.patches.push(await nativeMaskCleanup(patch, masks[index], page.image))
        }
      } finally {
        layout.pending = null
      }
    })
    layout.pending = task
    desktopQueue = task.catch(() => {})
  } else {
    layout.patches = rectangles.map((rect, index) => maskCleanup(cleanupPatch(page.image, rect, modes[index]), masks[index], page.image)).filter(Boolean)
  }
  cachedRedraw.delete(page.image)
  cachedRedraw.set(page.image, layout)
  if (cachedRedraw.size > 2) {
    const oldestKey = cachedRedraw.keys().next().value
    const oldest = cachedRedraw.get(oldestKey)
    if (oldest?.cancellable && oldest.pending) oldest.superseded = true
    cachedRedraw.delete(oldestKey)
  }
  return layout
}

export function paintRedraw(canvas, patches) {
  const context = canvas.getContext("2d")
  patches.forEach(({ patch, left, top }) => context.drawImage(patch, left, top))
}
