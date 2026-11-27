import assert from "node:assert/strict"
import test from "node:test"
import {
  alignScriptOpenAi,
  extractJsonObject,
  translateBoxesOpenAi,
  translateImageOpenAi,
  validateEndpointUrl,
} from "../src/openai-compat.js"
import { translationSignature } from "../src/translation.js"

// One synthetic assistant answer: no socket is opened and nothing outside this object is read.
function chatResponse(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ choices: [{ message: { content }, ...extra }] }),
  }
}

function installFetch(t, handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => { globalThis.fetch = original })
}

function installFileReader(t, dataUrl = "data:image/png;base64,AAAA") {
  const original = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = dataUrl
      queueMicrotask(() => this.onload())
    }
  }
  t.after(() => { globalThis.FileReader = original })
}

const imageSettings = (overrides = {}) => ({
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  llmModel: "gpt-4o-mini",
  apiKey: "sk-test",
  source: "Japanese",
  target: "Vietnamese",
  direction: "rtl",
  retryDelayMs: 1,
  ...overrides,
})

test("validateEndpointUrl allows HTTPS and loopback HTTP while rejecting remote insecure HTTP", () => {
  assert.equal(validateEndpointUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1")
  assert.equal(validateEndpointUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1")
  assert.equal(validateEndpointUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1")
  assert.throws(() => validateEndpointUrl("http://example.com/v1"), /HTTPS hoặc HTTP cục bộ/)
  assert.throws(() => validateEndpointUrl("not-a-url"), /không hợp lệ/)
})

test("extractJsonObject strips reasoning <think> blocks and markdown fences cleanly", () => {
  const raw = '<think>Analyzing Japanese honorifics...</think>\n```json\n{"lines":[{"id":"B1","text":"Xin chào!"}]}\n```'
  assert.deepEqual(extractJsonObject(raw), { lines: [{ id: "B1", text: "Xin chào!" }] })
  assert.throws(() => extractJsonObject("not json"), /JSON không hợp lệ/)
})

test("translateBoxesOpenAi translates existing OCR boxes with local text-only LLMs without API key", async (t) => {
  const originalFetch = globalThis.fetch
  let capturedRequest
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, headers: options.headers, body: JSON.parse(options.body) }
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '<think>ok</think>{"lines":[{"id":"B1","text":"Chào buổi sáng!"},{"id":"B2","text":"Đi thôi nào."}]}',
          },
        }],
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const boxes = [
    { id: "box-1", text: "おはよう" },
    { id: "box-2", text: "行こう" },
  ]
  const result = await translateBoxesOpenAi(boxes, {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    llmModel: "hy-mt2-manga",
    apiKey: "",
    source: "Japanese",
    target: "Vietnamese",
    notes: "Xưng hô thân mật",
    glossary: "おはよう = Chào buổi sáng",
    context: [],
  })

  assert.equal(capturedRequest.url, "http://localhost:11434/v1/chat/completions")
  assert.equal(capturedRequest.headers.Authorization, undefined)
  assert.equal(capturedRequest.body.model, "hy-mt2-manga")
  assert.deepEqual(result, [
    { id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng!" },
    { id: "B2", boxId: "box-2", source: "行こう", text: "Đi thôi nào." },
  ])
})

test("translateImageOpenAi sends image_url multimodal payload and normalizes box_2d", async (t) => {
  const originalFetch = globalThis.fetch
  const originalFileReader = globalThis.FileReader
  let capturedBody
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA"
      queueMicrotask(() => this.onload())
    }
  }
  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body)
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              lines: [{ source: "こんにちは", text: "Xin chào", box_2d: [100, 200, 300, 500] }],
            }),
          },
        }],
      }),
    }
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.FileReader = originalFileReader
  })

  const lines = await translateImageOpenAi(
    { file: { name: "01.png", type: "image/png", size: 64 } },
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      llmModel: "gpt-4o-mini",
      apiKey: "sk-test",
      source: "Japanese",
      target: "Vietnamese",
      direction: "rtl",
    },
  )
  assert.equal(capturedBody.messages[1].content[1].image_url.url, "data:image/png;base64,AAAA")
  assert.deepEqual(lines, [{ id: "B1", box: [200, 100, 500, 300], source: "こんにちは", text: "Xin chào" }])
})

