import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  arrowDelta,
  clampRect,
  geometryFromPixels,
  geometryMessage,
  geometryPixels,
  moveSelection,
  normalizeAngle,
  resizeHandleLabel,
  resizeHandles,
  resizeSelection,
  rotateSelection,
  rotationHandleLabel,
  rotationStep,
  stepPixels,
} from "../src/keyboard-geometry.js"

const image = { width: 400, height: 200 }
const selection = (...ids) => new Set(ids)

function close(actual, expected, label = "value") {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`)
}

test("one arrow step is one image pixel and Shift jumps ten", () => {
  assert.equal(stepPixels(false), 1)
  assert.equal(stepPixels(true), 10)

  const right = arrowDelta("ArrowRight", stepPixels(false), image)
  close(right.x, 1 / 400)
  close(right.y, 0)

  const up = arrowDelta("ArrowUp", stepPixels(true), image)
  close(up.x, 0)
  close(up.y, -10 / 200)

  const down = arrowDelta("ArrowDown", stepPixels(false), image)
  close(down.y, 1 / 200)
})

test("a nudge clamps the group to the page and moves every member by the same delta", () => {
  const boxes = [
    { id: "a", x: .9, y: .1, w: .1, h: .1 },
    { id: "b", x: .5, y: .1, w: .1, h: .1 },
  ]
  const stuck = moveSelection(boxes, selection("a", "b"), { dx: .5, dy: 0 })
  close(stuck.get("a").x, .9, "a stays on the right edge")
  close(stuck.get("b").x, .5, "b keeps its offset to a")

  const moved = moveSelection(boxes, selection("a", "b"), { dx: -.2, dy: 0 })
  close(moved.get("a").x, .7)
  close(moved.get("b").x, .3)

  const single = moveSelection([{ id: "a", x: 0, y: .5, w: .2, h: .1 }], selection("a"), { dx: -.1, dy: 0 })
  close(single.get("a").x, 0, "a box on the left edge cannot leave the page")
})

test("snapping pulls a nudge onto the guide it is heading for", () => {
  const boxes = [
    { id: "s", x: .296, y: .5, w: .1, h: .1 },
    { id: "o", x: .3, y: .1, w: .2, h: .1 },
  ]
  const moved = moveSelection(boxes, selection("s"), { dx: 1 / 400, dy: 0 })
  close(moved.get("s").x, .3, "the left edge lands on the other box's edge")
})

test("snapping never pulls a nudge back against its own step", () => {
  const boxes = [{ id: "s", x: .4, y: .4, w: .2, h: .2 }]
  const left = moveSelection(boxes, selection("s"), { dx: -1 / 400, dy: 0 })
  close(left.get("s").x, .4 - 1 / 400, "the centre guide behind the movement is ignored")

  const free = moveSelection(boxes, selection("s"), { dx: -1 / 400, dy: 0, snap: false })
  close(free.get("s").x, .4 - 1 / 400, "Alt keeps the raw step")

  const still = moveSelection(boxes, selection("s"), { dx: 0, dy: -1 / 200 })
  close(still.get("s").x, .4, "a vertical nudge never slides the box sideways")
})

test("the focused handle names the edge the arrows push", () => {
  const boxes = [{ id: "b1", x: .2, y: .2, w: .4, h: .3 }]
  const east = resizeSelection(boxes, selection("b1"), "b1", "e", { dx: .01, dy: 0 })
  close(east.get("b1").w, .41)
  close(east.get("b1").x, .2)

  const west = resizeSelection(boxes, selection("b1"), "b1", "w", { dx: -.01, dy: 0 })
  close(west.get("b1").x, .19)
  close(west.get("b1").w, .41)

  const north = resizeSelection(boxes, selection("b1"), "b1", "n", { dx: 0, dy: -.01 })
  close(north.get("b1").y, .19)
  close(north.get("b1").h, .31)

  const sideways = resizeSelection(boxes, selection("b1"), "b1", "n", { dx: .01, dy: 0 })
  close(sideways.get("b1").x, .2, "a vertical edge ignores a horizontal arrow")

  assert.equal(resizeSelection(boxes, selection("b1"), "b1", "middle", { dx: .01, dy: 0 }).size, 0)
  assert.equal(resizeSelection(boxes, selection("b1"), "gone", "e", { dx: .01, dy: 0 }).size, 0)
})

test("a multi-selection resizes together from one handle", () => {
  const boxes = [
    { id: "a", x: .2, y: .2, w: .4, h: .3 },
    { id: "b", x: .7, y: .5, w: .2, h: .2 },
  ]
  const resized = resizeSelection(boxes, selection("a", "b"), "a", "e", { dx: .01, dy: 0 })
  close(resized.get("a").w, .41)
  close(resized.get("b").w, .21)
  close(resized.get("b").x, .7, "the other member keeps its left edge")
  close(resized.get("b").y, .5)
})

test("a rotated box resizes along its own axes", () => {
  const boxes = [{ id: "b1", x: .3, y: .3, w: .3, h: .3, rotation: 90 }]
  // A quarter turn points the east edge at the page bottom, so the projected step that grows the box
  // is the vertical one; the horizontal arrow runs along the edge and changes nothing.
  const vertical = resizeSelection(boxes, selection("b1"), "b1", "e", { dx: 0, dy: .01, rotation: 90 })
  close(vertical.get("b1").w, .31)

  const along = resizeSelection(boxes, selection("b1"), "b1", "e", { dx: .01, dy: 0, rotation: 90 })
  close(along.get("b1").w, .3)
  assert.ok(along.get("b1").x >= 0 && along.get("b1").x + along.get("b1").w <= 1)
})

test("rotation steps turn every selected box and stay inside a half turn", () => {
  assert.equal(rotationStep("ArrowRight", false), 15)
  assert.equal(rotationStep("ArrowLeft", false), -15)
  assert.equal(rotationStep("ArrowUp", true), -45)
  assert.equal(rotationStep("Enter", false), 0)

  const boxes = [
    { id: "a", x: .1, y: .1, w: .2, h: .2, rotation: 170 },
    { id: "b", x: .5, y: .5, w: .2, h: .2 },
  ]
  const turned = rotateSelection(boxes, selection("a", "b"), 15)
  assert.equal(turned.get("a"), -175)
  assert.equal(turned.get("b"), 15)

  assert.equal(normalizeAngle(180), 180)
  assert.equal(normalizeAngle(-180), -180)
  assert.equal(normalizeAngle(360), 0)
  assert.equal(normalizeAngle(-190), 170)
})

test("geometry fields read and write pixels on the page", () => {
  const box = { x: .25, y: .5, w: .5, h: .25 }
  assert.deepEqual(geometryPixels(box, image), { x: 100, y: 100, w: 200, h: 50 })
  assert.deepEqual(geometryFromPixels({ x: 100, y: 100, w: 200, h: 50 }, image), box)

  const clamped = geometryFromPixels({ x: -40, y: 900, w: 0, h: 0 }, image)
  close(clamped.x, 0)
  close(clamped.w, .03)
  close(clamped.h, .03)
  assert.ok(clamped.y + clamped.h <= 1)
  close(clampRect({ x: .9, y: .9, w: .5, h: .5 }).x, .5)
})

test("the announcement names the geometry a gesture ended on", () => {
  const box = { x: .25, y: .5, w: .5, h: .25 }
  assert.equal(geometryMessage(box, image), "Khung ở X 100, Y 100, rộng 200, cao 50 px.")
  assert.equal(
    geometryMessage(box, { ...image, count: 3 }),
    "3 khung ở X 100, Y 100, rộng 200, cao 50 px.",
  )
  assert.equal(
    geometryMessage({ ...box, rotation: 45 }, image),
    "Khung ở X 100, Y 100, rộng 200, cao 50 px, xoay 45°.",
  )
})

test("the handles carry Vietnamese names for their edge", () => {
  assert.deepEqual(resizeHandles, ["nw", "n", "ne", "e", "se", "s", "sw", "w"])
  assert.equal(resizeHandleLabel("nw"), "Co giãn từ góc trên trái")
  assert.equal(resizeHandleLabel("e"), "Co giãn từ cạnh phải")
  assert.equal(resizeHandleLabel("diagonal"), "Co giãn từ tay cầm")
  assert.equal(rotationHandleLabel(), "Xoay khung")
})

test("the canvas builds the handles as focusable buttons", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
  const block = main.slice(main.indexOf("for (const handle of resizeHandles)"), main.indexOf("outline.append(rot)"))
  assert.ok(block, "renderCanvas must build the resize handles")
  assert.match(block, /dot\.setAttribute\("role", "button"\)/)
  assert.match(block, /dot\.setAttribute\("tabindex", "0"\)/)
  assert.match(block, /dot\.setAttribute\("aria-label", resizeHandleLabel\(handle\)\)/)
  assert.match(block, /dot\.dataset\.focusKey = `handle:\$\{box\.id\}:\$\{handle\}`/)
  assert.match(main, /rot\.setAttribute\("role", "button"\)/)
  assert.match(main, /rot\.setAttribute\("tabindex", "0"\)/)
  assert.match(main, /rot\.setAttribute\("aria-label", rotationHandleLabel\(\)\)/)
  assert.match(main, /rot\.dataset\.focusKey = `rotate:\$\{box\.id\}`/)
})

test("the inspector ships labelled geometry fields wired to the model", async () => {
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
  assert.match(markup, /<details class="prop-group" id="box-geometry">/)
  for (const id of ["box-x", "box-y", "box-w", "box-h"]) {
    assert.match(
      markup,
      new RegExp(`<label class="field" for="${id}">[^<]*<input id="${id}" type="number"`),
      `${id} must be a labelled pixel field`,
    )
  }

  const sync = main.slice(main.indexOf("function syncGeometryFields("), main.indexOf("\nfunction renderInspector("))
  for (const id of ["box-x", "box-y", "box-w", "box-h"]) assert.match(sync, new RegExp(`byId\\("${id}"\\)`))
  const inspector = main.slice(main.indexOf("function renderInspector("), main.indexOf("\nfunction render()"))
  assert.match(inspector, /syncGeometryFields\(\)/)
  const apply = main.slice(main.indexOf("function applyFormToBox("), main.indexOf("\nfunction liveUpdateForm("))
  assert.match(apply, /clampRect\(\{/)
  assert.match(main, /syncGeometry: syncGeometryFields,/)
})

test("the shortcut dialog documents the keyboard geometry keys", async () => {
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
  for (const row of [
    "Dịch khung 1 px (giữ Shift: 10 px), hút theo lưới căn thẳng hàng",
    "Tab tới tay cầm rồi mũi tên",
    "Mũi tên trên tay cầm xoay",
    "<dt>G</dt>",
    "Esc (trong thao tác phím)",
  ]) {
    assert.ok(markup.includes(row), `the shortcut table must list ${row}`)
  }
})
