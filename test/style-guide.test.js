import assert from "node:assert/strict"
import test from "node:test"
import { readProject, writeProject } from "../src/project.js"
import { lintStyleGuide, normalizeStyleGuide, styleGuideFieldIds, styleGuideFields, styleGuidePrompt } from "../src/style-guide.js"
import { translationNotes, translationSignature } from "../src/translation.js"
import { createAgentTools } from "../src/agent-tools.js"

const guide = {
  register: "formal",
  pronouns: "Nhân vật chính xưng tớ/cậu",
  quotes: "curly",
  casing: "sentence",
  sfx: "translate",
  notes: "Không dùng từ lóng hiện đại",
}

test("normalizeStyleGuide canonicalizes known fields and drops the rest", () => {
  assert.equal(normalizeStyleGuide(null), null)
  assert.equal(normalizeStyleGuide(""), null)
  assert.equal(normalizeStyleGuide({}), null)
  assert.equal(normalizeStyleGuide("not json"), null)
  assert.equal(normalizeStyleGuide({ register: "bogus", pronouns: "  " }), null)
  assert.deepEqual(
    normalizeStyleGuide({ ...guide, unknown: "x", quotes: "curly", pronouns: "  a   b  " }),
    { ...guide, pronouns: "a b" },
  )
  assert.equal(normalizeStyleGuide(JSON.stringify(guide)).register, "formal")
})

test("normalizeStyleGuide strict mode rejects malformed guides for file validation", () => {
  assert.throws(() => normalizeStyleGuide({ register: "bogus" }, { strict: true }))
  assert.throws(() => normalizeStyleGuide({ pronouns: 42 }, { strict: true }))
  assert.throws(() => normalizeStyleGuide("[1,2]", { strict: true }))
  assert.equal(normalizeStyleGuide({}, { strict: true }), null)
})

test("normalizeStyleGuide clips text fields to their bounds", () => {
  const clean = normalizeStyleGuide({ pronouns: "x".repeat(900), notes: "y".repeat(5000) })
  assert.equal(clean.pronouns.length, 401) // 400 chars + ellipsis
  assert.equal(clean.notes.length, 1201)
})

test("styleGuidePrompt is bounded, deterministic and empty without a guide", () => {
  assert.equal(styleGuidePrompt(null), "")
  assert.equal(styleGuidePrompt({}), "")
  const prompt = styleGuidePrompt(guide)
  assert.match(prompt, /Quy tắc phong cách dịch của dự án/)
  assert.match(prompt, /Giọng điệu: Giọng điệu trang trọng/)
  assert.match(prompt, /Xưng hô và đại từ: Nhân vật chính xưng tớ\/cậu/)
  assert.match(prompt, /Dấu ngoặc kép: Dùng dấu ngoặc kép cong/)
  assert.match(prompt, /Cách viết hoa: Chỉ viết hoa/)
  assert.match(prompt, /Âm thanh \/ SFX: Luôn dịch/)
  assert.match(prompt, /Ghi chú: Không dùng từ lóng/)
  assert.equal(styleGuidePrompt(guide), prompt)
  assert.equal(styleGuidePrompt({ notes: "n".repeat(5000) }).length < 1600, true)
  // Field order in the prompt follows styleGuideFields, not input key order.
  const reordered = styleGuidePrompt({ notes: "ghi chú", register: "casual" })
  assert.ok(reordered.indexOf("Giọng điệu") < reordered.indexOf("Ghi chú"))
})

test("translationNotes injects the compiled guide so signatures track it", () => {
  const plain = translationNotes({ notes: "n", skillPrompt: "", styleGuide: null })
  assert.equal(plain, "n")
  const withGuide = translationNotes({ notes: "n", skillPrompt: "", styleGuide: guide })
  assert.match(withGuide, /^n\n\nQuy tắc phong cách/)
  const base = { source: "Japanese", target: "Vietnamese", notes: "n", direction: "rtl", model: "auto", glossary: "" }
  assert.notEqual(translationSignature({ ...base, styleGuide: guide }), translationSignature(base))
})

