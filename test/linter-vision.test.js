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
