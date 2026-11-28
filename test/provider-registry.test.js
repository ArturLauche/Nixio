import assert from "node:assert/strict"
import test from "node:test"
import { runAgentTurn } from "../src/agent-harness.js"
import {
  ENDPOINT_KINDS,
  PROVIDER_SHAPES,
  createProviderRegistry,
  providerLabel,
  providerModels,
  providerRegistry,
  resolveProvider,
} from "../src/provider-registry.js"

function providerEntry(overrides = {}) {
  return {
    id: "echo",
    label: "Echo",
    shape: "openai",
    endpoint: { kind: "user", field: "baseUrl", validate: (url) => String(url) },
    credential: { required: false, message: "", vaultMessage: "Chưa có khóa API.", field: "llm-key" },
    models: { resolve: () => ["echo-1"] },
    capabilities: { tools: true },
    labels: { agent: () => "Echo", badge: () => "Echo" },
    prepareCredential: (settings) => settings,
    callStep: async () => ({ text: "ok", thought: "", toolCalls: [], usage: null }),
    conversation: {
      pruneShape: "openai",
      createThread: () => ({
        messages: [],
        request: () => ({ messages: [] }),
        fallbackChars: () => 0,
        appendAssistant: () => {},
        appendToolResults: () => {},
      }),
    },
    ...overrides,
  }
}

test("the built-in providers are described with endpoint, credential, models and capabilities", () => {
  assert.deepEqual(providerRegistry.ids(), ["gemini", "openai"])
  assert.equal(providerRegistry.size, 2)

  const gemini = providerRegistry.get("gemini")
  assert.equal(gemini.label, "Gemini")
  assert.equal(gemini.shape, "gemini")
  assert.equal(gemini.endpoint.kind, "fixed")
  assert.equal(gemini.endpoint.host, "generativelanguage.googleapis.com")
  assert.equal(gemini.credential.required, true)
  assert.equal(gemini.credential.field, "gemini-key")
  assert.match(gemini.credential.message, /khóa API Gemini/)
  assert.match(gemini.credential.vaultMessage, /kho bảo mật/)
  assert.deepEqual(gemini.capabilities, { tools: true, stream: true, vision: true })
  assert.equal(gemini.conversation.pruneShape, "gemini")

  const openai = providerRegistry.get("openai")
  assert.equal(openai.shape, "openai")
  assert.equal(openai.endpoint.kind, "user")
  assert.equal(openai.endpoint.field, "baseUrl")
  assert.equal(typeof openai.endpoint.validate, "function")
  // A local server often needs no key, but a missing vault entry still has a reviewed message.
  assert.equal(openai.credential.required, false)
  assert.equal(openai.credential.field, "llm-key")
  assert.match(openai.credential.vaultMessage, /endpoint này/)
  assert.equal(openai.conversation.pruneShape, "openai")

  assert.deepEqual(PROVIDER_SHAPES, {
    gemini: { endpointKind: "fixed", pruneShape: "gemini" },
    openai: { endpointKind: "user", pruneShape: "openai" },
  })
  assert.deepEqual(ENDPOINT_KINDS, ["fixed", "user"])
})

test("resolve keeps the Gemini fallback for an absent or unknown provider", () => {
  assert.equal(resolveProvider({ provider: "openai" }).id, "openai")
  assert.equal(resolveProvider({ provider: "gemini" }).id, "gemini")
  assert.equal(resolveProvider({}).id, "gemini")
  assert.equal(resolveProvider(undefined).id, "gemini")
  assert.equal(resolveProvider({ provider: "anthropic" }).id, "gemini")
  assert.equal(resolveProvider("openai").id, "openai")
  assert.equal(providerRegistry.has("gemini"), true)
  assert.equal(providerRegistry.has("anthropic"), false)
  assert.equal(providerRegistry.get("anthropic"), null)
})

