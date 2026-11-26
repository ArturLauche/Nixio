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
}

export function maskCleanup(patch, box, image) {
  if (!patch || !box.cleanupStrokes?.length) return patch
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
