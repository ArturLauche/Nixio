import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { migrateLegacyCredentials } from "../src/credential-settings.js"

// The settings screen and the provider calls share two inputs (provider and Base URL). These tests
// drive the real translation controller against a fake document and a synthetic desktop shell, so the
// assertions are about what reached the vault, what reached main, and what the password fields were
// asked for. Every credential below is synthetic, every exchange is in memory, and nothing here opens
// a socket or a keychain.

const CONFIG_KEY = "khung-thoai-llm-config"
const OPENAI_BASE = "https://api.example.com/v1"
const OTHER_BASE = "https://api.other.example/v1"
const VAULT_GEMINI = "AIza-vault-gemini-5c08"
const VAULT_OPENAI = "sk-vault-openai-2b71"
// A value typed into a password field. It must never reach an envelope, storage or a log.
const TYPED_SECRET = "sk-typed-in-the-field-3f9d"

const SAVED_MESSAGE = "Đã lưu khóa API vào kho bảo mật của hệ điều hành."
const REMOVED_MESSAGE = "Đã xóa khóa API khỏi kho bảo mật của hệ điều hành."
const KEYLESS_MESSAGE = "Không có khóa mới để lưu"

function fakeElement(id = "div") {
  const listeners = new Map()
  const element = {
    id,
    tagName: "DIV",
    children: [],
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    onclick: null,
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener() {},
    dispatch(type, event) { return listeners.get(type)?.(event) },
    setAttribute(name, value) { element[name] = String(value) },
    getAttribute(name) { return element[name] },
    removeAttribute(name) { delete element[name] },
    querySelectorAll() { return [] },
    querySelector() { return null },
    focus() { element.focused = true },
    click() { if (!element.disabled) element.onclick?.() },
  }
  return element
}

// A document whose two password inputs report every read. Nothing in the desktop path is allowed to
// read them, so the recorded list is the strongest available statement of "the key was never taken".
function createDom() {
  const elements = new Map()
  const held = new Map()
  const secretReads = []
  const build = (id) => {
    const element = fakeElement(id)
    if (id !== "gemini-key" && id !== "llm-key") return element
    Object.defineProperty(element, "value", {
      configurable: true,
      get() { secretReads.push(id); return held.get(id) ?? "" },
      set(next) { held.set(id, String(next ?? "")) },
    })
    return element
  }
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, build(id))
    return elements.get(id)
  }
  return {
    byId,
    secretReads,
    // Reads the field's contents without counting as a read, so a test can inspect what a channel saw.
    peek: (id) => held.get(id) ?? "",
  }
}

function memoryStorage(seed = {}) {
  const entries = new Map(Object.entries(seed))
  return {
    entries,
    getItem(key) { return entries.has(key) ? entries.get(key) : null },
    setItem(key, value) { entries.set(key, String(value)) },
    removeItem(key) { entries.delete(key) },
    snapshot() { return Object.fromEntries(entries) },
  }
}

const scopeKey = (provider, endpoint) => (provider === "gemini" ? "gemini:fixed" : "openai:" + endpoint)

// The three credential channels main exposes. The key enters through `save` and nothing comes back.
function credentialChannels({ vault, supported = true, reason = null, peek, holdSave = null }) {
  const calls = { status: [], save: [], remove: [] }
  const api = {
    async credentialStatus(provider, endpoint) {
      calls.status.push([provider, endpoint])
      return {
        stored: vault.has(scopeKey(provider, endpoint)),
        supported,
        protection: supported ? "safeStorage" : null,
        reason,
      }
    },
    async credentialSave(provider, endpoint, secret) {
      // What the field held at the moment the save was dispatched, without counting as a read.
      calls.save.push([provider, endpoint, secret, peek?.(provider === "gemini" ? "gemini-key" : "llm-key")])
      if (holdSave) await holdSave
      if (!supported) throw new Error("vault unavailable")
      vault.set(scopeKey(provider, endpoint), secret)
      return { provider, handle: scopeKey(provider, endpoint), stored: true }
    },
    async credentialRemove(provider, endpoint) {
      calls.remove.push([provider, endpoint])
      return { provider, handle: scopeKey(provider, endpoint), removed: vault.delete(scopeKey(provider, endpoint)) }
    },
  }
  return { api, calls }
}

// The trusted provider proxy: main owns the destination and the credential, so the renderer only ever
// sends a provider, an operation and a payload.
function providerChannels({ answer, requests, failure = null }) {
  const api = {
    async providerRequest(envelope) {
      requests.push(JSON.parse(JSON.stringify(envelope)))
      if (failure) return { ok: false, ...failure }
      return { ok: true, status: 200, contentType: "json", body: JSON.stringify(answer) }
    },
    async providerStream(envelope) {
      requests.push(JSON.parse(JSON.stringify(envelope)))
      return { ok: false, code: "ERR_PROVIDER_POLICY", message: "This path does not stream." }
    },
    providerActivate: () => ({ ok: true, active: true }),
    providerCancel: () => ({ ok: true }),
    onProviderEvent: () => () => {},
  }
  return { api }
}

