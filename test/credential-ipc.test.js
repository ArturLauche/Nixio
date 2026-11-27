import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CREDENTIAL_CODES, CREDENTIAL_MESSAGES, CredentialStore, CredentialStoreError } from "../desktop/credential-store.cjs"
import {
  CREDENTIAL_CHANNELS,
  CredentialService,
  canonicalCredentialScope,
  credentialHandle,
  sanitizeCredentialError,
  trustedChannel,
} from "../desktop/credential-ipc.cjs"

const SECRET = "sk-test-gemini-4f9c1b2a7d6e"
const OTHER = "sk-test-openai-8a1c3d5e7f90"
const root = fileURLToPath(new URL("..", import.meta.url))
const errorOf = async (promise) => promise.catch((value) => value)
// Canonical scopes are validated synchronously, before any store is touched.
const codeOf = (operation) => {
  try { operation() } catch (error) { return error.code }
  return null
}

const mask = (buffer) => {
  const output = Buffer.alloc(buffer.length)
  for (let index = 0; index < buffer.length; index++) output[index] = buffer[index] ^ 0x5a
  return output
}

function stubStore(overrides = {}) {
  const calls = []
  return {
    calls,
    async status() {
      calls.push(["status"])
      return overrides.support ?? { supported: true, provider: "keychain", reason: null }
    },
    async list() {
      calls.push(["list"])
      return overrides.handles ?? []
    },
    async save(provider, secret) {
      calls.push(["save", provider, secret])
      if (overrides.saveError) throw overrides.saveError
      return { provider }
    },
    async remove(provider) {
      calls.push(["remove", provider])
      return overrides.removed ?? true
    },
  }
}

test("fixed providers take no endpoint and the OpenAI-compatible provider needs one", () => {
  assert.equal(canonicalCredentialScope("gemini", undefined), "gemini:fixed")
  assert.equal(canonicalCredentialScope("gemini", null), "gemini:fixed")
  assert.equal(canonicalCredentialScope("gemini", ""), "gemini:fixed")
  for (const endpoint of ["https://generativelanguage.googleapis.com/v1", "http://localhost:8080", 42, {}, []]) {
    assert.equal(codeOf(() => canonicalCredentialScope("gemini", endpoint)), CREDENTIAL_CODES.INVALID_ENDPOINT)
  }
  for (const provider of ["", "Gemini", "openai-compatible", "anthropic", 42, null, undefined]) {
    assert.equal(codeOf(() => canonicalCredentialScope(provider, "https://api.example.com/v1")), CREDENTIAL_CODES.INVALID_PROVIDER)
  }
  for (const endpoint of [undefined, null, "", "not a url", "http://api.example.com/v1", "ftp://api.example.com/v1"]) {
    assert.equal(codeOf(() => canonicalCredentialScope("openai", endpoint)), CREDENTIAL_CODES.INVALID_ENDPOINT)
  }
})

test("a canonical endpoint drops spelling differences but keeps the endpoint distinct", () => {
  const canonical = canonicalCredentialScope("openai", "  https://API.Example.com:443/v1/  ")
  assert.equal(canonical, "openai:https://api.example.com/v1")
  for (const equivalent of ["https://api.example.com/v1", "https://api.example.com/v1/", "HTTPS://api.example.com/v1//"]) {
    assert.equal(canonicalCredentialScope("openai", equivalent), canonical)
  }
  assert.notEqual(canonicalCredentialScope("openai", "https://api.example.com/v2"), canonical)
  assert.notEqual(canonicalCredentialScope("openai", "https://api.example.com:8443/v1"), canonical)
  assert.notEqual(canonicalCredentialScope("openai", "https://other.example.com/v1"), canonical)

  // A local model server stays reachable, but only over the loopback addresses the renderer allows.
  assert.equal(canonicalCredentialScope("openai", "http://localhost:11434/v1"), "openai:http://localhost:11434/v1")
  assert.equal(canonicalCredentialScope("openai", "http://[::1]:11434/v1"), "openai:http://[::1]:11434/v1")
})

test("an endpoint that hides identity or smuggles data is refused", () => {
  const hostile = [
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1?api_key=sk-live-secret",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/" + "a".repeat(4096),
    "javascript:alert(1)",
    "file:///etc/passwd",
  ]
  for (const endpoint of hostile) {
    assert.equal(codeOf(() => canonicalCredentialScope("openai", endpoint)), CREDENTIAL_CODES.INVALID_ENDPOINT, endpoint)
  }
})

