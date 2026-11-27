// Generates the project-authored screentone and gradient benchmark pairs.
// The output is deterministic: rerunning this script with the same Node version
// rewrites byte-identical PNG and gzip fixtures. No third-party art or fonts are used.
// Run with --check to verify the committed fixtures still match the generator.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { gunzipSync, gzipSync } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { decodePng, encodePng } from "./lib/png.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "test/fixtures/comic")
const width = 480
const height = 640

// A 5x7 project-authored bitmap font, scaled at draw time. Only the glyphs used below are needed.
const glyphs = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
}

const ink = [22, 22, 24]

function createCanvas(fill) {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = typeof fill === "function" ? fill(x, y) : fill
      pixels.set([color[0], color[1], color[2], 255], (y * width + x) * 4)
    }
  }
  return pixels
}

function setPixel(pixels, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  pixels.set([color[0], color[1], color[2], 255], (y * width + x) * 4)
}

function fillRectangle(pixels, left, top, right, bottom, color) {
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) setPixel(pixels, x, y, color)
}

function drawText(pixels, text, { x, y, scale, color = ink }) {
  let cursor = x
  for (const character of text) {
    const rows = glyphs[character]
    if (!rows) throw new Error("No fixture glyph for " + JSON.stringify(character))
    for (let row = 0; row < rows.length; row++) {
      for (let column = 0; column < rows[row].length; column++) {
        if (rows[row][column] !== "1") continue
        fillRectangle(pixels, cursor + column * scale, y + row * scale, cursor + (column + 1) * scale, y + (row + 1) * scale, color)
      }
    }
    cursor += 6 * scale
  }
  return cursor - scale
}

function frame(pixels) {
  fillRectangle(pixels, 0, 0, width, 5, ink)
  fillRectangle(pixels, 0, height - 5, width, height, ink)
  fillRectangle(pixels, 0, 0, 5, height, ink)
  fillRectangle(pixels, width - 5, 0, width, height, ink)
}

function screentoneClean() {
  const paper = [238, 234, 226]
  const dot = [96, 92, 88]
  const pixels = createCanvas((x, y) => (x % 8 < 3 && y % 8 < 3 ? dot : paper))
  frame(pixels)
  // Inks outside every grading rectangle exercise preservation without touching the sample ring.
  fillRectangle(pixels, 20, 40, 24, 590, ink)
  fillRectangle(pixels, 20, 560, 460, 564, ink)
  fillRectangle(pixels, 60, 80, 420, 84, ink)
  fillRectangle(pixels, 356, 96, 420, 160, dot.map((value) => Math.max(0, value - 30)))
  return pixels
}

function gradientClean() {
  const pixels = createCanvas((x, y) => [
    Math.round(70 + x * .25 + y * .08),
    Math.round(60 + x * .18 + y * .14),
    Math.round(140 + x * .06 - y * .04),
  ])
  // A short diagonal stroke and a panel frame stay clear of the grading rectangles.
  for (let step = 0; step < 400; step++) {
    const x = 40 + step
    const y = 520 + Math.round(step * .1)
    fillRectangle(pixels, x, y, x + 4, y + 4, ink)
  }
  for (let radius = 34; radius < 40; radius++) {
    for (let angle = 0; angle < 360; angle += 2) {
      const radians = angle * Math.PI / 180
      setPixel(pixels, Math.round(392 + Math.cos(radians) * radius), Math.round(120 + Math.sin(radians) * radius), ink)
    }
  }
  frame(pixels)
  return pixels
}

function withLettering(clean, lines) {
  const pixels = clean.slice()
  for (const line of lines) drawText(pixels, line.text, line)
  return pixels
}

const pairs = [
  {
    id: "screentone",
    clean: screentoneClean(),
    lettering: [
      { text: "HALFTONE", x: 122, y: 300, scale: 5 },
      { text: "INK", x: 336, y: 474, scale: 3 },
    ],
  },
  {
    id: "gradient",
    clean: gradientClean(),
    lettering: [
      { text: "GRADIENT", x: 122, y: 300, scale: 5 },
      { text: "SKY", x: 345, y: 470, scale: 3 },
    ],
  },
]

const check = process.argv.includes("--check")
let drift = 0
await mkdir(fixtures, { recursive: true })
for (const pair of pairs) {
  const lettered = withLettering(pair.clean, pair.lettering)
  for (const [kind, pixels] of [["clean", pair.clean], ["lettered", lettered]]) {
    const base = path.join(fixtures, pair.id + "." + kind)
    if (!check) {
      await writeFile(base + ".png", encodePng({ width, height, data: pixels }))
      await writeFile(base + ".rgba.gz", gzipSync(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length), { level: 9 }))
      continue
    }
    const committedPng = decodePng(await readFile(base + ".png")).data
    const committedPixels = gunzipSync(await readFile(base + ".rgba.gz"))
    if (!committedPng.equals(Buffer.from(pixels)) || !committedPixels.equals(Buffer.from(pixels))) {
      console.error("Fixture drift:", path.relative(root, base))
      drift++
    }
  }
  if (!check) console.log("wrote", pair.id, pair.lettering.map((line) => line.text).join(" / "))
}
if (check) {
  if (drift) {
    console.error("Run scripts/generate-comic-fixtures.mjs and review the image difference.")
    process.exitCode = 1
  } else {
    console.log("Committed fixtures match the generator output.")
  }
}
