import assert from "node:assert/strict"
import test from "node:test"
import {
  extractParagraphText,
  extractSpreadsheetText,
  groupDialogue,
  imageMimeType,
  isImageFile,
} from "../src/io.js"

const el = (localName, children = [], textContent = "") => ({ localName, childNodes: children, textContent })

test("imageMimeType and isImageFile normalize MIME parameters and infer from extensions", () => {
  assert.equal(imageMimeType("01.jpg", ""), "image/jpeg")
  assert.equal(imageMimeType("01.WEBP", ""), "image/webp")
  assert.equal(imageMimeType("/cdn/img?id=1", "image/png; charset=binary"), "image/png")
  assert.equal(imageMimeType("/cdn/img?id=1", "IMAGE/JPEG; charset=utf-8"), "image/jpeg")
  assert.equal(imageMimeType("notes.txt", "application/octet-stream"), null)

  assert.equal(isImageFile({ name: "01.png", type: "image/png; charset=binary" }), true)
  assert.equal(isImageFile({ name: "01.jpg", type: "" }), true)
  assert.equal(isImageFile({ name: "01.gif", type: "image/gif" }), false)
})

test("extractSpreadsheetText ignores phonetic rPh runs in shared strings", () => {
  const sharedString = el("si", [
    el("r", [el("t", [], "漢字")]),
    el("r", [el("t", [], "テスト")]),
    el("rPh", [el("t", [], "かんじ")]),
  ])
  assert.equal(extractSpreadsheetText(sharedString), "漢字テスト")
})

test("extractParagraphText preserves DOCX line breaks and tabs while skipping deletions and ruby text", () => {
  const paragraph = el("p", [
    el("r", [el("t", [], "Trang 1"), el("br"), el("t", [], "Xin"), el("tab"), el("t", [], "chào")]),
    el("del", [el("r", [el("t", [], "bỏ đi")])]),
    el("r", [el("ruby", [
      el("rt", [el("r", [el("t", [], "furigana")])]),
      el("rubyBase", [el("r", [el("t", [], "!")])]),
    ])]),
  ])
  assert.equal(extractParagraphText(paragraph), "Trang 1\nXin chào!")
})

test("groupDialogue trims whitespace inside bracketed page headings", () => {
  const groups = groupDialogue("[ Trang 2 ]\nCâu một\n[ 03.png ]\nCâu hai")
  assert.deepEqual(groups, [
    { reference: 1, lines: ["Câu một"] },
    { reference: "03.png", lines: ["Câu hai"] },
  ])
})
