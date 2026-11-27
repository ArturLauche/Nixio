import assert from "node:assert/strict"
import test from "node:test"
import { detectAllBubbles, detectBubbleRect } from "../src/bubble.js"

function makeScene(width, height, fill = [40, 40, 40, 255]) {
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = fill[0]
    pixels[i * 4 + 1] = fill[1]
    pixels[i * 4 + 2] = fill[2]
    pixels[i * 4 + 3] = fill[3]
  }
  return pixels
}

function drawEllipse(pixels, width, height, cx, cy, rx, ry, color = [250, 250, 250, 255]) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) {
        const off = (y * width + x) * 4
        pixels[off] = color[0]
        pixels[off + 1] = color[1]
        pixels[off + 2] = color[2]
        pixels[off + 3] = color[3]
      }
    }
  }
}

test("detectBubbleRect detects a bright enclosed speech bubble and insets safely", () => {
  const width = 200
  const height = 200
  const pixels = makeScene(width, height, [30, 30, 30, 255])
  drawEllipse(pixels, width, height, 100, 80, 35, 25, [252, 252, 252, 255])

  const rect = detectBubbleRect(pixels, width, height, .5, .4)
  assert.ok(rect)
  assert.ok(rect.x > .32 && rect.x < .38)
  assert.ok(rect.y > .27 && rect.y < .33)
  assert.ok(rect.w > .25 && rect.w < .36)
  assert.ok(rect.h > .18 && rect.h < .26)
})

test("detectBubbleRect rejects dark artwork and open full-page white backgrounds", () => {
  const width = 160
  const height = 160
  const dark = makeScene(width, height, [20, 20, 20, 255])
  assert.equal(detectBubbleRect(dark, width, height, .5, .5), null)

  const openWhite = makeScene(width, height, [255, 255, 255, 255])
  assert.equal(detectBubbleRect(openWhite, width, height, .5, .5), null)
})

test("detectAllBubbles finds multiple speech bubbles and sorts in RTL/LTR reading order", () => {
  const width = 240
  const height = 240
  const pixels = makeScene(width, height, [28, 28, 28, 255])
  // Top-left bubble
  drawEllipse(pixels, width, height, 60, 60, 32, 24, [252, 252, 252, 255])
  // Top-right bubble
  drawEllipse(pixels, width, height, 180, 62, 32, 24, [252, 252, 252, 255])
  // Bottom-center bubble
  drawEllipse(pixels, width, height, 120, 175, 38, 26, [252, 252, 252, 255])
  // Tiny noise dot (must be ignored)
  drawEllipse(pixels, width, height, 20, 200, 3, 3, [255, 255, 255, 255])

  const rtl = detectAllBubbles(pixels, width, height, { direction: "rtl" })
  assert.equal(rtl.length, 3)
  // RTL: top-right first, then top-left, then bottom
  assert.ok(rtl[0].x > rtl[1].x)
  assert.ok(rtl[2].y > rtl[0].y)

  const ltr = detectAllBubbles(pixels, width, height, { direction: "ltr" })
  assert.equal(ltr.length, 3)
  // LTR: top-left first, then top-right, then bottom
  assert.ok(ltr[0].x < ltr[1].x)
  assert.ok(ltr[2].y > ltr[0].y)
})
