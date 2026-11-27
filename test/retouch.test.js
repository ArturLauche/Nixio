import assert from "node:assert/strict"
import test from "node:test"
import { paintRetouchStrokes, prepareNativeInpaint, samplePixelColor, validateRetouchStroke } from "../src/retouch.js"

test("validateRetouchStroke validates paint and clone strokes and rejects malformed inputs", () => {
  assert.deepEqual(
    validateRetouchStroke({ mode: "paint", size: .05, color: "#12ab34", opacity: 1, points: [{ x: .1, y: .2 }] }),
    { mode: "paint", size: .05, color: "#12ab34", points: [{ x: .1, y: .2 }] },
  )
  assert.deepEqual(
    validateRetouchStroke({ mode: "clone", size: .08, offsetX: -.1, offsetY: .2, opacity: .6, points: [{ x: .5, y: .5 }] }),
    { mode: "clone", size: .08, offsetX: -.1, offsetY: .2, opacity: .6, points: [{ x: .5, y: .5 }] },
  )
  assert.equal(validateRetouchStroke({ mode: "paint", size: .05, color: "red", points: [{ x: .1, y: .2 }] }), null)
  assert.equal(validateRetouchStroke({ mode: "clone", size: .05, offsetX: 2, offsetY: 0, points: [{ x: .1, y: .2 }] }), null)
  assert.equal(validateRetouchStroke({ mode: "paint", size: .05, color: "#ffffff", points: [] }), null)
})

test("samplePixelColor reads exact RGB hex at normalized coordinates", (t) => {
  const originalDocument = globalThis.document
  globalThis.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            drawImage(_image, dx, dy) { this.dx = dx; this.dy = dy },
            getImageData() { return { data: new Uint8ClampedArray([18, 62, 50, 255]) } },
          }
        },
      }
    },
  }
  t.after(() => { globalThis.document = originalDocument })
  assert.equal(samplePixelColor({ naturalWidth: 100, naturalHeight: 200 }, { x: .5, y: .25 }), "#123e32")
})

test("paintRetouchStrokes renders paint and clone strokes, caches layer, and invalidates on edits", (t) => {
  const originalDocument = globalThis.document
  const ops = []
  let createdCanvases = 0
  globalThis.document = {
    createElement() {
      createdCanvases++
      const index = createdCanvases
      return {
        width: 0, height: 0,
        getContext() {
          return {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { ops.push(["stroke", index, this.strokeStyle, this.globalAlpha]) },
            drawImage(_img, x, y) { ops.push(["drawImage", index, Math.round(x), Math.round(y), this.globalAlpha]) },
          }
        },
      }
    },
  }
  t.after(() => { globalThis.document = originalDocument })

  let destBlits = 0
  const canvas = {
    width: 100, height: 100,
    getContext() {
      return {
        drawImage() { destBlits++ },
      }
    },
  }
  const page = {
    image: { naturalWidth: 100, naturalHeight: 100 },
    retouchStrokes: [
      { mode: "paint", size: .1, color: "#ffffff", opacity: .8, points: [{ x: .2, y: .2 }, { x: .3, y: .3 }] },
      { mode: "clone", size: .1, offsetX: -.1, offsetY: .1, opacity: .5, points: [{ x: .5, y: .5 }] },
    ],
  }
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 1)
  assert.ok(ops.some(([op, , color, alpha]) => op === "stroke" && color === "#ffffff" && alpha === .8))
  assert.ok(ops.some(([op, , , , alpha]) => op === "drawImage" && alpha === .5))

  // Second call with unchanged strokes hits cache (no new offscreen canvases or stroke redraws).
  const opsAfterFirst = ops.length
  const canvasesAfterFirst = createdCanvases
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 2)
  assert.equal(ops.length, opsAfterFirst)
  assert.equal(createdCanvases, canvasesAfterFirst)

  // Popping a stroke invalidates the cache and re-renders.
  page.retouchStrokes.pop()
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.equal(destBlits, 3)
  assert.ok(createdCanvases > canvasesAfterFirst)

  // Changing only an intermediate point (same length, first, last) still invalidates cache.
  page.retouchStrokes = [
    { mode: "paint", size: .1, color: "#ffffff", opacity: .8, points: [{ x: .1, y: .1 }, { x: .2, y: .2 }, { x: .9, y: .9 }] },
  ]
  assert.equal(paintRetouchStrokes(canvas, page), true)
  const canvasesBeforeMidEdit = createdCanvases
  page.retouchStrokes = [
    { mode: "paint", size: .1, color: "#ffffff", opacity: .8, points: [{ x: .1, y: .1 }, { x: .8, y: .2 }, { x: .9, y: .9 }] },
  ]
  assert.equal(paintRetouchStrokes(canvas, page), true)
  assert.ok(createdCanvases > canvasesBeforeMidEdit)
})

test("prepareNativeInpaint cache survives structuredClone (Undo/Redo) on the same page image", async (t) => {
  const originalDocument = globalThis.document
  const originalDesktop = globalThis.khungThoaiDesktop
  const originalImageData = globalThis.ImageData
  let nativeCalls = 0

  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  globalThis.document = {
    createElement() {
      const c = {
        width: 0, height: 0,
        getContext() {
          return {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
            drawImage() {}, putImageData() {},
            getImageData(_x, _y, w, h) {
              const data = new Uint8ClampedArray(w * h * 4)
              data.fill(255)
              return { data }
            },
          }
        },
      }
      return c
    },
  }
  globalThis.khungThoaiDesktop = {
    async native(op, opts) {
      assert.equal(op, "inpaint")
      nativeCalls++
      return { data: new Uint8Array(opts.width * opts.height * 4).fill(200) }
    },
  }
  t.after(() => {
    globalThis.document = originalDocument
    globalThis.khungThoaiDesktop = originalDesktop
    globalThis.ImageData = originalImageData
  })

  const image = { naturalWidth: 100, naturalHeight: 100 }
  const stroke = { mode: "inpaint", size: .1, points: [{ x: .4, y: .4 }, { x: .6, y: .6 }] }
  assert.equal(await prepareNativeInpaint({ image }, stroke), true)
  assert.equal(nativeCalls, 1)

  // Simulate Undo/Redo cloning the stroke object while keeping the same page.image reference.
  const clonedStroke = structuredClone(stroke)
  assert.equal(await prepareNativeInpaint({ image }, clonedStroke), true)
  assert.equal(nativeCalls, 1)
})
