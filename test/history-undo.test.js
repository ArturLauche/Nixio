import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { checkUndoToken, copyEditor, EditHistory } from "../src/history.js"

function makePage(name, text = "thoại gốc") {
  return {
    id: `page-${name}`,
    name,
    image: { naturalWidth: 800, naturalHeight: 1200 },
    file: new File(["raw"], `${name}.png`),
    url: `blob:${name}`,
    boxes: [{ id: `box-${name}`, text }],
    unplaced: [],
    retouchStrokes: [],
  }
}

// Mirrors src/main.js: checkpoint() snapshots the pre-edit state and returns the action
// token, restoreHistory() reuses the newest snapshot, undoCleanupAction() guards the token
// before it delegates to restoreHistory("undo").
function createEditor({ pages = ["1", "2"], limit = 40 } = {}) {
  const history = new EditHistory(limit)
  const notices = []
  let formEditSnapshot = null
  let nudgeSnapshot = null
  let gesturing = false
  let busy = false
  let state = { pages: pages.map((name) => makePage(name)), queue: [] }

  const snapshot = () => copyEditor({ pages: state.pages, queue: state.queue })
  const updatePages = (update) => {
    state = { ...state, pages: state.pages.map(update) }
  }
  const updateBox = (pageIndex, text) => {
    updatePages((page, index) =>
      index === pageIndex
        ? { ...page, boxes: page.boxes.map((box) => ({ ...box, text })) }
        : page,
    )
  }

  function checkpoint(meta) {
    if (nudgeSnapshot) {
      const before = nudgeSnapshot
      nudgeSnapshot = null
      history.record(before)
    }
    if (formEditSnapshot) {
      const before = formEditSnapshot
      formEditSnapshot = null
      return history.record(before, meta)
    }
    return history.record(snapshot(), meta)
  }

  function commitLiveForm() {
    if (nudgeSnapshot) {
      const before = nudgeSnapshot
      nudgeSnapshot = null
      history.record(before)
    }
    if (formEditSnapshot) {
      const before = formEditSnapshot
      formEditSnapshot = null
      history.record(before)
    }
  }

  function restoreHistory(direction) {
    if (busy || gesturing) return false
    commitLiveForm()
    const restored = history[direction](snapshot())
    if (!restored) return false
    state = { ...state, pages: restored.pages, queue: restored.queue }
    return true
  }

  function checkUndo(token) {
    return checkUndoToken(history, token, {
      busy,
      gesturing,
      pending: Boolean(formEditSnapshot || nudgeSnapshot),
    })
  }

  function clickUndo(token) {
    const check = checkUndo(token)
    if (!check.ok) {
      notices.push(check)
      return false
    }
    return restoreHistory("undo")
  }

  function cleanPages(count) {
    updatePages((page, index) => (index < count ? { ...page, url: `${page.url}?clean` } : page))
  }

  return {
    history,
    notices,
    checkUndo,
    clickUndo,
    restoreHistory,
    pageUrl: (index) => state.pages[index].url,
    boxText: (pageIndex, boxIndex = 0) => state.pages[pageIndex].boxes[boxIndex].text,
    setBusy: (value) => { busy = value },
    setGesturing: (value) => { gesturing = value },
    runCleanup(meta) {
      const token = checkpoint(meta ?? { label: "Làm sạch raw trang 1", kind: "raw-cleanup" })
      cleanPages(1)
      return token
    },
    runChapterCleanup({ cleaned = 2, total = 4, pages: chapter = ["1", "2", "3", "4"] } = {}) {
      state = { ...state, pages: chapter.map((name) => makePage(name)) }
      const token = checkpoint({ label: `Làm sạch raw cả chương (${total} trang)`, kind: "raw-cleanup" })
      cleanPages(cleaned)
      return token
    },
    editBox(pageIndex, text) {
      checkpoint()
      updateBox(pageIndex, text)
    },
    startFormEdit(pageIndex, text) {
      if (!formEditSnapshot) formEditSnapshot = snapshot()
      updateBox(pageIndex, text)
    },
    commitFormEdit: commitLiveForm,
    startNudge(pageIndex) {
      if (!nudgeSnapshot) nudgeSnapshot = snapshot()
      updateBox(pageIndex, "đã đẩy khung")
    },
  }
}

