import assert from "node:assert/strict"
import test from "node:test"
import { matchDialogue, overlapScore, readOcrBox } from "../src/placement.js"

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
