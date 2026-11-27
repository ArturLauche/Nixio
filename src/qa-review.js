// QA triage board (Nixio #76).
//
// The linter answers "what is wrong in this chapter right now"; the board answers "what did the
// user decide about it". A decision is addressed by the id the linter stamps on the finding, so a
// decision survives every run that still reports the same row and disappears with it.
//
// Two rules keep the board honest:
// - The counts come from the linter's own totals (`total`, `byType`). `issues` may be capped by
//   `maxIssues`, so its length is the number of rows on screen, never the chapter total.
// - Only a complete run expires decisions. A capped run cannot prove a finding is gone, and
//   dropping its decision would silently lose work.

export const qaReviewVersion = 1
export const qaReviewEntryLimit = 2000
export const qaReviewNoteLimit = 400
export const qaReviewIdLimit = 120
// Written into the note of every finding an export was allowed to skip, so the override is a
// recorded decision on the board and not a silent dialog dismissal.
export const qaExportOverrideNote = "Đã duyệt xuất khi cảnh báo còn mở."

export const qaReviewStates = ["open", "accepted", "ignored", "fixed", "false-positive"]

export const qaReviewStateLabels = {
  open: "Chờ xử lý",
  accepted: "Chấp nhận",
  ignored: "Bỏ qua",
  fixed: "Đã sửa",
  "false-positive": "Báo sai",
}

export const qaReviewSeverityLabels = {
  error: "Lỗi",
  warning: "Cảnh báo",
  info: "Gợi ý",
}

export const qaReviewTypeLabels = {
  untranslated_source: "Sót bản gốc",
  glossary_violation: "Thuật ngữ",
  empty_or_placeholder: "Trống hoặc mẫu",
  punctuation_spacing: "Dấu câu",
}

const severityOrder = Object.keys(qaReviewSeverityLabels)
const typeOrder = Object.keys(qaReviewTypeLabels)

const isText = (value) => typeof value === "string"
const emptyReview = () => ({ version: qaReviewVersion, entries: [] })

// Persistence guard for one decision. Returns the cleaned record or null, so `src/project.js`
// decides what an invalid record means for the file it is reading.
export function validateQaReviewEntry(entry) {
  if (!entry || typeof entry !== "object") return null
  const { id, state, note = "", updatedAt = 0 } = entry
  if (!isText(id) || !id || id.length > qaReviewIdLimit) return null
  if (!qaReviewStates.includes(state)) return null
  if (!isText(note) || note.length > qaReviewNoteLimit) return null
  // Ignoring a finding means saying why: without a reason the row would come back with no trace
  // of the decision behind it.
  if (state === "ignored" && !note.trim()) return null
  if (!Number.isInteger(updatedAt) || updatedAt < 0) return null
  return { id, state, note: note.trim(), updatedAt }
}

// Lenient counterpart of the guard above: a record from storage keeps every valid decision and
// drops the rest, so one corrupt row cannot cost the whole board.
export function sanitizeQaReview(review) {
  const entries = []
  const seen = new Set()
  for (const entry of Array.isArray(review?.entries) ? review.entries : []) {
    const valid = validateQaReviewEntry(entry)
    if (!valid || seen.has(valid.id)) continue
    seen.add(valid.id)
    entries.push(valid)
  }
  return { version: qaReviewVersion, entries }
}

// Every finding gets its row state, defaulting to `open`: a finding nobody has looked at yet is
// exactly what the board must show first.
export function attachQaReviewState(issues = [], review) {
  const stored = new Map((review?.entries ?? []).map((entry) => [entry.id, entry]))
  return issues.map((issue) => {
    const entry = stored.get(issue.id)
    return {
      ...issue,
      state: entry?.state ?? "open",
      note: entry?.note ?? "",
      updatedAt: entry?.updatedAt ?? 0,
    }
  })
}

// A warning the user has not settled yet is what stands in the way of an export. Accepted,
// ignored, fixed and false-positive rows are recorded decisions, so they no longer block.
export function qaBlockingFindings(findings = []) {
  return findings.filter((finding) => finding.state === "open" && finding.severity === "warning")
}

function countBy(findings, key) {
  const counts = {}
  for (const finding of findings) counts[finding[key]] = (counts[finding[key]] ?? 0) + 1
  return counts
}

function presentInOrder(counts, order) {
  const known = order.filter((value) => (counts[value] ?? 0) > 0)
  const extra = Object.keys(counts).filter((value) => !order.includes(value) && counts[value] > 0)
  return [...known, ...extra]
}

export function buildQaBoard(qa, review) {
  const findings = attachQaReviewState(qa?.issues ?? [], review)
  const byState = Object.fromEntries(qaReviewStates.map((state) => [state, 0]))
  for (const finding of findings) byState[finding.state] = (byState[finding.state] ?? 0) + 1
  const bySeverity = countBy(findings, "severity")
  const byType = qa?.byType ? { ...qa.byType } : countBy(findings, "type")
  const blocking = qaBlockingFindings(findings)
  const pages = []
  for (const finding of findings) {
    if (pages.some(({ value }) => value === finding.pageIndex)) continue
    pages.push({
      value: finding.pageIndex,
      label: finding.pageName ? `Trang ${finding.pageIndex} · ${finding.pageName}` : `Trang ${finding.pageIndex}`,
    })
  }
  return {
    findings,
    blocking,
    counts: {
      total: Number.isInteger(qa?.total) ? qa.total : findings.length,
      byType,
      bySeverity,
      byState,
      listed: findings.length,
      open: byState.open,
      settled: findings.length - byState.open,
      blocking: blocking.length,
    },
    options: {
      states: qaReviewStates.map((state) => ({ value: state, label: qaReviewStateLabels[state] })),
      severities: presentInOrder(bySeverity, severityOrder)
        .map((severity) => ({ value: severity, label: qaReviewSeverityLabels[severity] ?? severity })),
      pages,
      // Only the checks that have a row on screen are offered: a filter that can only ever show
      // nothing is a dead end.
      types: presentInOrder(countBy(findings, "type"), typeOrder)
        .map((type) => ({ value: type, label: qaReviewTypeLabels[type] ?? type })),
    },
  }
}