const openAiAnswer = (text) => ({
  choices: [{ message: { content: JSON.stringify({ lines: [{ id: "B1", text }] }) } }],
})
const geminiAnswer = (text) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ lines: [{ id: "B1", text }] }) }] } }],
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function installGlobals(t, { storage, desktop }) {
  const previous = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    Option: globalThis.Option,
    FileReader: globalThis.FileReader,
    desktop: globalThis.khungThoaiDesktop,
    fetch: globalThis.fetch,
  }
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  }
  globalThis.localStorage = storage
  globalThis.Option = class {
    constructor(text, value) { this.text = text; this.value = value }
  }
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA"
      queueMicrotask(() => this.onload())
    }
  }
  if (desktop) globalThis.khungThoaiDesktop = desktop
  else delete globalThis.khungThoaiDesktop
  t.after(() => {
    globalThis.document = previous.document
    globalThis.localStorage = previous.localStorage
    globalThis.Option = previous.Option
    globalThis.FileReader = previous.FileReader
    globalThis.fetch = previous.fetch
    if (previous.desktop === undefined) delete globalThis.khungThoaiDesktop
    else globalThis.khungThoaiDesktop = previous.desktop
  })
}

function pageFixture() {
  return {
    id: "p1",
    name: "page-1",
    file: { name: "page.png", type: "image/png", size: 64 },
    boxes: [{ id: "b1", text: "おはよう" }],
    unplaced: [],
    canvas: {},
  }
}

async function createHarness(t, {
  desktop = false,
  storage = memoryStorage(),
  answer = null,
  failure = null,
  vault = new Map(),
  supported = true,
  reason = null,
  holdSave = null,
  configWritesReady = undefined,
  withMigration = false,
} = {}) {
  const dom = createDom()
  const page = pageFixture()
  const requests = []
  const statuses = []
  const tokens = { requests, vault, calls: { status: [], save: [], remove: [] } }
  let desktopShell
  if (desktop) {
    const credentials = credentialChannels({ vault, supported, reason, peek: dom.peek, holdSave })
    const providers = providerChannels({ answer, requests, failure })
    desktopShell = { ...credentials.api, ...providers.api }
    tokens.calls = credentials.calls
  }
  installGlobals(t, { storage, desktop: desktopShell })
  // The markup's own defaults: the provider select always has a value, so an empty string never
  // stands in for "Gemini" in a test.
  dom.byId("translation-provider").value = "gemini"
  dom.byId("gemini-model").value = "auto"
  dom.byId("source-language").value = "Japanese"
  dom.byId("target-language").value = "Vietnamese"
  dom.byId("direction").value = "ltr"
  dom.byId("llm-base-url").value = "http://localhost:11434/v1"
  const { setupTranslation } = await import("../src/controllers/translation.js")
  // Mirrors `src/main.js`: the migration starts before the controller exists and its promise gates
  // every settings write.
  const migration = withMigration ? migrateLegacyCredentials() : undefined
  setupTranslation({
    state: { pages: [page] },
    byId: dom.byId,
    status: (message, error = false) => { statuses.push({ message, error }) },
    checkpoint() {},
    render() {},
    renderPages() {},
    renderInspector() {},
    renderCanvas() {},
    selectedPage: () => page,
    pageForScript: () => page,
    applyTranslation: () => 0,
    projectBusy: () => false,
    configWritesReady: withMigration ? migration : configWritesReady,
    onSettingsChange() {},
    notify() {},
    notifyOverflowIfAny() {},
  })
  return {
    ...tokens,
    dom,
    page,
    storage,
    statuses,
    migration,
    byId: dom.byId,
    secretReads: dom.secretReads,
    status: (id) => dom.byId(id).textContent,
    lastStatus: () => statuses.at(-1),
    selectProvider(provider, baseUrl) {
      dom.byId("translation-provider").value = provider
      dom.byId("translation-provider").onchange()
      if (baseUrl !== undefined) {
        dom.byId("llm-base-url").value = baseUrl
        dom.byId("llm-base-url").onchange()
      }
    },
  }
}

