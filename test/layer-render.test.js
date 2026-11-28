import assert from "node:assert/strict"
import test from "node:test"
import { drawPage, exportPage, nativePageLayers } from "../src/canvas.js"
import {
  addStroke, defaultLayers, duplicateLayer, moveLayer, removeStroke, setLayerHidden, setLayerOpacity,
  setStrokeHidden,
} from "../src/layers.js"

const contextKeys = [
  "globalAlpha", "fillStyle", "strokeStyle", "globalCompositeOperation", "font", "textAlign",
  "textBaseline", "lineWidth", "lineJoin", "miterLimit", "shadowBlur", "shadowColor",
  "shadowOffsetX", "shadowOffsetY",
]

const rounded = (value) => Math.round(value * 100) / 100

function contextFor(canvas) {
  const stack = []
  return {
    canvas,
    globalAlpha: 1, fillStyle: "", strokeStyle: "", globalCompositeOperation: "source-over",
    font: "", textAlign: "", textBaseline: "", lineWidth: 0, lineJoin: "", miterLimit: 0,
    shadowBlur: 0, shadowColor: "", shadowOffsetX: 0, shadowOffsetY: 0,
    save() { stack.push(Object.fromEntries(contextKeys.map((key) => [key, this[key]]))) },
    restore() { Object.assign(this, stack.pop() ?? {}) },
    translate() {}, rotate() {}, beginPath() {}, closePath() {}, clip() {}, rect() {},
    moveTo() {}, lineTo() {}, arcTo() {}, ellipse() {},
    fill() {}, fillRect() {}, clearRect() {},
    stroke() { canvas.ops.push(["stroke", this.strokeStyle, rounded(this.globalAlpha), this.globalCompositeOperation]) },
    drawImage(image, x, y) {
      canvas.ops.push(["draw", image?.naturalWidth ? "scan" : "canvas", x, y, rounded(this.globalAlpha)])
    },
    strokeText(text) { canvas.ops.push(["strokeText", text]) },
    fillText(text) { canvas.ops.push(["fillText", text, this.fillStyle, rounded(this.globalAlpha)]) },
    measureText(text) { return { width: text.length * 6 } },
    getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData() {},
  }
}

// Every canvas the renderer creates is recorded, so a test can inspect the page canvas, the per-layer
// canvases the strokes are drawn into and the export composite.
function mockDocument() {
  const original = globalThis.document
  const canvases = []
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, ops: [] }
      let context
      canvas.getContext = () => (context ??= contextFor(canvas))
      canvas.toBlob = (resolve, type) => resolve({ type, ops: canvas.ops })
      canvases.push(canvas)
      return canvas
    },
  }
  return {
    canvases,
    newCanvas() {
      return globalThis.document.createElement("canvas")
    },
    // Strokes are painted into the layer canvas and blitted, so read them from every canvas created
    // since the last reset.
    reset() { canvases.length = 0 },
    strokes() {
      return canvases.flatMap((canvas) => canvas.ops.filter(([op]) => op === "stroke").map(([, color]) => color))
    },
    restore() { globalThis.document = original },
  }
}

const kindsOf = (ops) => ops.map(([op, kind]) => (op === "draw" ? `draw:${kind}` : op))
const firstIndex = (ops, kind) => kindsOf(ops).indexOf(kind)

function makePage() {
  return {
    // A fresh image object per page keeps the per-layer render cache isolated between tests.
    image: { naturalWidth: 100, naturalHeight: 100 },
    boxes: [{
      id: "box-1", x: .1, y: .1, w: .4, h: .2, text: "Xin chào", size: 18, font: "Arial",
      color: "#101010", align: "center", rotation: 0, fill: true,
    }],
    retouchStrokes: [],
    layers: defaultLayers(),
  }
}

const paint = (color) => ({ mode: "paint", size: .1, color, points: [{ x: .2, y: .2 }, { x: .6, y: .6 }] })

test("the renderer paints the stack bottom to top instead of flattening it", (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))

  const canvas = mock.newCanvas()
  drawPage(canvas, page)
  assert.equal(firstIndex(canvas.ops, "draw:scan"), 0, "the scan is the base layer")
  assert.ok(firstIndex(canvas.ops, "draw:canvas") > 0, "the strokes are painted over the scan")
  assert.ok(firstIndex(canvas.ops, "fillText") > firstIndex(canvas.ops, "draw:canvas"), "cleanup, then retouch, then text")

  // Move the text layer under the painted layers: the text is now painted before the strokes above it.
  assert.equal(moveLayer(page, "layer-text", -2), true)
  assert.equal(page.layers.map(({ kind }) => kind).join(","), "cleanup,text,retouch")
  const reordered = mock.newCanvas()
  drawPage(reordered, page)
  assert.equal(firstIndex(reordered.ops, "fillText") < firstIndex(reordered.ops, "draw:canvas"), true)
})

