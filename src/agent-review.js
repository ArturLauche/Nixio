// Per-change AI approval: a write tool proposes discrete changes instead of applying them, the
// user accepts or rejects each one, and accepted changes land as a single named history action.
//
// Everything here is pure data work: the tool layer turns a draft run into `changes`, the chat
// controller turns a reviewed session into live state. Rejected changes are remembered per
// project so an identical proposal is surfaced instead of being silently applied again.

// Every box field a tool may rewrite. Order is the order the review card lists them in.
export const CHANGE_FIELDS = [
  "text", "size", "font", "color", "align",
  "bold", "italic", "uppercase", "vertical", "bubbleFit",
  "warp", "warpAmount", "lineHeight", "strokeWidth", "strokeColor",
  "shadowBlur", "shadowColor", "fill", "fillShape", "fillColor",
  "cleanup", "x", "y", "w", "h",
]

export const FIELD_LABELS = {
  text: "Nội dung",
  size: "Cỡ chữ",
  font: "Phông chữ",
  color: "Màu chữ",
  align: "Canh lề",
  bold: "In đậm",
  italic: "In nghiêng",
  uppercase: "Chữ hoa",
  vertical: "Chữ dọc",
  bubbleFit: "Dàn theo bong bóng",
  warp: "Uốn chữ",
  warpAmount: "Độ uốn",
  lineHeight: "Giãn dòng",
  strokeWidth: "Độ dày viền",
  strokeColor: "Màu viền",
  shadowBlur: "Độ mờ bóng",
  shadowColor: "Màu bóng",
  fill: "Nền khung",
  fillShape: "Hình nền",
  fillColor: "Màu nền",
  cleanup: "Xóa chữ gốc",
  x: "Vị trí ngang",
  y: "Vị trí dọc",
  w: "Chiều rộng",
  h: "Chiều cao",
  glossary: "Bảng thuật ngữ",
}

const NUMBER_FIELDS = new Set(["x", "y", "w", "h", "size", "warpAmount", "lineHeight", "strokeWidth", "shadowBlur"])

const CHANGE_STATUSES = ["pending", "accepted", "applied", "rejected"]

// A draft is a throwaway copy of the pages a write tool mutates. Images, files and object URLs
// stay shared so a draft never duplicates a page bitmap.
export function clonePagesForDraft(pages = []) {
  return (pages ?? []).map((page) => {
    const { image, file, url, ...data } = page ?? {}
    let copy
    try {
      copy = structuredClone(data)
    } catch {
      copy = JSON.parse(JSON.stringify(data ?? {}))
    }
    return { ...copy, image, file, url }
  })
}

function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return String(a) === String(b)
}

function normalizeValue(field, value) {
  if (value === undefined) return undefined
  if (NUMBER_FIELDS.has(field) && typeof value === "number") return Math.round(value * 1000) / 1000
  return value
}

function snapshotBox(box) {
  const copy = {}
  for (const field of CHANGE_FIELDS) {
    if (box?.[field] === undefined) continue
    copy[field] = normalizeValue(field, box[field])
  }
  if (box?.id) copy.id = box.id
  return copy
}

// Identity of a proposed change: one page, one box, one field. Two tool calls that touch the same
// field collapse into a single row whose `before` stays the live value and whose `after` is latest.
export function changeKey(change) {
  return [change?.pageId ?? "", change?.boxId ?? "", change?.field ?? "", change?.kind ?? ""].join("|")
}

/**
 * Field-by-field difference between the live pages and the draft a write tool produced.
 * Added and removed boxes are one change each; a modified box yields one change per field.
 */
