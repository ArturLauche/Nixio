import assert from "node:assert/strict"
import test from "node:test"
import { checkUndoToken, copyEditor, DEFAULT_ACTION_LABEL, EditHistory, HISTORY_HEAD } from "../src/history.js"

const image = { naturalWidth: 800, naturalHeight: 1200 }
const file = new File(["raw"], "page-1.png")

function makeState(text = "gốc") {
  return {
    pages: [
      {
        id: "page-1",
        name: "1",
        image,
        file,
        url: "blob:1",
        boxes: [{ id: "box-1", text }],
        unplaced: [],
        retouchStrokes: [],
      },
    ],
    queue: [],
  }
}

// Mirrors src/main.js: checkpoint() copies the pre-edit state, undo/redo pass the live state back in
// and the caller re-applies whatever snapshot the history returns.
function createTimeline({ limit = 40, clock } = {}) {
  const history = new EditHistory(limit, clock ? { now: clock } : {})
  let state = makeState()
  const snapshot = () => copyEditor({ pages: state.pages, queue: state.queue })
  const apply = (restored) => {
    state = { ...state, pages: restored.pages, queue: restored.queue }
    return state.pages[0].boxes[0].text
  }

  return {
    history,
    snapshot,
    text: () => state.pages[0].boxes[0].text,
    edit(label, meta) {
      const token = history.record(snapshot(), meta ? { label, ...meta } : { label })
      state.pages[0].boxes[0].text = label
      return token
    },
    step(direction) {
      const restored = history[direction](snapshot())
      return restored ? apply(restored) : null
    },
    undo() {
      return this.step("undo")
    },
    redo() {
      return this.step("redo")
    },
    jump(id) {
      const result = history.jump(id, snapshot())
      if (result.ok) apply(result.snapshot)
      return result
    },
  }
}

const labels = (history) => history.entries().map(({ label }) => label)
const ids = (history) => history.entries().map(({ id }) => id)
const applied = (history) => history.entries().map(({ applied: isApplied }) => isApplied)
const shape = (history) => ({
  past: history.past.map(({ id }) => id),
  future: history.future.map(({ id }) => id),
  revision: history.revision,
})

test("every recorded action is named and timestamped, including the default fallback", () => {
  let tick = 500
  const timeline = createTimeline({ clock: () => (tick += 500) })
  const named = timeline.edit("Làm sạch raw trang 1", { kind: "raw-cleanup" })
  const unnamed = timeline.history.record(timeline.snapshot())

  assert.equal(named.label, "Làm sạch raw trang 1")
  assert.equal(named.kind, "raw-cleanup")
  assert.equal(named.at, 1000)
  assert.equal(unnamed.label, DEFAULT_ACTION_LABEL)
  assert.equal(unnamed.kind, "")
  assert.equal(unnamed.at, 1500)

  const rows = timeline.history.entries()
  assert.deepEqual(rows.map(({ label }) => label), ["Làm sạch raw trang 1", DEFAULT_ACTION_LABEL])
  assert.deepEqual(rows.map(({ at }) => at), [1000, 1500])
  assert.deepEqual(rows.map(({ index }) => index), [0, 1])
  assert.deepEqual(applied(timeline.history), [true, true])
})

test("a label names the action and jump parks the playhead just before it", () => {
  const jumped = createTimeline()
  jumped.edit("A")
  jumped.edit("B")
  const c = jumped.edit("C")

  const result = jumped.jump(c.id)
  assert.equal(result.ok, true)
  assert.equal(result.entry.id, c.id)
  assert.equal(jumped.text(), "B")

  // jump(newest.id) is exactly one undo: the state before C, with C waiting in redo order.
  const undone = createTimeline()
  undone.edit("A")
  undone.edit("B")
  undone.edit("C")
  assert.equal(undone.undo(), "B")
  assert.deepEqual(shape(jumped.history), shape(undone.history))
})

test("jumping backwards across several edits restores that boundary and keeps redo order", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  const b = timeline.edit("B")
  timeline.edit("C")
  timeline.edit("D")

  const result = timeline.jump(b.id)
  assert.equal(result.ok, true)
  assert.equal(timeline.text(), "A")
  assert.deepEqual(labels(timeline.history), ["A", "B", "C", "D"])
  assert.deepEqual(applied(timeline.history), [true, false, false, false])
  assert.deepEqual(timeline.history.future.map(({ label }) => label), ["D", "C", "B"])

  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
  assert.equal(timeline.redo(), "D")
  assert.equal(timeline.history.future.length, 0)
  assert.deepEqual(applied(timeline.history), [true, true, true, true])
})

