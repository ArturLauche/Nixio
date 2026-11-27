import { nudgeBox } from "../tools.js"

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
  checkpoint,
  renderCanvas,
  restoreHistory,
  duplicateSelectedBox,
  deleteSelectedBoxes,
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
    checkpoint(before)
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
    if (event.key === " " && !event.repeat && selectedPage()
      && !event.target.closest("button, [role='button'], a[href]")) {
      event.preventDefault()
      gestures.setSpaceHeld(true)
      return
    }
    if ((event.key === "\\" || event.key === "|") && selectedPage()) {
      event.preventDefault()
      if (event.shiftKey || event.key === "|") {
        state.splitCompare = !state.splitCompare
        if (state.splitCompare) state.compareOriginal = false
      } else {
        state.compareOriginal = !state.compareOriginal
        if (state.compareOriginal) state.splitCompare = false
      }
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

  return { commitNudge }
}
