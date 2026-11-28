import assert from "node:assert/strict"
import test from "node:test"
import { autoFixPunctuation, lintChapter, parseGlossary } from "../src/linter.js"
import { pruneOldToolResults } from "../src/agent-context.js"
import { createAgentTools } from "../src/agent-tools.js"
import { runAgentTurn } from "../src/agent-harness.js"

test("parseGlossary and lintChapter detect untranslated source, glossary drift, placeholders, and punctuation", () => {
  const glossary = [
    "# Character names",
    "五条悟 = Gojo Satoru",
    "領域展開 -> Lãnh Địa Triển Khai",
    "Sensei : Sư phụ",
  ].join("\n")

  const entries = parseGlossary(glossary)
  assert.equal(entries.length, 3)

  const pages = [
    {
      id: "p1",
      name: "01.png",
      boxes: [
        { id: "b1", text: "こんにちは mọi người" },
        { id: "b2", text: "Đây là gojo satoru và Sensei!" },
        { id: "b3", text: "Thoại 3" },
        { id: "b4", text: "Chào bạn  , đi thôi...." },
        { id: "b5", text: "Gojo Satoru dùng Lãnh Địa Triển Khai!" },
      ],
    },
  ]

  const qa = lintChapter(pages, {
    glossaryText: glossary,
    sourceLanguage: "Japanese",
    targetLanguage: "Vietnamese",
  })
  assert.equal(qa.byType.untranslated_source, 1)
  assert.equal(qa.byType.glossary_violation, 1)
  assert.equal(qa.byType.empty_or_placeholder, 1)
  assert.equal(qa.byType.punctuation_spacing, 1)
  assert.equal(qa.total, 4)

  assert.equal(autoFixPunctuation("Chào bạn  , đi thôi...."), "Chào bạn, đi thôi...")
})

test("English source left untranslated is reported without flagging target text, names or noises", () => {
  const lint = (text, options = {}, sourceText) => lintChapter(
    [{ id: "p1", name: "01.png", boxes: [{ id: "b1", text, ...(sourceText === undefined ? {} : { source: sourceText }) }] }],
    { sourceLanguage: "English", targetLanguage: "Vietnamese", ...options },
  )
  const leaks = (text, options, sourceText) => lint(text, options, sourceText).byType.untranslated_source

  for (const text of [
    "Hello everyone",
    "Hello everyone!",
    "Where are you going?",
    "Thank you very much.",
    "I don't know what you are talking about.",
    "Gojo Satoru is the strongest.",
    "Good morning, everyone.",
    "Is this the real world?",
  ]) {
    assert.equal(leaks(text), 1, text)
  }

  const reported = lint("Hello everyone")
  assert.equal(reported.total, 1)
  assert.deepEqual(reported.byType, {
    untranslated_source: 1,
    glossary_violation: 0,
    empty_or_placeholder: 0,
    punctuation_spacing: 0,
  })
  assert.deepEqual(
    Object.keys(reported.issues[0]),
    // The stamp of the box text travels with the finding so a decision cannot follow its position
    // onto whatever box takes it after a delete.
    ["type", "severity", "pageIndex", "boxIndex", "pageName", "boxId", "snippet", "message", "boxStamp", "id"],
  )
  assert.equal(reported.issues[0].id, "1:0:untranslated_source")
  assert.match(reported.issues[0].boxStamp, /^[0-9a-f]{8}$/)
  // Two different lines never share a stamp, so a decision cannot slide onto the next box.
  assert.notEqual(lint("Hello everyone").issues[0].boxStamp, lint("Hello everyone!").issues[0].boxStamp)
  assert.equal(reported.issues[0].snippet, "Hello everyone")
  assert.match(reported.issues[0].message, /^Còn sót câu tiếng Anh chưa dịch trong "Hello everyone"\.$/)

  for (const [text, why] of [
    ["Mọi người ơi, đi thôi!", "accented Vietnamese"],
    ["Hello everyone, café".normalize("NFD"), "decomposed Latin accents"],
    ["Anh ấy đã đi rồi.", "accented Vietnamese"],
    ["Xin chào", "accented Vietnamese"],
    ["Toi khong biet gi ca", "diacritic-free Vietnamese"],
    ["Gojo Satoru", "proper names only"],
    ["Project Nixio", "proper names only"],
    ["Sensei", "loan word"],
    ["OK", "shared expression"],
    ["OK, guitar và pizza", "shared words inside Vietnamese"],
    ["Ah!", "short noise"],
    ["Huh?", "short noise"],
    ["Kyaa!", "short noise"],
    ["Hmph", "short noise"],
    ["Hey!", "short noise"],
    ["Tch", "short noise"],
    ["ｱﾘｶﾞﾄｳ", "source script, not English"],
  ]) {
    assert.equal(leaks(text), 0, `${why}: ${text}`)
  }

  // The box's own source text is the reliable identity: an unchanged running line is
  // reported even without English markers, while a kept proper-noun line is not.
  assert.equal(leaks("Satoru, open the gate.", {}, "Satoru, open the gate."), 1)
  assert.equal(leaks("Gojo Satoru", {}, "Gojo Satoru"), 0)
  assert.equal(leaks("Mistral Vibe", {}, "Mistral Vibe"), 0)
  assert.equal(leaks("Satoru, open the gate.", {}, "Satoru, mở cổng."), 0)

  // English to English never flags, and the English profile never leaks into other pairs.
  assert.equal(leaks("Hello everyone", { targetLanguage: "English" }), 0)
  assert.equal(leaks("Where are you going?", { targetLanguage: "English" }), 0)
  assert.equal(leaks("Hello everyone", { sourceLanguage: "Japanese" }), 0)
  assert.equal(leaks("Hello everyone", { sourceLanguage: "Chinese" }), 0)
})

