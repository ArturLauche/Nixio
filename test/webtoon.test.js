import assert from "node:assert/strict"
import test from "node:test"
import {
  findSmartSliceCuts,
  planVerticalStitch,
  smartSlicePageImage,
  stitchPagesVertically,
} from "../src/webtoon.js"

test("findSmartSliceCuts cuts along flat empty gutters without slicing through artwork panels", () => {
  const width = 120
  const height = 1200
  const pixels = new Uint8ClampedArray(width * height * 4)

  // Paint 3 panels with textured high-contrast stripes separated by clean white gutters
  // Panel 1: y=0..460, Gutter 1: y=460..540 (center ~500)
  // Panel 2: y=540..840, Gutter 2: y=840..920 (center ~880)
  // Panel 3: y=920..1200
  for (let y = 0; y < height; y++) {
    const inGutter = (y >= 460 && y < 540) || (y >= 840 && y < 920)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const v = inGutter ? 255 : ((x + y) % 8 < 4 ? 30 : 220)
      pixels[o] = v
      pixels[o + 1] = v
      pixels[o + 2] = v
      pixels[o + 3] = 255
    }
  }

  const slices = findSmartSliceCuts(pixels, width, height, {
    targetHeight: 450,
    minSliceHeight: 200,
    searchWindow: 120,
  })
  assert.equal(slices.length, 3)
  assert.equal(slices[0].top, 0)
  // Cut 1 must land cleanly inside Gutter 1 [460, 540]
  assert.ok(slices[0].bottom >= 460 && slices[0].bottom <= 540, `Expected cut 1 in [460,540], got ${slices[0].bottom}`)
  assert.equal(slices[1].top, slices[0].bottom)
  // Cut 2 must land cleanly inside Gutter 2 [840, 920]
  assert.ok(slices[1].bottom >= 840 && slices[1].bottom <= 920, `Expected cut 2 in [840,920], got ${slices[1].bottom}`)
  assert.equal(slices[2].top, slices[1].bottom)
  assert.equal(slices[2].bottom, height)
})

test("findSmartSliceCuts leaves short pages intact as a single slice", () => {
  const pixels = new Uint8ClampedArray(64 * 400 * 4).fill(240)
  const slices = findSmartSliceCuts(pixels, 64, 400, { targetHeight: 1600 })
  assert.deepEqual(slices, [{ top: 0, bottom: 400, height: 400 }])
})

test("findSmartSliceCuts honors small probe-space heights instead of inflating them", () => {
  const width = 512
  const height = 512
  const pixels = gutterPixels(width, height, 100)
  const slices = findSmartSliceCuts(pixels, width, height, {
    targetHeight: 100,
    minSliceHeight: 40,
    searchWindow: 25,
  })
  assert.ok(slices.length >= 4, `Expected probe slices near 100px, got ${slices.length} slices`)
  assert.equal(slices[0].top, 0)
  for (const slice of slices) {
    assert.ok(slice.height >= 80 && slice.height <= 130, `Expected a ~100px probe slice, got ${slice.height}`)
  }
  assert.equal(slices.at(-1).bottom, height)
  for (let i = 1; i < slices.length; i++) assert.equal(slices[i].top, slices[i - 1].bottom)
})

test("findSmartSliceCuts rejects invalid buffers and malformed options safely", () => {
  assert.deepEqual(findSmartSliceCuts(null, 10, 10), [])
  assert.deepEqual(findSmartSliceCuts(new Uint8ClampedArray(8), 10, 10), [])
  assert.deepEqual(findSmartSliceCuts(new Uint8ClampedArray(6400), 10, 10, { targetHeight: -5 }), [
    { top: 0, bottom: 10, height: 10 },
  ])
})

test("planVerticalStitch keeps legacy stacking and common width for normal pages", () => {
  const first = { name: "chapter.png", image: { naturalWidth: 800, naturalHeight: 1200 } }
  const second = { name: "narrow.png", image: { naturalWidth: 400, naturalHeight: 900 } }
  const plan = planVerticalStitch([first, second])
  assert.equal(plan.width, 800)
  assert.equal(plan.rowLimit, 16000)
  assert.equal(plan.chunks.length, 1)
  const [{ height, items }] = plan.chunks
  assert.equal(height, 3000)
  assert.deepEqual(items.map((item) => [item.page, item.sourceY, item.sourceWidth, item.sourceHeight, item.destY, item.height]), [
    [first, 0, 800, 1200, 0, 1200],
    [second, 0, 400, 900, 1200, 1800],
  ])
})

