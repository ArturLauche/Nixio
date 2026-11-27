import assert from "node:assert/strict"
import test from "node:test"
import { EditHistory } from "../src/history.js"
import { remainingTranslations, translationLabel, translationNotes, translationSignature } from "../src/translation.js"

test("undo restores removed pages and nested edits while sharing the original images", () => {
  const image = { naturalWidth: 300 }
  const file = new File(["original"], "page.png")
  const editor = { pages: [{ id: "p1", image, file, url: "blob:page", boxes: [{ text: "Before", cleanupStrokes: [] }] }], queue: ["Waiting"] }
  const history = new EditHistory(2)
  history.record(editor)
  editor.pages[0].boxes[0].text = "After"
  editor.pages[0].boxes[0].cleanupStrokes.push({ points: [{ x: .1, y: .2 }] })
  history.record(editor)
  editor.pages = []
  const restored = history.undo(editor)
  assert.equal(restored.pages[0].boxes[0].text, "After")
  assert.equal(restored.pages[0].image, image)
  assert.equal(restored.pages[0].file, file)
  const original = history.undo(restored)
  assert.equal(original.pages[0].boxes[0].text, "Before")
  assert.deepEqual(original.pages[0].boxes[0].cleanupStrokes, [])
  const redone = history.redo(original)
  assert.equal(redone.pages[0].boxes[0].text, "After")
  history.record(redone)
  assert.equal(history.redo(redone), null)
})

test("history is bounded and a new project clears past and future edits", () => {
  const history = new EditHistory(2)
  for (let index = 0; index < 4; index++) history.record({ pages: [], index })
  assert.equal(history.past.length, 2)
  assert.equal(history.undo({ pages: [], index: 4 }).index, 3)
  history.clear()
  assert.equal(history.undo({ pages: [] }), null)
  assert.equal(history.redo({ pages: [] }), null)
})

test("resume skips completed pages and recomputes the suffix after a failure or changed glossary", () => {
  const settings = { source: "Japanese", target: "Vietnamese", notes: "", direction: "rtl", model: "auto", glossary: "先生 = thầy" }
  const signature = translationSignature(settings)
  const pages = ["done", "error", "done"].map((state) => ({ translationJob: { kind: "translate", signature, state } }))
  assert.deepEqual(remainingTranslations(pages, settings), pages.slice(1))
  pages[1].translationJob.state = "done"
  assert.deepEqual(remainingTranslations(pages, settings), [])
  assert.deepEqual(remainingTranslations(pages, { ...settings, glossary: "先生 = cô" }), pages)
  pages[1].translationJob.kind = "align"
  assert.deepEqual(remainingTranslations(pages, settings), pages.slice(1))
})

test("translation status and resume use the same effective notes as the provider", () => {
  const settings = { source: "Japanese", target: "Vietnamese", notes: "Use short dialogue", direction: "rtl", model: "auto", glossary: "" }
  const styled = { ...settings, skillPrompt: "Use period-appropriate pronouns." }
  const notes = translationNotes(styled)
  assert.equal(notes, "Use short dialogue\n\nUse period-appropriate pronouns.")
  assert.equal(translationSignature(styled), translationSignature({ ...settings, notes }))
  assert.equal(translationSignature({ ...settings, skillPrompt: "" }), translationSignature(settings))
  const pages = [{ translationJob: { kind: "translate", state: "done", signature: translationSignature(styled) } }]
  assert.equal(translationLabel(pages[0], styled), "Đã dịch")
  assert.deepEqual(remainingTranslations(pages, styled), [])
  assert.equal(translationLabel(pages[0], settings), "Thiết lập đã đổi")
  assert.deepEqual(remainingTranslations(pages, settings), pages)
})
