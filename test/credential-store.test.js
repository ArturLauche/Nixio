import assert from "node:assert/strict"
import test from "node:test"
import * as fsPromises from "node:fs/promises"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CREDENTIAL_CODES, CredentialStore } from "../desktop/credential-store.cjs"

// Synthetic values stand in for API keys: no real credential is ever used by these tests.
const SECRET = "sk-test-gemini-4f9c1b2a7d6e"
const OTHER = "sk-test-openai-8a1c3d5e7f90"
const PREFIX = "FAKE1:"

const mask = (buffer) => {
  const output = Buffer.alloc(buffer.length)
  for (let index = 0; index < buffer.length; index++) output[index] = buffer[index] ^ 0x5a
  return output
}

// Stands in for Electron safeStorage. It records usage and produces non-deterministic ciphertext so
// a rewrite is observable, but it never contains the plaintext.
function fakeSafeStorage(options = {}) {
  const { available = true, availableError, encryptError, decryptError, rotate = 0 } = options
  const calls = { encrypt: 0, decrypt: 0, plaintext: 0, rotations: 0 }
  let serial = 0
  let rotations = rotate
  const safeStorage = {
    async isAsyncEncryptionAvailable() {
      if (availableError) throw availableError
      return available
    },
    async encryptStringAsync(plaintext) {
      calls.encrypt++
      if (encryptError) throw typeof encryptError === "function" ? encryptError(plaintext) : encryptError
      return Buffer.concat([Buffer.from(`${PREFIX}${++serial}:`, "utf8"), mask(Buffer.from(plaintext, "utf8"))])
    },
    async decryptStringAsync(ciphertext) {
      calls.decrypt++
      if (decryptError) throw typeof decryptError === "function" ? decryptError(ciphertext) : decryptError
      const raw = Buffer.from(ciphertext).toString("latin1")
      const match = /^FAKE1:\d+:/.exec(raw)
      if (!match) throw new Error("not a fake ciphertext")
      const shouldReEncrypt = rotations > 0
      if (shouldReEncrypt) {
        rotations--
        calls.rotations++
      }
      return { shouldReEncrypt, result: mask(Buffer.from(raw.slice(match[0].length), "latin1")).toString("utf8") }
    },
    setUsePlainTextEncryption() { calls.plaintext++ },
  }
  if (Object.hasOwn(options, "backend")) safeStorage.getSelectedStorageBackend = () => options.backend
  return { safeStorage, calls }
}

async function prepare(t, { platform = "darwin", safeStorage = {}, fileSystem } = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "nixio-credentials-"))
  t.after(() => rm(userData, { recursive: true, force: true }))
  const fake = fakeSafeStorage(safeStorage)
  const store = new CredentialStore({ userData, safeStorage: fake.safeStorage, platform, fileSystem })
  return { store, userData, calls: fake.calls, safeStorage: fake.safeStorage, platform }
}

const recordPath = (userData, provider) => path.join(userData, "credentials", `${provider}.json`)

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    found.push(...(entry.isDirectory() ? await listFiles(full) : [full]))
  }
  return found
}

test("supported OS protection round-trips a credential through the injected safeStorage", async (t) => {
  const { store, userData, calls } = await prepare(t)
  assert.deepEqual(await store.save("gemini", SECRET), { provider: "gemini" })
  assert.equal(await store.read("gemini"), SECRET)
  assert.deepEqual(await store.list(), ["gemini"])
  assert.equal(await store.remove("gemini"), true)
  assert.equal(await store.read("gemini"), null)
  assert.equal(calls.plaintext, 0, "the store must never enable Electron plaintext encryption")

  await store.save("gemini", SECRET)
  const raw = await readFile(recordPath(userData, "gemini"), "utf8")
  const stored = JSON.parse(raw)
  assert.deepEqual(Object.keys(stored).sort(), ["ciphertext", "version"])
  assert.equal(stored.version, 1)
  assert.ok(!raw.includes(SECRET))
  assert.equal(Buffer.from(stored.ciphertext, "base64").includes(Buffer.from(SECRET, "utf8")), false)

  if (process.platform !== "win32") {
    assert.equal((await stat(recordPath(userData, "gemini"))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(userData, "credentials"))).mode & 0o777, 0o700)
  }
})

