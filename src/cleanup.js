export const cleanupRectangle = (box) => box.cleanupRect ?? box.originalBox ?? box

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
  const source = pixels.data.slice()
  const radius = Math.abs(expand)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      let alpha = expand > 0 ? 0 : 255
      if (expand < 0 && (x < radius || y < radius || x + radius >= canvas.width || y + radius >= canvas.height)) alpha = 0
      for (let yy = Math.max(0, y - radius); yy <= Math.min(canvas.height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(canvas.width - 1, x + radius); xx++) {
          const value = source[(yy * canvas.width + xx) * 4 + 3]
          alpha = expand > 0 ? Math.max(alpha, value) : Math.min(alpha, value)
        }
      }
      pixels.data[(y * canvas.width + x) * 4 + 3] = alpha
    }
  }
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
