// Nixio #106, #107: page, native-worker, OCR and task state all change asynchronously, so they are
// announced through one pair of live regions instead of a private copy per controller. The nodes ship
// in index.html; a caller without them (a test, a detached document) skips the announcement.
const POLITE_REGION = "live-region"
const ASSERTIVE_REGION = "live-region-alert"

export function announce(message, { assertive = false } = {}) {
  const text = String(message ?? "").trim()
  if (!text) return
  const node = globalThis.document?.getElementById?.(assertive ? ASSERTIVE_REGION : POLITE_REGION)
  // Writing the same sentence again leaves the node untouched, so it is not repeated.
  if (node && node.textContent !== text) node.textContent = text
}
