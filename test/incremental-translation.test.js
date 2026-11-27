import assert from "node:assert/strict"
import test from "node:test"
import {
  applyBoxTranslations,
  boxFingerprint,
  citedGlossary,
  resumePending,
  resumeWork,
  staleBoxes,
} from "../src/incremental-translation.js"
import { translationSignature } from "../src/translation.js"

function settings(overrides = {}) {
  return {
    provider: "gemini",
    model: "auto",
    baseUrl: "",
    llmModel: "",
    source: "Japanese",
    target: "Vietnamese",
    notes: "",
    direction: "rtl",
    glossary: "",
    ...overrides,
  }
}

function makeBox(id, text, overrides = {}) {
  return {
    id,
    x: .1,
    y: .2,
    w: .3,
    h: .1,
    text,
    size: 24,
    font: "Arial",
    color: "#171717",
    align: "center",
    rotation: 0,
    fill: true,
    ...overrides,
  }
}

function makePage(boxes, name = "trang-1.png", overrides = {}) {
  return {
    name,
    file: { name, size: 24, type: "image/png" },
    boxes,
    ...overrides,
  }
}

// Stands in for a provider answer: every box the caller decided to send comes back translated.
function translate(page, lines, config) {
  const boxes = page.boxes.filter((box) => lines[box.id] !== undefined)
  const translated = boxes.map((box) => ({ boxId: box.id, source: box.text, text: lines[box.id] }))
  return applyBoxTranslations(page, boxes, translated, config)
}

test("a box without a stamp is stale, so a project with no fingerprints runs a full pass", () => {
  const config = settings({ glossary: "先生 = thầy" })
  const page = makePage([makeBox("a", "先生、元気ですか"), makeBox("b", "五条悟だ")])
  assert.deepEqual(staleBoxes(page, config).map(({ id }) => id), ["a", "b"])
  assert.deepEqual(staleBoxes(makePage([makeBox("c", "   ")]), config), [])
})

test("a finished run stamps what it wrote, keeps other lines and converges on the next press", () => {
  const config = settings()
  const page = makePage([makeBox("a", "おはよう"), makeBox("b", "またね")])
  const applied = translate(page, { a: "Chào buổi sáng", b: "Hẹn gặp lại" }, config)
  assert.deepEqual(applied, { updated: 2, kept: 0 })
  assert.equal(page.boxes[0].text, "Chào buổi sáng")
  assert.equal(page.boxes[1].text, "Hẹn gặp lại")
  assert.deepEqual(staleBoxes(page, config), [])
  assert.deepEqual(translate(page, {}, config), { updated: 0, kept: 2 })
  assert.equal(page.boxes[0].text, "Chào buổi sáng")
})

test("editing one line re-sends that box only and leaves the other translations alone", () => {
  const config = settings()
  const page = makePage([makeBox("a", "おはよう"), makeBox("b", "またね")])
  translate(page, { a: "Chào buổi sáng", b: "Hẹn gặp lại" }, config)
  const untouched = { ...page.boxes[1] }
  page.boxes[0].text = "Chào buổi sáng, senpai"
  assert.deepEqual(staleBoxes(page, config).map(({ id }) => id), ["a"])
  const applied = translate(page, { a: "Chào buổi sáng, đàn anh" }, config)
  assert.deepEqual(applied, { updated: 1, kept: 1 })
  assert.equal(page.boxes[0].text, "Chào buổi sáng, đàn anh")
  assert.deepEqual(page.boxes[1], untouched)
  assert.deepEqual(staleBoxes(page, config), [])
})

test("style, geometry, target language and notes each make a translated box stale again", () => {
  const config = settings()
  const cases = [
    ["size", { size: 30 }, config],
    ["font", { font: "Georgia" }, config],
    ["position", { x: .14 }, config],
    ["size of the box", { w: .4 }, config],
    ["target language", {}, settings({ target: "English" })],
    ["notes", {}, settings({ notes: "Giữ nguyên tên riêng" })],
    ["model", {}, settings({ model: "gemini-3.5-flash-lite" })],
  ]
  for (const [label, overrides, otherSettings] of cases) {
    const page = makePage([makeBox("a", "おはよう")])
    translate(page, { a: "Chào buổi sáng" }, config)
    assert.deepEqual(staleBoxes(page, config), [], label)
    Object.assign(page.boxes[0], overrides)
    assert.deepEqual(staleBoxes(page, otherSettings).map(({ id }) => id), ["a"], label)
  }
})

