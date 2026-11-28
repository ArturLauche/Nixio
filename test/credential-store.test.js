import assert from "node:assert/strict"
import test from "node:test"
import * as fsPromises from "node:fs/promises"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CREDENTIAL_CODES, CREDENTIAL_MESSAGES, CredentialStore } from "../desktop/credential-store.cjs"

// Synthetic values stand in for API keys: no real credential is ever used by these tests.
const SECRET = "sk-test-gemini-4f9c1b2a7d6e"
const OTHER = "sk-test-openai-8a1c3d5e7f90"
// Tags of the pinned runtime. "v10" on Linux is the POSIX fallback key, "v11" the Secret Service and
// "v12" the portal secret; macOS and Windows only ever produce "v10".
const FALLBACK_TAG = "v10"
const SECRET_SERVICE_TAG = "v11"
const PORTAL_TAG = "v12"

const mask = (buffer) => {
  const output = Buffer.alloc(buffer.length)
  for (let index = 0; index < buffer.length; index++) output[index] = buffer[index] ^ 0x5a
  return output
}

// Stands in for Electron safeStorage. Ciphertext is `tag + masked plaintext`, exactly as
// `Encryptor::EncryptString` prefixes the tag of the provider that encrypted the data, so a test can
// stand in for a specific key provider. It records what it was asked to encrypt, which is how the
// tests prove a secret never reached the fallback.
function fakeSafeStorage(options = {}) {
  const { available = true, availableError, encryptError, decryptError, rotate = null, tag = SECRET_SERVICE_TAG } = options
  const calls = { encrypt: 0, decrypt: 0, plaintext: 0, rotations: 0, plaintexts: [] }
  let serial = 0
  const failure = (option, ...args) => (typeof option === "function" ? option(...args) : option)
  const safeStorage = {
    async isAsyncEncryptionAvailable() {
      if (availableError) throw availableError
      return available
    },
    async encryptStringAsync(plaintext) {
      const index = calls.encrypt++
      calls.plaintexts.push(plaintext)
      const encryptedError = failure(encryptError, plaintext, index)
      if (encryptedError) throw encryptedError
      // A serial byte keeps a rewrite of the same key observable, like a real rotation would.
      return Buffer.concat([Buffer.from(tag, "latin1"), Buffer.from([serial++ % 256]), mask(Buffer.from(plaintext, "utf8"))])
    },
    async decryptStringAsync(ciphertext) {
      const index = calls.decrypt++
      const decryptedError = failure(decryptError, ciphertext, index)
      if (decryptedError) throw decryptedError
      const raw = Buffer.from(ciphertext)
      if (!raw.subarray(0, tag.length).equals(Buffer.from(tag, "latin1"))) {
        throw new Error("no key for this provider prefix")
      }
      const result = mask(raw.subarray(tag.length + 1)).toString("utf8")
      const shouldReEncrypt = typeof rotate === "function" && rotate(result) === true
      if (shouldReEncrypt) calls.rotations++
      return { shouldReEncrypt, result }
    },
    setUsePlainTextEncryption() { calls.plaintext++ },
  }
  if (Object.hasOwn(options, "backend")) safeStorage.getSelectedStorageBackend = () => options.backend
  return { safeStorage, calls }
}

async function prepare(t, { platform = "darwin", safeStorage = {}, fileSystem } = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "nixio-credentials-"))
  t.after(() => rm(userData, { recursive: true, force: true }))
  const fake = fakeSafeStorage({ tag: platform === "linux" ? SECRET_SERVICE_TAG : FALLBACK_TAG, ...safeStorage })
  const store = new CredentialStore({ userData, safeStorage: fake.safeStorage, platform, fileSystem })
  return { store, userData, calls: fake.calls, safeStorage: fake.safeStorage, platform }
}

const recordPath = (userData, provider) => path.join(userData, "credentials", `${provider}.json`)
const encode = (tag, plaintext) => Buffer.concat([Buffer.from(tag, "latin1"), mask(Buffer.from(plaintext, "utf8"))])
const errorOf = async (promise) => promise.catch((value) => value)

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    found.push(...(entry.isDirectory() ? await listFiles(full) : [full]))
  }
  return found
}

