import { nativeCapabilities } from "./native.js"
import { paintRedraw, redrawLayout } from "./redraw.js"

const psdFonts = { Arial: "ArialMT", Georgia: "Georgia", Verdana: "Verdana", "Times New Roman": "TimesNewRomanPSMT" }
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function makeBox(page, rectangle, text = "Lời thoại mới") {
  return {
    id: crypto.randomUUID(),
    ...rectangle,
    text,
    size: clamp(Math.round(page.image.naturalWidth * 0.033), 12, 400),
    font: "Arial",
    color: "#171717",
    align: "center",
    rotation: 0,
    fill: true,
  }
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

function baseCanvas(page) {
  const canvas = makeCanvas(page.image.naturalWidth, page.image.naturalHeight)
  canvas.getContext("2d").drawImage(page.image, 0, 0)
  return canvas
}

function wrap(context, text, width) {
  return text.split(/\r?\n/).flatMap((paragraph) => {
    const lines = []
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + " " + word : word
      if (line && context.measureText(candidate).width > width) {
        lines.push(line)
        line = ""
      }
      if (context.measureText(word).width > width) {
        for (const char of word) {
          if (line && context.measureText(line + char).width > width) {
            lines.push(line)
            line = ""
          }
          line += char
        }
      } else {
        line = line ? line + " " + word : word
      }
    }
    lines.push(line)
    return lines
  })
}

function geometry(context, box, width, height) {
  const w = box.w * width
  const h = box.h * height
  const padding = Math.max(2, Math.min(w, h) * 0.07)
  context.font = box.size + 'px "' + box.font + '", sans-serif'
  const lines = wrap(context, box.text, Math.max(1, w - padding * 2))
  const lineHeight = box.size * 1.15
  return {
    w, h, lines, lineHeight,
    cx: (box.x + box.w / 2) * width,
    cy: (box.y + box.h / 2) * height,
    offsetX: { left: -w / 2 + padding, center: 0, right: w / 2 - padding }[box.align],
    offsetY: -(lines.length - 1) * lineHeight / 2,
    angle: box.rotation * Math.PI / 180,
  }
}

function drawBox(canvas, box, {
  background = true, text = true, width = canvas.width, height = canvas.height, left = 0, top = 0,
} = {}) {
  const context = canvas.getContext("2d")
  context.save()
  const g = geometry(context, box, width, height)
  context.translate(g.cx - left, g.cy - top)
  context.rotate(g.angle)
  context.beginPath()
  context.rect(-g.w / 2, -g.h / 2, g.w, g.h)
  context.clip()
  if (background && box.fill) {
    context.fillStyle = "#fff"
    context.fillRect(-g.w / 2, -g.h / 2, g.w, g.h)
  }
  if (text) {
    context.fillStyle = box.color
    context.textAlign = box.align
    context.textBaseline = "middle"
    g.lines.forEach((line, index) => context.fillText(line, g.offsetX, g.offsetY + index * g.lineHeight))
  }
  context.restore()
}

function paintPage(canvas, page, patches, { showCleanup = true, showText = true } = {}) {
  const width = page.image.naturalWidth
  const height = page.image.naturalHeight
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const context = canvas.getContext("2d")
  context.clearRect(0, 0, width, height)
  context.drawImage(page.image, 0, 0)
  if (showCleanup) paintRedraw(canvas, patches)
  if (showText) page.boxes.forEach((box) => drawBox(canvas, box))
}

export function drawPage(canvas, page, options) {
  const redraw = redrawLayout(page)
  paintPage(canvas, page, redraw.patches, options)
  return redraw.pending
}

function croppedLayer({ width, height }, box, options) {
  const angle = box.rotation * Math.PI / 180
  const halfWidth = (Math.abs(Math.cos(angle)) * box.w * width + Math.abs(Math.sin(angle)) * box.h * height) / 2
  const halfHeight = (Math.abs(Math.sin(angle)) * box.w * width + Math.abs(Math.cos(angle)) * box.h * height) / 2
  const cx = (box.x + box.w / 2) * width
  const cy = (box.y + box.h / 2) * height
  const left = Math.max(0, Math.floor(cx - halfWidth))
  const top = Math.max(0, Math.floor(cy - halfHeight))
  const right = Math.min(width, Math.ceil(cx + halfWidth))
  const bottom = Math.min(height, Math.ceil(cy + halfHeight))
  const crop = makeCanvas(right - left, bottom - top)
  drawBox(crop, box, { width, height, left, top, ...options })
  return { canvas: crop, left, top }
}

