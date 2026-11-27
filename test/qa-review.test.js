import assert from "node:assert/strict"
import test from "node:test"
import { lintChapter } from "../src/linter.js"
import {
  buildQaBoard,
  createQaReviewStore,
  filterQaFindings,
  qaBlockingFindings,
  qaExportOverrideNote,
  qaFindingBox,
  qaReviewSummary,
  reconcileQaReview,
  sanitizeQaReview,
  setQaFindingState,
  validateQaReviewEntry,
} from "../src/qa-review.js"

// Nixio #76. The board is checked as three separate promises: the identity a decision is stored
// under (it must survive a re-run and never leak to another finding), the counts (they are the
// linter's own totals, not the length of the list it could show), and the expiry rule (only a
// complete run may forget a decision).

const chapter = () => [
  {
    name: "01.png",
    boxes: [
      { id: "b1", text: "" },
      { id: "b2", text: "Chào bạn  , đi thôi...." },
    ],
  },
  { name: "02.png", boxes: [{ id: "b3", text: "こんにちは mọi người" }] },
]

const lint = (pages = chapter(), options = {}) =>
  lintChapter(pages, {
    glossaryText: "",
    sourceLanguage: "Japanese",
    targetLanguage: "Vietnamese",
    ...options,
  })

const EMPTY = "1:0:empty_or_placeholder"
const PUNCTUATION = "1:1:punctuation_spacing"
const UNTRANSLATED = "2:0:untranslated_source"

test("finding ids follow the box and the check, not the text that tripped it", () => {
  const qa = lint()
  assert.deepEqual(qa.issues.map(({ id }) => id), [EMPTY, PUNCTUATION, UNTRANSLATED])

  // Rewriting the line keeps the same row on the board, so its decision stays attached.
  const edited = lint([{
    name: "01.png",
    boxes: [
      { id: "b1", text: "Chào bạn, đi thôi..." },
      { id: "b2", text: "Chào bạn  , đi thôi!!!" },
    ],
  }])
  assert.deepEqual(edited.issues.map(({ id }) => id), [PUNCTUATION])

  // Two glossary findings of one box are two rows: fixing one never inherits the other's decision.
  const glossary = "五条悟 = Gojo Satoru\n虎杖悠仁 = Itadori Yuji"
  const glossaryIds = (text) => lint([{ name: "01.png", boxes: [{ id: "b1", text }] }], { glossaryText: glossary })
    .issues.filter(({ type }) => type === "glossary_violation")
    .map(({ id }) => id)
  const [first] = glossaryIds("五条悟 và 虎杖悠仁")
  const [second] = glossaryIds("Gojo Satoru và 虎杖悠仁")
  assert.match(first, /^1:0:glossary_violation:/)
  assert.match(second, /^1:0:glossary_violation:/)
  assert.notEqual(first, second)
})

test("the board reports the linter's totals and joins stored decisions to the listed rows", () => {
  const qa = lint(chapter(), { maxIssues: 2 })
  assert.equal(qa.total, 3)
  assert.equal(qa.issues.length, 2)

  const store = createQaReviewStore()
  store.set(EMPTY, { state: "ignored", note: "Trang bìa", now: 4 })
  const board = buildQaBoard(qa, store.review())

  assert.equal(board.counts.total, qa.total)
  assert.deepEqual(board.counts.byType, qa.byType)
  assert.equal(board.counts.listed, 2)
  assert.equal(board.counts.open, 1)
  assert.equal(board.counts.settled, 1)
  assert.deepEqual(board.findings.map(({ id, state, note }) => [id, state, note]), [
    [EMPTY, "ignored", "Trang bìa"],
    [PUNCTUATION, "open", ""],
  ])
  assert.deepEqual(board.counts.bySeverity, { warning: 1, info: 1 })
  assert.deepEqual(board.options.pages, [{ value: 1, label: "Trang 1 · 01.png" }])
  assert.deepEqual(board.options.types.map(({ value }) => value), ["empty_or_placeholder", "punctuation_spacing"])
  assert.deepEqual(board.options.states.map(({ value }) => value), ["open", "accepted", "ignored", "fixed", "false-positive"])
})

