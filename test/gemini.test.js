import assert from "node:assert/strict"
import test from "node:test"
import { translateImage } from "../src/gemini.js"

function installMocks(dataUrl, handler) {
  const originalFileReader = globalThis.FileReader
  const originalFetch = globalThis.fetch
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = dataUrl
      queueMicrotask(() => this.onload())
    }
  }
  globalThis.fetch = handler
  return () => {
    globalThis.FileReader = originalFileReader
    globalThis.fetch = originalFetch
  }
}

test("translateImage infers image MIME type from filename when FileReader reports octet-stream", async (t) => {
  const seenMimeTypes = []
  const payloads = []
  let calls = 0
  const restore = installMocks("data:application/octet-stream;base64,AAAA", async (_url, options) => {
    const body = JSON.parse(options.body)
    seenMimeTypes.push(body.contents[0].parts[1].inlineData.mimeType)
    calls++
    payloads.push(body.contents[0].parts[0].text)
    const text = calls === 1
      ? JSON.stringify({ lines: [{ box_2d: [100, 100, 200, 300], text: "こんにちは" }] })
      : JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] })
    return {
      ok: true,
      json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }),
    }
  })
  t.after(restore)

  const page = { file: { name: "page-01.jpg", type: "", size: 128 } }
  const result = await translateImage(page, {
    key: "test-key",
    model: "gemini-3.1-flash-lite",
    source: "Japanese",
    target: "Vietnamese",
    direction: "rtl",
    notes: "",
    glossary: "こんにちは = Xin chào",
    context: [],
    report: () => {},
  })

  assert.ok(payloads[1].includes("こんにちは = Xin chào"))
  assert.deepEqual(seenMimeTypes, ["image/jpeg", "image/jpeg"])
  assert.deepEqual(result, [{ id: "B1", box: [100, 100, 300, 200], source: "こんにちは", text: "Xin chào" }])
})

test("translateImage surfaces a clear error when Gemini returns malformed JSON", async (t) => {
  const restore = installMocks("data:image/png;base64,AAAA", async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{not json" }] } }] }),
  }))
  t.after(restore)

  const page = { file: { name: "page-02.png", type: "image/png", size: 128 } }
  await assert.rejects(
    () => translateImage(page, {
      key: "test-key",
      model: "gemini-3.1-flash-lite",
      source: "Japanese",
      target: "Vietnamese",
      direction: "rtl",
      notes: "",
      context: [],
      report: () => {},
    }),
    /JSON không hợp lệ/,
  )
})

test("stopping translation aborts the in-flight Gemini request", async (t) => {
  const controller = new AbortController()
  const restore = installMocks("data:image/png;base64,AAAA", async (_url, { signal }) => {
    queueMicrotask(() => controller.abort())
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  })
  t.after(restore)
  await assert.rejects(() => translateImage({ file: { name: "page.png", size: 128 } }, {
    key: "test", model: "auto", source: "Japanese", target: "Vietnamese", direction: "rtl",
    report: () => {}, signal: controller.signal,
  }), { name: "AbortError" })
})