test("a desktop translation reaches main through the vault and never reads the password field", async (t) => {
  const harness = await createHarness(t, { desktop: true, answer: openAiAnswer("Chào buổi sáng") })
  harness.selectProvider("openai", OPENAI_BASE)
  harness.byId("llm-model").value = "hy-mt2-manga"
  harness.byId("llm-key").value = TYPED_SECRET

  await harness.byId("translate-boxes").onclick()

  assert.deepEqual(harness.secretReads, [], "the desktop path must not read the key field")
  assert.equal(harness.page.boxes[0].text, "Chào buổi sáng")
  assert.equal(harness.requests.length, 1)
  // The status line and the request are bound to the same endpoint the field shows.
  assert.deepEqual(harness.calls.status.at(-1), ["openai", OPENAI_BASE])
  assert.equal(harness.requests[0].endpoint, OPENAI_BASE)
  assert.deepEqual(
    Object.keys(harness.requests[0]).sort(),
    ["endpoint", "operation", "payload", "provider", "requestId"],
    "the envelope carries no key, header or URL override",
  )
  assert.equal(JSON.stringify(harness.requests).includes(TYPED_SECRET), false)
})

test("a desktop Gemini with an empty vault is rejected without reading the field", async (t) => {
  const harness = await createHarness(t, {
    desktop: true,
    failure: { code: "ERR_PROVIDER_CREDENTIAL", message: "No usable API key is stored for this provider and endpoint." },
  })
  harness.byId("gemini-key").value = TYPED_SECRET

  await harness.byId("translate-boxes").onclick()

  assert.deepEqual(harness.secretReads, [], "an unconfigured provider is main's answer, not the field's")
  assert.match(harness.lastStatus().message, /Chưa có khóa API Gemini trong kho bảo mật/)
  assert.equal(harness.lastStatus().error, true)
  assert.equal(harness.page.boxes[0].text, "おはよう", "a rejected turn leaves the page untouched")
  assert.equal(JSON.stringify(harness.requests).includes(TYPED_SECRET), false)
})

test("a browser keeps using the field in memory and persists nothing", async (t) => {
  const harness = await createHarness(t, { desktop: false, answer: geminiAnswer("Xin chào") })
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return new Response(JSON.stringify(geminiAnswer("Xin chào")), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  harness.byId("gemini-key").value = TYPED_SECRET

  await harness.byId("translate-boxes").onclick()

  assert.deepEqual(harness.secretReads, ["gemini-key"], "a browser reads the field once, at request time")
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].init.headers["x-goog-api-key"], TYPED_SECRET)
  assert.equal(harness.page.boxes[0].text, "Xin chào")
  assert.deepEqual(harness.storage.snapshot(), {}, "no key reaches renderer storage")
  // A browser has no vault, so the vault controls stay hidden and the status line says so.
  assert.equal(harness.byId("gemini-key-actions").hidden, true)
  assert.match(harness.status("gemini-key-status"), /phiên làm việc/)
})

test("saving hands the key to main and clears the field before the answer arrives", async (t) => {
  const harness = await createHarness(t, { desktop: true })

  harness.byId("gemini-key").value = TYPED_SECRET
  const saving = harness.byId("gemini-key-save").onclick()
  await saving

  assert.deepEqual(harness.calls.save.map(([provider, endpoint, secret]) => [provider, endpoint, secret]), [
    ["gemini", undefined, TYPED_SECRET],
  ])
  assert.equal(harness.calls.save[0][3], "", "the field was already empty when the save was dispatched")
  assert.equal(harness.vault.get("gemini:fixed"), TYPED_SECRET)
  assert.equal(harness.byId("gemini-key").value, "", "there is no readback into the field")
  assert.equal(harness.status("gemini-key-status"), SAVED_MESSAGE)
  assert.equal(harness.byId("gemini-key-remove").disabled, false)
  assert.deepEqual(harness.storage.snapshot(), {})
  assert.equal(harness.byId("gemini-key-actions").hidden, false)

  await harness.byId("gemini-key-remove").onclick()

  assert.equal(harness.vault.has("gemini:fixed"), false)
  assert.equal(harness.status("gemini-key-status"), REMOVED_MESSAGE)
  assert.equal(harness.byId("gemini-key-remove").disabled, true)
  assert.deepEqual(harness.storage.snapshot(), {})
})

test("changing the Base URL clears a value typed for the previous endpoint", async (t) => {
  const harness = await createHarness(t, { desktop: true })
  harness.selectProvider("openai", OPENAI_BASE)
  harness.byId("llm-key").value = TYPED_SECRET

  harness.byId("llm-base-url").value = OTHER_BASE
  harness.byId("llm-base-url").onchange()

  assert.equal(harness.byId("llm-key").value, "", "a stale value cannot follow the scope")
  assert.deepEqual(harness.calls.status.at(-1), ["openai", OTHER_BASE])
  // Clicking save now saves nothing: the keyless endpoint keeps working without a credential.
  await harness.byId("llm-key-save").onclick()
  assert.deepEqual(harness.calls.save, [])
  assert.match(harness.status("llm-key-status"), new RegExp(KEYLESS_MESSAGE))
})