test("handles are opaque, stable and fit the store's file name contract", () => {
  const scope = canonicalCredentialScope("openai", "https://api.example.com/v1")
  const handle = credentialHandle(scope)
  assert.equal(handle, credentialHandle(scope))
  assert.match(handle, /^[a-z][a-z0-9-]{0,31}$/)
  assert.equal(handle.length, 32)
  assert.ok(!handle.includes("example"))
  assert.notEqual(credentialHandle(canonicalCredentialScope("gemini", undefined)), handle)
  assert.notEqual(credentialHandle(canonicalCredentialScope("openai", "https://other.example.com/v1")), handle)
})

test("status reports support and only the requested scope's presence", async () => {
  const gemini = credentialHandle(canonicalCredentialScope("gemini"))
  const store = stubStore({ handles: [gemini] })
  const service = new CredentialService({ store })

  assert.deepEqual(await service.status("gemini"), {
    provider: "gemini",
    handle: gemini,
    stored: true,
    supported: true,
    protection: "keychain",
    reason: null,
  })
  const missing = await service.status("openai", "https://api.example.com/v1")
  assert.equal(missing.stored, false)
  assert.deepEqual(store.calls, [["status"], ["list"], ["status"], ["list"]])

  const offline = new CredentialService({ store: stubStore({ support: { supported: false, provider: null, reason: "unavailable" } }) })
  const state = await offline.status("gemini")
  assert.equal(state.supported, false)
  assert.equal(state.protection, null)
  assert.equal(state.reason, "unavailable")
})

test("save and remove address the derived handle and never echo the key", async () => {
  const store = stubStore()
  const service = new CredentialService({ store })
  const handle = credentialHandle(canonicalCredentialScope("openai", "https://api.example.com/v1"))

  const saved = await service.save("openai", "https://api.example.com/v1", SECRET)
  assert.deepEqual(saved, { provider: "openai", handle, stored: true })
  assert.deepEqual(store.calls, [["save", handle, SECRET]])
  assert.ok(!JSON.stringify(saved).includes(SECRET))

  assert.deepEqual(await service.remove("openai", "https://api.example.com/v1"), { provider: "openai", handle, removed: true })
  assert.deepEqual(store.calls.at(-1), ["remove", handle])
})

test("a renderer cannot reach another endpoint's key by naming it", async () => {
  const store = stubStore()
  const service = new CredentialService({ store })
  const first = await service.save("openai", "https://first.example.com/v1", SECRET)
  const second = await service.save("openai", "https://second.example.com/v1", OTHER)

  assert.notEqual(first.handle, second.handle)
  assert.deepEqual(store.calls.map((call) => call[1]), [first.handle, second.handle])

  // A key can only be removed through the endpoint it was saved for, and a fixed provider cannot be
  // given an endpoint at all.
  await service.remove("openai", "https://second.example.com/v1/")
  assert.deepEqual(store.calls.at(-1), ["remove", second.handle])
  assert.equal((await errorOf(service.save("gemini", "https://first.example.com/v1", SECRET))).code, CREDENTIAL_CODES.INVALID_ENDPOINT)
  assert.equal(store.calls.length, 3)
})

test("the service and store keep two endpoints of one provider in separate records", async (t) => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "nixio-credentials-ipc-"))
  t.after(() => rm(userData, { recursive: true, force: true }))
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(plaintext) {
      return Buffer.concat([Buffer.from("v10", "latin1"), mask(Buffer.from(plaintext, "utf8"))])
    },
    async decryptStringAsync(ciphertext) {
      return { shouldReEncrypt: false, result: mask(Buffer.from(ciphertext).subarray(3)).toString("utf8") }
    },
  }
  const store = new CredentialStore({ userData, safeStorage, platform: process.platform === "win32" ? "win32" : "darwin" })
  const service = new CredentialService({ store })

  const first = await service.save("openai", "https://first.example.com/v1", SECRET)
  const second = await service.save("openai", "https://second.example.com/v1", OTHER)
  assert.equal(await store.read(first.handle), SECRET)
  assert.equal(await store.read(second.handle), OTHER)
  assert.equal((await service.status("openai", "https://first.example.com/v1")).stored, true)
  assert.equal((await service.status("openai", "https://third.example.com/v1")).stored, false)

  const names = await readdir(path.join(userData, "credentials"))
  assert.deepEqual(names, [`${first.handle}.json`, `${second.handle}.json`].sort())
  for (const name of names) {
    const raw = await readFile(path.join(userData, "credentials", name), "utf8")
    assert.ok(!raw.includes(SECRET) && !raw.includes(OTHER), `${name} leaks a key`)
  }

  assert.equal((await service.remove("openai", "https://second.example.com/v1")).removed, true)
  assert.equal(await store.read(second.handle), null)
  assert.equal(await store.read(first.handle), SECRET)
})

