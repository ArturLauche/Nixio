const { createHash } = require("node:crypto")
const { CREDENTIAL_CODES, CREDENTIAL_MESSAGES, CredentialStoreError } = require("./credential-store.cjs")

const CHANNEL_PREFIX = "khung-thoai:"

// Only these three channels exist. There is deliberately no read, export or list channel: a key
// enters through `save`, and nothing but status and opaque identifiers comes back out.
const CREDENTIAL_CHANNELS = Object.freeze({
  status: CHANNEL_PREFIX + "credential-status",
  save: CHANNEL_PREFIX + "credential-save",
  remove: CHANNEL_PREFIX + "credential-remove",
})

const UNTRUSTED_ERROR = "Untrusted desktop frame."
const GENERIC_ERROR = "The credential operation failed."
const SCOPE_SEPARATOR = ":"
const HANDLE_PREFIX = "c"
// 31 digest characters plus the prefix fill the store's 32 character handle limit.
const HANDLE_DIGEST_LENGTH = 31
const MAX_ENDPOINT_LENGTH = 2048
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
// `gemini` always talks to one baked-in endpoint, so its scope carries no URL. `openai` is the
// OpenAI-compatible provider whose base URL the user configures, so its key is bound to exactly the
// endpoint it was entered for.
const FIXED_PROVIDERS = new Set(["gemini"])
const ENDPOINT_PROVIDERS = new Set(["openai"])

const scopeError = (code) => new CredentialStoreError(code)

function canonicalEndpoint(rawEndpoint) {
  if (typeof rawEndpoint !== "string") throw scopeError(CREDENTIAL_CODES.INVALID_ENDPOINT)
  const trimmed = rawEndpoint.trim()
  if (!trimmed || trimmed.length > MAX_ENDPOINT_LENGTH) throw scopeError(CREDENTIAL_CODES.INVALID_ENDPOINT)
  let url
  try { url = new URL(trimmed) } catch { throw scopeError(CREDENTIAL_CODES.INVALID_ENDPOINT) }
  // Credentials, query strings and fragments never identify an endpoint, and a query can smuggle a
  // key into the scope, so they are refused instead of ignored.
  if (url.username || url.password || url.search || url.hash) throw scopeError(CREDENTIAL_CODES.INVALID_ENDPOINT)
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw scopeError(CREDENTIAL_CODES.INVALID_ENDPOINT)
  }
  // `URL` lowercases the host and drops a default port. Trailing slashes do not identify a different
  // endpoint, so they are dropped too; the path stays case-sensitive.
  return url.protocol + "//" + url.host + url.pathname.replace(/\/+$/, "")
}

// The canonical scope is the only identity a credential has. It is derived in main from the
// provider the renderer names, never from a handle the renderer supplies, so a renderer that later
// configures a different endpoint cannot reach the key that belongs to another one.
function canonicalCredentialScope(provider, endpoint) {
  if (typeof provider !== "string") throw scopeError(CREDENTIAL_CODES.INVALID_PROVIDER)
  if (FIXED_PROVIDERS.has(provider)) {
    if (endpoint !== undefined && endpoint !== null && endpoint !== "") {
      throw scopeError(CREDENTIAL_CODES.INVALID_ENDPOINT)
    }
    return provider + SCOPE_SEPARATOR + "fixed"
  }
  if (ENDPOINT_PROVIDERS.has(provider)) {
    return provider + SCOPE_SEPARATOR + canonicalEndpoint(endpoint)
  }
  throw scopeError(CREDENTIAL_CODES.INVALID_PROVIDER)
}

function credentialHandle(scope) {
  const digest = createHash("sha256").update(scope, "utf8").digest("hex")
  return HANDLE_PREFIX + digest.slice(0, HANDLE_DIGEST_LENGTH)
}

function resolveCredentialScope(provider, endpoint) {
  const scope = canonicalCredentialScope(provider, endpoint)
  return { scope, handle: credentialHandle(scope) }
}

// The IPC envelope every channel shares. `isTrusted` is the main process' frame check; a check that
// throws is treated as untrusted, and an untrusted frame never reaches the action. `onError` decides
// what an error turns into, so a channel that handles secrets can replace native text with a fixed
// message instead of letting an arbitrary error string reach the renderer.
function trustedChannel(isTrusted, action, onError) {
  if (typeof isTrusted !== "function" || typeof action !== "function") {
    throw new TypeError("trustedChannel needs an isTrusted check and an action.")
  }
  return async (event, ...args) => {
    let trusted = false
    try { trusted = isTrusted(event) === true }
    catch { trusted = false }
    if (!trusted) return { error: UNTRUSTED_ERROR }
    try {
      return { value: await action(...args) }
    } catch (error) {
      return { error: onError ? onError(error) : error?.message }
    }
  }
}

// Fixed strings only: a recognized credential error carries one of the reviewed messages, and
// anything else becomes a generic message. A native cryptography cause, a stack, a path or a secret
// therefore never reaches the renderer or a log.
function sanitizeCredentialError(error) {
  if (error instanceof CredentialStoreError && Object.hasOwn(CREDENTIAL_MESSAGES, error.code)) {
    return CREDENTIAL_MESSAGES[error.code]
  }
  return GENERIC_ERROR
}

// Main-process facade for the credential channels. The renderer names a provider and, for the
// OpenAI-compatible provider, the endpoint it is configuring; main derives the opaque handle from
// that pair. Returned values are status and identifiers only, never plaintext.
class CredentialService {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("CredentialService needs a credential store.")
    this.store = store
  }

  async status(provider, endpoint) {
    const { handle } = resolveCredentialScope(provider, endpoint)
    const [support, handles] = await Promise.all([this.store.status(), this.store.list()])
    return {
      provider,
      handle,
      stored: handles.includes(handle),
      supported: support.supported === true,
      protection: support.provider ?? null,
      reason: support.reason ?? null,
    }
  }

  async save(provider, endpoint, secret) {
    const { handle } = resolveCredentialScope(provider, endpoint)
    // The store validates the secret and proves protection before the value reaches native code.
    await this.store.save(handle, secret)
    return { provider, handle, stored: true }
  }

  async remove(provider, endpoint) {
    const { handle } = resolveCredentialScope(provider, endpoint)
    return { provider, handle, removed: await this.store.remove(handle) }
  }
}

module.exports = {
  CREDENTIAL_CHANNELS,
  CredentialService,
  canonicalCredentialScope,
  credentialHandle,
  resolveCredentialScope,
  sanitizeCredentialError,
  trustedChannel,
}