test("fields the provider never sees do not disturb the stamp", () => {
  const config = settings()
  const plain = makeBox("a", "おはよう")
  const decorated = makeBox("a", "おはよう", {
    bold: false,
    italic: false,
    warp: "wave",
    warpAmount: 0,
    lineHeight: 1.15,
    cleanup: true,
    cleanupMode: "content-aware",
    cleanupExpand: -2,
    cleanupStrokes: [{ mode: "erase", size: .05, points: [{ x: .2, y: .3 }] }],
    originalBox: { x: .05, y: .15, w: .4, h: .2 },
  })
  const page = makePage([plain])
  assert.equal(boxFingerprint(plain, config, page), boxFingerprint(decorated, config, page))
  plain.cleanupStrokes = [{ mode: "erase", size: .2, points: [{ x: .3, y: .4 }] }]
  assert.equal(boxFingerprint(plain, config, page), boxFingerprint(decorated, config, page))
  plain.bold = true
  assert.notEqual(boxFingerprint(plain, config, page), boxFingerprint(decorated, config, page))
})

test("a glossary edit invalidates the boxes that cite the term and nothing else", () => {
  const base = settings({ glossary: "先生 = thầy\n五条悟 = Gojo Satoru\n元気 = khỏe" })
  const page = makePage([
    makeBox("a", "先生、元気ですか"),
    makeBox("b", "五条悟だ"),
    makeBox("c", "雨が降る"),
  ])
  translate(page, { a: "Thầy ơi, khỏe không?", b: "Gojo Satoru đây", c: "Trời mưa" }, base)
  assert.deepEqual(staleBoxes(page, base), [])
  assert.deepEqual(citedGlossary(base.glossary, page.boxes[0].translationStamp.source), [
    ["元気", "khỏe"],
    ["先生", "thầy"],
  ])
  const changedTerm = settings({ glossary: "先生 = thầy giáo\n五条悟 = Gojo Satoru\n元気 = khỏe" })
  assert.deepEqual(staleBoxes(page, changedTerm).map(({ id }) => id), ["a"])
  const renamedCharacter = settings({ glossary: "先生 = thầy\n五条悟 = Satoru\n元気 = khỏe" })
  assert.deepEqual(staleBoxes(page, renamedCharacter).map(({ id }) => id), ["b"])
  const unrelated = settings({ glossary: "先生 = thầy\n五条悟 = Gojo Satoru\n元気 = khỏe\n悪魔 = ác quỷ" })
  assert.deepEqual(staleBoxes(page, unrelated), [])
  const removedTerm = settings({ glossary: "五条悟 = Gojo Satoru\n元気 = khỏe" })
  assert.deepEqual(staleBoxes(page, removedTerm).map(({ id }) => id), ["a"])
})

test("replacing a page image invalidates that page and leaves the rest alone", () => {
  const config = settings()
  const first = makePage([makeBox("a", "おはよう")], "trang-1.png")
  const second = makePage([makeBox("b", "またね")], "trang-2.png")
  translate(first, { a: "Chào buổi sáng" }, config)
  translate(second, { b: "Hẹn gặp lại" }, config)
  assert.deepEqual(staleBoxes(first, config), [])
  assert.deepEqual(staleBoxes(second, config), [])
  second.name = "trang 2"
  second.file = { name: "trang-2-sua.png", size: 24, type: "image/png" }
  assert.deepEqual(staleBoxes(second, config).map(({ id }) => id), ["b"])
  assert.deepEqual(staleBoxes(first, config), [])
  second.file = { name: "trang-2.png", size: 99, type: "image/png" }
  assert.deepEqual(staleBoxes(second, config).map(({ id }) => id), ["b"])
})

