import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { outlineMarks, resizeGroup, showsTransformHandles } from "../src/selection.js"
import { resizeBox } from "../src/tools.js"

const css = (await readFile(new URL("../src/style.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "")
const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
const gestures = await readFile(new URL("../src/controllers/gestures.js", import.meta.url), "utf8")

const ids = (...list) => new Set(list)

function assertRectClose(actual, expected) {
  for (const key of ["x", "y", "w", "h"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} !== ${expected[key]}`)
  }
}

// Resolves the declarations an outline gets from style.css, so a rule that ties on specificity but
// sits later in the file is caught instead of being read as "the primary rule wins".
function cascade({ classes = [], attributes = [] }) {
  const rules = []
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const selector of match[1].split(",")) {
      const trimmed = selector.trim()
      if (!/^\.outline/.test(trimmed)) continue
      const excluded = [...trimmed.matchAll(/:not\(\[([\w-]+)\]\)/g)].map((hit) => hit[1])
      const positive = trimmed.replace(/:not\(\[[\w-]+\]\)/g, "")
      const wanted = [...positive.matchAll(/\.([\w-]+)/g)].map((hit) => hit[1])
      const wantedAttributes = [...positive.matchAll(/\[([\w-]+)\]/g)].map((hit) => hit[1])
      if (!wanted.every((name) => classes.includes(name))) continue
      if (!wantedAttributes.every((name) => attributes.includes(name))) continue
      if (excluded.some((name) => attributes.includes(name))) continue
      rules.push({ specificity: wanted.length + wantedAttributes.length + excluded.length, body: match[2] })
    }
  }
  const declarations = {}
  rules
    .map((rule, index) => ({ ...rule, index }))
    .sort((a, b) => a.specificity - b.specificity || a.index - b.index)
    .forEach((rule) => {
      for (const entry of rule.body.split(";")) {
        const [name, ...value] = entry.split(":")
        if (value.length) declarations[name.trim()] = value.join(":").trim()
      }
    })
  return declarations
}

test("a multi-selection keeps one primary box and marks the rest as the group (#98)", () => {
  const selected = ids("a", "b", "c")
  assert.deepEqual(outlineMarks({ id: "a", boxId: "a", selectedIds: selected }), { primary: true, multi: true })
  assert.deepEqual(outlineMarks({ id: "b", boxId: "a", selectedIds: selected }), { primary: false, multi: true })
  assert.deepEqual(outlineMarks({ id: "a", boxId: "a", selectedIds: ids("a") }), { primary: true, multi: false })
  assert.deepEqual(outlineMarks({ id: "b", boxId: "a", selectedIds: ids("a") }), { primary: false, multi: false })
})

test("the primary keeps the transform handles inside a group (#98)", () => {
  const selected = ids("a", "b", "c")
  const primary = outlineMarks({ id: "a", boxId: "a", selectedIds: selected })
  const member = outlineMarks({ id: "b", boxId: "a", selectedIds: selected })
  const text = { tool: "text", placing: false, compareOriginal: false }
  assert.equal(showsTransformHandles({ marks: primary, ...text }), true)
  assert.equal(showsTransformHandles({ marks: member, ...text }), false)
  assert.equal(showsTransformHandles({ marks: primary, ...text, placing: true }), false)
  assert.equal(showsTransformHandles({ marks: primary, ...text, compareOriginal: true }), false)
  assert.equal(showsTransformHandles({ marks: primary, ...text, tool: "region" }), false)
})

test("the canvas renders those handles from the marks, not from a single-selection count (#98)", () => {
  assert.doesNotMatch(main, /multiCount <= 1/)
  assert.match(main, /showsTransformHandles\(\{ marks, tool, placing: state\.placing, compareOriginal: state\.compareOriginal \}\)/)
  assert.match(gestures, /resizeGroup\(gesture\.starts, gesture\.box\.id, next\)/)
})

test("the primary outline wins the cascade against the group highlight (#98)", () => {
  const primary = cascade({ classes: ["outline", "multi-selected"], attributes: ["aria-current"] })
  assert.match(primary.border, /var\(--accent\)/, "the primary keeps its accent border")
  assert.match(primary["box-shadow"], /inset/, "the primary gains an inner ring inside the group")

  const member = cascade({ classes: ["outline", "multi-selected"] })
  assert.match(member.border, /1\.5px solid #0284c7/, "the rest of the group keeps the blue highlight")

  const single = cascade({ classes: ["outline"], attributes: ["aria-current"] })
  assert.match(single.border, /var\(--accent\)/)
  assert.equal(single["box-shadow"], undefined)
})

test("resizing the group applies the primary's change to every selected box (#98)", () => {
  // The se handle grows the primary without moving its origin: the group has to grow with it, or the
  // handle would only ever resize the primary and never the selection it belongs to.
  const starts = new Map([
    ["a", { x: .2, y: .2, w: .2, h: .1 }],
    ["b", { x: .5, y: .3, w: .1, h: .1 }],
    ["c", { x: .7, y: .5, w: .15, h: .2 }],
  ])
  const next = resizeBox(starts.get("a"), "se", { x: .1, y: .05 })
  const resized = resizeGroup(starts, "a", next)
  assertRectClose(resized.get("a"), { x: .2, y: .2, w: .3, h: .15 })
  assertRectClose(resized.get("b"), { x: .5, y: .3, w: .2, h: .15 })
  assertRectClose(resized.get("c"), { x: .7, y: .5, w: .25, h: .25 })
  assert.equal(resized.size, starts.size)
})

test("a handle that moves the origin carries the whole group with it (#98)", () => {
  const starts = new Map([
    ["a", { x: .3, y: .3, w: .2, h: .1 }],
    ["b", { x: .6, y: .5, w: .1, h: .1 }],
  ])
  const next = resizeBox(starts.get("a"), "nw", { x: -.1, y: -.05 })
  const resized = resizeGroup(starts, "a", next)
  assertRectClose(resized.get("a"), { x: .2, y: .25, w: .3, h: .15 })
  assertRectClose(resized.get("b"), { x: .5, y: .45, w: .2, h: .15 })
})

test("a group resize keeps every member on the page and above the minimum size (#98)", () => {
  const near = new Map([
    ["a", { x: .1, y: .1, w: .2, h: .1 }],
    ["b", { x: .85, y: .85, w: .1, h: .1 }],
  ])
  const grown = resizeGroup(near, "a", { x: .1, y: .1, w: .4, h: .3 })
  assert.ok(grown.get("b").x + grown.get("b").w <= 1 + 1e-9, "the member stays inside the page")
  assert.ok(grown.get("b").y + grown.get("b").h <= 1 + 1e-9)
  assertRectClose(grown.get("b"), { x: .7, y: .7, w: .3, h: .3 })

  const shrunk = resizeGroup(near, "a", { x: .1, y: .1, w: .01, h: .01 })
  assert.ok(shrunk.get("b").w >= .03 - 1e-9, "the member keeps a usable width")
  assert.ok(shrunk.get("b").h >= .03 - 1e-9)
})

test("a group resize without a known primary leaves every box alone", () => {
  const starts = new Map([["b", { x: .4, y: .2, w: .2, h: .1 }]])
  assert.equal(resizeGroup(starts, "a", { x: .5, y: .3, w: .2, h: .1 }).size, 0)
  assert.equal(resizeGroup(starts, "b", null).size, 0)
  assert.deepEqual([...resizeGroup(starts, "b", { x: .5, y: .3, w: .2, h: .1 }).values()], [{ x: .5, y: .3, w: .2, h: .1 }])
})