export function diffPages(beforePages = [], afterPages = [], { toolName = "", toolCallId = "" } = {}) {
  const changes = []
  const livePages = Array.isArray(beforePages) ? beforePages : []
  let seq = 0
  const push = (change) => {
    seq++
    changes.push({
      id: `${toolCallId || toolName || "call"}-${seq}`,
      toolName,
      toolCallId,
      status: "pending",
      blocked: false,
      ...change,
    })
  }

  for (const afterPage of afterPages ?? []) {
    const index = livePages.findIndex((page) => page.id === afterPage?.id)
    if (index < 0) continue
    const livePage = livePages[index]
    const liveBoxes = new Map((livePage.boxes ?? []).map((box) => [box.id, box]))
    const afterIds = new Set((afterPage.boxes ?? []).map((box) => box.id))
    const base = { pageId: livePage.id, pageIndex: index + 1, pageName: livePage.name }

    for (const box of afterPage.boxes ?? []) {
      const liveBox = liveBoxes.get(box.id)
      if (!liveBox) {
        push({ ...base, kind: "added", field: "", boxId: box.id, boxText: box.text, before: null, after: snapshotBox(box) })
        continue
      }
      for (const field of CHANGE_FIELDS) {
        if (sameValue(liveBox[field], box[field])) continue
        push({
          ...base,
          kind: "modified",
          field,
          boxId: box.id,
          boxText: box.text,
          before: normalizeValue(field, liveBox[field]),
          after: normalizeValue(field, box[field]),
        })
      }
    }

    for (const box of livePage.boxes ?? []) {
      if (afterIds.has(box.id)) continue
      push({ ...base, kind: "removed", field: "", boxId: box.id, boxText: box.text, before: snapshotBox(box), after: null })
    }
  }

  return changes
}

/** The project glossary lives in a settings field, so it gets one change instead of a box diff. */
export function diffGlossaryChange(beforeValue, afterValue, { toolName = "", toolCallId = "" } = {}) {
  const before = String(beforeValue ?? "")
  const after = String(afterValue ?? "")
  if (before === after) return null
  return {
    id: `${toolCallId || toolName || "call"}-glossary`,
    toolName,
    toolCallId,
    status: "pending",
    blocked: false,
    kind: "glossary",
    pageId: "",
    pageIndex: 0,
    pageName: "",
    boxId: "",
    boxText: "",
    field: "glossary",
    before,
    after,
  }
}

function clip(text, max = 42) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function showValue(field, value) {
  if (typeof value === "boolean") return value ? "bật" : "tắt"
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number") return String(value)
  return clip(value, field === "text" ? 42 : 24)
}

function countLines(text) {
  return String(text ?? "").split(/\r?\n/).filter((line) => line.trim()).length
}

/** One-line Vietnamese description of a change for the review card and the tool result. */
export function describeChange(change) {
  if (!change) return ""
  const page = change.pageIndex ? `Tr.${change.pageIndex}` : "Dự án"
  if (change.kind === "glossary") {
    return `${page} · ${FIELD_LABELS.glossary}: ${countLines(change.before)} → ${countLines(change.after)} dòng`
  }
  if (change.kind === "added") return `${page} · Thêm khung "${clip(change.boxText)}"`
  if (change.kind === "removed") return `${page} · Xóa khung "${clip(change.before?.text ?? change.boxText)}"`
  const label = FIELD_LABELS[change.field] ?? change.field
  return `${page} · ${label}: ${showValue(change.field, change.before)} → ${showValue(change.field, change.after)}`
}