test("hiding the retouch layer leaves the cleanup and text layers on the canvas", (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))
  const retouch = page.layers.find((layer) => layer.kind === "retouch")

  const visible = mock.newCanvas()
  drawPage(visible, page)
  assert.deepEqual(mock.strokes(), ["#112233"])

  setLayerHidden(retouch, true)
  mock.reset()
  const hidden = mock.newCanvas()
  drawPage(hidden, page)
  assert.deepEqual(mock.strokes(), [], "no stroke is painted")
  assert.ok(kindsOf(hidden.ops).includes("fillText"), "the text layer is untouched")
  assert.equal(kindsOf(hidden.ops)[0], "draw:scan", "the scan is still the base")
})

test("one hidden or deleted stroke changes the page without clearing the others", (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))
  const middle = addStroke(page, paint("#445566"))
  const last = addStroke(page, paint("#778899"))

  drawPage(mock.newCanvas(), page)
  assert.deepEqual(mock.strokes(), ["#112233", "#445566", "#778899"])

  setStrokeHidden(middle, true)
  mock.reset()
  drawPage(mock.newCanvas(), page)
  assert.deepEqual(mock.strokes(), ["#112233", "#778899"])

  // Deleting the last stroke leaves the hidden middle one out and keeps the first.
  removeStroke(page, last)
  mock.reset()
  drawPage(mock.newCanvas(), page)
  assert.deepEqual(mock.strokes(), ["#112233"])
  assert.equal(page.retouchStrokes.length, 2, "only the last stroke is gone")
  assert.equal(page.retouchStrokes.includes(middle), true, "the hidden stroke is still in the list")
})

test("layer opacity reaches the retouch blit and the text fill", (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))
  setLayerOpacity(page.layers.find((layer) => layer.kind === "retouch"), .5)
  setLayerOpacity(page.layers.find((layer) => layer.kind === "text"), .4)

  const canvas = mock.newCanvas()
  drawPage(canvas, page)
  const blit = canvas.ops.find(([op, kind]) => op === "draw" && kind === "canvas")
  assert.equal(blit[4], .5, "the strokes are blitted at the layer opacity")
  const text = canvas.ops.find(([op]) => op === "fillText")
  assert.equal(text[3], .4, "the text is filled at the layer opacity")
})

test("export paints the visible layers in order, so hiding or deleting a stroke changes the file", async (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))
  const middle = addStroke(page, paint("#445566"))
  addStroke(page, paint("#778899"))

  const exported = await exportPage(page, "png")
  assert.deepEqual(mock.strokes(), ["#112233", "#445566", "#778899"])
  assert.ok(kindsOf(exported.ops).includes("fillText"), "the text layer is exported")
  assert.equal(firstIndex(exported.ops, "draw:scan"), 0)
  assert.ok(firstIndex(exported.ops, "fillText") > firstIndex(exported.ops, "draw:canvas"))

  removeStroke(page, middle)
  mock.reset()
  const afterDelete = await exportPage(page, "png")
  assert.deepEqual(mock.strokes(), ["#112233", "#778899"])
  assert.ok(kindsOf(afterDelete.ops).includes("fillText"))

  setLayerHidden(page.layers.find((layer) => layer.kind === "text"), true)
  mock.reset()
  const afterHide = await exportPage(page, "png")
  assert.equal(kindsOf(afterHide.ops).includes("fillText"), false, "a hidden text layer is not exported")
})

test("the native exporter refuses a stack it cannot reproduce and accepts the default one", async (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))

  const native = await nativePageLayers(page)
  assert.equal(native.options.width, 100)
  assert.ok(native.options.patches.length >= 1, "the painted layers travel as patches")

  setLayerOpacity(page.layers.find((layer) => layer.kind === "retouch"), .5)
  assert.equal(await nativePageLayers(page), null)

  setLayerOpacity(page.layers.find((layer) => layer.kind === "retouch"), 1)
  moveLayer(page, "layer-text", -2)
  assert.equal(await nativePageLayers(page), null, "text below the painted layers is renderer-only")
})

test("a duplicated retouch layer paints its own copy of the strokes", (t) => {
  const mock = mockDocument()
  t.after(mock.restore)
  const page = makePage()
  addStroke(page, paint("#112233"))
  const copy = duplicateLayer(page, page.layers.find((layer) => layer.kind === "retouch").id)

  drawPage(mock.newCanvas(), page)
  assert.deepEqual(mock.strokes(), ["#112233", "#112233"], "both layers paint their strokes")
  assert.equal(page.retouchStrokes.length, 2)
  assert.equal(copy.kind, "retouch")
})
