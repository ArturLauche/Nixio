const nativeFileSystem = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")

// Records hold Electron safeStorage ciphertext only. The provider handle is the file name, so a
// payload never carries a second copy of a secret and no caller-supplied path reaches the disk.
const RECORD_VERSION = 1
const CREDENTIAL_DIRECTORY = "credentials"
// Lowercase, separator-free handles make traversal, absolute paths and hidden files impossible.
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const MAX_SECRET_LENGTH = 8192
const MAX_RECORD_BYTES = 64 * 1024
// Electron safeStorage on Linux reports `basic_text` when it encrypts with a hardcoded password and
// `unknown` before the app is ready. Any backend missing from this set is refused until it has been
// reviewed and shown to be OS protected. Windows uses DPAPI and macOS the Keychain, with no
// plaintext fallback, so those platforms only need `isAsyncEncryptionAvailable()`.
const PROTECTED_LINUX_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])
const FILE_SYSTEM_METHODS = ["chmod", "mkdir", "readFile", "readdir", "rename", "unlink", "writeFile"]

const CREDENTIAL_CODES = Object.freeze({
  INVALID_PROVIDER: "ERR_CREDENTIAL_PROVIDER",
  INVALID_SECRET: "ERR_CREDENTIAL_SECRET",
  UNAVAILABLE: "ERR_CREDENTIAL_UNAVAILABLE",
  UNPROTECTED: "ERR_CREDENTIAL_UNPROTECTED",
  CORRUPT: "ERR_CREDENTIAL_CORRUPT",
  ENCRYPT: "ERR_CREDENTIAL_ENCRYPT",
  DECRYPT: "ERR_CREDENTIAL_DECRYPT",
  IO: "ERR_CREDENTIAL_IO",
})

class CredentialStoreError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = "CredentialStoreError"
    this.code = code
  }
}

const corruptRecord = () => new CredentialStoreError(CREDENTIAL_CODES.CORRUPT, "The stored credential record is unreadable.")

// OS error text is useful for diagnosis, but an encryption failure that quotes the plaintext must
// not be attached as a cause: exceptions end up in logs and crash reports.
function safeCause(error, secret) {
  if (!error || typeof error !== "object") return undefined
  return typeof secret === "string" && String(error.message ?? "").includes(secret) ? undefined : error
}

function protectionMessage({ reason, backend }) {
  if (reason === "api-unavailable") return "Electron safeStorage is unavailable; refusing to handle API keys without OS protection."
  if (reason === "unavailable") return "OS credential encryption is unavailable; refusing to handle API keys without OS protection."
  if (reason === "insecure-backend") return 'Refusing to handle API keys: the Linux secret service is unavailable so safeStorage fell back to "basic_text".'
  return `Refusing to handle API keys: the OS credential backend "${backend ?? "none"}" cannot prove OS protection.`
}

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < 1 || secret.length > MAX_SECRET_LENGTH ||
    secret !== secret.trim() || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new CredentialStoreError(CREDENTIAL_CODES.INVALID_SECRET,
      "An API key must be a non-empty string without surrounding whitespace or control characters.")
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
  }

  // Safe to surface to a settings screen: reports support and the selected backend, never a key.
  async status() {
    return this.enqueue(() => this.protection())
  }

  async list() {
    return this.enqueue(async () => {
      let names
      try { names = await this.fileSystem.readdir(this.directory) }
      catch (error) {
        if (error?.code === "ENOENT") return []
        throw new CredentialStoreError(CREDENTIAL_CODES.IO, "Cannot list credential records.", { cause: error })
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
        throw new CredentialStoreError(CREDENTIAL_CODES.IO, "Cannot remove the credential record.", { cause: error })
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
      throw new CredentialStoreError(CREDENTIAL_CODES.INVALID_PROVIDER, "Invalid credential provider handle.")
    }
    return path.join(this.directory, provider + ".json")
  }

  async protection() {
    const safeStorage = this.safeStorage
    if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== "function" ||
      typeof safeStorage.encryptStringAsync !== "function" || typeof safeStorage.decryptStringAsync !== "function") {
      return { supported: false, backend: null, reason: "api-unavailable" }
    }
    const linuxLike = this.platform !== "win32" && this.platform !== "darwin"
    const backend = linuxLike ? this.backend() : this.platform === "darwin" ? "keychain" : "dpapi"
    if (linuxLike && !PROTECTED_LINUX_BACKENDS.has(backend)) {
      return { supported: false, backend, reason: backend === "basic_text" ? "insecure-backend" : "unsupported-backend" }
    }
    let available = false
    try { available = await safeStorage.isAsyncEncryptionAvailable() === true }
    catch { available = false }
    return available
      ? { supported: true, backend, reason: null }
      : { supported: false, backend, reason: "unavailable" }
  }

  backend() {
    const selected = this.safeStorage?.getSelectedStorageBackend
    if (typeof selected !== "function") return null
    try {
      const value = selected.call(this.safeStorage)
      return typeof value === "string" && value ? value : null
    } catch { return null }
  }

  async assertProtected() {
    const state = await this.protection()
    if (state.supported) return
    const unavailable = state.reason === "unavailable" || state.reason === "api-unavailable"
    throw new CredentialStoreError(unavailable ? CREDENTIAL_CODES.UNAVAILABLE : CREDENTIAL_CODES.UNPROTECTED, protectionMessage(state))
  }

  async encrypt(secret) {
    let ciphertext
    try { ciphertext = await this.safeStorage.encryptStringAsync(secret) }
    catch (error) {
      throw new CredentialStoreError(CREDENTIAL_CODES.ENCRYPT, "OS credential encryption failed.", { cause: safeCause(error, secret) })
    }
    if (!(ciphertext instanceof Uint8Array) || !ciphertext.length) {
      throw new CredentialStoreError(CREDENTIAL_CODES.ENCRYPT, "OS credential encryption returned no ciphertext.")
    }
    return Buffer.from(ciphertext)
  }

  async decrypt(ciphertext) {
    let outcome
    try { outcome = await this.safeStorage.decryptStringAsync(ciphertext) }
    catch (error) {
      throw new CredentialStoreError(CREDENTIAL_CODES.DECRYPT, "OS credential decryption failed.", { cause: safeCause(error) })
    }
    if (!outcome || typeof outcome.result !== "string") {
      throw new CredentialStoreError(CREDENTIAL_CODES.DECRYPT, "OS credential decryption returned no value.")
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
      throw new CredentialStoreError(CREDENTIAL_CODES.IO, "Cannot read the credential record.", { cause: error })
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
      throw new CredentialStoreError(CREDENTIAL_CODES.IO, "Cannot write the encrypted credential record.", { cause: error })
    }
  }

  async ensureDirectory() {
    try { await this.fileSystem.mkdir(this.directory, { recursive: true, mode: 0o700 }) }
    catch (error) {
      throw new CredentialStoreError(CREDENTIAL_CODES.IO, "Cannot prepare the credential directory.", { cause: error })
    }
    // Windows ignores POSIX modes; elsewhere this tightens a directory left by an older build.
    if (process.platform !== "win32") await this.fileSystem.chmod(this.directory, 0o700).catch(() => {})
  }
}

module.exports = { CREDENTIAL_CODES, CredentialStore, CredentialStoreError }