test("planVerticalStitch splits a tall first page into balanced contiguous bands", () => {
  const tall = { name: "tall.png", image: { naturalWidth: 800, naturalHeight: 28000 } }
  const wide = { name: "wide.png", image: { naturalWidth: 1600, naturalHeight: 2000 } }
  const plan = planVerticalStitch([tall, wide])
  assert.equal(plan.width, 1600)
  assert.equal(plan.rowLimit, 15625)
  assert.deepEqual(plan.chunks.map((chunk) => chunk.height), [14000, 14000, 14000, 14000, 2000])
  for (const chunk of plan.chunks) {
    assert.ok(chunk.height <= plan.rowLimit)
    assert.ok(chunk.height <= 16384)
    assert.ok(plan.width * chunk.height <= 25_000_000)
  }

  const tallItems = plan.chunks.flatMap((chunk) => chunk.items).filter((item) => item.page === tall)
  assert.equal(tallItems.length, 4)
  let covered = 0
  for (const item of tallItems) {
    assert.equal(item.sourceY, covered)
    assert.equal(item.sourceWidth, 800)
    assert.equal(item.height, 14000)
    covered += item.sourceHeight
  }
  assert.equal(covered, 28000)
  assert.deepEqual(tallItems.map((item) => item.sourceHeight), [7000, 7000, 7000, 7000])
  assert.equal(tallItems.reduce((sum, item) => sum + item.height, 0), 56000)
})

test("planVerticalStitch applies the configured pixel budget to every chunk", () => {
  const tall = { name: "a.png", image: { naturalWidth: 2000, naturalHeight: 3000 } }
  const short = { name: "b.png", image: { naturalWidth: 2000, naturalHeight: 1000 } }
  const plan = planVerticalStitch([tall, short], { maxPixels: 5_000_000 })
  assert.equal(plan.width, 2000)
  assert.equal(plan.rowLimit, 2500)
  assert.deepEqual(plan.chunks.map((chunk) => chunk.height), [1500, 2500])
  assert.deepEqual(plan.chunks[1].items.map((item) => [item.page, item.sourceY, item.sourceHeight, item.destY, item.height]), [
    [tall, 1500, 1500, 0, 1500],
    [short, 0, 1000, 1500, 1000],
  ])
  for (const chunk of plan.chunks) assert.ok(plan.width * chunk.height <= 5_000_000)
})

test("planVerticalStitch bounds oversized widths and keeps aspect ratio under the pixel cap", () => {
  const oversized = { name: "oversized.png", image: { naturalWidth: 20000, naturalHeight: 100 } }
  const square = { name: "square.png", image: { naturalWidth: 1000, naturalHeight: 1000 } }
  const plan = planVerticalStitch([oversized, square])
  assert.equal(plan.width, 16384)
  assert.equal(plan.rowLimit, 1525)
  assert.ok(plan.chunks.length <= 12)
  for (const chunk of plan.chunks) {
    assert.ok(chunk.height <= 1525)
    assert.ok(chunk.height <= 16384)
    assert.ok(plan.width * chunk.height <= 25_000_000)
  }
  const oversizedItems = plan.chunks.flatMap((chunk) => chunk.items).filter((item) => item.page === oversized)
  assert.equal(oversizedItems.length, 1)
  assert.equal(oversizedItems[0].height, 82)
  assert.equal(oversizedItems[0].sourceHeight, 100)
  const squareHeight = plan.chunks
    .flatMap((chunk) => chunk.items)
    .filter((item) => item.page === square)
    .reduce((sum, item) => sum + item.height, 0)
  assert.equal(squareHeight, 16384)
})

