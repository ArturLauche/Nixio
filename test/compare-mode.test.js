import assert from "node:assert/strict"
import test from "node:test"
import { compareMode, toggleCompare } from "../src/compare.js"

const editing = () => ({ compareOriginal: false, splitCompare: false, compareRestore: "edit" })
const apply = (state, mode) => ({ ...state, ...toggleCompare(state, mode) })

test("turning So sánh gốc off restores the curtain it replaced (#97)", () => {
  const curtain = apply(editing(), "split")
  assert.deepEqual(curtain, { compareOriginal: false, splitCompare: true, compareRestore: "edit" })

  const original = apply(curtain, "original")
  assert.deepEqual(original, { compareOriginal: true, splitCompare: false, compareRestore: "split" })

  // The reproducer: toggling the original image off landed in the edit view with the curtain gone.
  const restored = apply(original, "original")
  assert.deepEqual(restored, { compareOriginal: false, splitCompare: true, compareRestore: "edit" })
})

test("turning Kéo so sánh off restores the original view it replaced (#97)", () => {
  const original = apply(editing(), "original")
  const curtain = apply(original, "split")
  assert.deepEqual(curtain, { compareOriginal: false, splitCompare: true, compareRestore: "original" })
  assert.deepEqual(apply(curtain, "split"), { compareOriginal: true, splitCompare: false, compareRestore: "edit" })
})

test("a compare view opened from the edit view still closes back to the edit view", () => {
  const start = editing()
  const opened = apply(start, "original")
  assert.equal(compareMode(opened), "original")
  assert.deepEqual(apply(opened, "original"), start)
  const held = apply(opened, "original")
  assert.equal(compareMode(held), "edit")
})

test("repeated toggling keeps exactly one compare view and never restores itself", () => {
  let state = editing()
  for (const mode of ["split", "original", "original", "split", "split", "original", "original"]) {
    state = apply(state, mode)
    const active = compareMode(state)
    assert.ok(active === "edit" || active === "original" || active === "split")
    assert.ok(!(state.compareOriginal && state.splitCompare), "both compare views must never be on")
    assert.ok(active === "edit" || state.compareRestore !== active, `${active} must not remember itself`)
  }
})

test("the toggle reads the state and returns the next one without mutating it", () => {
  const state = Object.freeze({ compareOriginal: false, splitCompare: true, compareRestore: "edit" })
  const next = toggleCompare(state, "original")
  assert.deepEqual(next, { compareOriginal: true, splitCompare: false, compareRestore: "split" })
  assert.deepEqual(state, { compareOriginal: false, splitCompare: true, compareRestore: "edit" })
})

test("a missing, unknown or self-referencing restore falls back to the edit view", () => {
  assert.deepEqual(toggleCompare({ splitCompare: true }, "split"), { compareOriginal: false, splitCompare: false, compareRestore: "edit" })
  assert.deepEqual(toggleCompare({ compareOriginal: true, compareRestore: "bogus" }, "original"),
    { compareOriginal: false, splitCompare: false, compareRestore: "edit" })
  assert.deepEqual(toggleCompare({ compareOriginal: true, compareRestore: "original" }, "original"),
    { compareOriginal: false, splitCompare: false, compareRestore: "edit" })
  assert.deepEqual(toggleCompare(editing(), "nonsense"), editing())
})