export function filterQaFindings(findings = [], { state = "all", severity = "all", page = "all", type = "all" } = {}) {
  return findings.filter((finding) =>
    (state === "all" || finding.state === state) &&
    (severity === "all" || finding.severity === severity) &&
    (page === "all" || String(finding.pageIndex) === String(page)) &&
    (type === "all" || finding.type === type),
  )
}

// One line above the rows: the linter's own total, how much of it is still open, and how many
// rows the current filter leaves on screen.
export function qaReviewSummary(counts, shown) {
  const capped = counts.listed < counts.total ? ` · liệt kê ${counts.listed}/${counts.total}` : ""
  return `${counts.total} mục QA${capped} · ${counts.open} chờ xử lý · ${counts.settled} đã xử lý · hiện ${shown}`
}

// The row the user is looking at, resolved back into the live chapter. Positional because the
// project format stores no box ids; see `findingId` in `src/linter.js`.
export function qaFindingBox(pages, finding) {
  const page = pages?.[(finding?.pageIndex ?? 0) - 1]
  return page?.boxes?.[finding?.boxIndex ?? -1] ?? null
}

// Records one decision. A row put back to `open` with nothing written on it is the default, so it
// is not stored: the project file only carries decisions a human actually took.
export function setQaFindingState(review, id, { state, note = "", now } = {}) {
  const fail = (error) => ({ review, entry: null, error })
  if (!isText(id) || !id || id.length > qaReviewIdLimit) return fail("Mục QA không hợp lệ.")
  if (!qaReviewStates.includes(state)) return fail("Trạng thái rà soát không hợp lệ.")
  if (!isText(note)) return fail(`Ghi chú tối đa ${qaReviewNoteLimit} ký tự.`)
  const text = note.trim()
  if (text.length > qaReviewNoteLimit) return fail(`Ghi chú tối đa ${qaReviewNoteLimit} ký tự.`)
  if (state === "ignored" && !text) return fail("Bỏ qua một mục QA cần lý do.")
  const entries = (review?.entries ?? []).filter((entry) => entry.id !== id)
  let entry = null
  if (state !== "open" || text) {
    entry = { id, state, note: text, updatedAt: Number.isInteger(now) ? now : Date.now() }
    entries.push(entry)
    // The store is bounded so a long-lived project cannot grow a manifest of decisions forever:
    // the least recently touched decision goes first.
    while (entries.length > qaReviewEntryLimit) {
      let oldest = 0
      for (const [index, candidate] of entries.entries()) {
        if (candidate.updatedAt < entries[oldest].updatedAt) oldest = index
      }
      entries.splice(oldest, 1)
    }
    if (!entries.includes(entry)) entry = null
  }
  return { review: { version: qaReviewVersion, entries }, entry, error: null }
}

// The linter ran again: decisions for findings it still reports are kept, decisions for findings
// it no longer reports are expired. A run capped by `maxIssues` (`issues.length < total`) proves
// nothing about the rows it did not list, so it never expires anything.
export function reconcileQaReview(review, qa) {
  const entries = Array.isArray(review?.entries) ? review.entries : []
  const findings = Array.isArray(qa?.issues) ? qa.issues : []
  const total = Number.isInteger(qa?.total) ? qa.total : findings.length
  if (findings.length < total) return { review: { version: qaReviewVersion, entries }, expired: [] }
  const live = new Set(findings.map((finding) => finding.id))
  const kept = entries.filter((entry) => live.has(entry.id))
  const expired = entries.filter((entry) => !live.has(entry.id)).map((entry) => entry.id)
  return { review: { version: qaReviewVersion, entries: kept }, expired }
}

// The editor holds one board per project. `revision` lets the panel skip rebuilding a board it
// already shows, and `replace` is how opening a project hands over the decisions saved in its
// manifest.
export function createQaReviewStore(initial) {
  let review = initial === undefined ? emptyReview() : sanitizeQaReview(initial)
  let revision = 0
  return {
    get revision() {
      return revision
    },
    get size() {
      return review.entries.length
    },
    review() {
      return review
    },
    snapshot() {
      return { version: qaReviewVersion, entries: review.entries.map((entry) => ({ ...entry })) }
    },
    replace(next) {
      review = next === undefined ? emptyReview() : sanitizeQaReview(next)
      revision++
    },
    clear() {
      review = emptyReview()
      revision++
    },
    entry(id) {
      return review.entries.find((entry) => entry.id === id) ?? null
    },
    set(id, patch) {
      const result = setQaFindingState(review, id, patch)
      if (result.error) return result
      review = result.review
      revision++
      return result
    },
    reconcile(qa) {
      const result = reconcileQaReview(review, qa)
      if (result.expired.length) {
        review = result.review
        revision++
      }
      return result
    },
  }
}
