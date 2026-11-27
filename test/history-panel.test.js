import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { copyEditor, EditHistory, HISTORY_HEAD } from "../src/history.js"

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
// The global keydown handler lives in its own controller, so its wiring is read from there.
const shortcutSource = await readFile(new URL("../src/controllers/shortcuts.js", import.meta.url), "utf8")
const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")

// src/main.js is a browser entry module, so the panel's own rule is read out of the real source
// instead of being mirrored: the function under test is the one the app ships.
function mainFunction(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start > 0, `main.js must define ${name}`)
  const end = main.indexOf("\n}\n", start)
  assert.ok(end > start, `${name} must be a top-level function`)
  return main.slice(start, end + 3)
}

const historyJumpTarget = new Function(
  "HISTORY_HEAD",
  `${mainFunction("historyJumpTarget")}\nreturn historyJumpTarget`,
)(HISTORY_HEAD)

// The click path resolves a row id against the timeline as it stands after the pending commits, so
// the shipped resolver is exercised against a real EditHistory instead of a mirrored copy.
const historyResolver = (history) => new Function(
  "history",
  "HISTORY_HEAD",
  "historyJumpTarget",
  `${mainFunction("historyTargetFor")}\nreturn historyTargetFor`,
)(history, HISTORY_HEAD, historyJumpTarget)

const image = { naturalWidth: 800, naturalHeight: 1200 }
const file = new File(["raw"], "page-1.png")

// Mirrors src/main.js: a row names the state after its action and the playhead sits after the
// last applied row, while jump() addresses the boundary before the action that follows it.
function createTimeline() {
  const history = new EditHistory()
  let state = {
    pages: [{
      id: "page-1",
      name: "1",
      image,
      file,
      url: "blob:1",
      boxes: [{ id: "box-1", text: "gốc" }],
      unplaced: [],
      retouchStrokes: [],
    }],
    queue: [],
  }
  const snapshot = () => copyEditor({ pages: state.pages, queue: state.queue })
  const apply = (restored) => {
    state = { ...state, pages: restored.pages }
    return state.pages[0].boxes[0].text
  }

  return {
    history,
    rows: () => history.entries(),
    applied: () => history.entries().filter((row) => row.applied).length,
    text: () => state.pages[0].boxes[0].text,
    edit(label) {
      const token = history.record(snapshot(), { label, kind: "edit" })
      state.pages[0].boxes[0].text = label
      return token
    },
    jump(row, rows = history.entries()) {
      const result = history.jump(historyJumpTarget(rows, row), snapshot())
      return result.ok ? apply(result.snapshot) : result
    },
    undo() {
      const restored = history.undo(snapshot())
      return restored ? apply(restored) : null
    },
    redo() {
      const restored = history.redo(snapshot())
      return restored ? apply(restored) : null
    },
  }
}

test("an after-action row jumps to the next chronological boundary, or the newest state", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  timeline.edit("C")
  const rows = timeline.rows()

  assert.equal(historyJumpTarget(rows, rows[0]), rows[1].id)
  assert.equal(historyJumpTarget(rows, rows[1]), rows[2].id)
  assert.equal(historyJumpTarget(rows, rows[2]), HISTORY_HEAD)

  // Row A means "the state right after A", so the jump undoes B and C and keeps both redoable.
  assert.equal(timeline.jump(rows[0]), "A")
  assert.deepEqual(timeline.rows().map(({ applied }) => applied), [true, false, false])
  assert.equal(timeline.redo(), "B")
  assert.equal(timeline.redo(), "C")
  assert.equal(timeline.text(), "C")
})

test("the newest row restores the newest state after a jump backwards", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  timeline.jump(timeline.rows()[0])
  assert.equal(timeline.text(), "A")

  const rows = timeline.rows()
  assert.equal(timeline.jump(rows.at(-1)), "B")
  assert.deepEqual(timeline.rows().map(({ applied }) => applied), [true, true])
  assert.equal(timeline.history.future.length, 0)
})