test("a raw cleanup notification undoes its own cleanup while it is the newest action", () => {
  const editor = createEditor()
  const token = editor.runCleanup()

  assert.equal(token.label, "Làm sạch raw trang 1")
  assert.equal(token.kind, "raw-cleanup")
  assert.equal(editor.history.past.length, 1)
  assert.equal(editor.pageUrl(0), "blob:1?clean")
  assert.equal(editor.checkUndo(token).ok, true)

  assert.equal(editor.clickUndo(token), true)
  assert.equal(editor.pageUrl(0), "blob:1")
  assert.equal(editor.history.past.length, 0)
  assert.equal(editor.history.future.length, 1)
  assert.deepEqual(editor.notices, [])
})

test("an unrelated edit after cleanup refuses the one-click undo and keeps both changes", () => {
  const editor = createEditor()
  const token = editor.runCleanup()
  editor.editBox(1, "thoại mới")

  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "superseded")
  assert.match(editor.notices.at(-1).message, /Đã có chỉnh sửa khác sau "Làm sạch raw trang 1"/)
  assert.match(editor.notices.at(-1).message, /Ctrl\+Z/)

  // Neither change was rewound, and history was not consumed by the refusal.
  assert.equal(editor.pageUrl(0), "blob:1?clean")
  assert.equal(editor.boxText(1), "thoại mới")
  assert.equal(editor.history.past.length, 2)

  // Ordinary undo still rewinds only the newest edit.
  assert.equal(editor.restoreHistory("undo"), true)
  assert.equal(editor.boxText(1), "thoại gốc")
  assert.equal(editor.pageUrl(0), "blob:1?clean")
})

test("an equal stack depth after a manual undo/redo never revives a stale cleanup token", () => {
  const editor = createEditor()
  const token = editor.runCleanup()
  editor.editBox(1, "sửa khác")
  assert.equal(editor.history.past.length, 2)

  // Undoing the later edit puts the cleanup action back on top at the same depth it had
  // when the notification was issued, so a past.length guard would wrongly accept it.
  assert.equal(editor.restoreHistory("undo"), true)
  assert.equal(editor.history.past.length, 1)
  assert.equal(editor.history.past.at(-1).id, token.id)
  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "rewound")

  assert.equal(editor.restoreHistory("redo"), true)
  assert.equal(editor.history.past.length, 2)
  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "superseded")
})

test("undoing the cleanup itself reports it as already undone instead of rewinding again", () => {
  const editor = createEditor()
  const token = editor.runCleanup()

  assert.equal(editor.restoreHistory("undo"), true)
  assert.equal(editor.pageUrl(0), "blob:1")
  assert.equal(editor.history.future.at(-1).id, token.id)

  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "undone")
  assert.match(editor.notices.at(-1).message, /đã được hoàn tác rồi/)
  assert.match(editor.notices.at(-1).message, /Ctrl\+Y/)
  assert.equal(editor.pageUrl(0), "blob:1")
  assert.equal(editor.history.past.length, 0)
})

test("a redo keeps the action identity but the rewound timeline still refuses the old token", () => {
  const editor = createEditor()
  const token = editor.runCleanup()

  assert.equal(editor.restoreHistory("undo"), true)
  assert.equal(editor.restoreHistory("redo"), true)
  assert.equal(editor.pageUrl(0), "blob:1?clean")
  assert.equal(editor.history.past.at(-1).id, token.id)
  assert.equal(editor.history.past.at(-1).label, token.label)

  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "rewound")
  assert.equal(editor.pageUrl(0), "blob:1?clean")
})