function psdTextLayer(canvas, box) {
  const g = geometry(canvas.getContext("2d"), box, canvas.width, canvas.height)
  const cos = Math.cos(g.angle)
  const sin = Math.sin(g.angle)
  const baseline = g.offsetY + box.size * 0.34
  const rgb = box.color.slice(1).match(/../g).map((value) => parseInt(value, 16))
  return {
    name: box.text.split(/\r?\n/)[0].slice(0, 72),
    text: {
      text: g.lines.join("\n"),
      transform: [cos, sin, -sin, cos, g.cx + g.offsetX * cos - baseline * sin, g.cy + g.offsetX * sin + baseline * cos],
      style: { font: { name: psdFonts[box.font] }, fontSize: box.size, leading: g.lineHeight, fillColor: { r: rgb[0], g: rgb[1], b: rgb[2] } },
      paragraphStyle: { justification: box.align },
    },
  }
}

export async function nativePageLayers(page) {
  const redraw = redrawLayout(page, { cancellable: false })
  if (redraw.pending) await redraw.pending
  const base = baseCanvas(page)
  const text = makeCanvas(base.width, base.height)
  page.boxes.forEach((box) => drawBox(text, box))
  const read = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
  let patches = redraw.patches
  if (patches.reduce((sum, { patch }) => sum + patch.width * patch.height, 0) > base.width * base.height) {
    const merged = makeCanvas(base.width, base.height)
    paintRedraw(merged, patches)
    patches = [{ patch: merged, left: 0, top: 0 }]
  }
  const parts = [read(base), read(text), ...patches.map(({ patch }) => read(patch))]
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { data.set(part, offset); offset += part.length }
  return {
    options: { width: base.width, height: base.height, patches: patches.map(({ patch, left, top }) => ({
      left, top, width: patch.width, height: patch.height,
    })) },
    data,
  }
}

export async function exportPage(page, format) {
  const redraw = redrawLayout(page, { cancellable: false })
  if (redraw.pending) await redraw.pending
  if (format === "png" && globalThis.khungThoaiDesktop?.native) {
    if (await nativeCapabilities()) {
      const { options, data } = await nativePageLayers(page)
      const response = await globalThis.khungThoaiDesktop.native("png", options, data)
      return new Blob([response.data], { type: "image/png" })
    }
  }
  const composite = makeCanvas(page.image.naturalWidth, page.image.naturalHeight)
  paintPage(composite, page, redraw.patches)
  if (format === "png") {
    const result = await new Promise((resolve) => composite.toBlob(resolve, "image/png"))
    if (!result) throw new Error("Không thể tạo ảnh PNG.")
    return result
  }
  const { writePsd } = await import("ag-psd")
  const base = baseCanvas(page)
  const children = [{ name: "Ảnh gốc", canvas: base }]
  if (redraw.patches.length) {
    const cleaned = makeCanvas(base.width, base.height)
    paintRedraw(cleaned, redraw.patches)
    children.push({ name: "Nền đã xóa chữ", canvas: cleaned })
  }
  const dialogue = []
  for (const box of page.boxes) {
    const title = box.text.split(/\r?\n/)[0].slice(0, 72)
    if (format === "raster") {
      children.push({ name: title, ...croppedLayer(base, box) })
      continue
    }
    if (box.fill) {
      dialogue.push({ name: "Nền / " + title, ...croppedLayer(base, box, { text: false }) })
    }
    dialogue.push({ ...psdTextLayer(composite, box), ...croppedLayer(base, box, { background: false }) })
  }
  if (dialogue.length) children.push({ name: "Thoại", opened: true, children: dialogue })
  const psd = writePsd({ width: base.width, height: base.height, canvas: composite, children }, { invalidateTextLayers: format === "psd" })
  return new Blob([psd], { type: "image/vnd.adobe.photoshop" })
}

export function textOverflows(page, box) {
  const context = document.createElement("canvas").getContext("2d")
  const g = geometry(context, box, page.image.naturalWidth, page.image.naturalHeight)
  const padding = Math.max(2, Math.min(g.w, g.h) * .07)
  return g.lines.length * g.lineHeight > g.h - padding * 2 ||
    g.lines.some((line) => context.measureText(line).width > g.w - padding * 2 + .01)
}