test("planVerticalStitch rejects invalid pages, limits and explosive chunk counts early", () => {
  const page = (width, height) => ({ name: "p.png", image: { naturalWidth: width, naturalHeight: height } })
  assert.throws(() => planVerticalStitch([]), /ít nhất 2 trang/)
  assert.throws(() => planVerticalStitch([page(800, 1000)]), /ít nhất 2 trang/)
  assert.throws(() => planVerticalStitch([page(0, 0), page(800, 1000)]), /kích thước ảnh hợp lệ/)
  assert.throws(() => planVerticalStitch([page(800, 1000), page(800, 1000)], { maxPixels: Number.NaN }), /Giới hạn điểm ảnh/)
  assert.throws(() => planVerticalStitch([page(800, 1000), page(800, 1000)], { maxPixels: 0 }), /Giới hạn điểm ảnh/)
  assert.throws(() => planVerticalStitch([page(800, 1000), page(800, 1000)], { maxPixels: 500 }), /nhỏ hơn chiều rộng/)
  assert.throws(
    () => planVerticalStitch([page(100, 100000), page(1600, 100)]),
    /vượt giới hạn 32 mảnh/,
  )
  assert.throws(
    () => planVerticalStitch([page(1, 40_000_000), page(1600, 100)]),
    /vượt giới hạn 32 mảnh/,
  )
})

test("stitchPagesVertically renders one bounded canvas for normal pages", async (t) => {
  const { canvases } = installCanvasHarness(t)
  const first = { name: "chapter.png", image: { naturalWidth: 800, naturalHeight: 1200 } }
  const second = { name: "narrow.png", image: { naturalWidth: 400, naturalHeight: 900 } }
  const files = await stitchPagesVertically([first, second])
  assert.equal(files.length, 1)
  assert.equal(files[0].name, "chapter-ghep.png")
  assert.equal(files[0].type, "image/png")
  assert.equal(canvases.length, 1)
  const [canvas] = canvases
  assert.deepEqual([canvas.width, canvas.height], [800, 3000])
  assert.deepEqual(canvas.fills, [["#ffffff", 0, 0, 800, 3000]])
  assert.deepEqual(canvas.draws, [
    [first.image, 0, 0, 800, 1200, 0, 0, 800, 1200],
    [second.image, 0, 0, 400, 900, 0, 1200, 800, 1800],
  ])
})

test("stitchPagesVertically splits tall pages into bounded, contiguous output strips", async (t) => {
  const { canvases } = installCanvasHarness(t)
  const tall = { name: "narrow-tall.png", image: { naturalWidth: 800, naturalHeight: 28000 } }
  const wide = { name: "wide.png", image: { naturalWidth: 1600, naturalHeight: 2000 } }
  const files = await stitchPagesVertically([tall, wide])
  assert.deepEqual(files.map((file) => file.name), [
    "narrow-tall-ghep-01.png",
    "narrow-tall-ghep-02.png",
    "narrow-tall-ghep-03.png",
    "narrow-tall-ghep-04.png",
    "narrow-tall-ghep-05.png",
  ])
  assert.deepEqual(canvases.map((canvas) => [canvas.width, canvas.height]), [
    [1600, 14000],
    [1600, 14000],
    [1600, 14000],
    [1600, 14000],
    [1600, 2000],
  ])
  for (const canvas of canvases) {
    assert.ok(canvas.height <= 16384)
    assert.ok(canvas.width * canvas.height <= 25_000_000)
    assert.deepEqual(canvas.fills, [["#ffffff", 0, 0, canvas.width, canvas.height]])
  }
  const tallDraws = canvases.slice(0, 4).map((canvas) => canvas.draws[0])
  assert.deepEqual(tallDraws.map((draw) => [draw[2], draw[4], draw[6], draw[8]]), [
    [0, 7000, 0, 14000],
    [7000, 7000, 0, 14000],
    [14000, 7000, 0, 14000],
    [21000, 7000, 0, 14000],
  ])
  const wideDraw = canvases[4].draws[0]
  assert.strictEqual(wideDraw[0], wide.image)
  assert.deepEqual([wideDraw[2], wideDraw[4], wideDraw[6], wideDraw[8]], [0, 2000, 0, 2000])
})

test("stitchPagesVertically rejects invalid geometry before allocating a canvas", async (t) => {
  const { canvases } = installCanvasHarness(t)
  await assert.rejects(
    stitchPagesVertically([
      { name: "bad.png", image: { naturalWidth: 0, naturalHeight: 0 } },
      { name: "ok.png", image: { naturalWidth: 800, naturalHeight: 1000 } },
    ]),
    /kích thước ảnh hợp lệ/,
  )
  assert.equal(canvases.length, 0)
})

test("stitchPagesVertically surfaces PNG encoding failures", async (t) => {
  installCanvasHarness(t, { blob: () => null })
  await assert.rejects(
    stitchPagesVertically([
      { name: "a.png", image: { naturalWidth: 800, naturalHeight: 500 } },
      { name: "b.png", image: { naturalWidth: 800, naturalHeight: 500 } },
    ]),
    /Không thể tạo ảnh sau khi ghép dọc/,
  )
})

