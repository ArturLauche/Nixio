import assert from "node:assert/strict"
import test from "node:test"
import { redrawLayout } from "../src/redraw.js"

function installCanvasMocks(redrawTexture) {
  const originalDocument = globalThis.document
  const originalImageData = globalThis.ImageData
  const originalDesktop = globalThis.khungThoaiDesktop

  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas")
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(240) }),
            putImageData() {},
          }
        },
      }
    },
  }
  globalThis.khungThoaiDesktop = { redrawTexture }

  return () => {
    globalThis.document = originalDocument
    globalThis.ImageData = originalImageData
    globalThis.khungThoaiDesktop = originalDesktop
  }
}

test("redrawLayout cancels superseded preview layouts so rapid drags do not exhaust the native worker queue", async (t) => {
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const restore = installCanvasMocks(async ({ inner }) => {
    calls++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight--
    const size = (inner.right - inner.left) * (inner.bottom - inner.top) * 4
    return new Uint8Array(size).fill(255)
  })
  t.after(restore)

  const image = { naturalWidth: 200, naturalHeight: 200 }
  let finalLayout
  for (let step = 0; step < 12; step++) {
    const page = {
      image,
      boxes: [{ x: 0.1 + step * 0.02, y: 0.1, w: 0.2, h: 0.2, cleanup: true }],
    }
    finalLayout = redrawLayout(page)
  }

  await finalLayout.pending
  assert.equal(maxInFlight, 1)
  assert.ok(calls <= 2, `expected superseded drags to be skipped, got ${calls} IPC calls`)
  assert.equal(finalLayout.patches.length, 1)
})

test("redrawLayout preserves non-cancellable export layouts when preview updates concurrently", async (t) => {
  const restore = installCanvasMocks(async ({ inner }) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const size = (inner.right - inner.left) * (inner.bottom - inner.top) * 4
    return new Uint8Array(size).fill(255)
  })
  t.after(restore)

  const image = { naturalWidth: 200, naturalHeight: 200 }
  const exportPage = { image, boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, cleanup: true }] }
  const exportLayout = redrawLayout(exportPage, { cancellable: false })

  const movedPreview = { image, boxes: [{ x: 0.5, y: 0.5, w: 0.2, h: 0.2, cleanup: true }] }
  const previewLayout = redrawLayout(movedPreview)

  await Promise.all([exportLayout.pending, previewLayout.pending])
  assert.equal(exportLayout.patches.length, 1)
  assert.equal(previewLayout.patches.length, 1)
})