test("project file round-trips the style guide and stays backwards compatible", async () => {
  const base = {
    pages: [{
      file: new File([Uint8Array.of(1)], "trang.png"),
      name: "trang.png",
      boxes: [],
      unplaced: [],
    }],
    queue: [],
    settings: {
      "script-text": "", direction: "rtl", "gemini-model": "auto",
      "source-language": "Japanese", "target-language": "Vietnamese",
      "translation-notes": "", "translation-glossary": "",
    },
    currentPage: 0,
    fit: true,
  }
  const opened = await readProject(writeProject({ ...base, styleGuide: guide }))
  assert.deepEqual(opened.styleGuide, guide)
  const legacy = await readProject(writeProject(base))
  assert.equal(legacy.styleGuide, undefined)
  assert.throws(() => writeProject({ ...base, styleGuide: { register: "bogus" } }))
})

const lintPages = (texts) => [{
  name: "trang-1.png",
  boxes: texts.map((text, i) => ({ id: "b" + (i + 1), text })),
}]

test("lintStyleGuide reports quote, casing and SFX violations with page and box", () => {
  const qa = lintStyleGuide(lintPages([
    'Cô ấy nói "đi ngay".',       // straight quotes vs curly rule
    "ĐỪNG ĐI VỘI QUÁ!",          // all-caps words vs sentence casing
    "BÙm!!!",                    // SFX left in place vs translate rule
    "Câu bình thường, ổn.",      // clean
  ]), { quotes: "curly", casing: "sentence", sfx: "translate" })
  assert.equal(qa.total, 3)
  assert.equal(qa.byType.quote_style, 1)
  assert.equal(qa.byType.casing, 1)
  assert.equal(qa.byType.sfx, 1)
  for (const issue of qa.issues) {
    assert.equal(issue.pageIndex, 1)
    assert.equal(issue.pageName, "trang-1.png")
    assert.equal(issue.severity, "warning")
  }
  assert.deepEqual(qa.issues.map((i) => i.boxId), ["b1", "b2", "b3"])
})

test("lintStyleGuide respects keep policy, title casing and empty guides", () => {
  const pages = lintPages(["BÙM!", "Đi nào!"])
  assert.equal(lintStyleGuide(pages, { sfx: "keep" }).total, 0)
  assert.equal(lintStyleGuide(pages, null).total, 0)
  const title = lintStyleGuide(lintPages(["đi nào ngay", "Đi Nào Ngay"]), { casing: "title" })
  assert.equal(title.byType.casing, 1)
  assert.equal(title.issues[0].boxId, "b1")
  const drop = lintStyleGuide(lintPages(["RẦM!", "Đi thôi!"]), { sfx: "drop" })
  assert.equal(drop.byType.sfx, 1)
  assert.equal(drop.issues[0].boxId, "b1")
})

test("check_style_guide tool lints pages 0-token and reports when no guide exists", async () => {
  const state = {
    pages: [{
      id: "p1",
      name: "trang-1.png",
      boxes: [{ id: "b1", text: "BÙM!!!" }],
      unplaced: [],
    }],
    queue: [],
    presets: [],
  }
  const tools = createAgentTools({
    state,
    byId: () => ({ value: "" }),
    selectedPage: () => state.pages[0],
    selectedIndex: () => 0,
    selectPage: () => {},
    checkpoint: () => {},
    render: () => {},
    readTranslationSettings: () => ({ styleGuide: { sfx: "translate", quotes: "curly" } }),
  })
  const result = await tools.execute("check_style_guide", {})
  assert.equal(result.ok, true)
  assert.equal(result.data.active, true)
  assert.equal(result.data.total, 1)
  assert.equal(result.data.issues[0].boxId, "b1")
  const scoped = await tools.execute("check_style_guide", { pageIndex: 1 })
  assert.equal(scoped.data.total, 1)

  const empty = createAgentTools({
    state,
    byId: () => ({ value: "" }),
    selectedPage: () => state.pages[0],
    selectedIndex: () => 0,
    selectPage: () => {},
    checkpoint: () => {},
    render: () => {},
    readTranslationSettings: () => ({}),
  })
  const inactive = await empty.execute("check_style_guide", {})
  assert.equal(inactive.data.active, false)
  assert.equal(inactive.data.total, 0)
})

test("styleGuideFields covers the documented guide dimensions", () => {
  assert.deepEqual(styleGuideFieldIds, ["register", "pronouns", "quotes", "casing", "sfx", "notes"])
  for (const id of styleGuideFieldIds) {
    assert.ok(styleGuideFields.some((field) => field.id === id))
  }
})