test("glossary casing QA ignores sentence-initial capitals but keeps proper-noun and accent drift", () => {
  const lint = (text, glossaryText) => lintChapter(
    [{ id: "p1", name: "01.png", boxes: [{ id: "b1", text }] }],
    { glossaryText, sourceLanguage: "Japanese", targetLanguage: "Vietnamese" },
  )
  const violations = (text, glossaryText) => lint(text, glossaryText).byType.glossary_violation

  // Reported on #29: "Đi thôi" is capitalised only because it heads a sentence, so an
  // ordinary lower-case occurrence in running text is correct Vietnamese.
  const phrasal = "行こう = Đi thôi"
  for (const text of ["Anh ấy đi thôi", "Đi thôi!", "anh ấy đi thôi", "ANH ẤY ĐI THÔI"]) {
    assert.equal(violations(text, phrasal), 0, text)
  }

  // Dropping the accents is still drift, whichever position the term sits in.
  for (const text of ["Anh ay di thoi", "Anh ấy di thoi", "Anh ấy đi thoi"]) {
    assert.equal(violations(text, phrasal), 1, text)
  }
  // Only the term's own accents are checked, so a neighbour losing its accents is not
  // attributed to this entry.
  assert.equal(violations("Anh ay đi thôi", phrasal), 0)
  const accentIssue = lint("Anh ay di thoi", phrasal).issues[0]
  assert.match(accentIssue.message, /^Thuật ngữ "Đi thôi" bị mất dấu trong "Anh ay di thoi"\.$/)
  assert.equal(accentIssue.suggestion, "Đi thôi")

  // Explicit proper nouns and terms keep their explanatory casing QA.
  const terms = "五条悟 = Gojo Satoru\n領域展開 = Lãnh Địa Triển Khai\n先生 = Thầy"
  assert.equal(violations("Đây là gojo satoru.", terms), 1)
  assert.equal(violations("gojo satoru xuất hiện.", terms), 1)
  assert.equal(violations("Đây là Gojo Satoru.", terms), 0)
  assert.equal(violations("Gojo Satoru dùng lãnh địa triển khai", terms), 1)
  assert.equal(violations("Gojo Satoru dùng Lãnh Địa Triển Khai!", terms), 0)
  assert.equal(violations("Gojo Satoru dùng Lãnh Địa Triển Khai!".normalize("NFD"), terms), 0)
  assert.equal(violations("Gojo Satoru dung lanh dia trien khai", terms), 1)

  // A single-word target cannot separate a capital from a sentence start, so only its
  // accents are checked — the glossary check is narrowed, not removed.
  assert.equal(violations("Thầy ơi!", terms), 0)
  assert.equal(violations("Tôi gặp thầy.", terms), 0)
  assert.equal(violations("Tôi gặp thay.", terms), 1)

  // The source-side term check is untouched.
  assert.equal(violations("Đây là Gojo và Sensei!", "Sensei : Sư phụ"), 1)
})

test("script detection covers half-width katakana and compatibility jamo without widening to target scripts", () => {
  const leaks = (text, sourceLanguage, targetLanguage = "Vietnamese") => lintChapter(
    [{ id: "p1", name: "01.png", boxes: [{ id: "b1", text }] }],
    { sourceLanguage, targetLanguage },
  ).byType.untranslated_source

  // Half-width katakana U+FF66–FF9F and compatibility/extended jamo are the forms OCR and
  // copy-paste leave behind, so they count as untranslated source text.
  for (const text of ["\uFF71\uFF98\uFF76\uFF9E\uFF84\uFF73", "\uFF66", "\uFF8A\uFF9F", "\uFF9E", "\uFF9F"]) {
    assert.equal(leaks(text, "Japanese"), 1, JSON.stringify(text))
    assert.equal(leaks(text, "Japanese", "English"), 1, JSON.stringify(text))
  }
  for (const text of [
    "\u314B\u314B\u314B", "\u314E\u314E", "\u3131", "\u318F",
    "\uA960", "\uA97F", "\uD7B0", "\uD7FF", "\uFFA1", "\uFFDC",
  ]) {
    assert.equal(leaks(text, "Korean"), 1, JSON.stringify(text))
  }

  // Blocks just outside each widened range stay unmatched.
  for (const text of ["\uFF65", "\uFF5E", "\uFF61", "\uFFA0"]) {
    assert.equal(leaks(text, "Japanese"), 0, `${JSON.stringify(text)} must not read as Japanese`)
  }
  for (const text of ["\uFF5E", "\uFF61"]) {
    assert.equal(leaks(text, "Korean"), 0, `${JSON.stringify(text)} must not read as Korean`)
  }

  // The widened Japanese and Korean ranges still exclude each other and the target script.
  assert.equal(leaks("\uFF71\uFF98", "Korean"), 0)
  assert.equal(leaks("\u314B\u314B", "Japanese"), 0)
  assert.equal(leaks("\uFF71\uFF98", "Chinese"), 0)
  assert.equal(leaks("\u314B\u314B", "Chinese"), 0)
  for (const source of ["Japanese", "Korean", "Chinese"]) {
    assert.equal(leaks("Đi thôi", source), 0, `${source} must not flag Vietnamese`)
    assert.equal(leaks("\uFF28\uFF45\uFF4C\uFF4C\uFF4F", source), 0, `${source} must not flag full-width Latin`)
    assert.equal(leaks("Hello", source), 0, `${source} must not flag ASCII`)
  }

  // Chinese keeps its own range and still matches ordinary Han text.
  assert.equal(leaks("\u4E2D\u6587", "Chinese"), 1)
  assert.equal(leaks("\u3042", "Chinese"), 0)
  assert.equal(leaks("\uAC00", "Chinese"), 0)
})

