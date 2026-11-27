import assert from "node:assert/strict"
import test from "node:test"
import { Readable } from "node:stream"
import { credentialHandle } from "../desktop/credential-ipc.cjs"
import { ProviderTransport } from "../desktop/provider-transport.cjs"
import { runAgentTurn } from "../src/agent-harness.js"
import { translateBoxesGemini } from "../src/gemini.js"
import { translateBoxesOpenAi } from "../src/openai-compat.js"

// End-to-end wiring without Electron: the real main-process transport answers the real renderer
// adapter through a synthetic IPC layer, so the envelope, the acknowledgement and the cancel token
// are exercised across the same seam the app uses. No socket, no resolver, no real key leaves these
// objects, and every assertion is about what each side actually received.

const SENDER = "w1"
const PUBLIC_ADDRESS = "93.184.216.34"
const VAULT_GEMINI_KEY = "AIza-vault-gemini-77c1"
const VAULT_OPENAI_KEY = "sk-vault-openai-5a1b"
const RENDERER_KEY = "sk-renderer-must-not-travel-9e2f"
const OPENAI_BASE = "https://api.example.com/v1"

function readable(chunks, signal) {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)))
  stream.on("error", () => {})
  signal?.addEventListener("abort", () => { if (!stream.destroyed) stream.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })) }, { once: true })
  return stream
}

function fakeRequest(handler) {
  const calls = []
  const request = async (options, url) => {
    calls.push({ ...options, url })
    const answer = (await handler(options, calls.length - 1)) ?? {}
    return {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
      response: answer.response ?? readable(answer.chunks ?? ["{}"], options.signal),
    }
  }
  return { calls, request }
}

// A fake main window: the transport's `emit` lands in a queue that only reaches the renderer listener
// when the synthetic IPC delivers it, which is what makes activation observable.
function wire({ keys = {}, handler, request } = {}) {
  const envelopes = []
  const pending = []
  const listeners = new Set()
  const layer = request ? { calls: [], request } : fakeRequest(handler ?? defaultHandler)
  const deliver = () => {
    while (pending.length) {
      const payload = pending.shift()
      for (const listener of [...listeners]) listener(payload)
    }
  }
  const transport = new ProviderTransport({
    credentials: {
      async read(handle) {
        return Object.hasOwn(keys, handle) ? keys[handle] : null
      },
    },
    emit: (senderKey, payload) => {
      assert.equal(senderKey, SENDER)
      // Like Electron IPC, a push frame reaches the renderer after the main-side call returns.
      pending.push(payload)
      queueMicrotask(deliver)
    },
    lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    request: layer.request,
  })
  const bridge = {
    async providerRequest(envelope) {
      envelopes.push(envelope)
      const value = await transport.execute(SENDER, envelope)
      queueMicrotask(deliver)
      return value
    },
    async providerStream(envelope) {
      envelopes.push(envelope)
      const value = await transport.stream(SENDER, envelope)
      queueMicrotask(deliver)
      return value
    },
    providerActivate(ticket) {
      const value = transport.activate(SENDER, ticket)
      deliver()
      return value
    },
    providerCancel(target) {
      const value = transport.cancel(SENDER, target)
      return value
    },
    onProviderEvent(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  return { transport, bridge, layer, envelopes, listeners }
}

const defaultHandler = () => ({ status: 200, headers: { "content-type": "application/json" }, chunks: ["{}"] })

function installBridge(t, bridge) {
  const original = globalThis.khungThoaiDesktop
  globalThis.khungThoaiDesktop = bridge
  t.after(() => {
    if (original === undefined) delete globalThis.khungThoaiDesktop
    else globalThis.khungThoaiDesktop = original
  })
}

function installFileReader(t, dataUrl) {
  const original = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = dataUrl
      queueMicrotask(() => this.onload())
    }
  }
  t.after(() => { globalThis.FileReader = original })
}

const geminiHandle = credentialHandle("gemini:fixed")
const openAiHandle = credentialHandle("openai:" + OPENAI_BASE)
const toolRegistry = {
  definitions: () => [],
  execute: async () => ({ ok: true }),
  isConcurrencySafe: () => false,
  getRuntimeSnapshot: () => ({}),
}

