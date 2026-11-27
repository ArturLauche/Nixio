import assert from "node:assert/strict"
import test from "node:test"

import { setupShortcuts } from "../src/controllers/shortcuts.js"

function installDom({ openDialog = false } = {}) {
  const listeners = {}
  regions.clear()
  globalThis.document = {
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler) },
    querySelector(selector) {
      return selector === "dialog[open]" && openDialog ? { open: true } : null
    },
    getElementById: (id) => regions.get(id) ?? null,
  }
  globalThis.window = { addEventListener() {} }
  return listeners
}

const regions = new Map()

function liveRegion(id = "live-region") {
  const node = { id, textContent: "" }
  regions.set(id, node)
  return node
}

function keyEvent(key, { target, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false, repeat = false } = {}) {
  return {
    key, target, ctrlKey, metaKey, shiftKey, altKey, repeat,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }
}

const plainTarget = { closest: () => null }
const buttonTarget = {
  closest(selector) {
    return selector === "button, [role='button'], a[href]" ? {} : null
  },
}
const inputTarget = {
  closest(selector) {
    return selector === "input, textarea, select, [contenteditable]" ? {} : null
  },
}
const handleTarget = (handle) => ({
  closest(selector) {
    return selector === ".resize-handle" ? { dataset: { handle } } : null
  },
})
const rotateTarget = {
  closest(selector) {
    return selector === ".rotate-handle" ? {} : null
  },
}

function makeDeps(overrides = {}) {
  const calls = {
    space: [], restored: [], deleted: 0, duplicated: 0, rendered: 0, checkpoints: [],
    resized: [], rotated: [], find: 0, shortcutsDialog: 0, focused: [], geometry: 0,
  }
  const state = {
    pages: [{ id: "p1", name: "page-1", image: { naturalWidth: 100, naturalHeight: 100 }, boxes: [{ id: "b1", x: 0.5, y: 0.5, w: 0.2, h: 0.2 }] }],
    pageId: "p1",
    boxId: "b1",
    selectedBoxIds: new Set(["b1"]),
    splitCompare: false,
    compareOriginal: false,
  }
  const fields = new Map()
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { id, value: "", open: false, focus() { calls.focused.push(id) } })
    return fields.get(id)
  }
  const deps = {
    state,
    byId: field,
    stage: {},
    pageCanvas: { width: 100, height: 100 },
    gestures: {
      setSpaceHeld(value) { calls.space.push(value) },
      getSpaceHeld() { return calls.space.at(-1) === true },
    },
    dialogs: {
      openFind() { calls.find++ },
      openShortcuts() { calls.shortcutsDialog++ },
    },
    selectedPage: () => state.pages[0],
    selectedBox: () => state.pages[0].boxes[0],
    projectBusy: () => false,
    editorSnapshot: () => structuredClone({ pages: state.pages, boxId: state.boxId, settings: {} }),
    commitLiveForm() {},
    formEditing: () => false,
    recordNudge(snapshot) { calls.checkpoints.push(snapshot) },
    recordResize(snapshot) { calls.resized.push(snapshot) },
    recordRotate(snapshot) { calls.rotated.push(snapshot) },
    syncGeometry() { calls.geometry++ },
    renderCanvas() { calls.rendered++ },
    restoreHistory(direction) { calls.restored.push(direction) },
    duplicateSelectedBox() { calls.duplicated++ },
    deleteSelectedBoxes() { calls.deleted++ },
    ...overrides,
  }
  return { deps, calls, state, field }
}

function press(listeners, event) {
  for (const handler of listeners.keydown ?? []) handler(event)
}

function release(listeners, event) {
  for (const handler of listeners.keyup ?? []) handler(event)
}

test("space activates focused buttons instead of being stolen by the pan shortcut", () => {
  const listeners = installDom()
  const { deps, calls } = makeDeps()
  setupShortcuts(deps)

  const onButton = keyEvent(" ", { target: buttonTarget })
  press(listeners, onButton)
  assert.equal(onButton.defaultPrevented, false, "button keeps its native Space activation")
  assert.deepEqual(calls.space, [], "pan mode must not start")

  const onStage = keyEvent(" ", { target: plainTarget })
  press(listeners, onStage)
  assert.equal(onStage.defaultPrevented, true)
  assert.deepEqual(calls.space, [true], "space still pans from the canvas")

  const inInput = keyEvent(" ", { target: inputTarget })
  press(listeners, inInput)
  assert.equal(inInput.defaultPrevented, false)
  assert.deepEqual(calls.space, [true])
})

