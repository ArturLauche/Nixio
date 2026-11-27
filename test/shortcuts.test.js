import assert from "node:assert/strict"
import test from "node:test"

import { setupShortcuts } from "../src/controllers/shortcuts.js"

function installDom({ openDialog = false } = {}) {
  const listeners = {}
  globalThis.document = {
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler) },
    querySelector(selector) {
      return selector === "dialog[open]" && openDialog ? { open: true } : null
    },
  }
  globalThis.window = { addEventListener() {} }
  return listeners
}

function keyEvent(key, { target, ctrlKey = false, metaKey = false, shiftKey = false, repeat = false } = {}) {
  return {
    key, target, ctrlKey, metaKey, shiftKey, repeat,
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

function makeDeps(overrides = {}) {
  const calls = { space: [], restored: [], deleted: 0, duplicated: 0, rendered: 0, checkpoints: [], find: 0, shortcutsDialog: 0 }
  const state = {
    pages: [{ id: "p1", name: "page-1", image: { naturalWidth: 100, naturalHeight: 100 }, boxes: [{ id: "b1", x: 0.5, y: 0.5, w: 0.2, h: 0.2 }] }],
    pageId: "p1",
    boxId: "b1",
    selectedBoxIds: new Set(["b1"]),
    splitCompare: false,
    compareOriginal: false,
  }
  const deps = {
    state,
    stage: {},
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
    editorSnapshot: () => ({ snapshot: true }),
    commitLiveForm() {},
    formEditing: () => false,
    checkpoint(snapshot) { calls.checkpoints.push(snapshot) },
    renderCanvas() { calls.rendered++ },
    restoreHistory(direction) { calls.restored.push(direction) },
    duplicateSelectedBox() { calls.duplicated++ },
    deleteSelectedBoxes() { calls.deleted++ },
    ...overrides,
  }
  return { deps, calls, state }
}

function press(listeners, event) {
  for (const handler of listeners.keydown ?? []) handler(event)
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
})
