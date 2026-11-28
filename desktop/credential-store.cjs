const nativeFileSystem = require("node:fs/promises")
const path = require("node:path")
const { randomBytes, randomUUID } = require("node:crypto")

// Records hold Electron safeStorage ciphertext only. The provider handle is the file name, so a
// payload never carries a second copy of a secret and no caller-supplied path reaches the disk.
const RECORD_VERSION = 1
const CREDENTIAL_DIRECTORY = "credentials"
// Lowercase, separator-free handles make traversal, absolute paths and hidden files impossible.
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const MAX_SECRET_LENGTH = 8192
const MAX_RECORD_BYTES = 64 * 1024
const FILE_SYSTEM_METHODS = ["chmod", "mkdir", "readFile", "readdir", "rename", "unlink", "writeFile"]

// Protection is decided from the ciphertext a key provider actually produced, never from a reported
// label. `Encryptor::EncryptString` prefixes the tag of the provider that encrypted the data
// (components/os_crypt/async/common/encryptor.cc), so the prefix proves which key was used.
//
// Pinned runtime: Electron 45.5.0, Chromium 156.0.8078.109.
//   macOS   KeychainKeyProvider          tag "v10"  key held by the login Keychain
//   Windows DPAPIKeyProvider             tag "v10"  key held by DPAPI
//   Linux   FreedesktopSecretKeyProvider tag "v11"  secret held by the Secret Service
//   Linux   SecretPortalKeyProvider      tag "v12"  secret held by org.freedesktop.portal.Secret
//   Linux   PosixKeyProvider             tag "v10"  key is PBKDF2("peanuts", "saltysalt"), registered
//                                                   unconditionally as a fallback that reports
//                                                   UseForEncryption() == true
// (shell/browser/browser_process_impl.cc CreateOSCryptAsync, and the provider sources above.)
// `--password-store=basic` disables the Freedesktop provider instead of weakening it
// (freedesktop_secret_key_provider.cc: `FinalizeFailure(InitStatus::kDisabled)`, "Use
// PosixKeyProvider"), so a "v11"/"v12" ciphertext always comes from a secret the Secret Service,
// KWallet or the portal holds.
//
// `safeStorage.getSelectedStorageBackend()` cannot authorize anything here: it reports the
// synchronous OSCrypt selection, which is built by a different code path than the async provider
// chain, so it can say "gnome_libsecret" while the async chain encrypts with the POSIX fallback.
// `isAsyncEncryptionAvailable()` likewise resolves true as soon as any provider yields a key, and
// the fallback always does. On Linux a "v10" prefix is therefore the plaintext-equivalent fallback,
// while "v11"/"v12" prove a secret-service or portal key.
//
// An unknown tag or platform is refused rather than trusted, so a provider that appears in a future
// Chromium fails closed. The reverse case is the limitation to re-check on every Electron upgrade: a
// future fallback that reused an OS-key tag would not be distinguishable from the ciphertext alone.
const PROTECTED_TAGS = new Map([
  ["darwin", new Map([["v10", "keychain"]])],
  ["win32", new Map([["v10", "dpapi"]])],
  [
    "linux",
    new Map([
      ["v11", "freedesktop-secret-service"],
      ["v12", "xdg-portal-secret"],
    ]),
  ],
])
const PROBE_PREFIX = "nixio-credential-probe-"

const CREDENTIAL_CODES = Object.freeze({
  INVALID_PROVIDER: "ERR_CREDENTIAL_PROVIDER",
  // The IPC scope validator throws this one, so both layers share a single error vocabulary.
  INVALID_ENDPOINT: "ERR_CREDENTIAL_ENDPOINT",
  INVALID_SECRET: "ERR_CREDENTIAL_SECRET",
  UNAVAILABLE: "ERR_CREDENTIAL_UNAVAILABLE",
  UNPROTECTED: "ERR_CREDENTIAL_UNPROTECTED",
  UNPROTECTED_RECORD: "ERR_CREDENTIAL_UNPROTECTED_RECORD",
  CORRUPT: "ERR_CREDENTIAL_CORRUPT",
  ENCRYPT: "ERR_CREDENTIAL_ENCRYPT",
  DECRYPT: "ERR_CREDENTIAL_DECRYPT",
  IO: "ERR_CREDENTIAL_IO",
})