test("translationSignature stays backwards-compatible for Gemini and tracks OpenAI endpoint and skillPrompt changes", () => {
  const base = { source: "Japanese", target: "Vietnamese", notes: "", direction: "rtl", model: "auto", glossary: "" }
  assert.equal(translationSignature(base), translationSignature({ ...base, provider: "gemini" }))
  assert.equal(translationSignature(base), translationSignature({ ...base, skillPrompt: "" }))
  const withSkill = translationSignature({ ...base, skillPrompt: "Hồ sơ Shounen" })
  assert.notEqual(withSkill, translationSignature(base))
  const ollama = translationSignature({ ...base, provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" })
  const lmstudio = translationSignature({ ...base, provider: "openai", baseUrl: "http://localhost:1234/v1", llmModel: "hy-mt2" })
  assert.notEqual(ollama, translationSignature(base))
  assert.notEqual(ollama, lmstudio)
})

test("translateBoxesOpenAi retries transient 503 errors with backoff", async (t) => {
  const originalFetch = globalThis.fetch
  let calls = 0
  const reports = []
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return { ok: false, status: 503, headers: new Headers() }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ lines: [{ id: "B1", text: "Được rồi!" }] }) } }],
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await translateBoxesOpenAi([{ id: "box-1", text: "よし" }], {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    llmModel: "qwen2.5:7b",
    source: "Japanese",
    target: "Vietnamese",
    retryDelayMs: 5,
    report: (msg) => reports.push(msg),
  })

  assert.equal(calls, 2)
  assert.ok(reports.some((m) => m.includes("thử lại")))
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "よし", text: "Được rồi!" }])
})

test("translateImageOpenAi keeps a box the model reported with decimal coordinates (#23)", async (t) => {
  installFileReader(t)
  installFetch(t, async () => chatResponse(JSON.stringify({
    lines: [
      { source: "こんにちは", text: "Xin chào", box_2d: [100.4, 200.6, 300.8, 400.2] },
      { source: "行こう", text: "Đi thôi", box_2d: [10, 20, 30, 40] },
    ],
  })))

  const lines = await translateImageOpenAi({ file: { name: "01.png", type: "image/png", size: 64 } }, imageSettings())
  assert.deepEqual(lines, [
    { id: "B1", box: [201, 100, 400, 301], source: "こんにちは", text: "Xin chào" },
    { id: "B2", box: [20, 10, 40, 30], source: "行こう", text: "Đi thôi" },
  ])
})

test("alignScriptOpenAi matches a page whose boxes came back as decimals (#23)", async (t) => {
  installFileReader(t)
  installFetch(t, async () => chatResponse(JSON.stringify({
    lines: [{ id: "T1", source: "こんにちは", text: "T1", box_2d: [100.5, 200.5, 300.5, 400.5] }],
  })))

  const aligned = await alignScriptOpenAi(
    { file: { name: "01.png", type: "image/png", size: 64 } },
    imageSettings(),
    ["Xin chào"],
  )
  assert.deepEqual(aligned, [{ id: "T1", text: "Xin chào", box: [201, 101, 401, 301], source: "こんにちは" }])
})

test("translateBoxesOpenAi refuses a blank translation instead of keeping the source text (#24)", async (t) => {
  let calls = 0
  installFetch(t, async () => {
    calls += 1
    return chatResponse(JSON.stringify({ lines: [{ id: "B1", text: "  " }] }))
  })

  await assert.rejects(
    () => translateBoxesOpenAi([{ id: "box-1", text: "こんにちは" }], {
      provider: "openai",
      baseUrl: "http://localhost:11434/v1",
      llmModel: "qwen2.5:7b",
      source: "Japanese",
      target: "Vietnamese",
      maxRetries: 1,
      retryDelayMs: 1,
    }),
    /trả bản dịch rỗng cho B1/,
  )
  // The blank answer is a content error, so it is retried once and then reported, never swallowed.
  assert.equal(calls, 2)
})

test("translateBoxesOpenAi keeps a valid line list and its ID mapping intact (#24)", async (t) => {
  installFetch(t, async () => chatResponse(JSON.stringify({
    lines: [{ id: "B2", text: "Đi thôi" }, { id: "B1", text: "  Chào   buổi sáng " }],
  })))

  const result = await translateBoxesOpenAi(
    [{ id: "box-1", text: "おはよう" }, { id: "box-2", text: "行こう" }],
    { provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "m", source: "Japanese", target: "Vietnamese" },
  )
  assert.deepEqual(result, [
    { id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng" },
    { id: "B2", boxId: "box-2", source: "行こう", text: "Đi thôi" },
  ])
})

test("a malformed model answer is retried inside the bounded loop and then succeeds (#40)", async (t) => {
  const answers = [
    "not json at all",
    JSON.stringify({ lines: [{ id: "B1", text: "" }] }),
    JSON.stringify({ lines: [{ id: "B1", text: "Chào buổi sáng" }] }),
  ]
  let calls = 0
  installFetch(t, async () => chatResponse(answers[calls++]))

  const result = await translateBoxesOpenAi([{ id: "box-1", text: "おはよう" }], {
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    llmModel: "m",
    source: "Japanese",
    target: "Vietnamese",
    maxRetries: 2,
    retryDelayMs: 1,
  })
  assert.equal(calls, 3)
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng" }])
})

test("a truncated answer and an unreadable body are retried, then reported once exhausted (#40)", async (t) => {
  // One install with a swappable handler: a second install would leave a stale fake behind for the
  // tests that run later in this file.
  let respond = async () => chatResponse("{}")
  installFetch(t, async (url, options) => respond(url, options))

  let truncated = 0
  respond = async () => {
    truncated += 1
    return chatResponse(JSON.stringify({ lines: [{ id: "B1", text: "Chào" }] }), { finish_reason: "length" })
  }
  await assert.rejects(
    () => translateBoxesOpenAi([{ id: "box-1", text: "おはよう" }], {
      provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "m",
      source: "Japanese", target: "Vietnamese", maxRetries: 1, retryDelayMs: 1,
    }),
    /bị cắt ngắn/,
  )
  assert.equal(truncated, 2)

  let unreadable = 0
  respond = async () => {
    unreadable += 1
    return { ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError("Unexpected token <") } }
  }
  await assert.rejects(
    () => translateBoxesOpenAi([{ id: "box-1", text: "よし" }], {
      provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "m",
      source: "Japanese", target: "Vietnamese", maxRetries: 1, retryDelayMs: 1,
    }),
    /phản hồi JSON không hợp lệ/,
  )
  assert.equal(unreadable, 2)
})