test("a backwards jump keeps actions that were already undone behind the new playhead", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  const b = timeline.edit("B")
  timeline.edit("C")
  timeline.edit("D")
  assert.equal(timeline.undo(), "C")

  const result = timeline.jump(b.id)
  assert.equal(result.ok, true)
  assert.equal(timeline.text(), "A")
  assert.deepEqual(timeline.history.past.map(({ label }) => label), ["A"])
  assert.deepEqual(timeline.history.future.map(({ label }) => label), ["D", "C", "B"])

  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
  assert.equal(timeline.redo(), "D")
})

test("jumping forwards redoes up to the named action and stops before it", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  const b = timeline.edit("B")
  timeline.edit("C")
  assert.equal(timeline.undo(), "B")
  assert.equal(timeline.undo(), "A")
  assert.equal(timeline.undo(), "gốc")

  const result = timeline.jump(b.id)
  assert.equal(result.ok, true)
  assert.equal(timeline.text(), "A")
  assert.deepEqual(timeline.history.past.map(({ label }) => label), ["A"])
  assert.deepEqual(timeline.history.future.map(({ label }) => label), ["C", "B"])
  assert.deepEqual(applied(timeline.history), [true, false, false])

  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
})

test("a forwards jump crosses several undone edits at once", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  const c = timeline.edit("C")
  timeline.edit("D")
  for (let step = 0; step < 4; step++) timeline.undo()
  assert.equal(timeline.text(), "gốc")

  const result = timeline.jump(c.id)
  assert.equal(result.ok, true)
  assert.equal(timeline.text(), "B")
  assert.deepEqual(timeline.history.past.map(({ label }) => label), ["A", "B"])
  assert.deepEqual(timeline.history.future.map(({ label }) => label), ["D", "C"])

  // The entries the jump moved into `past` keep the real intermediate states.
  assert.equal(timeline.undo(), "A")
  assert.equal(timeline.undo(), "gốc")

  assert.equal(timeline.redo(), "A")
  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
  assert.equal(timeline.redo(), "D")
})

test("jumping to the newest boundary clears redo and keeps every action applied", () => {
  const timeline = createTimeline()
  const a = timeline.edit("A")
  timeline.edit("B")
  timeline.edit("C")
  assert.equal(timeline.jump(a.id).ok, true)
  assert.deepEqual(applied(timeline.history), [false, false, false])
  const before = ids(timeline.history)

  const result = timeline.jump(HISTORY_HEAD)
  assert.equal(result.ok, true)
  assert.equal(result.entry, null)
  assert.equal(timeline.text(), "C")
  assert.deepEqual(ids(timeline.history), before)
  assert.deepEqual(applied(timeline.history), [true, true, true])
  assert.equal(timeline.history.future.length, 0)
  assert.equal(timeline.redo(), null)
})

test("unknown, cleared and evicted ids are refused without touching the timeline", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  const b = timeline.edit("B")
  const before = shape(timeline.history)

  assert.deepEqual(timeline.jump("edit_999"), { ok: false, reason: "unknown", entry: null, snapshot: null })
  assert.deepEqual(timeline.jump(undefined), { ok: false, reason: "unknown", entry: null, snapshot: null })
  assert.deepEqual(shape(timeline.history), before)
  assert.equal(timeline.text(), "B")

  timeline.history.clear()
  const cleared = shape(timeline.history)
  assert.equal(timeline.jump(b.id).reason, "unknown")
  assert.deepEqual(shape(timeline.history), cleared)

  const capped = createTimeline({ limit: 2 })
  const evicted = capped.edit("A")
  capped.edit("B")
  capped.edit("C")
  const cappedShape = shape(capped.history)
  assert.equal(capped.jump(evicted.id).reason, "unknown")
  assert.deepEqual(shape(capped.history), cappedShape)
  assert.deepEqual(labels(capped.history), ["B", "C"])
})

test("jumping to the current boundary is a no-op", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  const b = timeline.edit("B")
  timeline.edit("C")
  assert.equal(timeline.undo(), "B")
  assert.equal(timeline.jump(b.id).ok, true)
  assert.equal(timeline.text(), "A")
  const before = shape(timeline.history)

  // B is already the next redo, so its boundary is exactly where the playhead sits.
  const current = timeline.jump(b.id)
  assert.equal(current.ok, false)
  assert.equal(current.reason, "current")
  assert.equal(current.entry.id, b.id)
  assert.equal(current.entry.applied, false)
  assert.equal(current.snapshot, null)
  assert.equal(timeline.text(), "A")
  assert.deepEqual(shape(timeline.history), before)
})

