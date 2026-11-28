// The editor shows the original image, the split curtain, or the edit view. The two compare toggles
// override the view they were opened from, so turning one off has to put the user back in that view
// instead of dropping them in the edit view: compareRestore remembers the view the toggle replaced.
const compareModes = ["original", "split"]

export function compareMode(state) {
  if (state?.compareOriginal) return "original"
  if (state?.splitCompare) return "split"
  return "edit"
}

function compareFields(mode, restore) {
  return {
    compareOriginal: mode === "original",
    splitCompare: mode === "split",
    compareRestore: restore,
  }
}

// A remembered view is restored only when it is a compare view and not the one being switched off,
// so a stale or self-referencing value falls back to the edit view instead of looping on itself.
function restoreMode(state) {
  const stored = state?.compareRestore
  if (stored !== "original" && stored !== "split") return "edit"
  return stored === compareMode(state) ? "edit" : stored
}

export function toggleCompare(state, mode) {
  const current = compareMode(state)
  if (!compareModes.includes(mode)) return compareFields(current, restoreMode(state))
  if (current === mode) return compareFields(restoreMode(state), "edit")
  return compareFields(mode, current)
}
