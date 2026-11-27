// Clearing the field clears the box: the canvas then draws no text, so the inspector has nothing
// older to write back when the user picks another box. The previous line is never kept "just in
// case", because that is exactly what resurrected it on the next selection.
export function applyBoxText(box, value) {
  box.text = String(value ?? "").trim()
}

// Only the explicit save is validated: a field with no visible text has nothing to draw, so it is
// refused with a message next to the field instead of quietly restoring the previous line.
export function boxTextError(value) {
  return String(value ?? "").trim() ? "" : "Hãy nhập nội dung khung."
}

// An empty box still needs a name in the outline and in the box list.
export function boxLabel(box) {
  return String(box?.text ?? "").trim() || "Khung trống"
}