test("recording after a jump cuts the branch and drops the abandoned redo entries", () => {
  const timeline = createTimeline()
  const a = timeline.edit("A")
  const b = timeline.edit("B")
  timeline.edit("C")
  assert.equal(timeline.jump(a.id).ok, true)

  const d = timeline.edit("D")
  assert.deepEqual(labels(timeline.history), ["D"])
  assert.deepEqual(ids(timeline.history), [d.id])
  assert.equal(timeline.history.future.length, 0)
  assert.equal(timeline.redo(), null)
  assert.equal(timeline.jump(b.id).reason, "unknown")
})

test("the cap still bounds the timeline and jump stays inside the retained window", () => {
  const timeline = createTimeline({ limit: 2 })
  timeline.edit("A")
  const b = timeline.edit("B")
  timeline.edit("C")
  assert.deepEqual(labels(timeline.history), ["B", "C"])

  assert.equal(timeline.jump(b.id).ok, true)
  assert.equal(timeline.text(), "A")
  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
  assert.equal(timeline.history.past.length, 2)
})

test("jumps keep image references and every snapshot reachable for releaseUnusedImages", () => {
  const timeline = createTimeline()
  const a = timeline.edit("A")
  timeline.edit("B")
  timeline.edit("C")

  assert.equal(timeline.jump(a.id).ok, true)
  const snapshots = timeline.history.snapshots()
  assert.equal(snapshots.length, timeline.history.size)
  assert.deepEqual(
    snapshots.flatMap(({ pages }) => pages.map(({ url }) => url)),
    Array(timeline.history.size).fill("blob:1"),
  )
  for (const page of snapshots.flatMap(({ pages }) => pages)) {
    assert.equal(page.image, image)
    assert.equal(page.file, file)
  }
})

test("labels, kinds, ids and timestamps survive moves between the stacks", () => {
  let tick = 100
  const timeline = createTimeline({ clock: () => (tick += 100) })
  timeline.edit("A", { kind: "edit" })
  const b = timeline.edit("B", { kind: "raw-cleanup" })
  const c = timeline.edit("C")

  assert.equal(timeline.undo(), "B")
  const undone = timeline.history.future.at(-1)
  assert.equal(undone.id, c.id)
  assert.equal(undone.label, "C")
  assert.equal(undone.at, 400)

  assert.equal(timeline.jump(b.id).ok, true)
  const moved = timeline.history.future.at(-1)
  assert.equal(moved.id, b.id)
  assert.equal(moved.label, "B")
  assert.equal(moved.kind, "raw-cleanup")
  assert.equal(moved.at, 300)

  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
  const rows = timeline.history.entries()
  assert.deepEqual(rows.map(({ label }) => label), ["A", "B", "C"])
  assert.deepEqual(rows.map(({ at }) => at), [200, 300, 400])
})

test("the timeline is searchable without accents and filters applied entries", () => {
  const timeline = createTimeline()
  timeline.edit("Làm sạch raw trang 1", { kind: "raw-cleanup" })
  timeline.edit("Dịch chương 2", { kind: "translation" })
  timeline.edit("Đẩy khung thoại")
  timeline.undo()

  assert.deepEqual(
    timeline.history.entries({ query: "lam sach" }).map(({ label }) => label),
    ["Làm sạch raw trang 1"],
  )
  assert.deepEqual(
    timeline.history.entries({ query: "ĐẨY" }).map(({ label }) => label),
    ["Đẩy khung thoại"],
  )
  assert.deepEqual(
    timeline.history.entries({ query: "day khung" }).map(({ label }) => label),
    ["Đẩy khung thoại"],
  )
  assert.deepEqual(
    timeline.history.entries({ query: "translation" }).map(({ label }) => label),
    ["Dịch chương 2"],
  )
  assert.deepEqual(timeline.history.entries({ query: "khong-co-gi" }), [])
  assert.equal(timeline.history.entries({ query: "   " }).length, 3)
  assert.deepEqual(timeline.history.entries({ applied: false }).map(({ index }) => index), [2])
  assert.deepEqual(timeline.history.entries({ applied: true }).map(({ index }) => index), [0, 1])
})

test("timeline rows are lightweight copies that never expose or alias snapshots", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")

  const rows = timeline.history.entries()
  assert.deepEqual(Object.keys(rows[0]), ["id", "label", "kind", "at", "index", "applied"])
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows)

  rows[0].label = "đã sửa"
  rows[0].applied = false
  assert.equal(timeline.history.past[0].label, "A")
  assert.equal(timeline.history.entries()[0].applied, true)
})