test("inspect_page_image attaches multimodal images for Gemini & OpenAI and prunes old images", async (t) => {
  const state = {
    pages: [
      {
        id: "p1",
        name: "01.png",
        image: { naturalWidth: 800, naturalHeight: 1200 },
        boxes: [{ id: "b1", text: "Đi thôi!", x: 0.2, y: 0.2, w: 0.3, h: 0.15 }],
        unplaced: [],
      },
    ],
    queue: [],
    presets: [],
  }
  const tools = createAgentTools({
    state,
    byId: () => ({ value: "", dispatchEvent() {} }),
    selectedPage: () => state.pages[0],
    selectedIndex: () => 0,
    selectPage: () => {},
    checkpoint: () => {},
    render: () => {},
    readTranslationSettings: () => ({ source: "Japanese", target: "Vietnamese", direction: "rtl", glossary: "五条 = Gojo" }),
    capturePageImageFn: async (_page, { box }) => ({
      mimeType: "image/jpeg",
      base64: "FAKEBASE64DATA",
      width: box ? 320 : 512,
      height: box ? 240 : 768,
      cropped: Boolean(box),
    }),
  })

  // Test lint_chapter_qa tool directly
  const lintRes = await tools.execute("lint_chapter_qa", {})
  assert.equal(lintRes.ok, true)
  assert.equal(lintRes.data.total, 0)

  // Test inspect_page_image with Gemini
  const originalFetch = globalThis.fetch
  const capturedBodies = []
  let step = 0
  globalThis.fetch = async (url, opts) => {
    step++
    capturedBodies.push({ url, body: JSON.parse(opts.body) })
    if (url.includes("generativelanguage")) {
      if (step === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{ functionCall: { name: "inspect_page_image", args: { boxId: "b1" } } }],
              },
            }],
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Nhân vật đang cười tự tin, nên dùng đại từ cậu/tớ." }] } }],
        }),
      }
    }
    // OpenAI-compatible path
    if (step === 3) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: "call_img", type: "function", function: { name: "inspect_page_image", arguments: "{}" } }],
            },
          }],
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Đã quan sát toàn trang." } }],
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const gemEvents = []
  const gemRes = await runAgentTurn({
    userMessage: "Xem biểu cảm khung b1",
    settings: { provider: "gemini", key: "k", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese" },
    tools,
    onEvent: (e) => gemEvents.push(e),
  })
  assert.ok(gemRes.answer.includes("cậu/tớ"))
  // Verify Gemini step 2 received inlineData with FAKEBASE64DATA
  const gemTurn2Parts = capturedBodies[1].body.contents.at(-1).parts
  assert.ok(gemTurn2Parts.some((p) => p.inlineData?.data === "FAKEBASE64DATA"))
  // Verify UI tool_end event omitted raw base64 attachment
  const toolEndEvent = gemEvents.find((e) => e.type === "tool_end" && e.name === "inspect_page_image")
  assert.equal(toolEndEvent.hasAttachment, true)
  assert.equal(toolEndEvent.attachment, undefined)

  // Test inspect_page_image with OpenAI-compatible
  const oaiRes = await runAgentTurn({
    userMessage: "Xem toàn trang 1",
    settings: { provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "gpt-4o-mini", source: "Japanese", target: "Vietnamese" },
    tools,
  })
  assert.ok(oaiRes.answer.includes("toàn trang"))
  const oaiMessages = capturedBodies[3].body.messages
  assert.ok(
    oaiMessages.some(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url" && p.image_url.url.includes("FAKEBASE64DATA")),
    ),
  )

  // Verify pruneOldToolResults strips old image attachments
  const oldOaiThread = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
    { role: "assistant", content: "done" },
  ]
  const pruned = pruneOldToolResults(oldOaiThread, { provider: "openai" })
  assert.equal(pruned.prunedCount, 1)
  assert.equal(typeof oldOaiThread[1].content, "string")
})