test("records never contain plaintext keys and replacements replace the ciphertext", async (t) => {
  const { store, userData } = await prepare(t)
  const providers = ["gemini", "openai-compatible"]
  await store.save(providers[0], SECRET)
  const before = await readFile(recordPath(userData, providers[0]), "utf8")
  await store.save(providers[1], OTHER)
  await store.save(providers[0], OTHER)

  const after = await readFile(recordPath(userData, providers[0]), "utf8")
  assert.notEqual(after, before)
  assert.equal(await store.read(providers[0]), OTHER)
  assert.deepEqual(await store.list(), providers)
  assert.deepEqual(await readdir(path.join(userData, "credentials")), ["gemini.json", "openai-compatible.json"])

  for (const file of await listFiles(userData)) {
    const bytes = await readFile(file)
    for (const secret of [SECRET, OTHER]) {
      assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `${file} leaks a plaintext key`)
      assert.equal(bytes.includes(Buffer.from(secret, "utf16le")), false, `${file} leaks a plaintext key`)
    }
    const stored = JSON.parse(bytes.toString("utf8"))
    assert.equal(stored.version, 1)
    assert.equal(Buffer.from(stored.ciphertext, "base64").toString("base64"), stored.ciphertext)
  }
})

test("a missing record reads as null without creating the credential directory", async (t) => {
  const { store, userData } = await prepare(t)
  assert.equal(await store.read("gemini"), null)
  assert.equal(await store.remove("gemini"), false)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(stat(path.join(userData, "credentials")), /ENOENT/)
})

test("records persist across store instances", async (t) => {
  const first = await prepare(t)
  await first.store.save("openai-compatible", OTHER)
  const reopened = new CredentialStore({ userData: first.userData, safeStorage: first.safeStorage, platform: "darwin" })
  assert.equal(await reopened.read("openai-compatible"), OTHER)
  assert.deepEqual(await reopened.list(), ["openai-compatible"])
})

test("an encryption failure rejects without exposing the key or replacing the previous record", async (t) => {
  const { store, userData } = await prepare(t)
  await store.save("gemini", SECRET)
  const failing = new CredentialStore({
    userData,
    safeStorage: fakeSafeStorage({ encryptError: (plaintext) => new Error(`encryption failed for ${plaintext}`) }).safeStorage,
    platform: "darwin",
  })

  const error = await failing.save("gemini", OTHER).catch((value) => value)
  assert.equal(error.code, CREDENTIAL_CODES.ENCRYPT)
  assert.ok(!error.message.includes(OTHER))
  assert.ok(!String(error.cause?.message ?? "").includes(OTHER))
  assert.equal(await store.read("gemini"), SECRET)
})

test("decryption failures and tampered records fail closed and can be repaired", async (t) => {
  const { store, userData } = await prepare(t)
  await store.save("gemini", SECRET)
  const record = recordPath(userData, "gemini")

  const locked = new CredentialStore({
    userData,
    safeStorage: fakeSafeStorage({ decryptError: new Error("secret service locked") }).safeStorage,
    platform: "darwin",
  })
  assert.equal((await locked.read("gemini").catch((value) => value)).code, CREDENTIAL_CODES.DECRYPT)

  await writeFile(record, "not json")
  assert.equal((await store.read("gemini").catch((value) => value)).code, CREDENTIAL_CODES.CORRUPT)

  await writeFile(record, JSON.stringify({ version: 2, ciphertext: "AAAA" }))
  assert.equal((await store.read("gemini").catch((value) => value)).code, CREDENTIAL_CODES.CORRUPT)

  await writeFile(record, JSON.stringify({ version: 1, ciphertext: "%%%not-base64%%%" }))
  assert.equal((await store.read("gemini").catch((value) => value)).code, CREDENTIAL_CODES.CORRUPT)

  await store.save("gemini", OTHER)
  assert.equal(await store.read("gemini"), OTHER)
})