/** Collects the changes of one AI turn until the user reviews them. */
export function createReviewSession({ turnId = "", at = Date.now() } = {}) {
  const changes = []

  const find = (id) => changes.find((change) => change.id === id) ?? null
  const summary = () => {
    const counts = { total: changes.length, pending: 0, accepted: 0, applied: 0, rejected: 0, blocked: 0 }
    for (const change of changes) {
      if (counts[change.status] !== undefined) counts[change.status]++
      if (change.blocked) counts.blocked++
    }
    return counts
  }

  return {
    turnId,
    at,
    changes,
    /** Adds staged changes, collapsing repeats of the same field into one row. */
    add(list = []) {
      for (const incoming of list ?? []) {
        if (!incoming) continue
        const key = changeKey(incoming)
        const existing = changes.find((change) => changeKey(change) === key && change.status !== "applied")
        if (existing) {
          // Same field proposed again in the same turn: the newest value wins and the original
          // "before" is kept, so the row still shows the whole move from the live state.
          existing.after = incoming.after
          existing.blocked = Boolean(incoming.blocked)
          existing.boxText = incoming.boxText ?? existing.boxText
          if (incoming.kind === "added") existing.before = incoming.before
          existing.toolName = incoming.toolName || existing.toolName
          if (existing.kind === "modified" && sameValue(existing.before, existing.after)) {
            // The two proposals cancel out, so there is nothing left to review.
            changes.splice(changes.indexOf(existing), 1)
          }
          continue
        }
        changes.push({
          ...incoming,
          id: incoming.id || `change-${changes.length + 1}`,
          status: CHANGE_STATUSES.includes(incoming.status) ? incoming.status : "pending",
        })
      }
      return changes.length
    },
    setStatus(id, status) {
      const change = find(id)
      if (!change || !CHANGE_STATUSES.includes(status)) return null
      change.status = status
      return change
    },
    pending: () => changes.filter((change) => change.status === "pending"),
    accepted: () => changes.filter((change) => change.status === "accepted"),
    rejected: () => changes.filter((change) => change.status === "rejected"),
    applied: () => changes.filter((change) => change.status === "applied"),
    acceptAll() {
      for (const change of changes) {
        if (change.status === "pending") change.status = "accepted"
      }
      return changes.length
    },
    rejectAll() {
      for (const change of changes) {
        if (change.status !== "applied") change.status = "rejected"
      }
      return changes.length
    },
    summary,
    /** Vietnamese one-liner the chat panel and the tool result both use. */
    text() {
      const counts = summary()
      if (!counts.total) return "Không có thay đổi nào được đề xuất."
      const parts = []
      if (counts.pending) parts.push(`${counts.pending} chờ duyệt`)
      if (counts.accepted) parts.push(`${counts.accepted} đã chọn`)
      if (counts.applied) parts.push(`${counts.applied} đã áp dụng`)
      if (counts.rejected) parts.push(`${counts.rejected} bị từ chối`)
      return `${counts.total} thay đổi: ${parts.join(", ")}`
    },
  }
}

function pageOf(pages, pageId) {
  return (pages ?? []).find((page) => page.id === pageId) ?? null
}

function applyOne(pages, change, glossaryField) {
  if (change.kind === "glossary") {
    if (!glossaryField) return false
    glossaryField.value = String(change.after ?? "")
    try {
      glossaryField.dispatchEvent?.(new Event("input"))
    } catch {
      // Headless tests have no Event constructor; the value change is what matters.
    }
    return true
  }
  const page = pageOf(pages, change.pageId)
  if (!page) return false
  if (change.kind === "added") {
    if (!change.after) return false
    const box = { ...change.after }
    page.boxes = [...(page.boxes ?? []), box]
    return true
  }
  if (change.kind === "removed") {
    const before = (page.boxes ?? []).length
    page.boxes = (page.boxes ?? []).filter((box) => box.id !== change.boxId)
    return page.boxes.length !== before
  }
  const box = (page.boxes ?? []).find((item) => item.id === change.boxId)
  if (!box || !change.field) return false
  box[change.field] = change.after
  return true
}

/**
 * Applies the chosen changes to live pages. `ids` is the set the user ticked; omitted means
 * "every change that is not already rejected". Rows that were not chosen are marked rejected so
 * the caller can record them and the card can show the final state of each row.
 */
export function applyAcceptedChanges({ pages = [], session, ids = null, glossaryField = null } = {}) {
  const wanted = ids ? new Set(ids) : null
  const applied = []
  const rejected = []
  if (!session) return { applied, rejected }
  for (const change of session.changes) {
    if (change.status === "applied") continue
    const chosen = wanted ? wanted.has(change.id) : change.status !== "rejected"
    if (!chosen) {
      change.status = "rejected"
      rejected.push(change)
      continue
    }
    if (applyOne(pages, change, glossaryField)) {
      change.status = "applied"
      applied.push(change)
    } else {
      change.status = "rejected"
      rejected.push(change)
    }
  }
  return { applied, rejected }
}

