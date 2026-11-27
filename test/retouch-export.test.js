import assert from "node:assert/strict"
import test from "node:test"

test("an export snapshot waits for and reuses the native inpaint patch", async (t) => {
  const original = { desktop: globalThis.khungThoaiDesktop, document: globalThis.document, ImageData: globalThis.ImageData }
  t.after(() => {
    globalThis.khungThoaiDesktop = original.desktop
    globalThis.document = original.document
    globalThis.ImageData = original.ImageData
  })
  let completeNative
  let nativeCalls = 0
  let nativeDraws = 0
  globalThis.khungThoaiDesktop = {
    native(operation, { width, height }) {
      assert.equal(operation, "inpaint")
      nativeCalls++
      return new Promise((resolve) => {
        completeNative = () => resolve({ data: new Uint8Array(width * height * 4).fill(120) })
      })
    },
  }
  globalThis.ImageData = class {
    constructor(data) { this.data = data }
  }
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => context }
      const context = {
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        drawImage(image) { if (image.nativePatch) nativeDraws++ },
        getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(255) } },
        putImageData() { canvas.nativePatch = true },
      }
      return canvas
    },
  }
  const { nativePageLayers } = await import("../src/canvas.js")
  const { copyEditor } = await import("../src/history.js")
  const { prepareNativeInpaint } = await import("../src/retouch.js")
  const stroke = { mode: "inpaint", size: .05, points: [{ x: .2, y: .25 }, { x: .25, y: .3 }] }
  const page = { image: { naturalWidth: 100, naturalHeight: 120 }, boxes: [], retouchStrokes: [stroke] }
  const pending = prepareNativeInpaint(page, stroke)
  const snapshot = copyEditor({ pages: [page] }).pages[0]
  assert.notEqual(snapshot.retouchStrokes[0], stroke)

  let exported = false
  const exportResult = nativePageLayers(snapshot).then((response) => {
    exported = true
    return response
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(exported, false)

  completeNative()
  assert.equal(await pending, true)
  assert.equal((await exportResult).options.patches.length, 1)
  assert.equal(nativeCalls, 1)
  assert.equal(nativeDraws, 1)
})

test("an export snapshot waits for and reuses a seamless Poisson clone patch", async (t) => {
  const original = { desktop: globalThis.khungThoaiDesktop, document: globalThis.document, ImageData: globalThis.ImageData }
  t.after(() => {
    globalThis.khungThoaiDesktop = original.desktop
    globalThis.document = original.document
    globalThis.ImageData = original.ImageData
  })
  let completeNative
  let nativeCalls = 0
  let nativeDraws = 0
  globalThis.khungThoaiDesktop = {
    native(operation, { width, height }, payload) {
      assert.equal(operation, "seamless_clone")
      assert.equal(payload.length, width * height * 4 * 2 + width * height)
      nativeCalls++
      return new Promise((resolve) => {
        completeNative = () => resolve({ data: new Uint8Array(width * height * 4).fill(180) })
      })
    },
  }
  globalThis.ImageData = class {
    constructor(data) { this.data = data }
  }
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => context }
      const context = {
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        drawImage(image) { if (image.nativePatch) nativeDraws++ },
        getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(255) } },
        putImageData() { canvas.nativePatch = true },
      }
      return canvas
    },
  }
  const { nativePageLayers } = await import("../src/canvas.js")
  const { copyEditor } = await import("../src/history.js")
  const { prepareNativeClone } = await import("../src/retouch.js")
  const stroke = { mode: "clone", size: .05, offsetX: -.1, offsetY: .05, seamless: true, points: [{ x: .4, y: .4 }, { x: .45, y: .45 }] }
  const page = { image: { naturalWidth: 100, naturalHeight: 100 }, boxes: [], retouchStrokes: [stroke] }
  const pending = prepareNativeClone(page, stroke)
  const snapshot = copyEditor({ pages: [page] }).pages[0]
  assert.notEqual(snapshot.retouchStrokes[0], stroke)

  let exported = false
  const exportResult = nativePageLayers(snapshot).then((response) => {
    exported = true
    return response
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(exported, false)

  completeNative()
  assert.equal(await pending, true)
  assert.equal((await exportResult).options.patches.length, 1)
  assert.equal(nativeCalls, 1)
  assert.equal(nativeDraws, 1)
})