test("the capped history drops an expired cleanup action and its notification refuses", () => {
  const editor = createEditor({ limit: 3 })
  const token = editor.runCleanup()
  for (let index = 0; index < 3; index++) editor.editBox(0, `sửa ${index}`)

  assert.equal(editor.history.past.length, 3)
  assert.equal(editor.history.past.some((entry) => entry.id === token.id), false)
  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "missing")
  assert.match(editor.notices.at(-1).message, /Không còn "Làm sạch raw trang 1" trong lịch sử hoàn tác/)
  assert.equal(editor.pageUrl(0), "blob:1?clean")

  // Ordinary undo keeps working inside the capped window.
  assert.equal(editor.restoreHistory("undo"), true)
  assert.equal(editor.boxText(0), "sửa 1")
})

test("a project load or reset that clears history refuses the old cleanup notification", () => {
  const editor = createEditor()
  const token = editor.runCleanup()
  editor.history.clear()

  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "missing")
  assert.equal(editor.pageUrl(0), "blob:1?clean")
})

test("a token from another history session never matches a fresh history instance", () => {
  const previous = createEditor()
  const token = previous.runCleanup()

  const fresh = createEditor()
  const replacement = fresh.runCleanup()
  assert.equal(replacement.id, token.id)
  assert.notEqual(replacement.session, token.session)
  assert.equal(fresh.checkUndo(token).reason, "missing")
  assert.equal(fresh.clickUndo(token), false)
  assert.equal(fresh.pageUrl(0), "blob:1?clean")
  assert.equal(fresh.checkUndo(replacement).ok, true)
})

test("in-flight form edits, nudges, gestures and busy tasks refuse the one-click undo", () => {
  const editor = createEditor()
  const token = editor.runCleanup()

  editor.startFormEdit(0, "đang gõ")
  assert.equal(editor.checkUndo(token).reason, "pending")
  assert.match(editor.checkUndo(token).message, /chỉnh sửa chưa lưu/)
  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.pageUrl(0), "blob:1?clean")

  // Once the form edit is committed it supersedes the cleanup like any other action.
  editor.commitFormEdit()
  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "superseded")

  const nudged = editor.runCleanup({ label: "Làm sạch raw trang 2", kind: "raw-cleanup" })
  editor.startNudge(0)
  assert.equal(editor.checkUndo(nudged).reason, "pending")
  editor.commitFormEdit()

  const gesturing = editor.runCleanup({ label: "Làm sạch raw lần 3", kind: "raw-cleanup" })
  editor.setGesturing(true)
  assert.equal(editor.checkUndo(gesturing).reason, "gesturing")
  editor.setGesturing(false)

  editor.setBusy(true)
  assert.equal(editor.checkUndo(gesturing).reason, "busy")
  assert.equal(editor.clickUndo(gesturing), false)
  editor.setBusy(false)

  assert.equal(editor.checkUndo(gesturing).ok, true)
  assert.equal(editor.clickUndo(gesturing), true)
})

test("a cancelled chapter cleanup that cleaned some pages undoes as one action", () => {
  const editor = createEditor({ pages: ["1"] })
  const token = editor.runChapterCleanup({ cleaned: 2, total: 4 })

  assert.equal(editor.history.past.length, 1)
  assert.equal(token.label, "Làm sạch raw cả chương (4 trang)")
  assert.equal(editor.pageUrl(0), "blob:1?clean")
  assert.equal(editor.pageUrl(1), "blob:2?clean")
  assert.equal(editor.pageUrl(2), "blob:3")

  assert.equal(editor.clickUndo(token), true)
  assert.equal(editor.history.past.length, 0)
  assert.equal(editor.pageUrl(0), "blob:1")
  assert.equal(editor.pageUrl(1), "blob:2")
  assert.equal(editor.pageUrl(2), "blob:3")

  // A second click cannot undo the same action twice.
  assert.equal(editor.clickUndo(token), false)
  assert.equal(editor.notices.at(-1).reason, "undone")
})