test("jumping invalidates the one-click undo token instead of rewinding the wrong state", () => {
  const timeline = createTimeline()
  const token = timeline.edit("Làm sạch raw trang 1", { kind: "raw-cleanup" })
  assert.equal(checkUndoToken(timeline.history, token).ok, true)

  assert.equal(timeline.jump(token.id).ok, true)
  assert.equal(checkUndoToken(timeline.history, token).ok, false)
  assert.equal(checkUndoToken(timeline.history, token).reason, "undone")

  assert.equal(timeline.jump(HISTORY_HEAD).ok, true)
  assert.equal(timeline.text(), "Làm sạch raw trang 1")
  assert.equal(checkUndoToken(timeline.history, token).ok, false)
  assert.equal(checkUndoToken(timeline.history, token).reason, "rewound")
})

test("a jump that leaves a newer action applied still refuses an older notification token", () => {
  const timeline = createTimeline()
  const a = timeline.edit("A")
  const token = timeline.edit("B", { kind: "raw-cleanup" })
  assert.equal(timeline.jump(a.id).ok, true)
  assert.deepEqual(applied(timeline.history), [false, false])

  assert.equal(timeline.jump(token.id).ok, true)
  assert.equal(timeline.text(), "A")
  assert.equal(timeline.history.past.length, 1)
  assert.equal(checkUndoToken(timeline.history, token).reason, "undone")

  assert.equal(timeline.jump(timeline.history.past[0].id).ok, true)
  assert.equal(checkUndoToken(timeline.history, token).reason, "undone")
})

test("a failed clone during a jump leaves both stacks and the token untouched", () => {
  const history = new EditHistory()
  const first = history.record({ pages: [], index: 0 })
  history.record({ pages: [], index: 1 })
  const before = shape(history)
  const uncloneable = { pages: [], callback() {} }

  assert.throws(() => history.jump(first.id, uncloneable), { name: "DataCloneError" })
  assert.deepEqual(shape(history), before)
  assert.equal(checkUndoToken(history, first).reason, "superseded")

  const redoable = new EditHistory()
  const token = redoable.record({ pages: [], index: 0 })
  redoable.record({ pages: [], index: 1 })
  redoable.undo({ pages: [], index: 2 })
  const undone = shape(redoable)
  assert.throws(() => redoable.jump(HISTORY_HEAD, uncloneable), { name: "DataCloneError" })
  assert.deepEqual(shape(redoable), undone)
  assert.equal(checkUndoToken(redoable, token).reason, "rewound")
  assert.equal(redoable.undo({ pages: [], index: 3 }).index, 0)
})

test("one live form group stays one named action while it keeps the same group id", () => {
  const history = new EditHistory(40, { now: () => 1000 })
  const first = history.record({ pages: [], step: 0 }, { label: "Sửa khung thoại", kind: "form", group: "form-1" })
  const second = history.record({ pages: [], step: 1 }, { label: "Sửa khung thoại", kind: "form", group: "form-1" })

  assert.equal(history.past.length, 1)
  assert.equal(second.id, first.id)
  assert.equal(history.past[0].snapshot.step, 0)
  assert.equal(history.past[0].label, "Sửa khung thoại")
  assert.equal(history.past[0].at, 1000)
  assert.equal(history.entries().length, 1)

  history.record({ pages: [], step: 2 }, { label: "Đẩy khung", kind: "nudge", group: "form-2" })
  assert.equal(history.past.length, 2)
  assert.deepEqual(history.entries().map(({ label }) => label), ["Sửa khung thoại", "Đẩy khung"])

  // A move closes the group, so repeating its id afterwards starts a new action instead of
  // rewriting the entry the user already undid.
  history.undo({ pages: [], step: 3 })
  history.record({ pages: [], step: 4 }, { label: "Sửa khung thoại", group: "form-1" })
  assert.equal(history.past.length, 2)
  assert.equal(history.past.at(-1).snapshot.step, 4)
  assert.notEqual(history.past.at(-1).id, first.id)
})

test("group updates refresh the name and stay undoable as one action", () => {
  const history = new EditHistory(40, { now: () => 1000 })
  const first = history.record({ pages: [], text: "gốc" }, { group: "form-1" })
  assert.equal(first.label, DEFAULT_ACTION_LABEL)

  history.record({ pages: [], text: "đang gõ" }, { label: "Sửa nội dung khung", group: "form-1" })
  assert.equal(history.past.length, 1)
  assert.equal(history.past[0].label, "Sửa nội dung khung")
  assert.equal(history.past[0].snapshot.text, "gốc")

  assert.equal(history.undo({ pages: [], text: "đang gõ" }).text, "gốc")
  assert.equal(history.future.at(-1).label, "Sửa nội dung khung")
  assert.equal(history.redo({ pages: [], text: "gốc" }).text, "đang gõ")
})