test("destructive shortcuts do not fire while a modal dialog is open", () => {
  const listeners = installDom({ openDialog: true })
  const { deps, calls, state } = makeDeps()
  setupShortcuts(deps)

  const del = keyEvent("Delete", { target: plainTarget })
  press(listeners, del)
  assert.equal(del.defaultPrevented, false)
  assert.equal(calls.deleted, 0, "Delete must not remove boxes behind a dialog")

  const undo = keyEvent("z", { target: plainTarget, ctrlKey: true })
  press(listeners, undo)
  assert.equal(undo.defaultPrevented, false)
  assert.deepEqual(calls.restored, [], "Ctrl+Z must not undo behind a dialog")

  const nudge = keyEvent("ArrowLeft", { target: plainTarget })
  press(listeners, nudge)
  assert.equal(nudge.defaultPrevented, false)
  assert.equal(calls.rendered, 0, "arrows must not move boxes behind a dialog")

  const find = keyEvent("h", { target: plainTarget, ctrlKey: true })
  press(listeners, find)
  assert.equal(find.defaultPrevented, false)
  assert.equal(calls.find, 0)
  assert.equal(state.boxId, "b1")
})

test("shortcuts still work when no dialog is open", () => {
  const listeners = installDom()
  const { deps, calls, state } = makeDeps()
  setupShortcuts(deps)

  const del = keyEvent("Backspace", { target: plainTarget })
  press(listeners, del)
  assert.equal(del.defaultPrevented, true)
  assert.equal(calls.deleted, 1)

  const undo = keyEvent("z", { target: plainTarget, ctrlKey: true })
  press(listeners, undo)
  assert.deepEqual(calls.restored, ["undo"])

  const help = keyEvent("?", { target: plainTarget })
  press(listeners, help)
  assert.equal(calls.shortcutsDialog, 1)

  const nudge = keyEvent("ArrowLeft", { target: plainTarget })
  press(listeners, nudge)
  assert.equal(nudge.defaultPrevented, true)
  assert.equal(calls.rendered, 1, "arrow keys still nudge the selected box")
  assert.equal(state.pages[0].boxes[0].x, 0.49) // 1px of a 100px-wide image
  release(listeners, keyEvent("ArrowLeft", { target: plainTarget }))
})

test("a held arrow key is one history entry that announces the geometry it ended on", () => {
  const listeners = installDom()
  const region = liveRegion()
  const { deps, calls, state } = makeDeps()
  setupShortcuts(deps)

  press(listeners, keyEvent("ArrowRight", { target: plainTarget }))
  press(listeners, keyEvent("ArrowRight", { target: plainTarget, repeat: true }))
  assert.equal(calls.checkpoints.length, 0, "the run is recorded only when it ends")
  assert.equal(region.textContent, "", "no step is announced on its own")

  release(listeners, keyEvent("ArrowRight", { target: plainTarget }))
  assert.equal(calls.checkpoints.length, 1, "the whole run is one history entry")
  assert.ok(Math.abs(state.pages[0].boxes[0].x - 0.52) < 1e-9)
  assert.equal(region.textContent, "Khung ở X 52, Y 50, rộng 20, cao 20 px.")
})

test("Shift nudges ten pixels and an idle run commits without a key up", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const listeners = installDom()
  const { deps, calls, state } = makeDeps()
  const shortcuts = setupShortcuts(deps)

  press(listeners, keyEvent("ArrowDown", { target: plainTarget, shiftKey: true }))
  assert.ok(Math.abs(state.pages[0].boxes[0].y - 0.6) < 1e-9, "Shift moves 10 px of a 100 px page")
  assert.equal(shortcuts.hasPendingNudge(), true)

  t.mock.timers.tick(600)
  assert.equal(shortcuts.hasPendingNudge(), false)
  assert.equal(calls.checkpoints.length, 1)
})

test("a focused resize handle resizes the box and records one entry per run", () => {
  const listeners = installDom()
  const { deps, calls, state } = makeDeps()
  setupShortcuts(deps)

  press(listeners, keyEvent("ArrowRight", { target: handleTarget("e") }))
  const box = state.pages[0].boxes[0]
  assert.ok(Math.abs(box.w - 0.21) < 1e-9, "the east edge grows by one pixel")
  assert.equal(box.x, 0.5, "the opposite edge stays put")
  assert.equal(calls.resized.length, 0)

  release(listeners, keyEvent("ArrowRight", { target: handleTarget("e") }))
  assert.equal(calls.resized.length, 1)
  assert.equal(calls.checkpoints.length, 0, "a resize is not recorded as a nudge")

  press(listeners, keyEvent("ArrowRight", { target: handleTarget("e"), shiftKey: true }))
  assert.ok(Math.abs(box.w - 0.31) < 1e-9, "Shift resizes ten pixels from the same handle")
  release(listeners, keyEvent("ArrowRight", { target: handleTarget("e"), shiftKey: true }))
  assert.equal(calls.resized.length, 2, "a second run is a second entry")
})