test("smartSlicePageImage keeps wide-page slice heights in original units", async (t) => {
  const { canvases } = installCanvasHarness(t, { probe: (width, height) => gutterPixels(width, height, 100) })
  const image = { naturalWidth: 8192, naturalHeight: 8192 }
  const files = await smartSlicePageImage({ name: "wide.png", image }, { targetHeight: 1600 })
  assert.deepEqual([canvases[0].width, canvases[0].height], [512, 512])
  assert.equal(files.length, 5)
  assert.deepEqual(files.map((file) => file.name), ["wide-01.png", "wide-02.png", "wide-03.png", "wide-04.png", "wide-05.png"])

  let covered = 0
  for (let i = 0; i < files.length; i++) {
    const canvas = canvases[i + 1]
    assert.equal(canvas.width, 8192)
    const [sourceImage, sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight] = canvas.draws[0]
    assert.strictEqual(sourceImage, image)
    assert.equal(sourceX, 0)
    assert.equal(sourceY, covered)
    assert.equal(sourceWidth, 8192)
    assert.equal(sourceHeight, canvas.height)
    assert.deepEqual([destX, destY, destWidth, destHeight], [0, 0, 8192, canvas.height])
    assert.ok(canvas.height >= 1400 && canvas.height <= 1900, `Expected a ~1600px slice, got ${canvas.height}`)
    covered += canvas.height
  }
  assert.equal(covered, 8192)
})

test("smartSlicePageImage bounds the probe for very tall narrow pages", async (t) => {
  const { canvases } = installCanvasHarness(t, { probe: (width, height) => gutterPixels(width, height, 66) })
  const image = { naturalWidth: 300, naturalHeight: 100000 }
  const files = await smartSlicePageImage({ name: "tall.png", image }, { targetHeight: 1600 })
  assert.deepEqual([canvases[0].width, canvases[0].height], [300, 4096])
  assert.ok(files.length > 20)
  assert.equal(canvases.length, files.length + 1)

  let covered = 0
  for (let i = 0; i < files.length; i++) {
    const canvas = canvases[i + 1]
    assert.equal(canvas.width, 300)
    assert.equal(canvas.draws[0][2], covered)
    assert.equal(canvas.draws[0][4], canvas.height)
    assert.ok(canvas.height >= 1200 && canvas.height <= 2200, `Expected a ~1600px slice, got ${canvas.height}`)
    covered += canvas.height
  }
  assert.equal(covered, 100000)
})

test("smartSlicePageImage leaves pages close to the target height untouched", async (t) => {
  const { canvases } = installCanvasHarness(t, { probe: (width, height) => gutterPixels(width, height, 100) })
  const files = await smartSlicePageImage(
    { name: "short.png", image: { naturalWidth: 800, naturalHeight: 1000 } },
    { targetHeight: 1600 },
  )
  assert.deepEqual(files, [])
  assert.equal(canvases.length, 1)
})

test("smartSlicePageImage rejects invalid images before creating a probe", async (t) => {
  const { canvases } = installCanvasHarness(t)
  await assert.rejects(smartSlicePageImage({ image: { naturalWidth: 0, naturalHeight: 0 } }), /không có ảnh hợp lệ/)
  await assert.rejects(smartSlicePageImage(null), /không có ảnh hợp lệ/)
  assert.equal(canvases.length, 0)
})

function installCanvasHarness(t, { blob = () => new Blob([]), probe = null } = {}) {
  const previousDocument = globalThis.document
  const canvases = []
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        draws: [],
        fills: [],
        getContext() {
          return {
            fillStyle: "",
            drawImage(...args) {
              canvas.draws.push(args)
            },
            fillRect(...args) {
              canvas.fills.push([this.fillStyle, ...args])
            },
            getImageData() {
              if (!probe) return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }
              return { data: probe(canvas.width, canvas.height) }
            },
          }
        },
        toBlob(callback) {
          callback(blob(canvas))
        },
      }
      canvases.push(canvas)
      return canvas
    },
  }
  t.after(() => {
    globalThis.document = previousDocument
  })
  return { canvases }
}

function gutterPixels(width, height, period, gutter = 4) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const flat = y % period < gutter
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const value = flat ? 255 : ((x + y) % 8 < 4 ? 30 : 220)
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }
  return pixels
}