test("model lists come from the registry instead of a table in each adapter", () => {
  assert.deepEqual(providerModels("gemini", { model: "auto" }), ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"])
  assert.deepEqual(providerModels("gemini", { model: "gemini-3.5-flash-lite" }), ["gemini-3.5-flash-lite"])
  assert.deepEqual(providerModels("gemini", {}), ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"])
  assert.deepEqual(providerModels("gemini", { model: "khong-co" }), ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"])

  assert.deepEqual(providerModels("openai", { llmModel: "qwen2.5:7b" }), ["qwen2.5:7b"])
  assert.throws(() => providerModels("openai", {}), /Hãy nhập tên Model LLM ở mục Dịch ảnh & LLM/)
  assert.deepEqual(providerModels("anthropic", {}), [])
})

test("labels keep the wording each surface already showed", () => {
  assert.equal(providerLabel({ provider: "gemini", model: "gemini-3.5-flash-lite" }), "Gemini (gemini-3.5-flash-lite)")
  assert.equal(providerLabel({ provider: "gemini" }), "Gemini (auto)")
  assert.equal(providerLabel({ provider: "gemini", model: "auto" }, "badge"), "Gemini (auto)")
  assert.equal(providerLabel({ provider: "openai", llmModel: "qwen2.5:7b" }), "qwen2.5:7b")
  assert.equal(providerLabel({ provider: "openai" }), "OpenAI/Local")
  assert.equal(providerLabel({ provider: "openai" }, "badge"), "Local/OpenAI LLM")
  // An unknown id keeps the Gemini fallback on both surfaces.
  assert.equal(providerLabel({ provider: "anthropic" }), "Gemini (auto)")
})

test("prepareCredential moves each provider's screen rules into its descriptor", () => {
  const readField = (value) => () => value

  const gemini = resolveProvider({ provider: "gemini" })
  const stored = { provider: "gemini", model: "auto" }
  assert.equal(gemini.prepareCredential(stored, { vaultKeys: true, readField: readField("") }), stored)
  assert.deepEqual(
    gemini.prepareCredential(stored, { vaultKeys: false, readField: readField("abc") }),
    { ...stored, key: "abc" },
  )
  assert.throws(
    () => gemini.prepareCredential(stored, { vaultKeys: false, readField: readField("") }),
    /Hãy nhập khóa API Gemini\./,
  )

  const openai = resolveProvider({ provider: "openai" })
  const local = { provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" }
  assert.equal(openai.prepareCredential(local, { vaultKeys: true, readField: readField("") }), local)
  assert.deepEqual(
    openai.prepareCredential(local, { vaultKeys: false, readField: readField("k") }),
    { ...local, apiKey: "k" },
  )
  assert.throws(
    () => openai.prepareCredential({ ...local, llmModel: "" }, { vaultKeys: true, readField: readField("") }),
    /Hãy nhập tên Model LLM\./,
  )
  assert.throws(
    () => openai.prepareCredential({ ...local, baseUrl: "ftp://example.com" }, { vaultKeys: true, readField: readField("") }),
    /Chỉ cho phép HTTPS/,
  )
})

test("registration rejects a provider that cannot work", () => {
  const fixedEndpoint = { kind: "fixed", host: "generativelanguage.googleapis.com" }
  const userEndpoint = { kind: "user", field: "baseUrl", validate: (url) => String(url) }

  assert.throws(() => createProviderRegistry([]), /at least one provider is required/)
  assert.throws(
    () => createProviderRegistry([providerEntry(), providerEntry()]),
    /duplicate provider "echo"/,
  )
  assert.throws(() => createProviderRegistry([providerEntry({ id: " " })]), /every provider needs an id/)
  assert.throws(() => createProviderRegistry([providerEntry({ label: "" })]), /needs a label/)
  assert.throws(() => createProviderRegistry([providerEntry({ callStep: null })]), /has no step handler/)
  assert.throws(() => createProviderRegistry([providerEntry({ prepareCredential: null })]), /has no credential handler/)
  assert.throws(() => createProviderRegistry([providerEntry({ models: {} })]), /needs a model list resolver/)
  assert.throws(() => createProviderRegistry([providerEntry({ shape: "anthropic" })]), /unknown transport shape/)

  // Endpoint type mismatch: the transport owns the destination, so the two must agree.
  assert.throws(
    () => createProviderRegistry([providerEntry({ shape: "gemini", endpoint: userEndpoint })]),
    /user endpoint but the gemini transport only speaks fixed/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ shape: "openai", endpoint: fixedEndpoint })]),
    /fixed endpoint but the openai transport only speaks user/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ endpoint: { kind: "proxy" } })]),
    /unknown endpoint kind "proxy"/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ shape: "gemini", endpoint: { kind: "fixed" } })]),
    /needs a fixed endpoint host/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ endpoint: { kind: "user", validate: (url) => url } })]),
    /needs the settings field/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ endpoint: { kind: "user", field: "baseUrl" } })]),
    /needs an endpoint validator/,
  )

  assert.throws(
    () => createProviderRegistry([providerEntry({ credential: { required: "yes" } })]),
    /must declare whether a credential is required/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ credential: { required: true, message: "", vaultMessage: "x", field: "k" } })]),
    /needs a message for its missing credential/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ credential: { required: false, message: "", vaultMessage: "", field: "k" } })]),
    /needs the message shown when the vault holds no key/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ credential: { required: false, message: "", vaultMessage: "x" } })]),
    /needs the settings field/,
  )

  assert.throws(
    () => createProviderRegistry([providerEntry({ capabilities: { audio: true } })]),
    /unknown capability "audio"/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ labels: { agent: () => "Echo" } })]),
    /needs a "badge" label/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ conversation: { pruneShape: "openai" } })]),
    /has no conversation factory/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry({ conversation: { pruneShape: "anthropic", createThread: () => {} } })]),
    /unknown prune shape "anthropic"/,
  )
  assert.throws(
    () => createProviderRegistry([providerEntry()], { fallbackId: "nope" }),
    /fallback provider "nope" is not registered/,
  )
})