test("searching only hides rows and never retargets one", () => {
  const timeline = createTimeline()
  timeline.edit("Làm sạch raw trang 1")
  timeline.edit("Dịch chương 2")
  timeline.edit("Đẩy khung thoại")
  const rows = timeline.rows()

  for (const query of ["", "lam sach", "dich", "khong-co-gi", "day khung"]) {
    const shown = timeline.history.entries({ query })
    for (const row of shown) {
      const unfiltered = rows.find(({ id }) => id === row.id)
      assert.equal(row.index, unfiltered.index)
      assert.equal(historyJumpTarget(rows, row), historyJumpTarget(rows, unfiltered))
    }
  }
  assert.equal(timeline.history.entries({ query: "lam sach" }).length, 1)
  assert.equal(historyJumpTarget(rows, timeline.history.entries({ query: "lam sach" })[0]), rows[1].id)
})

test("the newest row that is not the current state is the keyboard jump target", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  timeline.edit("C")

  // Mirrors jumpToNewestMatch(): the search picks the row, the playhead decides the meaning.
  const newest = (query) => {
    const applied = timeline.applied()
    return timeline.history.entries({ query })
      .filter((row) => applied !== row.index + 1)
      .at(-1)
  }

  assert.equal(newest("").label, "B")
  assert.equal(newest("B").label, "B")
  assert.equal(timeline.jump(newest("B")), "B")
  assert.equal(timeline.rows().filter((row) => row.applied).length, 2)

  // The playhead now sits after B, so Enter picks the newest undone row and redoes back to C.
  assert.equal(newest("").label, "C")
  assert.equal(timeline.jump(newest("")), "C")
  assert.equal(timeline.history.future.length, 0)
})

test("the row under the playhead is the last applied one and cannot move it", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  const rows = timeline.rows()
  const applied = timeline.applied()
  const current = rows.filter((row) => applied === row.index + 1)

  assert.deepEqual(current.map(({ label }) => label), ["B"])
  assert.equal(current.at(-1).id, timeline.history.past.at(-1).id)

  const target = historyJumpTarget(rows, current.at(-1))
  const result = timeline.history.jump(target, copyEditor({ pages: [] }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, "current")
})

