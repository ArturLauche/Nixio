import assert from "node:assert/strict"
import test from "node:test"
import { matchDialogue, overlapScore, readModelOcrBox, readOcrBox } from "../src/placement.js"

const area = [100, 100, 300, 300]
const next = [600, 300, 800, 470]
const line = (id, box) => ({ id, text: "Thoại " + id, box })
const region = (id, box) => ({ id, box })

test("normalizes Gemini coordinates and rejects malformed rectangles", () => {
  assert.deepEqual(readOcrBox([100, 200, 350, 400]), [200, 100, 400, 350])
  for (const invalid of [[], [100, 200, 100, 300], [100, -1, 200, 300], [100, 200, 310.5, 400]]) {
    assert.equal(readOcrBox(invalid), null)
  }
})

test("rounds the decimals a vision model reports before the integer box invariants run (#23)", () => {
  // The issue reproducer: every coordinate is finite and in range, only fractional. Dropping the box
  // left the whole page in "Chưa đặt", so the coordinates are normalized and the box survives.
  assert.deepEqual(readModelOcrBox([100.4, 200.6, 300.8, 400.2]), [201, 100, 400, 301])
  assert.deepEqual(readModelOcrBox([100, 200, 350, 400]), [200, 100, 400, 350])
  // A model that overshoots the range by a fraction still lands on a valid edge.
  assert.deepEqual(readModelOcrBox([0.4, 0.4, 999.6, 999.6]), [0, 0, 1000, 1000])
  // Normalizing the representation must not weaken the shape: the range, the ordering, the length and
  // the numeric type are all still enforced, so an inverted or out-of-range rectangle stays unplaced.
  for (const invalid of [
    [100, 200, 100, 300], [100, -1.2, 200, 300], [100, 200, 300, 1000.6],
    [100, 200, 300], [100, 200, 300, 400, 500], [100, "200", 300, 400],
    [100, null, 300, 400], [100, Infinity, 300, 400], [100, NaN, 300, 400],
    [], null, undefined, "100,200,300,400",
  ]) {
    assert.equal(readModelOcrBox(invalid), null, JSON.stringify(invalid))
  }
})

test("a rounded model box places dialogue the strict reader could not", () => {
  const lines = [line("B1", readModelOcrBox([100.2, 100.3, 300.4, 300.5]))]
  assert.equal(readOcrBox([100.2, 100.3, 300.4, 300.5]), null)
  assert.deepEqual(matchDialogue(lines, [region("x", area)]).placed.length, 1)
})

test("scores both overlap and relative coverage", () => {
  assert.equal(overlapScore(area, area), 1)
  assert.equal(overlapScore(area, [170, 100, 300, 300]), .825)
  assert.equal(overlapScore(area, [190, 190, 900, 900]), 0)
  assert.equal(overlapScore(area, [100, 100, 110, 110]), 0)
})

test("places distinct dialogue while retaining lines with no reliable box", () => {
  const lines = [line("B1", area), line("B2", null), line("B3", next)]
  const regions = [region("x", area), region("y", next)]
  const result = matchDialogue(lines, regions)
  assert.deepEqual(result.placed, [{ line: lines[0], region: regions[0] }, { line: lines[2], region: regions[1] }])
  assert.deepEqual(result.unplaced, [lines[1]])
})

test("defers tied regions and dialogue competing for the same region", () => {
  const lines = [line("B1", area), line("B2", area)]
  const box = region("x", area)
  assert.deepEqual(matchDialogue(lines, [box]), { placed: [], unplaced: lines })
  assert.deepEqual(matchDialogue([lines[0]], [box, region("y", area)]), { placed: [], unplaced: [lines[0]] })
})

test("keeps a clear leader even when a weaker line overlaps that region", () => {
  const lines = [line("B1", area), line("B2", [140, 100, 300, 300])]
  const box = region("x", area)
  assert.deepEqual(matchDialogue(lines, [box]), {
    placed: [{ line: lines[0], region: box }], unplaced: [lines[1]],
  })
})