test("a multi-selection moves together from the keyboard", () => {
  const listeners = installDom()
  const { deps, state } = makeDeps()
  state.pages[0].boxes.push({ id: "b2", x: 0.2, y: 0.2, w: 0.1, h: 0.1 })
  state.selectedBoxIds.add("b2")
  setupShortcuts(deps)

  press(listeners, keyEvent("ArrowRight", { target: plainTarget }))
  const [first, second] = state.pages[0].boxes
  assert.ok(Math.abs(first.x - 0.51) < 1e-9)
  assert.ok(Math.abs(second.x - 0.21) < 1e-9, "both selected boxes take the same step")
  release(listeners, keyEvent("ArrowRight", { target: plainTarget }))
})

test("the rotate handle turns the box in 15 degree steps", () => {
  const listeners = installDom()
  const { deps, calls, state, field } = makeDeps()
  setupShortcuts(deps)

  press(listeners, keyEvent("ArrowRight", { target: rotateTarget }))
  assert.equal(state.pages[0].boxes[0].rotation, 15)
  assert.equal(field("box-rotation").value, 15, "the inspector field follows the keyboard")

  press(listeners, keyEvent("ArrowRight", { target: rotateTarget, shiftKey: true }))
  assert.equal(state.pages[0].boxes[0].rotation, 60)

  release(listeners, keyEvent("ArrowRight", { target: rotateTarget }))
  assert.equal(calls.rotated.length, 1)
  assert.equal(calls.geometry, 2, "each step rewrites the geometry fields")
})

test("Escape cancels the run without writing a history entry", () => {
  const listeners = installDom()
  const region = liveRegion()
  const { deps, calls, state } = makeDeps()
  setupShortcuts(deps)

  press(listeners, keyEvent("ArrowRight", { target: plainTarget }))
  press(listeners, keyEvent("ArrowRight", { target: plainTarget, repeat: true }))
  const escape = keyEvent("Escape", { target: plainTarget })
  press(listeners, escape)

  assert.equal(escape.defaultPrevented, true)
  assert.equal(state.pages[0].boxes[0].x, 0.5, "the box goes back to where the run started")
  assert.equal(calls.checkpoints.length, 0)
  assert.equal(region.textContent, "Đã huỷ thao tác khung bằng phím.")

  const idle = keyEvent("Escape", { target: plainTarget })
  press(listeners, idle)
  assert.equal(idle.defaultPrevented, false, "Escape without a run keeps its other meaning")
})

test("G opens and focuses the geometry fields but never interrupts typing", () => {
  const listeners = installDom()
  const { deps, calls, field } = makeDeps()
  setupShortcuts(deps)

  const typed = keyEvent("g", { target: inputTarget })
  press(listeners, typed)
  assert.equal(typed.defaultPrevented, false, "a g typed into a field stays a g")
  assert.deepEqual(calls.focused, [])

  const shortcut = keyEvent("g", { target: plainTarget })
  press(listeners, shortcut)
  assert.equal(shortcut.defaultPrevented, true)
  assert.equal(field("box-geometry").open, true, "the fields are revealed before they take focus")
  assert.deepEqual(calls.focused, ["box-x"])
})

test("Escape clears the page selection and Ctrl+A inside the page list selects all (#74)", () => {
  const listeners = installDom()
  const { deps } = makeDeps()
  const pageListTarget = { closest: (selector) => (selector === "#pages" ? {} : null) }
  const selection = {
    size: 2,
    cleared: 0,
    selectedAll: 0,
    count() { return this.size },
    clear() { this.cleared++; this.size = 0 },
    selectAll() { this.selectedAll++ },
    owns: (target) => target === pageListTarget,
  }
  setupShortcuts({ ...deps, pageSelection: selection })

  const escape = keyEvent("Escape", { target: pageListTarget })
  press(listeners, escape)
  assert.equal(escape.defaultPrevented, true)
  assert.equal(selection.cleared, 1)
  assert.equal(selection.size, 0)

  const secondEscape = keyEvent("Escape", { target: pageListTarget })
  press(listeners, secondEscape)
  assert.equal(secondEscape.defaultPrevented, false, "nothing left to clear")
  assert.equal(selection.cleared, 1)

  selection.size = 1
  const selectAll = keyEvent("a", { target: pageListTarget, ctrlKey: true })
  press(listeners, selectAll)
  assert.equal(selectAll.defaultPrevented, true)
  assert.equal(selection.selectedAll, 1)

  const outside = keyEvent("a", { target: plainTarget, ctrlKey: true })
  press(listeners, outside)
  assert.equal(outside.defaultPrevented, false, "Ctrl+A outside the page list keeps its native meaning")
  assert.equal(selection.selectedAll, 1)
})
