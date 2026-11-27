import { nudgeBox } from "../tools.js"
import { toggleCompare } from "../compare.js"

const arrowKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]

export function setupShortcuts({
  state,
  stage,
  gestures,
  dialogs,
  selectedPage,
  selectedBox,
  projectBusy,
  editorSnapshot,
  commitLiveForm,
  formEditing,
  renderCanvas,
  restoreHistory,
  duplicateSelectedBox,
  deleteSelectedBoxes,
  toggleHistoryPanel,
  recordNudge,
  pageSelection,
}) {
  let nudgeSnapshot = null
  let nudgeTimer = null

  function commitNudge() {
    if (nudgeTimer) {
      clearTimeout(nudgeTimer)
      nudgeTimer = null
    }
    if (!nudgeSnapshot) return false
    const before = nudgeSnapshot
    nudgeSnapshot = null
    recordNudge(before)
    return true
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
    // Escape drops the additive page selection wherever focus sits; dialogs and text fields keep
    // their own Escape behaviour through the guards above.
    if (event.key === "Escape" && pageSelection?.count() > 0) {
      event.preventDefault()
      pageSelection.clear()
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
    if (arrowKeys.includes(event.key) && event.target !== stage) {
      const page = selectedPage()
      const targets = page && state.selectedBoxIds.size > 1
        ? page.boxes.filter((item) => state.selectedBoxIds.has(item.id))
        : [selectedBox()].filter(Boolean)
      if (!targets.length || projectBusy()) return
      event.preventDefault()
      const stepPx = event.shiftKey ? 10 : 1
      const dx = (event.key === "ArrowRight" ? stepPx : event.key === "ArrowLeft" ? -stepPx : 0) / page.image.naturalWidth
      const dy = (event.key === "ArrowDown" ? stepPx : event.key === "ArrowUp" ? -stepPx : 0) / page.image.naturalHeight
      if (formEditing()) commitLiveForm()
      if (!nudgeSnapshot) nudgeSnapshot = editorSnapshot()
      for (const item of targets) Object.assign(item, nudgeBox(item, dx, dy))
      renderCanvas()
      if (nudgeTimer) clearTimeout(nudgeTimer)
      nudgeTimer = setTimeout(commitNudge, 600)
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

  return { commitNudge, hasPendingNudge: () => Boolean(nudgeSnapshot || nudgeTimer) }
}