// Every message is a fixed string. Nothing here interpolates a secret, a path, a ladder of native
// error text or a provider-supplied value, so a message is safe to hand to the renderer as-is.
const CREDENTIAL_MESSAGES = Object.freeze({
  [CREDENTIAL_CODES.INVALID_PROVIDER]: "Invalid credential provider handle.",
  [CREDENTIAL_CODES.INVALID_ENDPOINT]: "Invalid credential endpoint scope.",
  [CREDENTIAL_CODES.INVALID_SECRET]: "An API key must be a non-empty string without surrounding whitespace or control characters.",
  [CREDENTIAL_CODES.UNAVAILABLE]: "OS credential encryption is unavailable; refusing to handle API keys without OS protection.",
  [CREDENTIAL_CODES.UNPROTECTED]: "Refusing to handle API keys: the OS credential provider could not be shown to protect them.",
  [CREDENTIAL_CODES.UNPROTECTED_RECORD]: "Refusing to read a stored API key that the OS credential provider did not protect.",
  [CREDENTIAL_CODES.CORRUPT]: "The stored credential record is unreadable.",
  [CREDENTIAL_CODES.ENCRYPT]: "OS credential encryption failed.",
  [CREDENTIAL_CODES.DECRYPT]: "OS credential decryption failed.",
  [CREDENTIAL_CODES.IO]: "Cannot access the credential store.",
})

class CredentialStoreError extends Error {
  constructor(code, options) {
    super(CREDENTIAL_MESSAGES[code] ?? CREDENTIAL_MESSAGES[CREDENTIAL_CODES.IO], options)
    this.name = "CredentialStoreError"
    this.code = code
  }
}

const credentialError = (code) => new CredentialStoreError(code)
const corruptRecord = () => credentialError(CREDENTIAL_CODES.CORRUPT)

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < 1 || secret.length > MAX_SECRET_LENGTH ||
    secret !== secret.trim() || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw credentialError(CREDENTIAL_CODES.INVALID_SECRET)
  }
}

// Main-process only. One instance per app session, created after `app.whenReady()` via
// `new CredentialStore({ userData: app.getPath("userData"), safeStorage })`. Secrets are never
// cached: every read decrypts, and the plaintext only lives in the caller's local variable.
class CredentialStore {
  constructor({ userData, safeStorage, platform = process.platform, fileSystem = nativeFileSystem } = {}) {
    if (typeof userData !== "string" || !userData || !path.isAbsolute(userData)) {
      throw new TypeError("CredentialStore needs an absolute userData directory.")
    }
    for (const method of FILE_SYSTEM_METHODS) {
      if (typeof fileSystem?.[method] !== "function") throw new TypeError(`CredentialStore fileSystem is missing ${method}().`)
    }
    this.directory = path.join(userData, CREDENTIAL_DIRECTORY)
    this.safeStorage = safeStorage
    this.platform = platform
    this.fileSystem = fileSystem
    this.tail = Promise.resolve()
    this.protectionState = null
  }

  // Safe to surface to a settings screen: reports support and the proven key provider, never a key.
  async status() {
    return this.enqueue(() => this.protection())
  }

