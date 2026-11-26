import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import bridge from "../desktop/worker.cjs"

const { TextureWorker } = bridge
const platform = { win32: "win", linux: "linux", darwin: "osx" }[process.platform]
const rid = platform + "-" + process.arch
const executable = fileURLToPath(new URL(
  path.posix.join("../native/out", rid, "native-worker", "KhungThoai.Redraw" + (platform === "win" ? ".exe" : "")),
  import.meta.url,
))
const available = existsSync(executable)
const fixtureSize = 160
const area = { left: 44, top: 39, right: 111, bottom: 106 }

function sample(pattern) {
  const pixels = new Uint8Array(fixtureSize * fixtureSize * 4)
  for (let y = 0; y < fixtureSize; y++) {
    for (let x = 0; x < fixtureSize; x++) {
      const index = (y * fixtureSize + x) * 4
      const level = pattern(x, y)
      pixels.set([level, level, level, 255], index)
    }
  }
  return { width: fixtureSize, height: fixtureSize, inner: area, pixels }
}

function drawInk({ pixels }) {
  for (let y = 54; y < 86; y++) {
    for (let x = 58; x < 94; x++) {
      if (x >= 65 && x < 85 && y >= 59 && y < 80) continue
      const index = (y * fixtureSize + x) * 4
      pixels.fill(3, index, index + 3)
    }
  }
}

function cropWithPatch(source, patch) {
  const width = area.right - area.left
  const height = area.bottom - area.top
  const result = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const original = ((area.top + y) * fixtureSize + area.left + x) * 4
      const destination = (y * width + x) * 4
      result.set(patch?.[destination + 3]
        ? patch.subarray(destination, destination + 4)
        : source.pixels.subarray(original, original + 4), destination)
    }
  }
  return result
}

test("native redraw rejects malformed IPC payloads", () => {
  const worker = new TextureWorker(executable)
  assert.equal(worker.redraw(null), null)
  assert.equal(worker.redraw({ ...sample(() => 245), pixels: new Uint8Array(4) }), null)
})

test("native redraw restores the sampled texture and preserves pixels outside lettering", { skip: !available }, async (context) => {
  const worker = new TextureWorker(executable)
  context.after(() => worker.close())
  const texture = (x, y) => x % 6 < 2 && y % 6 < 2 ? 19 : 244
  const original = sample(texture)
  const inked = sample(texture)
  drawInk(inked)
  assert.notDeepEqual(cropWithPatch(inked), cropWithPatch(original))
  const patch = await worker.redraw(inked)
  assert.ok(patch?.length)
  const restored = cropWithPatch(inked, patch)
  const expected = cropWithPatch(original)
  // The observed dot may contain darker ink than the expected dot, without enough contrast to alter it.
  for (const offset of restored.keys()) {
    if (offset % 4 === 3) assert.equal(restored[offset], 255)
    else assert.ok(Math.abs(restored[offset] - expected[offset]) <= 16)
  }
})

test("native redraw leaves irregular backgrounds alone and keeps concurrent replies ordered", { skip: !available }, async (context) => {
  const worker = new TextureWorker(executable)
  context.after(() => worker.close())
  let seed = 539
  const irregular = sample(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return 38 + (seed >>> 25)
  })
  const repeat = sample((x, y) => (x + y) % 6 < 2 ? 35 : 245)
  drawInk(irregular)
  drawInk(repeat)
  const [rejected, accepted] = await Promise.all([worker.redraw(irregular), worker.redraw(repeat)])
  assert.equal(rejected, null)
  assert.ok(accepted?.length)
})

test("native redraw restores a color gradient and protects an ink line crossing the box", { skip: !available }, async (context) => {
  const worker = new TextureWorker(executable)
  context.after(() => worker.close())
  const paper = () => {
    const result = sample(() => 0)
    for (let y = 0; y < result.height; y++) {
      for (let x = 0; x < result.width; x++) {
        result.pixels.set([
          145 + Math.round(x * .42 + y * .15),
          95 + Math.round(x * .35 + y * .32),
          130 + Math.round(x * .18 + y * .27),
          255,
        ], (y * result.width + x) * 4)
      }
    }
    // A short slice of panel artwork crosses both edges of the selection.
    for (let y = 93; y < 95; y++) {
      for (let x = 27; x < 133; x++) result.pixels.fill(9, (y * result.width + x) * 4, (y * result.width + x) * 4 + 3)
    }
    return result
  }
  const expected = cropWithPatch(paper())
  const inked = paper()
  drawInk(inked)
  const patch = await worker.redraw(inked)
  assert.ok(patch?.length)
  const result = cropWithPatch(inked, patch)
  let largestError = 0
  for (let i = 0; i < result.length; i++) largestError = Math.max(largestError, Math.abs(result[i] - expected[i]))
  assert.ok(largestError <= 2, "maximum RGBA error: " + largestError)
  const crossing = ((93 - area.top) * (area.right - area.left) + 80 - area.left) * 4
  assert.equal(result[crossing], 9)
  assert.equal(patch[crossing + 3], 0)
})

test("native redraw recovers screentone with a brightness gradient", { skip: !available }, async (context) => {
  const worker = new TextureWorker(executable)
  context.after(() => worker.close())
  const shadedDots = (x, y) => 120 + Math.round(x * .45 + y * .22) - (x % 6 < 2 && y % 6 < 2 ? 78 : 0)
  const expected = cropWithPatch(sample(shadedDots))
  const inked = sample(shadedDots)
  drawInk(inked)
  const patch = await worker.redraw(inked)
  assert.ok(patch?.length)
  const result = cropWithPatch(inked, patch)
  let error = 0
  for (let i = 0; i < result.length; i++) error = Math.max(error, Math.abs(result[i] - expected[i]))
  assert.ok(error <= 3, "maximum RGBA error: " + error)
})

test("native redraw restores larger screentone periods", { skip: !available }, async (context) => {
  const worker = new TextureWorker(executable)
  context.after(() => worker.close())
  const source = sample((x, y) => x % 20 < 5 && y % 20 < 5 ? 80 : 240)
  const original = source.pixels.slice()
  drawInk(source)
  const patch = await worker.redraw(source)
  assert.ok(patch)
  const restored = cropWithPatch(source, patch)
  let error = 0
  for (let y = area.top; y < area.bottom; y++) {
    for (let x = area.left; x < area.right; x++) {
      const offset = ((y - area.top) * (area.right - area.left) + x - area.left) * 4
      error += Math.abs(restored[offset] - original[(y * fixtureSize + x) * 4])
    }
  }
  assert.ok(error / ((area.right - area.left) * (area.bottom - area.top)) < 1)
})

test("native screentone redraw protects a line connected to drawing outside the region", { skip: !available }, async (context) => {
  const worker = new TextureWorker(executable)
  context.after(() => worker.close())
  const source = sample((x, y) => x % 4 < 2 && y % 4 < 2 ? 100 : 240)
  for (let y = area.top - 4; y < area.bottom + 4; y++) {
    for (let x = 49; x < 52; x++) source.pixels.fill(3, (y * fixtureSize + x) * 4, (y * fixtureSize + x) * 4 + 3)
  }
  drawInk(source)
  const patch = await worker.redraw(source)
  assert.ok(patch)
  const lineOffset = ((50 - area.top) * (area.right - area.left) + 50 - area.left) * 4
  assert.equal(patch[lineOffset + 3], 0)
  const textOffset = ((54 - area.top) * (area.right - area.left) + 60 - area.left) * 4
  assert.equal(patch[textOffset + 3], 255)
})