test("resume reads unfinished pages again and only patches the boxes that drifted", () => {
  const base = settings()
  const settled = translationSignature(base)
  const done = () => ({ kind: "translate", signature: settled, state: "done" })
  const stamped = (id, text, lines) => {
    const page = makePage([makeBox(id, text)], id + ".png")
    translate(page, lines, base)
    return page
  }
  const finished = { ...stamped("p1", "おはよう", { p1: "Chào buổi sáng" }), translationJob: done() }
  const edited = { ...stamped("p2", "またね", { p2: "Hẹn gặp lại" }), translationJob: done() }
  edited.boxes[0].text = "Hẹn gặp lại nhé"
  const failed = { ...stamped("p3", "雨だ", { p3: "Trời mưa" }), translationJob: { ...done(), state: "error", error: "Lỗi mạng" } }
  const fresh = makePage([makeBox("p4", "風だ")], "p4.png")
  const unstamped = { ...makePage([makeBox("p5", "空だ")], "p5.png"), translationJob: done() }
  const pages = [finished, edited, failed, fresh, unstamped]
  const work = resumeWork(pages, base)
  assert.deepEqual(work.full.map(({ name }) => name), ["p3.png", "p4.png"])
  assert.deepEqual(work.delta.map(({ name }) => name), ["p2.png"])
  assert.deepEqual(resumeWork([finished, unstamped], base), { full: [], delta: [] })
})

test("a glossary change resumes as a box pass instead of a chapter OCR pass", () => {
  const base = settings({ glossary: "先生 = thầy" })
  const page = makePage([makeBox("a", "先生、元気ですか"), makeBox("b", "雨だ")], "p1.png", {
    translationJob: { kind: "translate", signature: translationSignature(base), state: "done" },
  })
  translate(page, { a: "Thầy ơi, khỏe không?", b: "Trời mưa" }, base)
  const changed = settings({ glossary: "先生 = thầy giáo" })
  const work = resumeWork([page], changed)
  assert.deepEqual(work.full, [])
  assert.deepEqual(work.delta, [page])
  assert.deepEqual(staleBoxes(page, changed).map(({ id }) => id), ["a"])
})

test("a project without fingerprints anywhere falls back to the page contract", () => {
  const base = settings()
  const pages = [1, 2, 3].map((index) => ({
    ...makePage([makeBox("b" + index, "おはよう")], "p" + index + ".png"),
    translationJob: { kind: "translate", signature: translationSignature(base), state: "done" },
  }))
  assert.deepEqual(resumeWork(pages, base), { full: [], delta: [] })
  const changed = settings({ glossary: "先生 = thầy" })
  assert.deepEqual(resumeWork(pages, changed).full, pages)
  pages[1].translationJob.state = "pending"
  assert.deepEqual(resumeWork(pages, base).full, [pages[1], pages[2]])
})

test("the resume button follows the same work the resume run would find", () => {
  const base = settings()
  const signature = translationSignature(base)
  const page = makePage([makeBox("a", "おはよう")], "p1.png", {
    translationJob: { kind: "translate", signature, state: "done" },
  })
  assert.equal(resumePending([page], base), false)
  translate(page, { a: "Chào buổi sáng" }, base)
  assert.equal(resumePending([page], base), false)
  page.boxes[0].text = "Chào buổi sáng nhé"
  assert.equal(resumePending([page], base), true)
  assert.equal(resumePending([page], settings({ glossary: "先生 = thầy" })), true)
  assert.equal(resumePending([{ ...page, translationJob: { kind: "translate", signature, state: "error" } }], base), true)
  assert.equal(resumePending([], base), false)
})

test("the digest follows the writing direction, like the job signature does (#review)", () => {
  const page = makePage([makeBox("a", "おはよう")])
  const box = page.boxes[0]
  const rtl = settings({ direction: "rtl" })
  const ltr = settings({ direction: "ltr" })
  assert.notEqual(boxFingerprint(box, rtl, page), boxFingerprint(box, ltr, page))
  // and a direction change is a real reason to send the box again
  translate(page, { a: "Chào buổi sáng" }, rtl)
  assert.deepEqual(staleBoxes(page, rtl), [])
  assert.deepEqual(staleBoxes(page, ltr).map(({ id }) => id), ["a"])
})

test("kept counts the boxes that were not written, not the ones the memory answered (#review)", () => {
  const config = settings()
  const page = makePage([makeBox("a", "おはよう"), makeBox("b", "またね"), makeBox("c", "五条悟だ")])
  // The memory answered "a" and the provider answered "b": only "c" still holds its old text.
  const applied = applyBoxTranslations(page, [page.boxes[1]], [{ boxId: "b", source: "またね", text: "Hẹn gặp lại" }], config, { reused: 1 })
  assert.deepEqual(applied, { updated: 1, kept: 1 })
  // A box the provider did not answer is kept too, so the count never goes negative.
  assert.deepEqual(
    applyBoxTranslations(page, [page.boxes[2]], [], config, { reused: 2 }),
    { updated: 0, kept: 1 },
  )
})
