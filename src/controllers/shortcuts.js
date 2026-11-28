import { announce } from "../live-region.js"
import { toggleCompare } from "../compare.js"
import {
  arrowDelta, geometryMessage, moveSelection, resizeSelection, rotateSelection,
  rotationStep, stepPixels,
} from "../keyboard-geometry.js"

const arrowKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
// A held arrow repeats faster than this, so the idle commit closes a gesture whose keyup never
// arrived, and a run of taps slower than this is a run of separate actions.
const GESTURE_IDLE_MS = 600

export function setupShortcuts({
  state,
  byId,
  stage,
  pageCanvas,
  gestures,
  dialogs,
  selectedPage,
  selectedBox,
  projectBusy,
  editorSnapshot,
  commitLiveForm,
  formEditing,
  renderCanvas,
  syncGeometry,
  restoreHistory,
  duplicateSelectedBox,
  deleteSelectedBoxes,
  toggleHistoryPanel,
  recordNudge,
  recordResize,
  recordRotate,
  pageSelection,
}) {
  let pending = null

  function commitNudge() {
    if (!pending) return false
    const { kind, before, timer } = pending
    clearTimeout(timer)
    pending = null
    if (kind === "resize") recordResize(before)
    else if (kind === "rotate") recordRotate(before)
    else recordNudge(before)
    announceGeometry()
    return true
  }

  // One key-down run is one action: the first step takes the snapshot and the repeats only move
  // geometry, so a held arrow writes a single history entry. Switching gesture (a nudge that turns
  // into a resize) closes the previous run first.
  function startGesture(kind, key) {
    if (pending?.key !== key) commitNudge()
    if (!pending) pending = { kind, key, before: editorSnapshot(), timer: null }
    clearTimeout(pending.timer)
    pending.timer = setTimeout(commitNudge, GESTURE_IDLE_MS)
  }

  // Escape before the run ended leaves nothing in history, so the snapshot is put back instead of
  // recorded: the gesture is undone without an entry to undo.
  function cancelGesture() {
    if (!pending) return false
    const { before, timer } = pending
    clearTimeout(timer)
    pending = null
    const { settings, ...editor } = before
    Object.assign(state, editor)
    renderCanvas()
    syncGeometry?.()
    announce("Đã huỷ thao tác khung bằng phím.")
    return true
  }

  function geometryContext() {
    const page = selectedPage()
    const box = selectedBox()
    if (!page || !box) return null
    return { page, box, size: { width: page.image.naturalWidth, height: page.image.naturalHeight } }
  }

  function selectionIds() {
    if (state.selectedBoxIds.size > 1) return new Set(state.selectedBoxIds)
    return new Set([state.boxId].filter(Boolean))
  }

  function writeRects(page, rects) {
    for (const [id, rect] of rects) {
      const item = page.boxes.find((box) => box.id === id)
      if (item) Object.assign(item, rect)
    }
  }

  function announceGeometry() {
    const context = geometryContext()
    if (!context) return
    announce(geometryMessage(context.box, { ...context.size, count: state.selectedBoxIds.size }))
  }

  function focusGeometryFields() {
    const group = byId("box-geometry")
    if (group) group.open = true
    byId("box-x")?.focus()
  }

  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return
    const editingText = Boolean(event.target.closest("input, textarea, select, [contenteditable]"))
    const key = event.key.toLowerCase()
    if (event.ctrlKey || event.metaKey) {
      if (event.altKey) return
      if ((key === "h" || key === "f") && !event.shiftKey) {
        event.preventDefault()
        dialogs.openFind()
        return
      }
      if (key === "h" && event.shiftKey) {
        event.preventDefault()
        toggleHistoryPanel?.(true)
        return
      }
      // Ctrl/Cmd+A inside the page list selects the whole chapter for the bulk bar; the only
      // inputs there are row checkboxes, so this stays clear of text fields.
      if (key === "a" && pageSelection?.owns?.(event.target)) {
        event.preventDefault()
        pageSelection.selectAll()
        return
      }
      if (editingText) return
      if (key === "z" || key === "y") {
        event.preventDefault()
        restoreHistory(key === "y" || event.shiftKey ? "redo" : "undo")
        return
      }
      if (key === "d" && selectedBox()) {
        event.preventDefault()
        duplicateSelectedBox()
        return
      }
      return
    }
    if (editingText) return
    // The history panel handles its own arrows and Enter, so nudging, Space-panning or deleting a
    // box from inside the timeline must not happen. Undo and redo shortcuts still work up above.
    if (event.target.closest("#history-panel")) return
    if (event.key === "Escape" && cancelGesture()) {
      event.preventDefault()
      return
    }
    // Escape drops the additive page selection wherever focus sits; dialogs and text fields keep
    // their own Escape behaviour through the guards above.
    if (event.key === "Escape" && pageSelection?.count() > 0) {
      event.preventDefault()
      pageSelection.clear()
      return
    }
    // The geometry fields sit behind a details group, so the shortcut opens it before taking focus.
    // The text guard above keeps a typed "g" a typed "g".
    if (key === "g" && !event.altKey && !event.shiftKey) {
      if (!geometryContext()) return
      event.preventDefault()
      focusGeometryFields()
      return
    }
    if (event.key === " " && !event.repeat && selectedPage()
      && !event.target.closest("button, [role='button'], a[href]")) {
      event.preventDefault()
      gestures.setSpaceHeld(true)
      return
    }
    if ((event.key === "\\" || event.key === "|") && selectedPage()) {
      event.preventDefault()
      // The key pair drives the same toggles as the buttons, so a second press restores the view
      // the first one replaced instead of dropping the user in the edit view.
      Object.assign(state, toggleCompare(state, event.shiftKey || event.key === "|" ? "split" : "original"))
      renderCanvas()
      return
    }
    if (event.key === "?") {
      event.preventDefault()
      dialogs.openShortcuts()
      return
    }
    if ((event.key === "Delete" || event.key === "Backspace") && (state.boxId || state.selectedBoxIds.size)) {
      event.preventDefault()
      deleteSelectedBoxes()
      return
    }
    const handle = event.target.closest?.(".resize-handle")?.dataset.handle
    const rotating = Boolean(event.target.closest?.(".rotate-handle"))
    if ((handle || rotating) && arrowKeys.includes(event.key)) {
      const context = geometryContext()
      if (!context || projectBusy()) return
      event.preventDefault()
      if (formEditing()) commitLiveForm()
      const ids = selectionIds()
      if (rotating) {
        startGesture("rotate", `rotate:${context.box.id}`)
        for (const [id, rotation] of rotateSelection(context.page.boxes, ids, rotationStep(event.key, event.shiftKey))) {
          const item = context.page.boxes.find((box) => box.id === id)
          if (item) item.rotation = rotation
        }
        byId("box-rotation").value = context.box.rotation
      } else {
        startGesture("resize", `resize:${context.box.id}:${handle}`)
        const delta = arrowDelta(event.key, stepPixels(event.shiftKey), context.size)
        writeRects(context.page, resizeSelection(context.page.boxes, ids, context.box.id, handle, {
          dx: delta.x,
          dy: delta.y,
          rotation: context.box.rotation ?? 0,
          aspect: pageCanvas.width / Math.max(1, pageCanvas.height),
        }))
      }
      renderCanvas()
      syncGeometry?.()
      return
    }
    if (arrowKeys.includes(event.key) && event.target !== stage) {
      const context = geometryContext()
      if (!context || projectBusy()) return
      event.preventDefault()
      if (formEditing()) commitLiveForm()
      startGesture("move", "move")
      const delta = arrowDelta(event.key, stepPixels(event.shiftKey), context.size)
      writeRects(context.page, moveSelection(context.page.boxes, selectionIds(), {
        dx: delta.x,
        dy: delta.y,
        snap: !event.altKey,
      }))
      renderCanvas()
      syncGeometry?.()
    }
  })

  document.addEventListener("keyup", (event) => {
    if (event.key === " " && gestures.getSpaceHeld()) {
      gestures.setSpaceHeld(false)
    }
    if (arrowKeys.includes(event.key)) {
      commitNudge()
    }
  })
  window.addEventListener("blur", () => {
    if (gestures.getSpaceHeld()) gestures.setSpaceHeld(false)
    commitNudge()
  })

  return { commitNudge, hasPendingNudge: () => Boolean(pending) }
}