test("unavailable OS encryption refuses reads and writes without a fallback", async (t) => {
  const base = await prepare(t)
  await base.store.save("gemini", SECRET)

  const off = await prepare(t, { safeStorage: { available: false } })
  assert.deepEqual(await off.store.status(), { supported: false, backend: "keychain", reason: "unavailable" })
  assert.equal((await off.store.save("gemini", SECRET).catch((value) => value)).code, CREDENTIAL_CODES.UNAVAILABLE)
  await assert.rejects(stat(path.join(off.userData, "credentials")), /ENOENT/)
  assert.equal(off.calls.encrypt, 0)

  const locked = new CredentialStore({ userData: base.userData, safeStorage: fakeSafeStorage({ available: false }).safeStorage, platform: "darwin" })
  assert.equal((await locked.read("gemini").catch((value) => value)).code, CREDENTIAL_CODES.UNAVAILABLE)
  assert.equal(await base.store.read("gemini"), SECRET)

  const throwing = await prepare(t, { safeStorage: { availableError: new Error("keychain timed out") } })
  assert.equal((await throwing.store.status()).reason, "unavailable")
})

test("Linux backends without OS protection are refused before encryption", async (t) => {
  for (const backend of ["basic_text", "unknown", "libsecret", "gnome-libsecret", ""]) {
    const { store, userData, calls } = await prepare(t, { platform: "linux", safeStorage: { backend } })
    const status = await store.status()
    assert.equal(status.supported, false)
    assert.equal(status.reason, backend === "basic_text" ? "insecure-backend" : "unsupported-backend")
    assert.equal((await store.save("gemini", SECRET).catch((value) => value)).code, CREDENTIAL_CODES.UNPROTECTED)
    assert.equal(calls.encrypt, 0)
    await assert.rejects(stat(path.join(userData, "credentials")), /ENOENT/)
  }

  const missing = await prepare(t, { platform: "linux" })
  assert.equal((await missing.store.status()).reason, "unsupported-backend")
  assert.equal((await missing.store.save("gemini", SECRET).catch((value) => value)).code, CREDENTIAL_CODES.UNPROTECTED)
})

test("a protected Linux backend round-trips the credential", async (t) => {
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    const { store } = await prepare(t, { platform: "linux", safeStorage: { backend } })
    assert.deepEqual(await store.status(), { supported: true, backend, reason: null })
    await store.save("gemini", SECRET)
    assert.equal(await store.read("gemini"), SECRET)
  }
})

test("a failed atomic replace keeps the previous encrypted record", async (t) => {
  let blocked = false
  const fileSystem = {
    ...fsPromises,
    rename(source, target) {
      if (blocked) throw Object.assign(new Error("EPERM: rename blocked"), { code: "EPERM" })
      return fsPromises.rename(source, target)
    },
  }
  const { store, userData } = await prepare(t, { fileSystem })
  await store.save("gemini", SECRET)

  blocked = true
  assert.equal((await store.save("gemini", OTHER).catch((value) => value)).code, CREDENTIAL_CODES.IO)
  assert.equal(await store.read("gemini"), SECRET)
  assert.deepEqual(await readdir(path.join(userData, "credentials")), ["gemini.json"])

  blocked = false
  await store.save("gemini", OTHER)
  assert.equal(await store.read("gemini"), OTHER)
})

