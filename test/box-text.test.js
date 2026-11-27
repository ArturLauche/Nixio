import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { applyBoxText, boxLabel, boxTextError } from "../src/box-text.js"
import { copyEditor } from "../src/history.js"

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8")

// The path the reproducer takes: clearing the field, then selecting another box. The inspector
// writes box.text back into the field, so an empty box can only stay empty if the box itself is
// empty.
function clearAndReselect(box) {
  applyBoxText(box, "")
  const field = { value: "Chữ cũ" }
  field.value = box.text
  return field.value
}

test("clearing the field clears the box instead of resurrecting the old line (#100)", () => {
  const box = { id: "a", text: "Chữ cũ" }
  assert.equal(clearAndReselect(box), "")
  assert.equal(box.text, "")
})

test("a cleared box does not come back when another box is selected (#100)", () => {
  const cleared = { id: "a", text: "Chữ cũ" }
  const other = { id: "b", text: "Thoại khác" }
  applyBoxText(cleared, "")
  // Selecting b refills the field from b, and selecting a again refills it from a.
  assert.equal(other.text, "Thoại khác")
  const field = { value: other.text }
  assert.equal(field.value, "Thoại khác")
  field.value = cleared.text
  assert.equal(field.value, "")
})

test("the text is trimmed but never conditionally skipped (#100)", () => {
  const box = { text: "cũ" }
  applyBoxText(box, "  Xin chào  ")
  assert.equal(box.text, "Xin chào")
  applyBoxText(box, "   ")
  assert.equal(box.text, "")
  applyBoxText(box, undefined)
  assert.equal(box.text, "")
})

test("the pre-edit snapshot still holds the old line, so undo can restore it (#100)", () => {
  const page = { id: "p", name: "p", boxes: [{ id: "a", text: "Chữ cũ" }] }
  const snapshot = copyEditor({ pages: [page], queue: [] })
  applyBoxText(page.boxes[0], "")
  assert.equal(page.boxes[0].text, "")
  assert.equal(snapshot.pages[0].boxes[0].text, "Chữ cũ")
})

test("only the explicit save refuses an empty field, and the box list still names the empty box (#100)", () => {
  assert.equal(boxTextError("Xin chào"), "")
  assert.equal(boxTextError("  Xin chào  "), "")
  assert.equal(boxTextError(""), "Hãy nhập nội dung khung.")
  assert.equal(boxTextError("   "), "Hãy nhập nội dung khung.")
  assert.equal(boxTextError(undefined), "Hãy nhập nội dung khung.")

  assert.equal(boxLabel({ text: " Xin chào " }), "Xin chào")
  assert.equal(boxLabel({ text: "" }), "Khung trống")
  assert.equal(boxLabel({ text: "   " }), "Khung trống")
  assert.equal(boxLabel({}), "Khung trống")
})

test("the editor saves the emptied text and explains a rejected save next to the field (#100)", () => {
  assert.match(main, /applyBoxText\(box, text\)/)
  assert.doesNotMatch(main, /if \(trimmed\) box\.text = trimmed/)
  assert.match(main, /const error = boxTextError\(byId\("box-text"\)\.value\)/)
  assert.match(main, /byId\("box-text"\)\.focus\(\)/)
  assert.match(markup, /id="box-text-error" class="field-error" role="alert"/)
  assert.match(markup, /<textarea id="box-text" rows="3"><\/textarea>/)
  assert.match(css, /\.field-error:empty \{ display: none; \}/)
})