  async list() {
    return this.enqueue(async () => {
      let names
      try { names = await this.fileSystem.readdir(this.directory) }
      catch (error) {
        if (error?.code === "ENOENT") return []
        throw new CredentialStoreError(CREDENTIAL_CODES.IO, { cause: error })
      }
      return names
        .filter((name) => typeof name === "string" && name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter((name) => PROVIDER_PATTERN.test(name))
        .sort()
    })
  }

  async save(provider, secret) {
    return this.enqueue(async () => {
      const file = this.recordPath(provider)
      assertSecret(secret)
      // The secret is checked and protection is proven before the secret reaches native code.
      await this.assertProtected()
      await this.writeRecord(file, await this.encrypt(secret))
      return { provider }
    })
  }

  // Returns the raw key for main-side provider calls only. Renderer code must receive an opaque
  // handle instead, so this value must never cross an IPC boundary.
  async read(provider) {
    return this.enqueue(async () => {
      const file = this.recordPath(provider)
      const ciphertext = await this.readRecord(file)
      if (!ciphertext) return null
      // A record written while the OS store was falling back stays on disk for a later migration,
      // but its key is never handed out.
      if (!this.classify(ciphertext)) throw credentialError(CREDENTIAL_CODES.UNPROTECTED_RECORD)
      await this.assertProtected()
      const { value, shouldReEncrypt } = await this.decrypt(ciphertext)
      if (shouldReEncrypt) await this.rotate(file, value)
      return value
    })
  }

  // Removal needs no protection: a user must be able to wipe keys even when the OS vault is locked.
  async remove(provider) {
    return this.enqueue(async () => {
      const file = this.recordPath(provider)
      try {
        await this.fileSystem.unlink(file)
        return true
      } catch (error) {
        if (error?.code === "ENOENT") return false
        throw new CredentialStoreError(CREDENTIAL_CODES.IO, { cause: error })
      }
    })
  }

  enqueue(operation) {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  recordPath(provider) {
    if (typeof provider !== "string" || !PROVIDER_PATTERN.test(provider)) {
      throw credentialError(CREDENTIAL_CODES.INVALID_PROVIDER)
    }
    return path.join(this.directory, provider + ".json")
  }

  // Maps a ciphertext to the provider that produced it, or null when this runtime cannot show that
  // an OS-protected key was used.
  classify(ciphertext) {
    const providers = PROTECTED_TAGS.get(this.platform)
    if (!providers || !ciphertext?.length) return null
    for (const [tag, provider] of providers) {
      if (ciphertext.length > tag.length && ciphertext.subarray(0, tag.length).toString("latin1") === tag) {
        return provider
      }
    }
    return null
  }

  // Encrypts a throwaway marker with the API that records will use and classifies the result, so a
  // configuration that silently encrypts with a fallback key reports itself as unsupported.
  async probe() {
    const marker = PROBE_PREFIX + randomBytes(12).toString("hex")
    const ciphertext = await this.safeStorage.encryptStringAsync(marker)
    if (!(ciphertext instanceof Uint8Array)) return { supported: false, provider: null, reason: "probe-failed" }
    const buffer = Buffer.from(ciphertext)
    const provider = this.classify(buffer)
    if (!provider) return { supported: false, provider: null, reason: "unsupported-provider" }
    const outcome = await this.safeStorage.decryptStringAsync(buffer)
    if (!outcome || outcome.result !== marker) return { supported: false, provider: null, reason: "probe-failed" }
    return { supported: true, provider, reason: null }
  }

  // Never throws: this result is reported to a settings screen. A successful proof is cached for the
  // session because the provider is fixed once the async encryptor is ready; failures are retried so
  // an unlocked vault can recover. Writes re-check the ciphertext they are about to persist, so the
  // cache can never authorize a fallback.
  async protection() {
    if (this.protectionState) return this.protectionState
    const safeStorage = this.safeStorage
    if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== "function" ||
      typeof safeStorage.encryptStringAsync !== "function" || typeof safeStorage.decryptStringAsync !== "function") {
      return { supported: false, provider: null, reason: "api-unavailable" }
    }
    let available = false
    try { available = await safeStorage.isAsyncEncryptionAvailable() === true }
    catch { available = false }
    if (!available) return { supported: false, provider: null, reason: "unavailable" }
    let state
    try { state = await this.probe() }
    catch { state = { supported: false, provider: null, reason: "probe-failed" } }
    if (state.supported) this.protectionState = state
    return state
  }

  async assertProtected() {
    const state = await this.protection()
    if (state.supported) return
    const unavailable = state.reason === "unavailable" || state.reason === "api-unavailable"
    throw credentialError(unavailable ? CREDENTIAL_CODES.UNAVAILABLE : CREDENTIAL_CODES.UNPROTECTED)
  }

  async encrypt(secret) {
    let ciphertext
    try { ciphertext = await this.safeStorage.encryptStringAsync(secret) }
    catch {
      throw credentialError(CREDENTIAL_CODES.ENCRYPT)
    }
    if (!(ciphertext instanceof Uint8Array) || !ciphertext.length) {
      throw credentialError(CREDENTIAL_CODES.ENCRYPT)
    }
    const buffer = Buffer.from(ciphertext)
    // The provider can differ from the one the probe saw, so the record's own ciphertext decides.
    if (!this.classify(buffer)) throw credentialError(CREDENTIAL_CODES.UNPROTECTED)
    return buffer
  }

  async decrypt(ciphertext) {
    let outcome
    try { outcome = await this.safeStorage.decryptStringAsync(ciphertext) }
    catch {
      throw credentialError(CREDENTIAL_CODES.DECRYPT)
    }
    if (!outcome || typeof outcome.result !== "string") {
      throw credentialError(CREDENTIAL_CODES.DECRYPT)
    }
    return { value: outcome.result, shouldReEncrypt: outcome.shouldReEncrypt === true }
  }

  // Electron can hand back data encrypted with a key that is being rotated out. Re-encrypting keeps
  // the record current; if the rewrite fails the previous ciphertext still decrypts, so the read
  // result stands and the next read retries.
  async rotate(file, value) {
    try { await this.writeRecord(file, await this.encrypt(value)) }
    catch {}
  }

  async readRecord(file) {
    let payload
    try { payload = await this.fileSystem.readFile(file, "utf8") }
    catch (error) {
      if (error?.code === "ENOENT") return null
      throw new CredentialStoreError(CREDENTIAL_CODES.IO, { cause: error })
    }
    if (payload.length > MAX_RECORD_BYTES) throw corruptRecord()
    let record
    try { record = JSON.parse(payload) } catch { throw corruptRecord() }
    if (!record || typeof record !== "object" || record.version !== RECORD_VERSION || typeof record.ciphertext !== "string") throw corruptRecord()
    const ciphertext = Buffer.from(record.ciphertext, "base64")
    if (!ciphertext.length || ciphertext.toString("base64") !== record.ciphertext) throw corruptRecord()
    return ciphertext
  }

  // The new record is written beside the old one and renamed into place, so readers only ever see a
  // complete record: a failure leaves the previous ciphertext untouched.
  async writeRecord(file, ciphertext) {
    await this.ensureDirectory()
    const payload = JSON.stringify({ version: RECORD_VERSION, ciphertext: ciphertext.toString("base64") })
    const temporary = path.join(this.directory, `${path.basename(file)}.${randomUUID()}.tmp`)
    try {
      await this.fileSystem.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" })
      await this.fileSystem.rename(temporary, file)
    } catch (error) {
      await this.fileSystem.unlink(temporary).catch(() => {})
      throw new CredentialStoreError(CREDENTIAL_CODES.IO, { cause: error })
    }
  }

  async ensureDirectory() {
    try { await this.fileSystem.mkdir(this.directory, { recursive: true, mode: 0o700 }) }
    catch (error) {
      throw new CredentialStoreError(CREDENTIAL_CODES.IO, { cause: error })
    }
    // Windows ignores POSIX modes; elsewhere this tightens a directory left by an older build.
    if (process.platform !== "win32") await this.fileSystem.chmod(this.directory, 0o700).catch(() => {})
  }
}

module.exports = { CREDENTIAL_CODES, CREDENTIAL_MESSAGES, CredentialStore, CredentialStoreError }