test("a supported OS provider round-trips a credential through the injected safeStorage", async (t) => {
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
    safeStorage: fakeSafeStorage({
      tag: FALLBACK_TAG,
      encryptError: (plaintext) => (plaintext === OTHER ? new Error(`encryption failed for ${plaintext}`) : null),
    }).safeStorage,
    platform: "darwin",
  })

  const error = await errorOf(failing.save("gemini", OTHER))
  assert.equal(error.code, CREDENTIAL_CODES.ENCRYPT)
  assert.equal(error.message, CREDENTIAL_MESSAGES[CREDENTIAL_CODES.ENCRYPT])
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
    safeStorage: fakeSafeStorage({
      tag: FALLBACK_TAG,
      // The store's probe decrypts first; the stored record must then fail like a locked vault.
      decryptError: (_ciphertext, index) => (index > 0 ? new Error("secret service locked") : null),
    }).safeStorage,
    platform: "darwin",
  })
  const lockedError = await errorOf(locked.read("gemini"))
  assert.equal(lockedError.code, CREDENTIAL_CODES.DECRYPT)
  assert.ok(!String(lockedError.message).includes("secret service locked"))

  await writeFile(record, "not json")
  assert.equal((await errorOf(store.read("gemini"))).code, CREDENTIAL_CODES.CORRUPT)

  await writeFile(record, JSON.stringify({ version: 2, ciphertext: "AAAA" }))
  assert.equal((await errorOf(store.read("gemini"))).code, CREDENTIAL_CODES.CORRUPT)

  await writeFile(record, JSON.stringify({ version: 1, ciphertext: "%%%not-base64%%%" }))
  assert.equal((await errorOf(store.read("gemini"))).code, CREDENTIAL_CODES.CORRUPT)

  await store.save("gemini", OTHER)
  assert.equal(await store.read("gemini"), OTHER)
})

test("unavailable OS encryption refuses reads and writes without a fallback", async (t) => {
  const base = await prepare(t)
  await base.store.save("gemini", SECRET)

  const off = await prepare(t, { safeStorage: { available: false } })
  assert.deepEqual(await off.store.status(), { supported: false, provider: null, reason: "unavailable" })
  assert.equal((await errorOf(off.store.save("gemini", SECRET))).code, CREDENTIAL_CODES.UNAVAILABLE)
  await assert.rejects(stat(path.join(off.userData, "credentials")), /ENOENT/)
  assert.equal(off.calls.encrypt, 0)

  const locked = new CredentialStore({ userData: base.userData, safeStorage: fakeSafeStorage({ available: false }).safeStorage, platform: "darwin" })
  assert.equal((await errorOf(locked.read("gemini"))).code, CREDENTIAL_CODES.UNAVAILABLE)
  assert.equal(await base.store.read("gemini"), SECRET)

  const throwing = await prepare(t, { safeStorage: { availableError: new Error("keychain timed out") } })
  const state = await throwing.store.status()
  assert.equal(state.reason, "unavailable")
  assert.equal(throwing.calls.encrypt, 0)
})

// The blocking review finding: Electron 45 can report a protected Linux backend while the async
// provider chain encrypts with the POSIX fallback ("peanuts" key), and async availability is true in
// that state. Nothing about a label or availability may therefore authorize a fallback ciphertext.
test("a plausible Linux backend plus async availability cannot authorize the fallback key", async (t) => {
  const { store, userData, calls } = await prepare(t, {
    platform: "linux",
    safeStorage: { tag: FALLBACK_TAG, backend: "gnome_libsecret", available: true },
  })
  assert.deepEqual(await store.status(), { supported: false, provider: null, reason: "unsupported-provider" })

  const error = await errorOf(store.save("gemini", SECRET))
  assert.equal(error.code, CREDENTIAL_CODES.UNPROTECTED)
  assert.equal(error.message, CREDENTIAL_MESSAGES[CREDENTIAL_CODES.UNPROTECTED])
  assert.equal(calls.plaintexts.includes(SECRET), false, "the key must never reach the fallback provider")
  await assert.rejects(stat(path.join(userData, "credentials")), /ENOENT/)
})

test("a Linux backend label is never consulted in either direction", async (t) => {
  for (const backend of ["basic_text", "unknown", "kwallet5", "gnome_libsecret"]) {
    const withFallback = await prepare(t, { platform: "linux", safeStorage: { tag: FALLBACK_TAG, backend } })
    assert.equal((await withFallback.store.status()).supported, false, `${backend} must not authorize v10`)

    const withSecretService = await prepare(t, { platform: "linux", safeStorage: { tag: SECRET_SERVICE_TAG, backend } })
    assert.equal((await withSecretService.store.status()).supported, true, `${backend} must not veto v11`)
  }

  const throwing = await prepare(t, { platform: "linux", safeStorage: { tag: SECRET_SERVICE_TAG } })
  throwing.safeStorage.getSelectedStorageBackend = () => { throw new Error("backend probe exploded") }
  assert.deepEqual(await throwing.store.status(), { supported: true, provider: "freedesktop-secret-service", reason: null })
})

test("Linux secret service and portal ciphertexts are accepted", async (t) => {
  const cases = [
    [SECRET_SERVICE_TAG, "freedesktop-secret-service"],
    [PORTAL_TAG, "xdg-portal-secret"],
  ]
  for (const [tag, provider] of cases) {
    const { store } = await prepare(t, { platform: "linux", safeStorage: { tag } })
    assert.deepEqual(await store.status(), { supported: true, provider, reason: null })
    await store.save("gemini", SECRET)
    assert.equal(await store.read("gemini"), SECRET)
  }
})