test("a row jump is guarded by busy, gesture and the open form edit", () => {
  const jump = mainFunction("jumpHistory")
  for (const [busy, gesturing, accepted] of [[true, false, false], [false, true, false], [false, false, true]]) {
    let committed = 0
    const prepare = new Function(
      "projectBusy", "gestures", "status", "commitLiveFormCheckpoint",
      mainFunction("prepareHistoryJump") + "\nreturn prepareHistoryJump",
    )(() => busy, { hasGesture: () => gesturing }, () => {}, () => { committed++ })
    assert.equal(prepare(), accepted)
    assert.equal(committed, accepted ? 1 : 0)
  }
  assert.match(jump, /history\.jump\(id, editorSnapshot\(\)\)/)
  assert.match(jump, /applyHistorySnapshot\(result\.snapshot\)/)

  // Undo, redo and jumps share one restore path, so selection and asset release stay identical.
  const apply = mainFunction("applyHistorySnapshot")
  assert.match(apply, /syncSelectionAfterRestore\(\)/)
  assert.match(apply, /render\(\)/)
  assert.match(apply, /releaseUnusedImages\(\)/)
  assert.match(mainFunction("restoreHistory"), /applyHistorySnapshot\(snapshot\)/)
  assert.match(mainFunction("undoCleanupAction"), /checkUndoToken\(history, token/)

  // Toolbar and keyboard undo/redo keep their existing wiring.
  assert.match(main, /byId\("undo"\)\.onclick = \(\) => restoreHistory\("undo"\)/)
  assert.match(main, /byId\("redo"\)\.onclick = \(\) => restoreHistory\("redo"\)/)
  assert.match(shortcutSource, /restoreHistory\(key === "y" \|\| event\.shiftKey \? "redo" : "undo"\)/)
})

test("the panel lists the unfiltered timeline and derives every target from it", () => {
  const panel = mainFunction("syncHistoryPanel")
  assert.match(panel, /const rows = history\.entries\(\)/)
  assert.match(panel, /const shown = history\.entries\(\{ query: byId\("history-search"\)\.value \}\)/)
  assert.match(panel, /jumpToHistoryRow\(row\.id\)/)
  assert.match(panel, /\.\.\.shown\.map\(/)

  // Current-state feedback, focus restoration and the current row's disabled state.
  assert.match(panel, /byId\("history-current"\)\.textContent/)
  assert.match(panel, /setAttribute\("aria-current", "true"\)/)
  assert.match(panel, /dataset\.historyId/)
  assert.match(panel, /\.focus\(\)/)

  assert.match(mainFunction("syncProjectActions"), /syncHistoryPanel\(\)/)
  assert.match(main, /byId\("history-search"\)\.addEventListener\("input", syncHistoryPanel\)/)
  // A closed panel costs nothing on the renders that only touch the toolbar.
  assert.match(panel, /if \(!list \|\| byId\("history-panel"\)\.hidden\) return/)
})

test("keyboard search, jump and Escape drive the panel and hand focus back", () => {
  assert.match(shortcutSource, /if \(key === "h" && event\.shiftKey\) \{\n\s*event\.preventDefault\(\)\n\s*toggleHistoryPanel\?\.\(true\)/)

  const start = main.indexOf('byId("history-panel").addEventListener("keydown"')
  assert.ok(start > 0, "the panel must handle its own keys")
  const body = main.slice(start, main.indexOf("\n})\n", start))
  assert.match(body, /event\.key === "Escape"[\s\S]*?toggleHistoryPanel\(false\)/)
  assert.match(body, /event\.key === "Enter"[\s\S]*?jumpToNewestMatch\(\)/)
  assert.match(body, /ArrowDown: 1, ArrowUp: -1/)
  assert.match(body, /\.history-entry:not\(:disabled\)/)
  assert.match(body, /\.focus\(\)/)

  const toggle = mainFunction("toggleHistoryPanel")
  assert.match(toggle, /aria-expanded/)
  assert.match(toggle, /byId\("history-search"\)\.focus\(\)/)
  assert.match(toggle, /button\.focus\(\)/)
})

test("the panel is labeled, searchable markup that starts closed", () => {
  assert.match(markup, /<section id="history-panel"[^>]*aria-labelledby="history-title"[^>]*hidden>/)
  assert.match(markup, /<button type="button" id="history-toggle" aria-expanded="false" aria-controls="history-panel"/)
  assert.match(markup, /<label class="field" for="history-search">Tìm thao tác/)
  assert.match(markup, /<input id="history-search" type="search"/)
  assert.match(markup, /<p id="history-empty" class="muted" hidden><\/p>/)
  assert.match(markup, /<ol id="history-list"/)
  assert.match(markup, /id="history-count"[^>]*role="status"[^>]*aria-live="polite"/)
})

test("an open live form edit is still recorded as one named action", () => {
  assert.match(main, /const FORM_EDIT_META = \{ label: "Sửa khung thoại", kind: "form" \}/)
  assert.match(mainFunction("commitLiveFormCheckpoint"), /checkpoint\(before, FORM_EDIT_META\)/)
  assert.match(mainFunction("checkpoint"), /history\.record\(pending, \{ \.\.\.FORM_EDIT_META, \.\.\.meta \}\)/)
})

test("the panel keeps its own keys away from the nudging and shortcut handlers", () => {
  assert.match(shortcutSource, /if \(event\.target\.closest\("#history-panel"\)\) return/)
})

test("a row keeps its action id and resolves its target after the pending commit", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  const rendered = timeline.rows()
  const clicked = rendered.at(-1)

  // Drawn as the newest action, the row alone can only name the newest boundary.
  assert.equal(historyJumpTarget(rendered, clicked), HISTORY_HEAD)

  // A form or nudge edit is still open: committing it records a real checkpoint after the render.
  timeline.edit("C")
  const target = historyResolver(timeline.history)(clicked.id)
  assert.equal(target.label, "B")
  assert.notEqual(target.id, HISTORY_HEAD)
  assert.equal(target.id, timeline.rows()[2].id)

  // The jump therefore lands on the state after B and keeps C waiting in redo order.
  assert.equal(timeline.jump(clicked), "B")
  assert.deepEqual(timeline.rows().map(({ applied }) => applied), [true, true, false])
})

test("a row cut by a new branch resolves to nothing instead of jumping somewhere else", () => {
  const timeline = createTimeline()
  timeline.edit("A")
  timeline.edit("B")
  const rendered = timeline.rows()

  // Undo back to A, then record a new action: the branch cut drops B from the timeline.
  timeline.jump(rendered[0])
  timeline.edit("C")
  const resolve = historyResolver(timeline.history)
  assert.equal(resolve(rendered[1].id), null)

  // The row that survived still targets the next action of the new branch, not a stale id.
  assert.equal(resolve(rendered[0].id).id, timeline.rows()[1].id)
})

test("the click path commits pending edits before it resolves the row", () => {
  const jump = mainFunction("jumpToHistoryRow")
  assert.ok(jump.indexOf("if (!prepareHistoryJump()) return false") < jump.indexOf("historyTargetFor(actionId)"))
  assert.match(jump, /if \(!target\) \{[\s\S]*?status\(/)
  assert.match(jump, /syncHistoryPanel\(\)/)
  assert.match(jump, /jumpHistory\(target\.id, target\.label\)/)

  // Enter resolves the selected row against the full list after preparation.
  const enter = mainFunction("jumpToNewestMatch")
  assert.ok(enter.indexOf("if (!prepareHistoryJump()) return false") < enter.indexOf("history.entries()"))
  assert.match(enter, /jumpHistory\(historyJumpTarget\(rows, row\), row\.label\)/)
})

test("the oldest state has its own control and reports when it is already current", () => {
  assert.match(markup, /<button type="button" id="history-start"[^>]*>Về mốc cũ nhất<\/button>/)
  assert.match(main, /byId\("history-start"\)\.onclick = \(\) => jumpToHistoryStart\(\)/)
  assert.match(mainFunction("syncHistoryPanel"), /byId\("history-start"\)\.disabled = !rows\.length \|\| applied === 0/)
  assert.match(mainFunction("jumpToHistoryStart"), /jumpHistory\(HISTORY_START, ""\)/)
  assert.match(mainFunction("jumpHistory"), /Đã trở về mốc cũ nhất trong lịch sử\./)
})

test("a pending nudge is finalized before the next action, a jump and a keyboard undo", () => {
  const checkpoint = mainFunction("checkpoint")
  assert.match(checkpoint, /^function checkpoint\(snapshot, meta\) \{\n(?:  \/\/.*\n)*  commitNudgeCheckpoint\(\)/)
  assert.match(main, /const recordNudge = \(before\) => checkpoint\(before, NUDGE_META\)/)
  assert.match(mainFunction("commitNudgeCheckpoint"), /shortcuts\.commitNudge\(\)/)
  assert.match(shortcutSource, /recordNudge\(before\)/)

  // The form commit finalizes the nudge first, so the older action keeps the older boundary.
  const commit = mainFunction("commitLiveFormCheckpoint")
  assert.ok(commit.indexOf("commitNudgeCheckpoint()") < commit.indexOf("formEditSnapshot"))
  assert.match(commit, /checkpoint\(before, FORM_EDIT_META\)/)

  // Jump and keyboard undo both route through that commit, so no timer survives either.
  assert.match(mainFunction("prepareHistoryJump"), /commitLiveFormCheckpoint\(\)/)
  assert.match(mainFunction("restoreHistory"), /commitLiveFormCheckpoint\(\)/)
})

test("the search box keeps its native Home/End and horizontal arrow keys", () => {
  const start = main.indexOf('byId("history-panel").addEventListener("keydown"')
  assert.ok(start > 0, "the panel must handle its own keys")
  const body = main.slice(start, main.indexOf("\n})\n", start))
  assert.match(
    body,
    /if \(event\.target === byId\("history-search"\) && \["Home", "End", "ArrowLeft", "ArrowRight"\]\.includes\(event\.key\)\) return/,
  )
  // The guard sits before the list's roving focus, so the caret keys actually stay native.
  assert.ok(body.indexOf('"ArrowLeft"') < body.indexOf("const steps ="))
})
