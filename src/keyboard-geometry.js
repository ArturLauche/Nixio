import { clamp } from "./canvas.js"
import { resizeBox, snapBox } from "./tools.js"
import { resizeGroup } from "./selection.js"

// Keyboard geometry speaks the same units as the page: one arrow step is one image pixel and Shift
// jumps ten, so a box can be placed without a mouse.
export const NUDGE_STEP_PX = 1
export const NUDGE_STEP_PX_LARGE = 10
export const ROTATE_STEP_DEGREES = 15
export const ROTATE_STEP_DEGREES_LARGE = 45

const minimumSize = .03

// The eight handles the selection exposes, in outline order. A handle name is the pair of edges the
// arrows push: "nw" moves the left and top edges, "e" only the right one.
export const resizeHandles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

const handleNames = {
  nw: "góc trên trái", n: "cạnh trên", ne: "góc trên phải", e: "cạnh phải",
  se: "góc dưới phải", s: "cạnh dưới", sw: "góc dưới trái", w: "cạnh trái",
}

export function resizeHandleLabel(handle) {
  return `Co giãn từ ${handleNames[handle] ?? "tay cầm"}`
}

export function rotationHandleLabel() {
  return "Xoay khung"
}

export function stepPixels(shiftKey) {
  return shiftKey ? NUDGE_STEP_PX_LARGE : NUDGE_STEP_PX
}

// A page is stored as a fraction of its own size, so one pixel of the rendered image is one over
// the image dimension on that axis.
export function arrowDelta(key, stepPx, { width, height }) {
  return {
    x: key === "ArrowRight" ? stepPx / Math.max(1, width) : key === "ArrowLeft" ? -stepPx / Math.max(1, width) : 0,
    y: key === "ArrowDown" ? stepPx / Math.max(1, height) : key === "ArrowUp" ? -stepPx / Math.max(1, height) : 0,
  }
}

export function rotationStep(key, shiftKey) {
  const size = shiftKey ? ROTATE_STEP_DEGREES_LARGE : ROTATE_STEP_DEGREES
  if (key === "ArrowRight" || key === "ArrowDown") return size
  if (key === "ArrowLeft" || key === "ArrowUp") return -size
  return 0
}

function groupRect(boxes) {
  const minX = Math.min(...boxes.map((box) => box.x))
  const maxX = Math.max(...boxes.map((box) => box.x + box.w))
  const minY = Math.min(...boxes.map((box) => box.y))
  const maxY = Math.max(...boxes.map((box) => box.y + box.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Snapping may pull a nudge further along the step it was asked for, never back against it: a guide
// behind the movement would otherwise undo a one pixel press on a box that already sits on the grid.
function forward(step, candidate) {
  if (!step) return 0
  if (Math.sign(candidate) !== Math.sign(step) || Math.abs(candidate) < Math.abs(step)) return step
  return candidate
}

// One delta for the whole selection: the group keeps its layout, the edge of the group is clamped
// so no member leaves the page, and the group rectangle is snapped against the boxes that stay put.
export function moveSelection(boxes, ids, { dx, dy, snap = true }) {
  const targets = boxes.filter((box) => ids.has(box.id))
  const moves = new Map()
  if (!targets.length) return moves
  let minDx = -Infinity
  let maxDx = Infinity
  let minDy = -Infinity
  let maxDy = Infinity
  for (const box of targets) {
    minDx = Math.max(minDx, -box.x)
    maxDx = Math.min(maxDx, 1 - box.w - box.x)
    minDy = Math.max(minDy, -box.y)
    maxDy = Math.min(maxDy, 1 - box.h - box.y)
  }
  let moveX = clamp(dx, minDx, maxDx)
  let moveY = clamp(dy, minDy, maxDy)
  if (snap) {
    const group = groupRect(targets)
    const others = boxes.filter((box) => !ids.has(box.id))
    const snapped = snapBox({ x: group.x + moveX, y: group.y + moveY, w: group.w, h: group.h }, others)
    moveX = clamp(forward(moveX, snapped.x - group.x), minDx, maxDx)
    moveY = clamp(forward(moveY, snapped.y - group.y), minDy, maxDy)
  }
  for (const box of targets) {
    moves.set(box.id, {
      x: clamp(box.x + moveX, 0, Math.max(0, 1 - box.w)),
      y: clamp(box.y + moveY, 0, Math.max(0, 1 - box.h)),
    })
  }
  return moves
}

// The focused handle is the edge the arrows push. It drives the same resizeBox/resizeGroup path as a
// pointer drag, so a rotated box and a multi-selection resize identically from the keyboard.
export function resizeSelection(boxes, ids, primaryId, handle, { dx, dy, rotation = 0, aspect = 1 }) {
  const resized = new Map()
  if (!resizeHandles.includes(handle)) return resized
  const starts = new Map(boxes
    .filter((box) => ids.has(box.id))
    .map((box) => [box.id, { x: box.x, y: box.y, w: box.w, h: box.h }]))
  const start = starts.get(primaryId)
  if (!start) return resized
  return resizeGroup(starts, primaryId, resizeBox(start, handle, { x: dx, y: dy }, { rotation, aspect }))
}

// Rotation is per box, so one step turns every selected box around its own centre.
export function rotateSelection(boxes, ids, stepDegrees) {
  const angles = new Map()
  for (const box of boxes) {
    if (ids.has(box.id)) angles.set(box.id, normalizeAngle((box.rotation ?? 0) + stepDegrees))
  }
  return angles
}

export function normalizeAngle(degrees) {
  let next = Math.round(degrees) % 360
  if (next > 180) next -= 360
  if (next < -180) next += 360
  return next === 0 ? 0 : next
}

export function geometryPixels(box, { width, height }) {
  return {
    x: Math.round(box.x * width), y: Math.round(box.y * height),
    w: Math.round(box.w * width), h: Math.round(box.h * height),
  }
}

// A typed or nudged rectangle is clamped exactly like a drag: it never leaves the page and never
// shrinks under the minimum size.
export function clampRect({ x, y, w, h }) {
  const width = clamp(Number(w) || 0, minimumSize, 1)
  const height = clamp(Number(h) || 0, minimumSize, 1)
  return {
    x: clamp(Number(x) || 0, 0, Math.max(0, 1 - width)),
    y: clamp(Number(y) || 0, 0, Math.max(0, 1 - height)),
    w: width,
    h: height,
  }
}

// The geometry fields are pixels on the page while the model is a fraction of it.
export function geometryFromPixels(values, { width, height }) {
  return clampRect({
    x: (Number(values.x) || 0) / Math.max(1, width),
    y: (Number(values.y) || 0) / Math.max(1, height),
    w: (Number(values.w) || 0) / Math.max(1, width),
    h: (Number(values.h) || 0) / Math.max(1, height),
  })
}

// One sentence for the live region: the geometry a gesture ended on, named by how many boxes the same
// step moved, so a screen reader hears the result instead of every keypress.
export function geometryMessage(box, { width, height, count = 1 } = {}) {
  const px = geometryPixels(box, { width, height })
  const name = count > 1 ? `${count} khung` : "Khung"
  const angle = box.rotation ? `, xoay ${Math.round(box.rotation)}°` : ""
  return `${name} ở X ${px.x}, Y ${px.y}, rộng ${px.w}, cao ${px.h} px${angle}.`
}
