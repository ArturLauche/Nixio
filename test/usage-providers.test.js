import assert from "node:assert/strict"
import test from "node:test"
import { translateBoxesGemini } from "../src/gemini.js"
import { translateBoxesOpenAi } from "../src/openai-compat.js"

function installFetch(handler) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  return () => { globalThis.fetch = originalFetch }
}

function installFileReader(dataUrl) {
  const originalFileReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = dataUrl
      queueMicrotask(() => this.onload())
    }
  }
  return () => { globalThis.FileReader = originalFileReader }
}

const page = { file: { name: "page-01.jpg", type: "image/jpeg", size: 128 } }
const boxes = [{ id: "box-1", text: "こんにちは" }]

test("translateBoxesGemini reports the usage metadata the provider returned", async (t) => {
  const restoreFetch = installFetch(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }) }] },
      }],
      usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 40, cachedContentTokenCount: 300 },
    }),
  }))
  const restoreFileReader = installFileReader("data:image/jpeg;base64,AAAA")
  t.after(() => {
    restoreFetch()
    restoreFileReader()
  })

  const calls = []
  const translated = await translateBoxesGemini(page, boxes, {
    key: "test-key",
    model: "gemini-3.1-flash-lite",
    source: "Japanese",
    target: "Vietnamese",
    direction: "rtl",
    notes: "",
    context: [],
    glossary: "",
    report: () => {},
    onUsage: (call) => calls.push(call),
  })

  assert.equal(translated[0].text, "Xin chào")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, "gemini")
  assert.equal(calls[0].model, "gemini-3.1-flash-lite")
  assert.equal(calls[0].kind, "translate")
  assert.deepEqual(calls[0].tokens, {
    promptTokens: 2100,
    completionTokens: 40,
    cachedTokens: 300,
    totalTokens: 2140,
    estimated: false,
  })
})

test("a Gemini answer without usage metadata is estimated from the prompt text, never the image bytes", async (t) => {
  const restoreFetch = installFetch(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }) }] } }],
    }),
  }))
  const restoreFileReader = installFileReader("data:image/jpeg;base64," + "A".repeat(200000))
  t.after(() => {
    restoreFetch()
    restoreFileReader()
  })

  const calls = []
  await translateBoxesGemini(page, boxes, {
    key: "test-key",
    model: "auto",
    source: "Japanese",
    target: "Vietnamese",
    direction: "rtl",
    notes: "",
    context: [],
    glossary: "",
    report: () => {},
    onUsage: (call) => calls.push(call),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].tokens.estimated, true)
  assert.ok(calls[0].tokens.promptTokens > 0)
  // 200k characters of base64 would be ~55k tokens; the text prompt alone stays far below that.
  assert.ok(calls[0].tokens.promptTokens < 2000, "image bytes are not counted as text")
  assert.ok(calls[0].tokens.completionTokens > 0)
})

test("translateBoxesOpenAi reports the usage of an OpenAI-compatible answer", async (t) => {
  const restoreFetch = installFetch(async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }) },
      }],
      usage: { prompt_tokens: 800, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 100 } },
    }),
  }))
  t.after(restoreFetch)

  const calls = []
  const translated = await translateBoxesOpenAi(boxes, {
    baseUrl: "http://localhost:11434/v1",
    llmModel: "qwen2.5:7b",
    apiKey: "",
    source: "Japanese",
    target: "Vietnamese",
    notes: "",
    context: [],
    glossary: "",
    onUsage: (call) => calls.push(call),
  })

  assert.equal(translated[0].text, "Xin chào")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, "openai")
  assert.equal(calls[0].model, "qwen2.5:7b")
  assert.deepEqual(calls[0].tokens, {
    promptTokens: 800,
    completionTokens: 60,
    cachedTokens: 100,
    totalTokens: 860,
    estimated: false,
  })
})

test("an OpenAI-compatible answer without usage is estimated and marked as such", async (t) => {
  const restoreFetch = installFetch(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }) } }],
    }),
  }))
  t.after(restoreFetch)

  const calls = []
  await translateBoxesOpenAi(boxes, {
    baseUrl: "http://localhost:11434/v1",
    llmModel: "qwen2.5:7b",
    apiKey: "",
    source: "Japanese",
    target: "Vietnamese",
    notes: "",
    context: [],
    glossary: "",
    onUsage: (call) => calls.push(call),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].tokens.estimated, true)
  assert.ok(calls[0].tokens.promptTokens > 0)
  assert.equal(calls[0].tokens.cachedTokens, 0)
})