test("switching provider clears the other field and suppresses a late vault answer", async (t) => {
  let release
  const holdSave = new Promise((resolve) => { release = resolve })
  const harness = await createHarness(t, { desktop: true, holdSave })
  harness.byId("gemini-key").value = TYPED_SECRET

  const saving = harness.byId("gemini-key-save").onclick()
  // The user moves to the OpenAI-compatible scope before main answers.
  harness.selectProvider("openai", OPENAI_BASE)
  assert.equal(harness.byId("gemini-key").value, "", "the switch clears the Gemini field")

  release()
  const outcome = await saving

  assert.equal(outcome.superseded, true, "the save reports that it was superseded")
  assert.equal(outcome.persisted, true, "main's own answer is not denied")
  assert.equal(harness.vault.get("gemini:fixed"), TYPED_SECRET)
  assert.equal(harness.status("gemini-key-status"), "", "a stale answer is never rendered")
  assert.notEqual(harness.status("llm-key-status"), SAVED_MESSAGE)
})

test("the settings writer waits for the startup migration and writes no key", async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const storage = memoryStorage({
    [CONFIG_KEY]: JSON.stringify({ provider: "openai", baseUrl: OPENAI_BASE, llmModel: "cũ", geminiKey: VAULT_GEMINI }),
  })
  const harness = await createHarness(t, { desktop: true, storage, configWritesReady: gate })

  harness.byId("llm-model").value = "qwen2.5:7b"
  harness.byId("llm-model").onchange()
  await tick()
  assert.equal(JSON.parse(storage.getItem(CONFIG_KEY)).llmModel, "cũ", "the write waits for the migration")

  release()
  await tick()
  const record = JSON.parse(storage.getItem(CONFIG_KEY))
  assert.deepEqual(record, { provider: "openai", baseUrl: OPENAI_BASE, llmModel: "qwen2.5:7b" })
  assert.equal(Object.hasOwn(record, "geminiKey"), false)
})

test("the startup migration erases legacy keys before the writer can clobber them", async (t) => {
  const legacy = {
    provider: "openai",
    baseUrl: OPENAI_BASE,
    llmModel: "hy-mt2-manga",
    geminiKey: VAULT_GEMINI,
    openaiKey: VAULT_OPENAI,
    apiKey: TYPED_SECRET,
    futureField: "not-ours",
  }
  const storage = memoryStorage({ [CONFIG_KEY]: JSON.stringify(legacy) })
  const harness = await createHarness(t, { desktop: true, storage, withMigration: true, vault: new Map() })

  // A user edit that lands while the migration is running must not rewrite the record first.
  harness.byId("llm-model").value = "gpt-4o-mini"
  harness.byId("llm-model").onchange()

  const outcome = await harness.migration
  assert.equal(outcome.code, "MIGRATION_REENTRY", "an ambiguous apiKey forces a re-entry instead of a guess")
  assert.equal(outcome.needsReentry, true)
  assert.match(outcome.message, /nhập lại khóa/)
  assert.equal(harness.vault.get("gemini:fixed"), VAULT_GEMINI)
  assert.equal(harness.vault.get("openai:" + OPENAI_BASE), VAULT_OPENAI)

  await tick()
  const record = JSON.parse(storage.getItem(CONFIG_KEY))
  assert.deepEqual(record, { provider: "openai", baseUrl: OPENAI_BASE, llmModel: "gpt-4o-mini" })
  const persisted = JSON.stringify(harness.storage.snapshot())
  for (const secret of [VAULT_GEMINI, VAULT_OPENAI, TYPED_SECRET]) {
    assert.equal(persisted.includes(secret), false, "no plaintext key survives in storage")
  }
})

test("the settings markup exposes the write-only controls the controller binds", async () => {
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
  for (const id of [
    "gemini-key", "gemini-key-save", "gemini-key-remove", "gemini-key-status", "gemini-key-actions",
    "llm-key", "llm-key-save", "llm-key-remove", "llm-key-status", "llm-key-actions",
  ]) {
    assert.equal(markup.includes(`id="${id}"`), true, `${id} is missing from index.html`)
  }
  for (const id of ["gemini-key", "llm-key"]) {
    const tag = new RegExp(`<input id="${id}"[^>]*>`).exec(markup)?.[0] ?? ""
    assert.match(tag, /type="password"/, `${id} stays a write-only password input`)
    assert.equal(tag.includes("value="), false, `${id} is never prefilled by the markup`)
  }
  // A browser has no vault, so the controls stay hidden until the desktop shell reveals them.
  for (const id of ["gemini-key-actions", "llm-key-actions"]) {
    assert.match(new RegExp(`<div id="${id}"[^>]*>`).exec(markup)?.[0] ?? "", /hidden/)
  }
})
