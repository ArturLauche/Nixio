import assert from "node:assert/strict"
import test from "node:test"
import { translateBoxesGemini, translateImage } from "../src/gemini.js"

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

test("translateImage retries transient 429/503 responses and succeeds", async (t) => {
  let calls = 0
  const reports = []
  const restore = installMocks("data:image/png;base64,AAAA", async () => {
    calls++
    if (calls === 1) return { ok: false, status: 429, headers: new Headers({ "retry-after": "0" }) }
    const text = calls === 2
      ? JSON.stringify({ lines: [{ box_2d: [100, 100, 200, 300], text: "はい" }] })
      : JSON.stringify({ lines: [{ id: "B1", text: "Vâng" }] })
    return {
      ok: true,
      json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }),
    }
  })
  t.after(restore)

  const page = { file: { name: "retry.png", type: "image/png", size: 128 } }
  const result = await translateImage(page, {
    key: "test-key",
    model: "gemini-3.1-flash-lite",
    source: "Japanese",
    target: "Vietnamese",
    direction: "rtl",
    notes: "",
    glossary: "",
    context: [],
    retryDelayMs: 5,
    report: (msg) => reports.push(msg),
  })

  assert.equal(calls, 3)
  assert.ok(reports.some((m) => m.includes("thử lại")))
  assert.deepEqual(result, [{ id: "B1", box: [100, 100, 300, 200], source: "はい", text: "Vâng" }])
})

function geminiResponse(text, finishReason = "STOP") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] }),
  }
}

test("the Gemini OCR turn keeps a box the model reported with decimal coordinates (#23)", async (t) => {
  // The Gemini JSON schema asks for integers, but a schema is a hint: the recognition answer still
  // arrives with decimals, and dropping the box left the whole page in "Chưa đặt".
  const answers = [
    JSON.stringify({ lines: [{ box_2d: [100.4, 200.6, 300.8, 400.2], text: "こんにちは" }] }),
    JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }),
  ]
  let calls = 0
  const restore = installMocks("data:image/png;base64,AAAA", async () => geminiResponse(answers[calls++]))
  t.after(restore)

  const result = await translateImage(
    { file: { name: "decimal.png", type: "image/png", size: 128 } },
    {
      key: "test-key", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
      direction: "rtl", notes: "", glossary: "", context: [], report: () => {},
    },
  )
  assert.deepEqual(result, [{ id: "B1", box: [201, 100, 400, 301], source: "こんにちは", text: "Xin chào" }])
})

test("translateBoxesGemini refuses a blank translation instead of keeping the source text (#24)", async (t) => {
  let calls = 0
  const restore = installMocks("data:image/png;base64,AAAA", async () => {
    calls += 1
    return geminiResponse(JSON.stringify({ lines: [{ id: "B1", text: "   " }] }))
  })
  t.after(restore)

  await assert.rejects(
    () => translateBoxesGemini(
      { file: { name: "blank.png", type: "image/png", size: 128 } },
      [{ id: "box-1", text: "こんにちは" }],
      {
        key: "test-key", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
        notes: "", glossary: "", context: [], report: () => {},
        maxRetries: 1, retryDelayMs: 1,
      },
    ),
    /Gemini trả bản dịch rỗng cho B1/,
  )
  assert.equal(calls, 2, "the blank answer was not given the bounded retry")
})

test("translateBoxesGemini keeps valid lines and their box mapping (#24)", async (t) => {
  const restore = installMocks("data:image/png;base64,AAAA", async () => geminiResponse(
    JSON.stringify({ lines: [{ id: "B2", text: "Đi thôi" }, { id: "B1", text: " Chào  buổi sáng " }] }),
  ))
  t.after(restore)

  const result = await translateBoxesGemini(
    { file: { name: "ok.png", type: "image/png", size: 128 } },
    [{ id: "box-1", text: "おはよう" }, { id: "box-2", text: "行こう" }],
    {
      key: "test-key", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
      notes: "", glossary: "", context: [], report: () => {},
    },
  )
  assert.deepEqual(result, [
    { id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng" },
    { id: "B2", boxId: "box-2", source: "行こう", text: "Đi thôi" },
  ])
})

test("a malformed Gemini answer is retried inside the bounded loop and then succeeds (#40)", async (t) => {
  const answers = [
    "{not json",
    JSON.stringify({ lines: [{ box_2d: [100, 100, 200, 300], text: "こんにちは" }] }),
    JSON.stringify({ lines: [{ id: "B1", text: "" }] }),
    JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }),
  ]
  let calls = 0
  const reports = []
  const restore = installMocks("data:image/png;base64,AAAA", async () => geminiResponse(answers[calls++]))
  t.after(restore)

  const result = await translateBoxesGemini(
    { file: { name: "retry.png", type: "image/png", size: 128 } },
    [{ id: "box-1", text: "こんにちは" }],
    {
      key: "test-key", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
      notes: "", glossary: "", context: [], maxRetries: 3, retryDelayMs: 1,
      report: (message) => reports.push(message),
    },
  )
  assert.equal(calls, 4)
  assert.ok(reports.some((message) => message.includes("thử lại")))
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "こんにちは", text: "Xin chào" }])
})

test("a truncated candidate is retried while a safety refusal fails on the first attempt (#40)", async (t) => {
  let truncated = 0
  let restore = installMocks("data:image/png;base64,AAAA", async () => {
    truncated += 1
    return truncated === 1
      ? geminiResponse("", "MAX_TOKENS")
      : geminiResponse(JSON.stringify({ lines: [{ id: "B1", text: "Chào" }] }))
  })
  t.after(restore)
  const translated = await translateBoxesGemini(
    { file: { name: "cut.png", type: "image/png", size: 128 } },
    [{ id: "box-1", text: "こんにちは" }],
    {
      key: "k", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
      notes: "", glossary: "", context: [], report: () => {}, maxRetries: 2, retryDelayMs: 1,
    },
  )
  assert.equal(truncated, 2)
  assert.deepEqual(translated, [{ id: "B1", boxId: "box-1", source: "こんにちは", text: "Chào" }])

  restore()
  let refused = 0
  restore = installMocks("data:image/png;base64,AAAA", async () => {
    refused += 1
    return geminiResponse("", "SAFETY")
  })
  t.after(restore)
  await assert.rejects(
    () => translateBoxesGemini(
      { file: { name: "refused.png", type: "image/png", size: 128 } },
      [{ id: "box-1", text: "こんにちは" }],
      {
        key: "k", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
        notes: "", glossary: "", context: [], report: () => {}, maxRetries: 2, retryDelayMs: 1,
      },
    ),
    /Gemini từ chối xử lý nội dung trang \(SAFETY\)/,
  )
  assert.equal(refused, 1, "a terminal refusal was retried")
})

test("an access error fails on the first Gemini attempt (#40)", async (t) => {
  let calls = 0
  const restore = installMocks("data:image/png;base64,AAAA", async () => {
    calls += 1
    return { ok: false, status: 403, headers: new Headers() }
  })
  t.after(restore)

  await assert.rejects(
    () => translateBoxesGemini(
      { file: { name: "forbidden.png", type: "image/png", size: 128 } },
      [{ id: "box-1", text: "こんにちは" }],
      {
        key: "k", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese",
        notes: "", glossary: "", context: [], report: () => {}, maxRetries: 2, retryDelayMs: 1,
      },
    ),
    /Gemini trả lỗi 403/,
  )
  assert.equal(calls, 1)
})