test("repeated cleanups issue distinct tokens and only the newest one undoes", () => {
  const editor = createEditor()
  const first = editor.runCleanup()
  const second = editor.runCleanup({ label: "Làm sạch raw trang 2", kind: "raw-cleanup" })

  assert.notEqual(first.id, second.id)
  assert.equal(editor.checkUndo(first).reason, "superseded")
  assert.equal(editor.clickUndo(first), false)
  assert.equal(editor.clickUndo(second), true)
  assert.equal(editor.pageUrl(0), "blob:1?clean")
  assert.equal(editor.pageUrl(1), "blob:2")
})

test("image URLs stay referenced by both stacks so undo and redo never restore a revoked asset", () => {
  const editor = createEditor()
  editor.runCleanup()
  editor.editBox(1, "sửa khác")
  editor.restoreHistory("undo")

  const urls = new Set(editor.history.snapshots().flatMap(({ pages }) => pages.map(({ url }) => url)))
  assert.equal(urls.has("blob:1?clean"), true)
  assert.equal(urls.has("blob:1"), true)
})

// src/main.js cannot be imported under node --test (it needs the DOM), so assert the wiring
// that carries these helpers into the raw cleanup notifications.
test("main.js routes both raw cleanup notifications through the guarded undo", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
  const start = main.indexOf("async function runCleanRawSingle")
  const end = main.indexOf('byId("clean-raw").onclick')
  const cleanup = main.slice(start, end)

  assert.ok(start > 0 && end > start)
  assert.equal((cleanup.match(/onClick: \(\) => undoCleanupAction\(token\)/g) ?? []).length, 2)
  assert.doesNotMatch(cleanup, /restoreHistory\("undo"\)/)
  assert.match(main, /function undoCleanupAction\(token\) \{[\s\S]*?checkUndoToken\(history, token, \{/)
  assert.match(main, /gesturing: gestures\.hasGesture\(\)/)
  assert.match(main, /pending: pendingHistoryEdit\(\)/)
  assert.match(main, /const snapshots = \[state, \.\.\.history\.snapshots\(\)\]/)
  // Ordinary toolbar and keyboard undo/redo stay untouched. The keyboard handler lives in the
  // shortcuts controller since the modal and Space guards moved there.
  assert.match(main, /byId\("undo"\)\.onclick = \(\) => restoreHistory\("undo"\)/)
  assert.match(main, /byId\("redo"\)\.onclick = \(\) => restoreHistory\("redo"\)/)
  const shortcuts = await readFile(new URL("../src/controllers/shortcuts.js", import.meta.url), "utf8")
  assert.match(shortcuts, /restoreHistory\(key === "y" \|\| event\.shiftKey \? "redo" : "undo"\)/)
})


test("undo and redo preserve history when the current snapshot cannot be copied", () => {
  const history = new EditHistory()
  const token = history.record({ pages: [], index: 0 })
  const uncloneable = { pages: [], callback() {} }
  assert.throws(() => history.undo(uncloneable), { name: "DataCloneError" })
  assert.equal(checkUndoToken(history, token).ok, true)
  assert.equal(history.undo({ pages: [], index: 1 }).index, 0)
  assert.throws(() => history.redo(uncloneable), { name: "DataCloneError" })
  assert.equal(history.redo({ pages: [], index: 0 }).index, 1)
})

test("the editor snapshot carries QA decisions, so undoing an applied suggestion restores them (#review)", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
  // The board is project data an action changes, so it belongs in the snapshot history records.
  assert.match(main, /function editorSnapshot\(\) \{[\s\S]*?qaReview: qaReview\.snapshot\(\),[\s\S]*?\n\}/)
  // ...and the restore path has to put it back, or the finding stays marked fixed.
  assert.match(main, /function applyHistorySnapshot\(snapshot\) \{[\s\S]*?qaReview: review[\s\S]*?qaReview\.replace\(review\)/)
})
