import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { holdFocus } from "../src/focus.js"

function fakeNode(key = "") {
  const node = {
    dataset: {},
    children: [],
    parentElement: null,
    focused: false,
    scrollTop: 0,
    focus(options) {
      node.focused = true
      node.focusedWith = options
      globalThis.document.activeElement = node
    },
  }
  if (key) node.dataset.focusKey = key
  return node
}

// A list of rows, each holding one keyed control, the way the page and box lists are built.
function rebuild(list, keys) {
  list.children = keys.map((key) => {
    const row = fakeNode()
    const control = fakeNode(key)
    control.parentElement = row
    row.parentElement = list
    row.children = [control]
    return row
  })
  return list
}

const listOf = (keys) => rebuild(fakeNode(), keys)
const control = (list, index) => list.children[index].children[0]

function installDocument(active = null) {
  globalThis.document = { activeElement: active, body: fakeNode() }
  return globalThis.document
}

test("holdFocus gives the caret back to the control it came from, not to its old position", () => {
  const list = listOf(["page:a", "page:b", "page:c"])
  installDocument(control(list, 1))

  const restore = holdFocus(list)
  rebuild(list, ["page:b", "page:a", "page:c"])
  restore()

  assert.equal(control(list, 0).focused, true, "the keyed control moves and takes the caret with it")
  assert.equal(control(list, 1).focused, false, "the row that slid into the old slot is left alone")
  assert.deepEqual(control(list, 0).focusedWith, { preventScroll: true })
})

test("a control that did not survive the rebuild leaves the caret where it is", () => {
  const list = listOf(["page:a", "page:b"])
  installDocument(control(list, 1))

  const restore = holdFocus(list)
  rebuild(list, ["page:a"])
  restore()

  assert.equal(control(list, 0).focused, false)
})

test("holdFocus puts the scrolled container back where the user left it", (t) => {
  const scroller = fakeNode()
  scroller.scrolls = true
  const list = listOf(["queue:1:anh", "queue:1:em"])
  list.parentElement = scroller
  scroller.children = [list]
  installDocument(control(list, 1))
  scroller.scrollTop = 240
  globalThis.getComputedStyle = (node) => ({ overflowY: node.scrolls ? "auto" : "visible" })
  t.after(() => { delete globalThis.getComputedStyle })

  const restore = holdFocus(list)
  rebuild(list, ["queue:1:anh", "queue:1:em"])
  restore()

  assert.equal(control(list, 1).focused, true)
  assert.equal(scroller.scrollTop, 240, "replacing the rows must not jump the reader back to the top")
})

test("holdFocus does nothing while focus sits outside the rebuilt list", () => {
  const list = listOf(["page:a"])
  installDocument(null)

  const restore = holdFocus(list)
  rebuild(list, ["page:a"])
  restore()

  assert.equal(control(list, 0).focused, false)
})

function bodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} must exist`)
  const end = source.indexOf("\n}\n", start)
  assert.ok(end > start, `${name} must be a top-level function`)
  return source.slice(start, end)
}

// The restore only works if the rebuilt lists key their controls, so the shipped render paths are
// read from the real source instead of being mirrored here.
test("every rebuilt list in the editor restores focus through the shared helper", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
  const paths = [["renderPages", 'byId("pages")'], ["renderCanvas", "overlays"], ["renderInspector", 'byId("boxes")']]
  for (const [name, root] of paths) {
    const body = bodyOf(main, name)
    assert.ok(body.includes(`holdFocus(${root}`), `${name} must capture focus before rebuilding its list`)
    assert.ok(body.includes("restoreFocus()"), `${name} must restore focus once the new rows exist`)
    assert.ok(body.includes(".dataset.focusKey = "), `${name} must key its controls by identity`)
  }
  const tasks = await readFile(new URL("../src/controllers/tasks.js", import.meta.url), "utf8")
  assert.ok(tasks.includes("holdFocus(list)"), "the task list must restore focus across its progress ticks")
})
