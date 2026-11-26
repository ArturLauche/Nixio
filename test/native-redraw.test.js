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
