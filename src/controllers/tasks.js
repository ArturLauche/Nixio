import { desktop } from "../native.js"
import { holdFocus } from "../focus.js"
import { announce } from "../live-region.js"

const ACTIVE = ["running", "queued"]
// A task that starts or stops working changes what the reader can do, so each state change is
// announced once; progress ticks stay visual.
const ANNOUNCED = ["running", "done", "error", "cancelled"]

export function setupTasks(byId) {
  if (!desktop?.onTask) return
  const tasks = new Map()
  const announcedStates = new Map()
  const panel = byId("task-panel")
  const list = byId("task-list")

  // One press is enough: the row reports the cancellation and ignores further presses until the
  // worker answers, and the button stays focusable so the caret does not jump out of the panel.
  function cancel(id) {
    const task = tasks.get(id)
    if (!task || task.cancelling) return
    task.cancelling = true
    desktop.cancelTask(id)
    paint()
  }

  function row(task) {
    const item = document.createElement("li")
    const label = document.createElement("span")
    label.textContent = task.operation + " · " + task.stage
    const progress = document.createElement("progress")
    progress.max = 100
    progress.value = task.progress
    progress.setAttribute("aria-label", label.textContent)
    item.append(label, progress)
    if (ACTIVE.includes(task.state)) {
      const cancelButton = document.createElement("button")
      cancelButton.className = "button"
      cancelButton.dataset.focusKey = "task:" + task.id
      cancelButton.textContent = task.cancelling ? "Đang hủy…" : "Hủy"
      if (task.cancelling) cancelButton.setAttribute("aria-disabled", "true")
      cancelButton.onclick = () => cancel(task.id)
      item.append(cancelButton)
    }
    return item
  }

  function paint() {
    const rows = [...tasks.values()].slice(-10)
    const restoreFocus = holdFocus(list)
    panel.hidden = !rows.some((task) => ACTIVE.includes(task.state))
    list.replaceChildren(...rows.map(row))
    restoreFocus()
    for (const [id, task] of tasks) {
      if (!rows.includes(task) && !ACTIVE.includes(task.state)) {
        tasks.delete(id)
        announcedStates.delete(id)
      }
    }
  }

  desktop.onTask((update) => {
    const known = tasks.get(update.id)
    tasks.set(update.id, { ...update, cancelling: Boolean(known?.cancelling) })
    // The queue names its own stages ("Đang xử lý", "Hoàn tất", "Đã hủy"), so the announcement is
    // the operation plus that stage.
    if (announcedStates.get(update.id) !== update.state) {
      announcedStates.set(update.id, update.state)
      if (ANNOUNCED.includes(update.state)) {
        announce(`${update.operation}: ${update.stage}.`, { assertive: update.state === "error" })
      }
    }
    paint()
  })
}
