import assert from "node:assert/strict"
import test from "node:test"
import { copyEditor, DEFAULT_ACTION_LABEL, EditHistory } from "../src/history.js"

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

const applied = (history) => history.entries().map(({ applied: isApplied }) => isApplied)

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