test("a fallback-encrypted record is refused on read and left on disk for migration", async (t) => {
  const { store, userData } = await prepare(t, { platform: "linux" })
  await fsPromises.mkdir(path.join(userData, "credentials"), { recursive: true, mode: 0o700 })
  const record = recordPath(userData, "gemini")
  await writeFile(record, JSON.stringify({ version: 1, ciphertext: encode(FALLBACK_TAG, SECRET).toString("base64") }))

  const error = await errorOf(store.read("gemini"))
  assert.equal(error.code, CREDENTIAL_CODES.UNPROTECTED_RECORD)
  assert.ok(!String(error.message).includes(SECRET))
  assert.equal((await readFile(record, "utf8")).includes(SECRET), false)
  assert.deepEqual(await store.list(), ["gemini"])
})

test("an unknown provider tag fails closed on every platform", async (t) => {
  for (const [platform, tag] of [["darwin", SECRET_SERVICE_TAG], ["win32", PORTAL_TAG], ["linux", "v99"], ["freebsd", SECRET_SERVICE_TAG]]) {
    const { store, calls } = await prepare(t, { platform, safeStorage: { tag } })
    assert.deepEqual(await store.status(), { supported: false, provider: null, reason: "unsupported-provider" }, `${platform}/${tag}`)
    assert.equal((await errorOf(store.save("gemini", SECRET))).code, CREDENTIAL_CODES.UNPROTECTED)
    assert.equal(calls.plaintexts.includes(SECRET), false)
  }
})

test("a provider that fails its own probe round-trip is refused", async (t) => {
  const { safeStorage } = fakeSafeStorage({ tag: SECRET_SERVICE_TAG })
  safeStorage.decryptStringAsync = async () => ({ shouldReEncrypt: false, result: "something else" })
  const userData = await mkdtemp(path.join(os.tmpdir(), "nixio-credentials-"))
  t.after(() => rm(userData, { recursive: true, force: true }))
  const store = new CredentialStore({ userData, safeStorage, platform: "linux" })
  assert.deepEqual(await store.status(), { supported: false, provider: null, reason: "probe-failed" })
  assert.equal((await errorOf(store.save("gemini", SECRET))).code, CREDENTIAL_CODES.UNPROTECTED)

  const empty = new CredentialStore({
    userData,
    safeStorage: { ...safeStorage, encryptStringAsync: async () => Buffer.alloc(0) },
    platform: "linux",
  })
  assert.equal((await empty.status()).reason, "unsupported-provider")
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
  assert.equal((await errorOf(store.save("gemini", OTHER))).code, CREDENTIAL_CODES.IO)
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
    assert.equal((await errorOf(store.save(provider, SECRET))).code, CREDENTIAL_CODES.INVALID_PROVIDER)
    assert.equal((await errorOf(store.read(provider))).code, CREDENTIAL_CODES.INVALID_PROVIDER)
  }
  for (const secret of ["", "  padded  ", "line\nbreak", "a".repeat(9000), 7, null, undefined]) {
    assert.equal((await errorOf(store.save("gemini", secret))).code, CREDENTIAL_CODES.INVALID_SECRET)
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
  let rotateRecords = true
  const rotating = fakeSafeStorage({ tag: FALLBACK_TAG, rotate: (plaintext) => rotateRecords && plaintext === SECRET })
  const store = new CredentialStore({ userData, safeStorage: rotating.safeStorage, platform: "darwin" })
  await store.save("gemini", SECRET)
  const record = recordPath(userData, "gemini")
  const before = await readFile(record, "utf8")

  assert.equal(await store.read("gemini"), SECRET)
  assert.equal(rotating.calls.rotations, 1)
  const after = await readFile(record, "utf8")
  assert.notEqual(after, before)
  rotateRecords = false
  await store.read("gemini")
  assert.equal(rotating.calls.rotations, 1)
  assert.equal(await readFile(record, "utf8"), after)

  const blockedFileSystem = {
    ...fsPromises,
    rename() { throw Object.assign(new Error("EPERM: rename blocked"), { code: "EPERM" }) },
  }
  const failing = new CredentialStore({
    userData,
    safeStorage: fakeSafeStorage({ tag: FALLBACK_TAG, rotate: (plaintext) => plaintext === SECRET }).safeStorage,
    platform: "darwin",
    fileSystem: blockedFileSystem,
  })
  assert.equal(await failing.read("gemini"), SECRET)
  assert.equal(await readFile(record, "utf8"), after)
})

test("status reports the proven provider without throwing", async (t) => {
  const darwin = await prepare(t)
  assert.deepEqual(await darwin.store.status(), { supported: true, provider: "keychain", reason: null })
  const windows = await prepare(t, { platform: "win32" })
  assert.deepEqual(await windows.store.status(), { supported: true, provider: "dpapi", reason: null })
  const linux = await prepare(t, { platform: "linux" })
  assert.deepEqual(await linux.store.status(), { supported: true, provider: "freedesktop-secret-service", reason: null })
  const bare = new CredentialStore({ userData: darwin.userData, platform: "darwin" })
  assert.deepEqual(await bare.status(), { supported: false, provider: null, reason: "api-unavailable" })
})