test("a decision is stored with its note, and ignoring a finding needs a reason", () => {
  const store = createQaReviewStore()
  assert.equal(store.set(PUNCTUATION, { state: "ignored" }).error, "Bỏ qua một mục QA cần lý do.")
  assert.equal(store.set(PUNCTUATION, { state: "không có" }).error, "Trạng thái rà soát không hợp lệ.")
  assert.equal(store.set(PUNCTUATION, { state: "open", note: "x".repeat(401) }).error, "Ghi chú tối đa 400 ký tự.")
  assert.equal(store.size, 0)

  const saved = store.set(PUNCTUATION, { state: "ignored", note: "  Biên tập chốt giữ nguyên  ", now: 1700 })
  assert.equal(saved.error, null)
  assert.deepEqual(store.entry(PUNCTUATION), {
    id: PUNCTUATION,
    state: "ignored",
    note: "Biên tập chốt giữ nguyên",
    updatedAt: 1700,
  })

  // Back to `open` with nothing written on it is the default again, so it is not persisted.
  store.set(PUNCTUATION, { state: "open", now: 1800 })
  assert.equal(store.size, 0)
  assert.equal(store.revision, 2)
})

test("a re-run keeps decisions for live findings and expires the ones it no longer reports", () => {
  const store = createQaReviewStore()
  store.set(EMPTY, { state: "ignored", note: "Trang bìa", now: 5 })
  store.set(PUNCTUATION, { state: "fixed", note: "Sửa tay", now: 6 })

  assert.deepEqual(store.reconcile(lint()).expired, [])
  assert.equal(store.size, 2)

  // The punctuation cleanup lands, so the next run stops reporting that row.
  const fixed = chapter()
  fixed[0].boxes[1].text = "Chào bạn, đi thôi..."
  assert.deepEqual(store.reconcile(lint(fixed)).expired, [PUNCTUATION])
  assert.equal(store.size, 1)
  assert.equal(store.entry(EMPTY).note, "Trang bìa")
})

test("a capped run keeps decisions for findings it could not list", () => {
  const store = createQaReviewStore()
  store.set(UNTRANSLATED, { state: "accepted", note: "Tên riêng", now: 7 })

  const capped = store.reconcile(lint(chapter(), { maxIssues: 2 }))
  assert.deepEqual(capped.expired, [])
  assert.equal(store.size, 1)

  // A complete run proves the row is gone, so the decision goes with it.
  assert.deepEqual(store.reconcile(lint([{ name: "01.png", boxes: [] }])).expired, [UNTRANSLATED])
  assert.equal(store.size, 0)
})

test("the board filters by state, severity, page and type", () => {
  const store = createQaReviewStore()
  store.set(EMPTY, { state: "ignored", note: "Trang bìa", now: 5 })
  const board = buildQaBoard(lint(), store.review())
  const ids = (filters) => filterQaFindings(board.findings, filters).map(({ id }) => id)

  assert.deepEqual(ids({ state: "ignored" }), [EMPTY])
  assert.deepEqual(ids({ state: "open" }), [PUNCTUATION, UNTRANSLATED])
  assert.deepEqual(ids({ severity: "info" }), [PUNCTUATION])
  assert.deepEqual(ids({ page: "2" }), [UNTRANSLATED])
  assert.deepEqual(ids({ type: "untranslated_source" }), [UNTRANSLATED])
  assert.deepEqual(ids({ page: 1, severity: "warning" }), [EMPTY])
  assert.deepEqual(ids({}), [EMPTY, PUNCTUATION, UNTRANSLATED])
})

test("only an open warning blocks an export, and a recorded decision clears the gate", () => {
  const store = createQaReviewStore()
  const open = buildQaBoard(lint(), store.review())
  assert.deepEqual(open.blocking.map(({ id }) => id), [EMPTY, UNTRANSLATED])
  assert.ok(!open.blocking.some(({ severity }) => severity === "info"), "punctuation is a suggestion, not a gate")

  store.set(EMPTY, { state: "ignored", note: "Trang bìa", now: 5 })
  store.set(UNTRANSLATED, { state: "accepted", note: qaExportOverrideNote, now: 6 })
  const settled = buildQaBoard(lint(), store.review())
  assert.equal(settled.blocking.length, 0)
  assert.equal(qaBlockingFindings(settled.findings).length, 0)
  // The punctuation suggestion is still open, and it is exactly what an export is allowed to skip.
  assert.equal(settled.counts.open, 1)
})