test("an OpenAI-compatible translation uses the vault key and never the renderer's settings key", async (t) => {
  const { bridge, layer, envelopes } = wire({
    keys: { [openAiHandle]: VAULT_OPENAI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({
        choices: [{ message: { content: '{"lines":[{"id":"B1","text":"Chào buổi sáng"}]}' } }],
      })],
    }),
  })
  installBridge(t, bridge)
  const result = await translateBoxesOpenAi(
    [{ id: "box-1", text: "おはよう" }],
    {
      provider: "openai",
      baseUrl: OPENAI_BASE,
      apiKey: RENDERER_KEY,
      llmModel: "hy-mt2-manga",
      source: "Japanese",
      target: "Vietnamese",
      notes: "",
      glossary: "",
      context: [],
    },
  )
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "おはよう", text: "Chào buổi sáng" }])
  assert.equal(layer.calls.length, 1)
  // The header carries the key main read from the vault, not the one the renderer still holds.
  assert.equal(layer.calls[0].headers.Authorization, "Bearer " + VAULT_OPENAI_KEY)
  assert.equal(JSON.stringify(layer.calls[0].headers).includes(RENDERER_KEY), false)
  for (const envelope of envelopes) {
    assert.equal(JSON.stringify(envelope).includes(RENDERER_KEY), false, "the settings key crossed the bridge")
    assert.equal(JSON.stringify(envelope).includes(VAULT_OPENAI_KEY), false, "the vault key crossed the bridge")
  }
})

test("a Gemini box translation reaches the fixed destination through the bridge", async (t) => {
  installFileReader(t, "data:image/png;base64,AAAA")
  const { bridge, layer, envelopes } = wire({
    keys: { [geminiHandle]: VAULT_GEMINI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"lines":[{"id":"B1","text":"Xin chào"}]}' }] } }],
      })],
    }),
  })
  installBridge(t, bridge)
  const result = await translateBoxesGemini(
    { file: { name: "page.png", type: "image/png", size: 64 } },
    [{ id: "box-1", text: "こんにちは" }],
    {
      provider: "gemini",
      key: RENDERER_KEY,
      model: "gemini-3.1-flash-lite",
      source: "Japanese",
      target: "Vietnamese",
      notes: "",
      glossary: "",
      context: [],
    },
  )
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "こんにちは", text: "Xin chào" }])
  assert.equal(layer.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent")
  // The Gemini key is header-only and comes from the vault, so the URL and the envelope stay clean.
  assert.equal(layer.calls[0].headers["x-goog-api-key"], VAULT_GEMINI_KEY)
  assert.equal(layer.calls[0].url.includes(VAULT_GEMINI_KEY), false)
  for (const envelope of envelopes) {
    assert.equal(JSON.stringify(envelope).includes(RENDERER_KEY), false)
    assert.equal(JSON.stringify(envelope).includes(VAULT_GEMINI_KEY), false)
  }
  // The inline image the editor already built survives the envelope unchanged.
  assert.equal(envelopes[0].payload.contents[0].parts[1].inlineData.mimeType, "image/png")
  assert.equal(envelopes[0].payload.contents[0].parts[1].inlineData.data, "AAAA")
})

test("local inference keeps working on the desktop: loopback, pinned and keyless", async (t) => {
  const localBase = "http://localhost:11434/v1"
  const { bridge, layer, envelopes } = wire({
    handler: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({ choices: [{ message: { content: '{"lines":[{"id":"B1","text":"Chào"}]}' } }] })],
    }),
  })
  installBridge(t, bridge)
  const result = await translateBoxesOpenAi([{ id: "box-1", text: "こんにちは" }], {
    provider: "openai",
    baseUrl: localBase,
    apiKey: "",
    llmModel: "qwen2.5:7b",
    source: "Japanese",
    target: "Vietnamese",
    notes: "",
    glossary: "",
    context: [],
  })
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "こんにちは", text: "Chào" }])
  assert.equal(layer.calls[0].url, localBase + "/chat/completions")
  assert.equal(layer.calls[0].host, "127.0.0.1")
  assert.equal(layer.calls[0].port, 11434)
  assert.equal("Authorization" in layer.calls[0].headers, false)
  // No key is stored for the local endpoint, and the keyless call is not treated as a failure.
  assert.equal(envelopes[0].endpoint, localBase)
})