test("concurrent saves and reads stay consistent", async (t) => {
  const { store, userData } = await prepare(t)
  const providers = Array.from({ length: 8 }, (_, index) => `provider-${index}`)
  await Promise.all(providers.map((provider) => store.save(provider, `${SECRET}-${provider}`)))
  assert.deepEqual(await store.list(), providers)
  assert.deepEqual(
    await Promise.all(providers.map((provider) => store.read(provider))),
    providers.map((provider) => `${SECRET}-${provider}`),
  )

  await Promise.all([
    store.save(providers[0], `${OTHER}-first`),
    store.save(providers[0], `${OTHER}-second`),
    store.read(providers[1]),
  ])
  assert.ok([`${OTHER}-first`, `${OTHER}-second`].includes(await store.read(providers[0])))
  const names = await readdir(path.join(userData, "credentials"))
  assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), [])
  assert.equal(names.length, providers.length)
})

test("invalid handles and keys are refused before the OS store is used", async (t) => {
  const { store, userData, calls } = await prepare(t)
  for (const provider of ["", "Gemini", "../escape", "gemini.json", "gemini/2", "a".repeat(33), 42, null]) {
    assert.equal((await store.save(provider, SECRET).catch((value) => value)).code, CREDENTIAL_CODES.INVALID_PROVIDER)
    assert.equal((await store.read(provider).catch((value) => value)).code, CREDENTIAL_CODES.INVALID_PROVIDER)
  }
  for (const secret of ["", "  padded  ", "line\nbreak", "a".repeat(9000), 7, null, undefined]) {
    assert.equal((await store.save("gemini", secret).catch((value) => value)).code, CREDENTIAL_CODES.INVALID_SECRET)
  }
  assert.equal(calls.encrypt, 0)
  await assert.rejects(stat(path.join(userData, "credentials")), /ENOENT/)

  const { safeStorage } = fakeSafeStorage()
  assert.throws(() => new CredentialStore({ userData: "relative", safeStorage }), TypeError)
  assert.throws(() => new CredentialStore({ userData: "", safeStorage }), TypeError)
  assert.throws(() => new CredentialStore({ userData: os.tmpdir(), safeStorage, fileSystem: { readFile() {} } }), TypeError)
})

test("key rotation rewrites the record and never fails the read", async (t) => {
  const { userData } = await prepare(t)
  const rotating = fakeSafeStorage({ rotate: 1 })
  const store = new CredentialStore({ userData, safeStorage: rotating.safeStorage, platform: "darwin" })
  await store.save("gemini", SECRET)
  const record = recordPath(userData, "gemini")
  const before = await readFile(record, "utf8")

  assert.equal(await store.read("gemini"), SECRET)
  assert.equal(rotating.calls.rotations, 1)
  const after = await readFile(record, "utf8")
  assert.notEqual(after, before)
  await store.read("gemini")
  assert.equal(await readFile(record, "utf8"), after)

  const blockedFileSystem = {
    ...fsPromises,
    rename() { throw Object.assign(new Error("EPERM: rename blocked"), { code: "EPERM" }) },
  }
  const failing = new CredentialStore({
    userData,
    safeStorage: fakeSafeStorage({ rotate: 1 }).safeStorage,
    platform: "darwin",
    fileSystem: blockedFileSystem,
  })
  assert.equal(await failing.read("gemini"), SECRET)
  assert.equal(await readFile(record, "utf8"), after)
})

test("status reports the selected backend without throwing", async (t) => {
  const darwin = await prepare(t)
  assert.deepEqual(await darwin.store.status(), { supported: true, backend: "keychain", reason: null })
  const windows = await prepare(t, { platform: "win32" })
  assert.deepEqual(await windows.store.status(), { supported: true, backend: "dpapi", reason: null })
  const linux = await prepare(t, { platform: "linux", safeStorage: { backend: "kwallet5" } })
  assert.deepEqual(await linux.store.status(), { supported: true, backend: "kwallet5", reason: null })
  const bare = new CredentialStore({ userData: darwin.userData, platform: "darwin" })
  assert.deepEqual(await bare.status(), { supported: false, backend: null, reason: "api-unavailable" })
})
