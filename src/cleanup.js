export const cleanupRectangle = (box) => box.cleanupRect ?? box.originalBox ?? box

export function applyAlphaExpand(alphaBytes, width, height, expand) {
  if (!expand) return alphaBytes
  const radius = Math.abs(expand)
  const dilate = expand > 0
  const temp = new Uint8Array(width * height)
  const output = new Uint8Array(width * height)
  if (radius === 1) {
    alphaPass3(alphaBytes, temp, width, height, 1, width, dilate)
    alphaPass3(temp, output, height, width, width, 1, dilate)
    return output
  }
  const deque = new Int32Array(Math.max(width, height))
  alphaPass(alphaBytes, temp, width, height, 1, width, radius, dilate, deque)
  alphaPass(temp, output, height, width, width, 1, radius, dilate, deque)
  return output
}

function alphaPass3(source, target, length, lines, stride, lineStride, dilate) {
  for (let line = 0; line < lines; line++) {
    const base = line * lineStride
    for (let center = 1; center < length - 1; center++) {
      const index = base + center * stride
      const previous = source[index - stride]
      const current = source[index]
      const next = source[index + stride]
      target[index] = dilate ? Math.max(previous, current, next) : Math.min(previous, current, next)
    }
    if (!dilate || !length) continue
    const last = base + (length - 1) * stride
    target[base] = length === 1 ? source[base] : Math.max(source[base], source[base + stride])
    target[last] = length === 1 ? source[last] : Math.max(source[last - stride], source[last])
  }
}

function alphaPass(source, target, length, lines, stride, lineStride, radius, dilate, deque) {
  // The front is the strongest alpha in the current window. Each sample enters and leaves once.
  for (let line = 0; line < lines; line++) {
    const base = line * lineStride
    let head = 0, tail = 0, next = 0
    for (let center = 0; center < length; center++) {
      const left = center - radius
      const right = center + radius
      while (head < tail && deque[head] < left) head++
      while (next < length && next <= right) {
        const value = source[base + next * stride]
        while (head < tail) {
          const previous = source[base + deque[tail - 1] * stride]
          if (dilate ? previous > value : previous < value) break
          tail--
        }
        deque[tail++] = next++
      }
      if (dilate || (left >= 0 && right < length)) {
        target[base + center * stride] = source[base + deque[head] * stride]
      }
    }
  }
}

// Stroke widths use the shorter image dimension, so masks survive zoom and export.
export function paintCleanupMask(canvas, box, image, left, top) {
  const context = canvas.getContext("2d")
  context.fillStyle = "#fff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.lineCap = "round"
  context.lineJoin = "round"
  for (const stroke of box.cleanupStrokes ?? []) {
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over"
    context.lineWidth = stroke.size * Math.min(image.naturalWidth, image.naturalHeight)
    context.beginPath()
    const points = stroke.points.map(({ x, y }) => ({
      x: x * image.naturalWidth - left, y: y * image.naturalHeight - top,
    }))
    context.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) context.lineTo(point.x, point.y)
    if (points.length === 1) context.lineTo(points[0].x + .01, points[0].y)
    context.stroke()
  }
  context.globalCompositeOperation = "source-over"
  const expand = box.cleanupExpand ?? 0
  if (!expand) return
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const alpha = new Uint8Array(canvas.width * canvas.height)
  for (let index = 0; index < alpha.length; index++) alpha[index] = pixels.data[index * 4 + 3]
  const expanded = applyAlphaExpand(alpha, canvas.width, canvas.height, expand)
  for (let index = 0; index < expanded.length; index++) pixels.data[index * 4 + 3] = expanded[index]
  context.putImageData(pixels, 0, 0)
}

export function maskCleanup(patch, box, image) {
  if (!patch || (!box.cleanupStrokes?.length && !box.cleanupExpand)) return patch
  const mask = document.createElement("canvas")
  mask.width = patch.patch.width
  mask.height = patch.patch.height
  paintCleanupMask(mask, box, image, patch.left, patch.top)
  const context = patch.patch.getContext("2d")
  context.globalCompositeOperation = "destination-in"
  context.drawImage(mask, 0, 0)
  context.globalCompositeOperation = "source-over"
  return patch
}

export async function nativeMaskCleanup(patch, box, image) {
  const native = globalThis.khungThoaiDesktop?.native
  if (!patch || !native) return maskCleanup(patch, box, image)
  if (!box.cleanupStrokes?.length && !box.cleanupExpand) return patch
  const { width, height } = patch.patch
  const context = patch.patch.getContext("2d")
  const pixels = context.getImageData(0, 0, width, height).data
  try {
    const { data } = await native("mask", {
      width, height, left: patch.left, top: patch.top,
      imageWidth: image.naturalWidth, imageHeight: image.naturalHeight,
      strokes: box.cleanupStrokes ?? [], expand: box.cleanupExpand ?? 0,
    }, pixels)
    if (data.length !== pixels.length) throw new Error("Invalid native mask.")
    context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    return patch
  } catch {
    // Preserve brush protection if the optional native worker is unavailable.
    return maskCleanup(patch, box, image)
  }
}