test("untrusted frames are refused before the action runs", async () => {
  let called = 0
  const action = async () => { called++; return "done" }
  const denied = trustedChannel(() => false, action)
  assert.deepEqual(await denied({}), { error: "Untrusted desktop frame." })
  assert.equal(called, 0)

  // A frame check that throws is a denied frame, not an unhandled rejection.
  const broken = trustedChannel(() => { throw new Error("no sender frame") }, action)
  assert.deepEqual(await broken({}), { error: "Untrusted desktop frame." })
  assert.equal(called, 0)

  // Only an explicit true trusts a frame.
  for (const truthy of [1, "yes", {}, undefined]) {
    assert.deepEqual(await trustedChannel(() => truthy, action)({}), { error: "Untrusted desktop frame." })
  }
  assert.equal(called, 0)

  assert.deepEqual(await trustedChannel(() => true, action)({}), { value: "done" })
  assert.equal(called, 1)
})

test("a trusted credential channel only ever reports a fixed message", async () => {
  const leaky = new Error(`cannot encrypt ${SECRET}`)
  const channel = trustedChannel(() => true, async () => { throw leaky }, sanitizeCredentialError)
  const denied = await channel({})
  assert.deepEqual(denied, { error: "The credential operation failed." })

  const storeError = new CredentialStoreError(CREDENTIAL_CODES.UNPROTECTED)
  const known = await trustedChannel(() => true, async () => { throw storeError }, sanitizeCredentialError)({})
  assert.deepEqual(known, { error: CREDENTIAL_MESSAGES[CREDENTIAL_CODES.UNPROTECTED] })

  // A foreign error that merely copies a credential code is not trusted either.
  const forged = Object.assign(new Error(SECRET), { name: "CredentialStoreError", code: CREDENTIAL_CODES.UNPROTECTED })
  assert.equal(sanitizeCredentialError(forged), "The credential operation failed.")
  assert.ok(!sanitizeCredentialError(leaky).includes(SECRET))

  // Errors that carry a cause or a stack never reach the envelope.
  const caused = new CredentialStoreError(CREDENTIAL_CODES.IO, { cause: new Error(`ENOENT ${SECRET}`) })
  assert.equal(sanitizeCredentialError(caused), CREDENTIAL_MESSAGES[CREDENTIAL_CODES.IO])
})

test("the credential channels are the only ones that exist", () => {
  assert.deepEqual(Object.keys(CREDENTIAL_CHANNELS).sort(), ["remove", "save", "status"])
  assert.deepEqual(Object.values(CREDENTIAL_CHANNELS), [
    "khung-thoai:credential-status",
    "khung-thoai:credential-save",
    "khung-thoai:credential-remove",
  ])
})

test("preload exposes write, status and remove only, and nothing logs a credential", async () => {
  const preload = await readFile(path.join(root, "desktop", "preload.cjs"), "utf8")
  for (const method of ["credentialStatus", "credentialSave", "credentialRemove"]) {
    assert.match(preload, new RegExp(`${method}:`))
  }
  for (const forbidden of ["credentialRead", "credentialList", "credentialExport", "credentialGet"]) {
    assert.doesNotMatch(preload, new RegExp(forbidden))
  }
  // The bridge can only reach the channels main actually registers.
  const bridged = [...preload.matchAll(/invoke\("(credential-[a-z]+)"/g)].map((match) => "khung-thoai:" + match[1])
  assert.deepEqual(bridged.sort(), Object.values(CREDENTIAL_CHANNELS).sort())

  for (const file of ["credential-store.cjs", "credential-ipc.cjs", "preload.cjs"]) {
    const source = await readFile(path.join(root, "desktop", file), "utf8")
    assert.doesNotMatch(source, /console\.\w+\(/, `${file} must not log`)
  }
})
