import assert from "node:assert/strict"
import test from "node:test"
import { findSmartSliceCuts } from "../src/webtoon.js"

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