test("a stored decision is validated on the way in and sanitized on the way out", () => {
  const good = { id: EMPTY, state: "fixed", note: "Đã xử lý", updatedAt: 3 }
  assert.deepEqual(validateQaReviewEntry(good), good)
  assert.equal(validateQaReviewEntry({ ...good, state: "done" }), null)
  assert.equal(validateQaReviewEntry({ ...good, id: "" }), null)
  assert.equal(validateQaReviewEntry({ ...good, updatedAt: -1 }), null)
  assert.equal(validateQaReviewEntry({ ...good, state: "ignored", note: "   " }), null)

  const review = sanitizeQaReview({
    version: 1,
    entries: [
      good,
      { id: PUNCTUATION, state: "ignored", note: "" },
      { id: UNTRANSLATED, state: "nope", note: "", updatedAt: 0 },
      { ...good },
    ],
  })
  assert.deepEqual(review, { version: 1, entries: [good] })
  assert.deepEqual(sanitizeQaReview(undefined), { version: 1, entries: [] })
  assert.deepEqual(sanitizeQaReview({ version: 9, entries: "không phải mảng" }), { version: 1, entries: [] })
})

test("the summary line separates the chapter total from the rows on screen", () => {
  assert.equal(
    qaReviewSummary({ total: 3, listed: 3, open: 1, settled: 2 }, 1),
    "3 mục QA · 1 chờ xử lý · 2 đã xử lý · hiện 1",
  )
  assert.equal(
    qaReviewSummary({ total: 3, listed: 2, open: 2, settled: 0 }, 2),
    "3 mục QA · liệt kê 2/3 · 2 chờ xử lý · 0 đã xử lý · hiện 2",
  )
})

test("a finding resolves back to its page and box", () => {
  const pages = chapter()
  const qa = lint()
  assert.equal(qaFindingBox(pages, qa.issues[1]), pages[0].boxes[1])
  assert.equal(qaFindingBox(pages, { pageIndex: 9, boxIndex: 0 }), null)
  assert.equal(qaFindingBox(undefined, qa.issues[0]), null)
})

test("setQaFindingState is pure, and a project hands its board over whole", () => {
  const review = { version: 1, entries: [] }
  const saved = setQaFindingState(review, EMPTY, { state: "accepted", now: 2 })
  assert.deepEqual(review.entries, [], "the caller's review is not mutated")
  assert.deepEqual(saved.review.entries, [{ id: EMPTY, state: "accepted", note: "", updatedAt: 2 }])

  assert.equal(reconcileQaReview(undefined, lint()).expired.length, 0)

  const store = createQaReviewStore()
  store.set(EMPTY, { state: "fixed", note: "", now: 1 })
  const snapshot = store.snapshot()
  snapshot.entries[0].state = "ignored"
  assert.equal(store.entry(EMPTY).state, "fixed")

  store.replace({ version: 1, entries: [{ id: UNTRANSLATED, state: "accepted", note: "ok", updatedAt: 9 }] })
  assert.equal(store.size, 1)
  assert.equal(store.entry(EMPTY), null)
  store.clear()
  assert.equal(store.size, 0)
})

test("a snapshot hands the whole board back, so undo restores the decision with the text (#review)", () => {
  const store = createQaReviewStore()
  const id = "1:0:punctuation_spacing"
  store.set(id, { state: "fixed", note: "Đã sửa dấu câu" })
  const before = store.snapshot()
  const revision = store.revision

  // The edit an undo has to reverse.
  store.set(id, { state: "ignored", note: "Biên tập giữ nguyên" })
  assert.equal(store.entry(id).state, "ignored")

  store.replace(before)
  assert.equal(store.entry(id).state, "fixed")
  assert.equal(store.entry(id).note, "Đã sửa dấu câu")
  assert.deepEqual(store.snapshot(), before)
  assert.notEqual(store.revision, revision, "a restore repaints the board")

  // The snapshot is a copy, so a later decision cannot rewrite the state history parked.
  store.set(id, { state: "ignored", note: "Biên tập giữ nguyên" })
  assert.equal(before.entries[0].state, "fixed")
  assert.deepEqual(store.snapshot().version, before.version)
})