// --- Rejection memory -------------------------------------------------------------------------
// Rejections survive the turn and the session: an identical proposal is flagged instead of being
// staged as if it were new.

export function rejectionKey(change) {
  return changeKey(change)
}

function rejectionValue(change) {
  try {
    return JSON.stringify(change?.after ?? null)
  } catch {
    return String(change?.after)
  }
}

export function isRejectedChange(log = [], change) {
  const key = rejectionKey(change)
  const value = rejectionValue(change)
  return (Array.isArray(log) ? log : []).some((entry) => entry?.key === key && entry?.value === value)
}

/** Adds (or refreshes) one log entry per rejected change and returns the same array. */
export function recordRejections(log = [], changes = [], { at = Date.now(), limit = 120 } = {}) {
  const next = Array.isArray(log) ? log : []
  for (const change of changes ?? []) {
    if (!change) continue
    const key = rejectionKey(change)
    const value = rejectionValue(change)
    const existing = next.find((entry) => entry?.key === key && entry?.value === value)
    if (existing) {
      existing.at = at
      continue
    }
    next.push({
      key,
      pageId: String(change.pageId ?? ""),
      boxId: String(change.boxId ?? ""),
      field: String(change.field ?? ""),
      kind: String(change.kind ?? ""),
      value,
      at,
    })
  }
  while (next.length > limit) next.shift()
  return next
}

/** Drops the rejections a user has now accepted, so the same change can be applied later. */
export function clearRejections(log = [], changes = []) {
  const next = Array.isArray(log) ? log : []
  for (const change of changes ?? []) {
    if (!change) continue
    const key = rejectionKey(change)
    const value = rejectionValue(change)
    const index = next.findIndex((entry) => entry?.key === key && entry?.value === value)
    if (index >= 0) next.splice(index, 1)
  }
  return next
}

/** History label for the one action a reviewed turn becomes. */
export function reviewActionLabel(applied = [], rejected = []) {
  const total = applied.length + rejected.length
  if (!applied.length) return "Từ chối chỉnh sửa từ Trợ lý AI"
  if (rejected.length) return `Chấp nhận ${applied.length}/${total} thay đổi từ Trợ lý AI`
  return `Chấp nhận ${applied.length} thay đổi từ Trợ lý AI`
}

/**
 * Why a turn produced nothing. The chat panel always shows one of these instead of leaving the
 * reader to wonder whether the assistant silently failed.
 */
export function explainNoChanges({
  planMode = false,
  allowEdits = true,
  budgetBlocked = false,
  writeCalls = 0,
  blocked = 0,
  rejected = 0,
} = {}) {
  const parts = []
  if (planMode) parts.push("Chế độ Kế hoạch chỉ khảo sát và lập kế hoạch nên chưa ghi gì vào dự án")
  else if (!allowEdits) parts.push("Bạn đang tắt \"Cho phép sửa khung & thuật ngữ\" nên AI chỉ đọc và trả lời")
  if (budgetBlocked) parts.push("Lượt đã bị dừng vì hạn mức chi phí AI")
  if (blocked > 0) parts.push(`${blocked} thay đổi trùng với thay đổi bạn đã từ chối trước đây nên không được đề xuất lại`)
  else if (rejected > 0) parts.push(`Bạn đã từ chối cả ${rejected} thay đổi được đề xuất`)
  else if (!writeCalls) parts.push("AI không gọi công cụ ghi nào trong lượt này")
  else parts.push("AI có gọi công cụ ghi nhưng không tạo ra khác biệt nào so với hiện trạng")
  const reason = parts.length ? parts.join("; ") : "Không có thay đổi nào được tạo ra"
  return `Lượt này không có thay đổi nào được áp dụng: ${reason}.`
}