test("an authentication failure, a configuration mistake and an abort all fail on the first attempt (#40)", async (t) => {
  let respond = async () => chatResponse("{}")
  installFetch(t, async (url, options) => respond(url, options))

  let unauthorized = 0
  respond = async () => {
    unauthorized += 1
    return { ok: false, status: 401, headers: new Headers() }
  }
  await assert.rejects(
    () => translateBoxesOpenAi([{ id: "box-1", text: "よし" }], {
      provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "m",
      source: "Japanese", target: "Vietnamese", maxRetries: 2, retryDelayMs: 1,
    }),
    /LLM trả lỗi 401/,
  )
  assert.equal(unauthorized, 1)

  let configured = 0
  respond = async () => { configured += 1; return chatResponse("{}") }
  await assert.rejects(
    () => translateBoxesOpenAi([{ id: "box-1", text: "よし" }], {
      provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "   ",
      source: "Japanese", target: "Vietnamese", maxRetries: 2, retryDelayMs: 1,
    }),
    /Hãy nhập tên Model/,
  )
  assert.equal(configured, 0)

  const controller = new AbortController()
  let aborted = 0
  respond = async () => {
    aborted += 1
    controller.abort()
    throw Object.assign(new Error("cancelled"), { name: "AbortError" })
  }
  await assert.rejects(
    () => translateBoxesOpenAi([{ id: "box-1", text: "よし" }], {
      provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "m",
      source: "Japanese", target: "Vietnamese", maxRetries: 2, retryDelayMs: 1,
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError",
  )
  assert.equal(aborted, 1)
})

test("the desktop bridge answers the same content errors without falling back to fetch (#40)", async (t) => {
  const original = globalThis.khungThoaiDesktop
  const envelopes = []
  const answers = [
    "not json at all",
    JSON.stringify({ lines: [{ id: "B1", text: "Chào buổi sáng" }] }),
  ]
  let served = 0
  globalThis.khungThoaiDesktop = {
    providerRequest: async (envelope) => {
      envelopes.push(envelope)
      return {
        ok: true,
        status: 200,
        contentType: "json",
        body: JSON.stringify({ choices: [{ message: { content: answers[served++] } }] }),
      }
    },
    providerStream: async () => ({ ok: true, ticket: "t-1", status: 200, contentType: "sse" }),
    providerActivate: async () => ({ ok: true, active: true }),
    providerCancel: async () => ({ ok: true }),
    onProviderEvent: () => () => {},
  }
  let fetched = 0
  installFetch(t, async () => { fetched += 1; throw new Error("fetch must not run while the bridge is present") })
  t.after(() => {
    if (original === undefined) delete globalThis.khungThoaiDesktop
    else globalThis.khungThoaiDesktop = original
  })

  const result = await translateBoxesOpenAi([{ id: "box-1", text: "おはよう" }], {
    provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b",
    apiKey: "sk-renderer-must-not-travel", source: "Japanese", target: "Vietnamese",
    retryDelayMs: 1,
  })

  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng" }])
  assert.equal(fetched, 0, "the renderer fell back to fetch")
  assert.equal(envelopes.length, 2, "the content error was not retried through the bridge")
  for (const envelope of envelopes) {
    assert.equal(envelope.provider, "openai")
    assert.equal(envelope.endpoint, "http://localhost:11434/v1")
    assert.equal(JSON.stringify(envelope).includes("sk-renderer-must-not-travel"), false)
  }
})