test("a transient provider status is retried through the bridge and then succeeds", async (t) => {
  const { bridge, layer } = wire({
    keys: { [openAiHandle]: VAULT_OPENAI_KEY },
    handler: (_options, index) => {
      if (index === 0) return { status: 503, headers: { "retry-after": "0" }, chunks: ["unavailable"] }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [JSON.stringify({ choices: [{ message: { content: '{"lines":[{"id":"B1","text":"Xong"}]}' } }] })],
      }
    },
  })
  installBridge(t, bridge)
  const result = await translateBoxesOpenAi([{ id: "box-1", text: "はい" }], {
    provider: "openai",
    baseUrl: OPENAI_BASE,
    apiKey: RENDERER_KEY,
    llmModel: "m",
    source: "Japanese",
    target: "Vietnamese",
    notes: "",
    glossary: "",
    context: [],
    retryDelayMs: 1,
  })
  assert.deepEqual(result, [{ id: "B1", boxId: "box-1", source: "はい", text: "Xong" }])
  assert.equal(layer.calls.length, 2, "the transient status was not retried")
  assert.equal(layer.calls[1].headers.Authorization, "Bearer " + VAULT_OPENAI_KEY)
})

test("an OpenAI-compatible stream crosses the bridge as SSE and keeps tool-free deltas", async (t) => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Đã "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"xong."}}]}\n\n',
    "data: [DONE]\n\n",
  ]
  const { bridge, layer, envelopes } = wire({
    keys: { [openAiHandle]: VAULT_OPENAI_KEY },
    handler: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, chunks: frames }),
  })
  installBridge(t, bridge)
  const deltas = []
  const result = await runAgentTurn({
    userMessage: "Chào",
    settings: { provider: "openai", baseUrl: OPENAI_BASE, llmModel: "qwen2.5:7b", source: "Japanese", target: "Vietnamese" },
    tools: toolRegistry,
    stream: true,
    onEvent: (event) => { if (event.type === "delta") deltas.push(event.text) },
  })
  assert.equal(result.answer, "Đã xong.")
  assert.equal(deltas.join(""), "Đã xong.")
  assert.equal(layer.calls[0].headers.Authorization, "Bearer " + VAULT_OPENAI_KEY)
  // The streaming flag is the main-side operation selector, and the envelope still carries no key.
  assert.equal(envelopes[0].operation, "chat.completions")
  assert.equal(JSON.stringify(envelopes).includes(VAULT_OPENAI_KEY), false)
})

test("a Gemini agent turn works without a settings key when main owns the vault", async (t) => {
  const { bridge, layer } = wire({
    keys: { [geminiHandle]: VAULT_GEMINI_KEY },
    handler: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: [JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Đã kiểm tra trang." }] } }],
      })],
    }),
  })
  installBridge(t, bridge)
  const result = await runAgentTurn({
    userMessage: "Xem trang",
    settings: { provider: "gemini", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese" },
    tools: toolRegistry,
  })
  assert.equal(result.answer, "Đã kiểm tra trang.")
  assert.equal(layer.calls[0].headers["x-goog-api-key"], VAULT_GEMINI_KEY)
})

test("a direct abort destroys the in-flight main request instead of dropping a result", async (t) => {
  let aborted = false
  let resolveRequest
  const request = (options) => new Promise((resolve, reject) => {
    resolveRequest = resolve
    const fail = () => {
      aborted = true
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    }
    if (options.signal.aborted) fail()
    else options.signal.addEventListener("abort", fail, { once: true })
  })
  const { bridge, transport } = wire({
    keys: { [openAiHandle]: VAULT_OPENAI_KEY, [geminiHandle]: VAULT_GEMINI_KEY },
    request,
  })
  installBridge(t, bridge)
  const controller = new AbortController()
  const pending = runAgentTurn({
    userMessage: "Chào",
    settings: { provider: "openai", baseUrl: OPENAI_BASE, llmModel: "m", source: "Japanese", target: "Vietnamese" },
    tools: toolRegistry,
    signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(transport.entries.size, 1, "main never registered the exchange")
  controller.abort()
  await assert.rejects(pending, (error) => error.name === "AbortError")
  assert.equal(aborted, true, "the main-side request was left in flight")
  assert.equal(transport.entries.size, 0)
  assert.equal(transport.requests.size, 0)
  assert.equal(typeof resolveRequest, "function")

  // A stream that is aborted before its headers arrive ends the same way.
  const streamController = new AbortController()
  const streaming = runAgentTurn({
    userMessage: "Chào",
    settings: { provider: "gemini", model: "gemini-3.1-flash-lite", source: "Japanese", target: "Vietnamese" },
    tools: toolRegistry,
    stream: true,
    signal: streamController.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  streamController.abort()
  await assert.rejects(streaming, (error) => error.name === "AbortError")
  assert.equal(transport.entries.size, 0)
})
