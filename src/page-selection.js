import { shareInpaintOrigins } from "./retouch.js"

// Page-list bulk selection (#74). `selectedPageIds` is additive UI state: the inspector keeps
// editing the primary page (`pageId`) while the set names every page a bulk action will touch.
export function pageIndex(pages, id) {
  return pages.findIndex((page) => page.id === id)
}

// Inclusive chapter-order id range between two pages; either end missing selects nothing.
export function pageRangeIds(pages, anchorId, targetId) {
  const from = pageIndex(pages, anchorId)
  const to = pageIndex(pages, targetId)
  if (from < 0 || to < 0) return []
  const [start, end] = from <= to ? [from, to] : [to, from]
  return pages.slice(start, end + 1).map((page) => page.id)
}

// The shift-range anchor falls back to the primary page, then to the chapter start, so a range
// still works after the anchor page was removed or the selection came from select-all.
export function rangeAnchorId(pages, anchorId, pageId) {
  if (pageIndex(pages, anchorId) >= 0) return anchorId
  if (pageIndex(pages, pageId) >= 0) return pageId
  return pages[0]?.id ?? null
}

export function togglePageId(selectedIds, id) {
  const next = new Set(selectedIds ?? [])
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function selectAllPageIds(pages) {
  return new Set(pages.map((page) => page.id))
}

// Selected pages always act in chapter order, no matter how the set was built.
export function selectedPages(pages, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? [])
  return pages.filter((page) => ids.has(page.id))
}

// Each selected page bubbles one slot toward `delta`, past the nearest unselected neighbour, so a
// contiguous block moves as one and scattered picks keep their relative order. Returns null when
// nothing can move (the selection already sits at the edge or the delta is invalid).
export function moveSelectedPages(pages, selectedIds, delta) {
  if (delta !== -1 && delta !== 1) return null
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? [])
  if (!ids.size || !pages.length) return null
  const result = [...pages]
  let moved = false
  const indexes = delta < 0
    ? result.map((_, index) => index).slice(1)
    : result.map((_, index) => index).slice(0, -1).reverse()
  for (const index of indexes) {
    const other = index + delta
    if (ids.has(result[index].id) && !ids.has(result[other].id)) {
      [result[index], result[other]] = [result[other], result[index]]
      moved = true
    }
  }
  return moved ? result : null
}

// The copy keeps the image, file and object URL (the URL stays owned once through the shared
// reference) but gets fresh page and box ids, so selection, history and the inspector never
// confuse the two. The untouched scan a raw cleanup kept is shared the same way, because an
// HTMLImageElement cannot be structured-cloned and would otherwise throw on a cleaned page.
export function duplicatePage(page, createId = () => crypto.randomUUID()) {
  const { image, file, url, originalImage, originalFile, originalUrl, ...data } = page
  const id = createId()
  const copy = structuredClone(data)
  for (const box of copy.boxes ?? []) box.id = createId()
  shareInpaintOrigins(page.retouchStrokes, copy.retouchStrokes)
  return {
    ...copy, id, name: `${page.name} (bản sao)`, image, file, url,
    ...(originalFile && { originalImage, originalFile, originalUrl }),
  }
}
