import assert from "node:assert/strict"
import test from "node:test"
import { redrawLayout } from "../src/redraw.js"

function installCanvasMocks(redrawTexture, { native, paperSpeckles = false } = {}) {
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
            getImageData: (_x, _y, w, h) => {
              const data = new Uint8ClampedArray(w * h * 4)
              for (let index = 0; index < data.length; index += 4) {
                data[index] = data[index + 1] = data[index + 2] = 240
                data[index + 3] = 255
              }
              if (paperSpeckles) {
                const center = Math.floor(w / 2)
                for (let y = center - 8; y <= center + 8; y++) {
                  for (let x = center - 8; x <= center + 8; x++) {
                    const offset = (y * w + x) * 4
                    data[offset] = data[offset + 1] = data[offset + 2] = 40
                  }
                }
              }
              return { data }
            },
            createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {},
          }
        },
      }
    },
  }
  globalThis.khungThoaiDesktop = { redrawTexture, native }

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

test("moving text keeps a separately selected cleanup region and its cached native patch", async (t) => {
  const samples = []
  const restore = installCanvasMocks(async (sample) => {
    samples.push(sample)
    const { inner } = sample
    return new Uint8Array((inner.right - inner.left) * (inner.bottom - inner.top) * 4).fill(255)
  })
  t.after(restore)
  const page = {
    image: { naturalWidth: 200, naturalHeight: 200 },
    boxes: [{
      x: .1, y: .1, w: .2, h: .2, cleanup: true,
      cleanupRect: { x: .3, y: .4, w: .2, h: .2 },
    }],
  }
  const first = redrawLayout(page)
  await first.pending
  assert.equal(first.patches[0].left, 60)
  assert.equal(first.patches[0].top, 80)
  page.boxes[0].x = .6
  page.boxes[0].y = .7
  assert.equal(redrawLayout(page), first)
  assert.equal(samples.length, 1)
})

const cleanupPage = (image, cleanupMode = "content-aware") => ({
  image,
  boxes: [{ x: .1, y: .1, w: .2, h: .2, cleanup: true, cleanupMode }],
})
const freshImage = () => ({ naturalWidth: 200, naturalHeight: 200 })
// Patch payload size follows the sampled inner box, like the real worker contract.
const patchBytes = (inner) =>
  new Uint8Array((inner.right - inner.left) * (inner.bottom - inner.top) * 4).fill(200)

test("content-aware cleanup retries through redrawTexture when the native worker rejects", async (t) => {
  const operations = []
  const restore = installCanvasMocks(async ({ inner }) => {
    const size = (inner.right - inner.left) * (inner.bottom - inner.top) * 4
    return new Uint8Array(size).fill(255)
  }, {
    native: async (operation) => {
      operations.push(operation)
      throw new Error("Native worker crashed.")
    },
  })
  t.after(restore)

  const layout = redrawLayout(cleanupPage(freshImage()))
  await layout.pending
  assert.deepEqual(operations, ["content_aware_cleanup"])
  assert.equal(layout.patches.length, 1)
})

test("content-aware cleanup falls back on null or malformed native responses", async (t) => {
  const responses = [
    () => null,
    () => ({}),
    () => ({ result: { filled: 3 }, data: null }),
    () => ({ result: { filled: 3 }, data: new Uint8Array(4) }),
    (inner) => ({
      result: { filled: 3 },
      data: new Uint8Array((inner.right - inner.left) * (inner.bottom - inner.top) * 4 + 4),
    }),
  ]
  for (const [index, respond] of responses.entries()) {
    const restore = installCanvasMocks(async ({ inner }) => patchBytes(inner), {
      native: async (_operation, options) => respond(options.inner),
    })
    const layout = redrawLayout(cleanupPage(freshImage()))
    await layout.pending
    restore()
    assert.equal(layout.patches.length, 1, `response ${index} should fall back to redrawTexture`)
  }
})

test("content-aware cleanup keeps a valid native patch without fallback", async (t) => {
  let redrawCalls = 0
  const restore = installCanvasMocks(async ({ inner }) => { redrawCalls++; return patchBytes(inner) }, {
    native: async (_operation, options) => ({ result: { filled: 12 }, data: patchBytes(options.inner) }),
  })
  t.after(restore)

  const layout = redrawLayout(cleanupPage(freshImage()))
  await layout.pending
  assert.equal(layout.patches.length, 1)
  assert.equal(redrawCalls, 0)
})

test("content-aware filled:0 stays an intentional no-op without touching fallbacks", async (t) => {
  let redrawCalls = 0
  const restore = installCanvasMocks(async ({ inner }) => { redrawCalls++; return patchBytes(inner) }, {
    native: async () => ({ result: { filled: 0 }, data: new Uint8Array(0) }),
  })
  t.after(restore)

  const layout = redrawLayout(cleanupPage(freshImage()))
  await layout.pending
  assert.equal(layout.patches.length, 0)
  assert.equal(redrawCalls, 0)
})

test("redrawTexture null, undefined, rejection and bad bytes all reach the canvas paper fallback", async (t) => {
  const replies = [null, undefined, new Uint8Array(4), Promise.reject(new Error("worker timeout"))]
  for (const [index, reply] of replies.entries()) {
    const restore = installCanvasMocks(async () => reply, { paperSpeckles: true })
    const layout = redrawLayout(cleanupPage(freshImage(), "auto"))
    await layout.pending
    restore()
    assert.equal(layout.patches.length, 1, `reply ${index} should produce a canvas fallback patch`)
  }
})

test("preview and export layouts share the same canvas fallback when workers are unavailable", async (t) => {
  const restore = installCanvasMocks(undefined, { paperSpeckles: true })
  t.after(restore)

  const preview = redrawLayout(cleanupPage(freshImage(), "auto"))
  const exported = redrawLayout(cleanupPage(freshImage(), "auto"), { cancellable: false })
  await Promise.all([preview.pending, exported.pending])
  assert.equal(preview.patches.length, 1)
  assert.equal(exported.patches.length, 1)
})
