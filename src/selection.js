import { clamp } from "./canvas.js"

const minimumSize = .03

// A multi-selection still has one primary box: the box the inspector edits and the box that carries
// the handles. It keeps its own marker inside the group, so the highlight never hides which box a
// form edit will land in.
export function outlineMarks({ id, boxId, selectedIds }) {
  return {
    primary: id === boxId,
    multi: Boolean(selectedIds?.size > 1 && selectedIds.has(id)),
  }
}

// The handles resize the whole selection, so they belong to the primary even when it sits inside a
// group; placing and comparing hide them because no handle can act there.
export function showsTransformHandles({ marks, tool, placing, compareOriginal }) {
  return Boolean(marks?.primary && tool === "text" && !placing && !compareOriginal)
}

// The primary takes the geometry the handle produced and every other member takes the same change,
// so the selection resizes as one block from any of the eight handles. Each member is clamped to the
// page and to the minimum size, because the primary's own clamp says nothing about its neighbours.
export function resizeGroup(starts, primaryId, next) {
  const before = starts.get(primaryId)
  const resized = new Map()
  if (!before || !next) return resized
  const dx = next.x - before.x
  const dy = next.y - before.y
  const dw = next.w - before.w
  const dh = next.h - before.h
  for (const [id, rect] of starts) {
    if (id === primaryId) {
      resized.set(id, { ...next })
      continue
    }
    const w = clamp(rect.w + dw, minimumSize, 1)
    const h = clamp(rect.h + dh, minimumSize, 1)
    resized.set(id, {
      x: clamp(rect.x + dx, 0, Math.max(0, 1 - w)),
      y: clamp(rect.y + dy, 0, Math.max(0, 1 - h)),
      w,
      h,
    })
  }
  return resized
}
