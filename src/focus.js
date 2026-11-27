// The editor rebuilds whole lists and canvases, so the control that holds the caret is destroyed
// before the browser can move focus on: focus falls to <body> and the keyboard user has to Tab in
// from the top of the document again. A control that must survive a rebuild names itself with a
// stable data-focus-key, and holdFocus carries that key across the rebuild. The key is restored,
// never the row position, because a rebuild can reorder or drop rows, so an index would land on
// whichever row happened to move into that slot.

const keyAttribute = "data-focus-key"

const keyOf = (element) => element?.dataset?.focusKey || element?.getAttribute?.(keyAttribute) || ""

function findByKey(node, key) {
  for (const child of node?.children ?? []) {
    if (keyOf(child) === key) return child
    const found = findByKey(child, key)
    if (found) return found
  }
  return null
}

// The scroll container keeps its element across the rebuild, so the offset the user scrolled to is
// written back to the same node instead of being lost when its content is replaced.
function scrollerOf(element) {
  if (typeof globalThis.getComputedStyle !== "function") return null
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(globalThis.getComputedStyle(node).overflowY)) return node
  }
  return null
}

// Capture before the rebuild, call the returned function once the new nodes exist.
export function holdFocus(...roots) {
  const doc = globalThis.document
  const active = doc?.activeElement
  const key = active && active !== doc?.body ? keyOf(active) : ""
  const scroller = scrollerOf(active)
  const scrolled = scroller?.scrollTop
  const search = roots.length ? roots : [doc?.body ?? doc]

  return () => {
    const target = key ? search.map((root) => findByKey(root, key)).find(Boolean) : null
    // The caret comes back without scrolling: a rebuild that briefly emptied the container already
    // moved the viewport, so the offset captured above is what the user was looking at.
    if (target && !target.disabled) target.focus({ preventScroll: true })
    if (scroller && scrolled !== undefined) scroller.scrollTop = scrolled
  }
}