test("a registered provider drives a full turn without any harness edit", async () => {
  const seen = []
  let threadArgs = null
  const echo = providerEntry({
    labels: { agent: () => "Echo", badge: () => "Echo" },
    callStep: async ({ thread, toolDefs, stream }) => {
      seen.push({ messages: thread.messages.length, tools: toolDefs.length, stream })
      return { text: `Xin chào từ ${thread.request().messages.length} tin nhắn`, thought: "", toolCalls: [], usage: null }
    },
    conversation: {
      pruneShape: "openai",
      createThread: (args) => {
        threadArgs = args
        const messages = [{ role: "system", content: args.systemPrompt }, { role: "user", content: args.userText }]
        return {
          messages,
          request: () => ({ messages }),
          fallbackChars: () => JSON.stringify(messages).length,
          appendAssistant: () => {},
          appendToolResults: () => {},
        }
      },
    },
  })
  const providers = createProviderRegistry([providerEntry({ id: "gemini", capabilities: { tools: true } }), echo])

  const tools = {
    definitions: () => [{ name: "list_boxes", description: "x", parameters: { type: "object", properties: {} } }],
    getRuntimeSnapshot: () => ({ pageCount: 0 }),
    categoryOf: () => "read",
    async execute() {
      return { ok: true, summary: "x" }
    },
  }
  const result = await runAgentTurn({
    userMessage: "chào",
    settings: { provider: "echo", source: "Japanese", target: "Vietnamese", direction: "rtl" },
    tools,
    providers,
  })

  assert.deepEqual(providers.ids(), ["gemini", "echo"])
  assert.equal(result.answer, "Xin chào từ 2 tin nhắn")
  assert.equal(result.steps, 1)
  // The provider's own label reached the runtime reminder.
  assert.match(threadArgs.userText, /Model: Echo/)
  // Its declared capability, not a provider id check, decides whether tool schemas travel.
  assert.deepEqual(seen, [{ messages: 2, tools: 1, stream: false }])
  assert.equal(result.contextBudget.estimated, true)
})

test("a provider without the tools capability receives no tool schemas", async () => {
  const seen = []
  const solo = providerEntry({
    capabilities: {},
    callStep: async ({ toolDefs }) => {
      seen.push(toolDefs.length)
      return { text: "không công cụ", thought: "", toolCalls: [], usage: null }
    },
  })
  const providers = createProviderRegistry([solo])
  const tools = {
    definitions: () => [{ name: "list_boxes", description: "x", parameters: { type: "object", properties: {} } }],
    getRuntimeSnapshot: () => ({}),
  }
  const result = await runAgentTurn({
    userMessage: "hi",
    settings: { provider: "echo", source: "Japanese", target: "Vietnamese" },
    tools,
    providers,
  })
  assert.deepEqual(seen, [0])
  assert.equal(result.answer, "không công cụ")
})
