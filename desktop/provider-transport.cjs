const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const { randomUUID } = require("node:crypto")
const { resolvePublicAddress } = require("./web-search.cjs")
const { resolveCredentialScope } = require("./credential-ipc.cjs")
const { CREDENTIAL_CODES, CredentialStoreError } = require("./credential-store.cjs")

// Main-process transport for the two selected provider shapes the renderer used to call itself.
// The renderer names a provider, an operation and a request body; main decides the origin, the path,
// the headers and the credential. No channel accepts a URL, a method, a header or a handle, so there
// is no generic privileged proxy to misdirect.

const CHANNEL_PREFIX = "khung-thoai:"
// `event` is the only push channel; it carries stream frames for a ticket main just issued.
const PROVIDER_CHANNELS = Object.freeze({
  request: CHANNEL_PREFIX + "provider-request",
  stream: CHANNEL_PREFIX + "provider-stream",
  cancel: CHANNEL_PREFIX + "provider-cancel",
  event: CHANNEL_PREFIX + "provider-event",
})

const GEMINI_HOST = "generativelanguage.googleapis.com"
const GEMINI_ORIGIN = "https://" + GEMINI_HOST
// `streamGenerateContent` needs ?alt=sse to answer with text/event-stream. The suffix is a property of
// the operation, never of the caller's request.
const GEMINI_OPERATIONS = new Map([
  ["generateContent", { suffix: ":generateContent", sse: false }],
  ["streamGenerateContent", { suffix: ":streamGenerateContent?alt=sse", sse: true }],
])
// A Gemini model is a single path segment between two main-built pieces of the path, so it is checked
// against a lowercase segment grammar that cannot carry a slash, a colon, a percent escape, a query
// delimiter or a dot-dot traversal.
const GEMINI_MODEL_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,7}$/
const MAX_MODEL_LENGTH = 64

const OPENAI_SCOPE_PREFIX = "openai:"
const OPENAI_CHAT_PATH = "/chat/completions"

const PROVIDER_NAMES = new Set(["gemini", "openai"])
const GEMINI_REQUEST_OPERATION = "generateContent"
const GEMINI_STREAM_OPERATION = "streamGenerateContent"
const OPENAI_OPERATION = "chat.completions"

// Loopback names are mapped to fixed literals instead of the resolver, so the local inference path
// keeps working on the address the user configured while DNS cannot re-point it anywhere else.
const LOOPBACK_ADDRESSES = new Map([
  ["localhost", "127.0.0.1"],
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "::1"],
])

const MAX_REQUEST_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_STREAM_CHUNKS = 20000
const MAX_RETRY_AFTER_MS = 15000
// Longest suffix of a frame that is held back while a secret prefix could still be forming.
const MAX_PREFIX_SCAN = 256
const REQUEST_TIMEOUT_MS = 120000
const STREAM_IDLE_TIMEOUT_MS = 120000
const STREAM_TOTAL_TIMEOUT_MS = 600000
const REDACTED = "[redacted]"
const USER_AGENT = "KhungThoai/1.0 (Manga Editor Provider Transport)"

const PROVIDER_CODES = Object.freeze({
  UNTRUSTED: "ERR_PROVIDER_UNTRUSTED",
  REQUEST: "ERR_PROVIDER_REQUEST",
  OPERATION: "ERR_PROVIDER_OPERATION",
  MODEL: "ERR_PROVIDER_MODEL",
  ENDPOINT: "ERR_PROVIDER_ENDPOINT",
  SCOPE: "ERR_PROVIDER_SCOPE",
  // Kept distinct from SCOPE so a settings screen can say "enter a key" instead of "bad URL".
  CREDENTIAL: "ERR_PROVIDER_CREDENTIAL",
  POLICY: "ERR_PROVIDER_POLICY",
  REDIRECT: "ERR_PROVIDER_REDIRECT",
  STATUS: "ERR_PROVIDER_STATUS",
  LIMIT: "ERR_PROVIDER_LIMIT",
  TIMEOUT: "ERR_PROVIDER_TIMEOUT",
  NETWORK: "ERR_PROVIDER_NETWORK",
  CANCELLED: "ERR_PROVIDER_CANCELLED",
})

// Fixed strings only: nothing here interpolates a key, an endpoint, a socket error or a header, so a
// message is safe to hand to the renderer, to a log and to an error toast.
const PROVIDER_MESSAGES = Object.freeze({
  [PROVIDER_CODES.UNTRUSTED]: "Untrusted desktop frame.",
  [PROVIDER_CODES.REQUEST]: "Invalid provider request.",
  [PROVIDER_CODES.OPERATION]: "This provider operation is not supported.",
  [PROVIDER_CODES.MODEL]: "Invalid provider model name.",
  [PROVIDER_CODES.ENDPOINT]: "Invalid provider endpoint.",
  [PROVIDER_CODES.SCOPE]: "Invalid provider credential scope.",
  [PROVIDER_CODES.CREDENTIAL]: "No usable API key is stored for this provider and endpoint.",
  [PROVIDER_CODES.POLICY]: "The provider endpoint is not an allowed destination.",
  [PROVIDER_CODES.REDIRECT]: "The provider answered with a redirect, which is never followed.",
  [PROVIDER_CODES.STATUS]: "The provider returned an error status.",
  [PROVIDER_CODES.LIMIT]: "The provider exchange exceeded its size or frame limit.",
  [PROVIDER_CODES.TIMEOUT]: "The provider did not answer in time.",
  [PROVIDER_CODES.NETWORK]: "The provider request failed.",
  [PROVIDER_CODES.CANCELLED]: "The provider request was cancelled.",
})

class ProviderTransportError extends Error {
  constructor(code, { status, retryAfterMs } = {}) {
    super(PROVIDER_MESSAGES[code] ?? PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK])
    this.name = "ProviderTransportError"
    this.code = code
    if (Number.isInteger(status)) this.status = status
    if (Number.isInteger(retryAfterMs)) this.retryAfterMs = retryAfterMs
  }
}

const providerError = (code, options) => new ProviderTransportError(code, options)

function loopbackAddress(hostname) {
  const clean = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "")
  return LOOPBACK_ADDRESSES.get(clean) ?? null
}

// Mirrors `parseRetryAfterMs` in src/llm-retry.js. src is an ES module bundled for the browser and
// cannot be required from a CommonJS main process, so the bounded parser is kept here as well.
function parseRetryAfterMs(value, maxMs = MAX_RETRY_AFTER_MS) {
  if (!value) return null
  const text = String(value).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.min(maxMs, Math.max(0, Math.round(Number(text) * 1000)))
  const date = Date.parse(text)
  if (Number.isFinite(date)) return Math.min(maxMs, Math.max(0, date - Date.now()))
  return null
}

function describeContentType(rawHeader) {
  const value = String(rawHeader ?? "").toLowerCase()
  if (value.includes("text/event-stream")) return "sse"
  if (value.includes("json")) return "json"
  return "text"
}

const isRedirectStatus = (status) => status >= 300 && status < 400
const isSuccessStatus = (status) => status >= 200 && status < 300

/**
 * Redacts a secret from a response body, including when the secret is split across two chunks.
 *
 * A frame only ever emits text that cannot be the start of a secret: everything after the last
 * position that could still grow into one is held back and re-examined with the next frame, so a key
 * reflected across a chunk boundary never crosses the IPC.
 */
class SecretRedactor {
  constructor(secret) {
    this.secret = typeof secret === "string" && secret ? secret : null
    // A "key" longer than the scan window would make the suffix search unbounded, so such a value is
    // held back whole and emitted only once at flush.
    this.holdAll = Boolean(this.secret && this.secret.length - 1 > MAX_PREFIX_SCAN)
    this.tail = ""
  }

  redact(text) {
    // split/join replaces every occurrence without interpreting the secret as a pattern.
    return text.split(this.secret).join(REDACTED)
  }

  // Longest suffix of `text` that is a proper prefix of the secret, so it is held back until it can
  // be shown not to complete one.
  holdback(text) {
    if (this.holdAll) return text.length
    const limit = Math.min(this.secret.length - 1, text.length)
    for (let size = limit; size > 0; size--) {
      if (text.charCodeAt(text.length - size) !== this.secret.charCodeAt(0)) continue
      if (text.endsWith(this.secret.slice(0, size))) return size
    }
    return 0
  }

  push(text) {
    const chunk = String(text ?? "")
    if (!this.secret) return chunk
    const buffer = this.redact(this.tail + chunk)
    const hold = this.holdback(buffer)
    this.tail = hold ? buffer.slice(buffer.length - hold) : ""
    return hold ? buffer.slice(0, buffer.length - hold) : buffer
  }

  flush() {
    const rest = this.tail
    this.tail = ""
    return rest
  }
}

function senderKeyOf(event) {
  const id = event?.sender?.id
  return Number.isInteger(id) && id > 0 ? "w" + id : null
}

// Request parsing. Only these four fields are read; anything else the renderer includes is ignored,
// so no extra field can become authority over the destination.
function parseProviderRequest(raw, streaming) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw providerError(PROVIDER_CODES.REQUEST)
  const { provider, operation, model, payload } = raw
  if (!PROVIDER_NAMES.has(provider)) throw providerError(PROVIDER_CODES.REQUEST)
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw providerError(PROVIDER_CODES.REQUEST)
  if (provider === "gemini") {
    const expected = streaming ? GEMINI_STREAM_OPERATION : GEMINI_REQUEST_OPERATION
    if (operation !== expected) throw providerError(PROVIDER_CODES.OPERATION)
    if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH || !GEMINI_MODEL_PATTERN.test(model)) {
      throw providerError(PROVIDER_CODES.MODEL)
    }
  } else {
    if (operation !== OPENAI_OPERATION) throw providerError(PROVIDER_CODES.OPERATION)
    // The stream flag is the only way the OpenAI-compatible shape selects streaming, so the two paths
    // cannot disagree about which one is running.
    if (streaming ? payload.stream !== true : payload.stream !== undefined && payload.stream !== false) {
      throw providerError(PROVIDER_CODES.REQUEST)
    }
  }
  let body
  try { body = JSON.stringify(payload) } catch { throw providerError(PROVIDER_CODES.REQUEST) }
  if (typeof body !== "string" || !body || Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw providerError(PROVIDER_CODES.REQUEST)
  }
  return { provider, operation, model, body }
}

// The canonical provider+endpoint scope is the only identity a key has. It is resolved here, from the
// provider main built the destination for, so a request cannot name a scope it did not derive.
function credentialScopeFor(provider, endpoint) {
  try {
    return resolveCredentialScope(provider, endpoint)
  } catch (error) {
    if (error instanceof CredentialStoreError && error.code === CREDENTIAL_CODES.INVALID_PROVIDER) {
      throw providerError(PROVIDER_CODES.REQUEST)
    }
    if (error instanceof CredentialStoreError && error.code === CREDENTIAL_CODES.INVALID_ENDPOINT) {
      throw providerError(PROVIDER_CODES.ENDPOINT)
    }
    throw providerError(PROVIDER_CODES.SCOPE)
  }
}

// Gemini's origin, path prefix and query are constants; only a validated model and a whitelisted
// operation take part, and the assembled URL is parsed again to prove nothing else came along.
function geminiDestination(model, operation) {
  const spec = GEMINI_OPERATIONS.get(operation)
  if (!spec) throw providerError(PROVIDER_CODES.OPERATION)
  // Checked here as well as at the request boundary: the path invariant must not depend on a caller
  // having validated the model first.
  if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH || !GEMINI_MODEL_PATTERN.test(model)) {
    throw providerError(PROVIDER_CODES.MODEL)
  }
  const url = new URL(GEMINI_ORIGIN + "/v1beta/models/" + model + spec.suffix)
  if (url.username || url.password || url.hash) throw providerError(PROVIDER_CODES.ENDPOINT)
  if (url.protocol !== "https:" || url.hostname !== GEMINI_HOST) throw providerError(PROVIDER_CODES.ENDPOINT)
  // `alt=sse` is the operation's own query, and it is the only query allowed to exist.
  if (url.search !== "" && !(spec.sse && url.search === "?alt=sse")) throw providerError(PROVIDER_CODES.ENDPOINT)
  const { scope, handle } = credentialScopeFor("gemini")
  return {
    provider: "gemini",
    url: GEMINI_ORIGIN + url.pathname + url.search,
    host: GEMINI_HOST,
    loopback: null,
    scope,
    handle,
  }
}

// The OpenAI-compatible base URL is user-configured, so it is not trusted as given: it goes through
// the credential scope's canonical form and the request URL is rebuilt from that same string. The URL
// the key was stored for is therefore the URL the key is sent to, byte for byte.
function openAiDestination(rawEndpoint) {
  const { scope, handle } = credentialScopeFor("openai", rawEndpoint)
  const base = scope.slice(OPENAI_SCOPE_PREFIX.length)
  if (!base) throw providerError(PROVIDER_CODES.ENDPOINT)
  let url
  try { url = new URL(base + OPENAI_CHAT_PATH) } catch { throw providerError(PROVIDER_CODES.ENDPOINT) }
  if (url.username || url.password || url.search || url.hash) throw providerError(PROVIDER_CODES.ENDPOINT)
  if (!url.pathname.endsWith(OPENAI_CHAT_PATH)) throw providerError(PROVIDER_CODES.ENDPOINT)
  const loopback = loopbackAddress(url.hostname)
  const secure = url.protocol === "https:"
  if (!secure && !(url.protocol === "http:" && loopback)) throw providerError(PROVIDER_CODES.ENDPOINT)
  const origin = url.protocol + "//" + url.host
  return {
    provider: "openai",
    url: origin + url.pathname,
    host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    loopback,
    scope,
    handle,
  }
}

function buildHeaders(destination, secret, streaming) {
  const accept = streaming ? "text/event-stream, application/json" : "application/json, text/event-stream"
  const headers = {
    "Content-Type": "application/json",
    Accept: accept,
    // An uncompressed body keeps the byte limit meaningful and needs no decoder in the path.
    "Accept-Encoding": "identity",
    "User-Agent": USER_AGENT,
  }
  if (!secret) return headers
  if (destination.provider === "gemini") headers["x-goog-api-key"] = secret
  else headers.Authorization = "Bearer " + secret
  return headers
}

/**
 * Single POST to the pinned address of an already-validated destination.
 *
 * The socket goes to the resolved or fixed literal address while the TLS name and Host header stay on
 * the real hostname, so certificate checks still apply. `agent: false` means no pooled connection is
 * shared between destinations, and the caller's signal is the only way out of a request.
 */
function openRequest({ url, address, headers, body, signal, timeoutMs, request = null }) {
  const target = new URL(url)
  const secure = target.protocol === "https:"
  const hostname = target.hostname.replace(/^\[|\]$/g, "")
  const literal = net.isIP(hostname) !== 0
  const transport = secure ? https : http
  const options = {
    method: "POST",
    host: address,
    port: target.port ? Number(target.port) : secure ? 443 : 80,
    path: target.pathname + target.search,
    headers: {
      Host: target.host,
      ...headers,
      "Content-Length": String(Buffer.byteLength(body)),
    },
    agent: false,
    signal,
    ...(secure && !literal ? { servername: target.hostname } : {}),
  }
  if (request) return request(options, url)

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const req = transport.request(options, (res) => {
      if (settled) {
        res.destroy()
        return
      }
      settled = true
      resolve({ status: res.statusCode ?? 0, headers: res.headers, response: res })
    })
    // A socket timeout is an inactivity timer: it covers a stalled connect, a stalled header block
    // and a body trickling in below any progress the deadline would notice.
    req.setTimeout(timeoutMs, () => {
      fail(providerError(PROVIDER_CODES.TIMEOUT))
      req.destroy()
    })
    req.on("error", (error) => {
      if (signal?.aborted) fail(providerError(PROVIDER_CODES.CANCELLED))
      else if (error?.name === "AbortError" || error?.code === "ABORT_ERR") fail(providerError(PROVIDER_CODES.CANCELLED))
      else fail(providerError(PROVIDER_CODES.NETWORK))
    })
    req.end(body)
  })
}

function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const done = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    }
    response.on("data", (chunk) => {
      if (settled) return
      received += chunk.length
      if (received > maxBytes) {
        fail(providerError(PROVIDER_CODES.LIMIT))
        response.destroy()
        return
      }
      chunks.push(chunk)
    })
    response.on("end", done)
    response.on("aborted", () => fail(providerError(PROVIDER_CODES.NETWORK)))
    response.on("error", (error) => {
      if (error instanceof ProviderTransportError) fail(error)
      else if (error?.name === "AbortError" || error?.code === "ABORT_ERR") fail(providerError(PROVIDER_CODES.CANCELLED))
      else fail(providerError(PROVIDER_CODES.NETWORK))
    })
  })
}

// The renderer only ever receives a closed shape: a status code, a content-type class and the body.
// Response headers are not forwarded, so a reflected credential in an echo header cannot travel.
function failureOf(error) {
  if (error instanceof ProviderTransportError && Object.hasOwn(PROVIDER_MESSAGES, error.code)) {
    const payload = { ok: false, code: error.code, message: PROVIDER_MESSAGES[error.code] }
    if (Number.isInteger(error.status)) payload.status = error.status
    if (Number.isInteger(error.retryAfterMs)) payload.retryAfterMs = error.retryAfterMs
    return payload
  }
  return { ok: false, code: PROVIDER_CODES.NETWORK, message: PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK] }
}

const streamFailureOf = (error) => ({ type: "error", ...failureOf(error) })

// Main-process facade for the provider channels. Main-process only: `credentials` is the credential
// store itself, read with a handle derived from the canonical scope, and the decrypted key never
// leaves this module except as a request header.
class ProviderTransport {
  constructor({ credentials, emit, lookup, request } = {}) {
    if (!credentials || typeof credentials.read !== "function") {
      throw new TypeError("ProviderTransport needs a credential store.")
    }
    if (typeof emit !== "function") throw new TypeError("ProviderTransport needs an event sink.")
    this.credentials = credentials
    this.emit = emit
    // Test seams only: a resolver and a request function let a fake transport prove what main builds.
    this.lookup = lookup
    this.request = request ?? null
    // Live exchanges by ticket, so a cancel can only reach an exchange its own sender started.
    this.entries = new Map()
  }

  async plan(senderKey, raw, streaming) {
    if (typeof senderKey !== "string" || !senderKey) throw providerError(PROVIDER_CODES.UNTRUSTED)
    const request = parseProviderRequest(raw, streaming)
    const destination = request.provider === "gemini"
      ? geminiDestination(request.model, request.operation)
      : openAiDestination(raw.endpoint)
    const secret = await this.readSecret(destination.handle)
    // A stored key that cannot be read is an error, not an invitation to try keyless: silently
    // dropping auth would turn "vault locked" into a confusing provider 401.
    if (!secret && !this.allowsKeyless(destination)) throw providerError(PROVIDER_CODES.CREDENTIAL)
    const address = await this.resolveAddress(destination)
    return {
      destination,
      secret,
      transport: {
        url: destination.url,
        address,
        headers: buildHeaders(destination, secret, streaming),
        body: request.body,
        request: this.request,
      },
    }
  }

  allowsKeyless(destination) {
    // Local inference servers commonly need no key, and that path is the one the desktop must keep
    // working. It is only reachable at a loopback literal, so "keyless" can never leak to the network.
    return destination.provider === "openai" && Boolean(destination.loopback)
  }

  async readSecret(handle) {
    try {
      return await this.credentials.read(handle)
    } catch {
      // A native cryptography failure keeps its own fixed message in the credential layer; here it
      // becomes one provider message with no cause chain attached.
      throw providerError(PROVIDER_CODES.CREDENTIAL)
    }
  }

  async resolveAddress(destination) {
    if (destination.loopback) return destination.loopback
    try {
      return await resolvePublicAddress(destination.host, this.lookup ? { lookup: this.lookup } : undefined)
    } catch {
      throw providerError(PROVIDER_CODES.POLICY)
    }
  }

  async execute(senderKey, raw) {
    let plan
    try {
      plan = await this.plan(senderKey, raw, false)
    } catch (error) {
      return failureOf(error)
    }
    const controller = new AbortController()
    const ticket = "r" + randomUUID().replace(/-/g, "")
    const entry = { ticket, senderKey, controller, response: null, cancelled: false }
    this.entries.set(ticket, entry)
    try {
      const opened = await openRequest({ ...plan.transport, signal: controller.signal, timeoutMs: REQUEST_TIMEOUT_MS })
      entry.response = opened.response
      const status = opened.status
      const contentType = describeContentType(opened.headers?.["content-type"])
      if (isRedirectStatus(status)) {
        opened.response.destroy()
        throw providerError(PROVIDER_CODES.REDIRECT, { status })
      }
      if (!isSuccessStatus(status)) {
        opened.response.destroy()
        throw providerError(PROVIDER_CODES.STATUS, {
          status,
          retryAfterMs: parseRetryAfterMs(opened.headers?.["retry-after"]),
        })
      }
      const body = await readBody(opened.response, MAX_RESPONSE_BYTES)
      const redactor = new SecretRedactor(plan.secret)
      const text = redactor.push(body.toString("utf8")) + redactor.flush()
      return { ok: true, status, contentType, body: text }
    } catch (error) {
      if (entry.cancelled) return failureOf(providerError(PROVIDER_CODES.CANCELLED))
      return failureOf(error)
    } finally {
      this.entries.delete(ticket)
    }
  }

  async stream(senderKey, raw) {
    let plan
    try {
      plan = await this.plan(senderKey, raw, true)
    } catch (error) {
      return failureOf(error)
    }
    const controller = new AbortController()
    const ticket = "s" + randomUUID().replace(/-/g, "")
    let opened
    try {
      opened = await openRequest({ ...plan.transport, signal: controller.signal, timeoutMs: STREAM_IDLE_TIMEOUT_MS })
    } catch (error) {
      return failureOf(error)
    }
    const status = opened.status
    const contentType = describeContentType(opened.headers?.["content-type"])
    if (isRedirectStatus(status)) {
      opened.response.destroy()
      return failureOf(providerError(PROVIDER_CODES.REDIRECT, { status }))
    }
    if (!isSuccessStatus(status)) {
      opened.response.destroy()
      return failureOf(providerError(PROVIDER_CODES.STATUS, {
        status,
        retryAfterMs: parseRetryAfterMs(opened.headers?.["retry-after"]),
      }))
    }

    const entry = { ticket, senderKey, controller, response: opened.response, cancelled: false, deadline: null }
    this.entries.set(ticket, entry)
    // A stream that keeps trickling bytes must still end, so the frame budget is bounded by a wall
    // clock as well as by an inactivity timer.
    entry.deadline = setTimeout(() => this.abortEntry(entry, providerError(PROVIDER_CODES.TIMEOUT)), STREAM_TOTAL_TIMEOUT_MS)
    entry.deadline?.unref?.()
    // The reply carrying the ticket has to reach the renderer before the first frame, so pumping
    // starts once the handler's promise has been resolved.
    setImmediate(() => { this.pump(entry, plan.secret).catch(() => {}) })
    return { ok: true, ticket, status, contentType }
  }

  async pump(entry, secret) {
    const { response, ticket, senderKey } = entry
    const redactor = new SecretRedactor(secret)
    const decoder = new TextDecoder("utf-8")
    let bytes = 0
    let chunks = 0
    const emit = (payload) => {
      // A frame that cannot be delivered (window gone, IPC closed) must not become a rejection in
      // the pump, which nothing awaits.
      try { this.emit(senderKey, { ticket, ...payload }) } catch {}
    }
    const deliver = (payload) => { if (!entry.cancelled) emit(payload) }
    // The inactivity timer is the socket's own, reset by every byte the provider sends.
    response.setTimeout?.(STREAM_IDLE_TIMEOUT_MS, () => {
      this.abortEntry(entry, providerError(PROVIDER_CODES.TIMEOUT))
    })
    try {
      for await (const chunk of response) {
        bytes += chunk.length
        chunks += 1
        if (bytes > MAX_STREAM_BYTES || chunks > MAX_STREAM_CHUNKS) throw providerError(PROVIDER_CODES.LIMIT)
        // stream: true keeps a multi-byte character split across two frames intact.
        const text = redactor.push(decoder.decode(chunk, { stream: true }))
        if (text) deliver({ type: "chunk", text })
      }
      const tail = redactor.push(decoder.decode()) + redactor.flush()
      if (tail) deliver({ type: "chunk", text: tail })
      deliver({ type: "end" })
    } catch (error) {
      // Deliberately unguarded: a cancelled exchange still reports its own terminal frame.
      emit(streamFailureOf(entry.cancelled
        ? entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED)
        : error))
    } finally {
      this.releaseEntry(entry)
      if (!response.destroyed) response.destroy()
    }
  }

  abortEntry(entry, reason) {
    if (entry.cancelled) return false
    entry.cancelled = true
    entry.abortReason = reason ?? null
    clearTimeout(entry.deadline)
    entry.deadline = null
    try { entry.controller.abort() } catch {}
    try { entry.response?.destroy?.() } catch {}
    this.entries.delete(entry.ticket)
    return true
  }

  releaseEntry(entry) {
    clearTimeout(entry.deadline)
    entry.deadline = null
    this.entries.delete(entry.ticket)
  }

  // A ticket is only cancellable by the sender that opened it, so one document cannot stop another
  // document's stream.
  cancel(senderKey, ticket) {
    const entry = typeof ticket === "string" ? this.entries.get(ticket) : null
    if (!entry || entry.senderKey !== senderKey) return { ok: true, cancelled: false }
    return { ok: true, cancelled: this.abortEntry(entry, providerError(PROVIDER_CODES.CANCELLED)) }
  }

  // Teardown for a navigation or a closed window: every exchange still open, whatever opened it, so
  // nothing keeps reading a body after its document is gone.
  cancelAll() {
    let cancelled = 0
    for (const entry of [...this.entries.values()]) {
      if (this.abortEntry(entry, providerError(PROVIDER_CODES.CANCELLED))) cancelled += 1
    }
    return cancelled
  }

  cancelSender(senderKey) {
    let cancelled = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.senderKey !== senderKey) continue
      if (this.abortEntry(entry, providerError(PROVIDER_CODES.CANCELLED))) cancelled += 1
    }
    return cancelled
  }
}

// Envelope for the provider channels. `trustedChannel` in credential-ipc.cjs deliberately drops the
// event, but ownership here is derived from it, so the validated event is passed to the action as a
// sender key the renderer never supplies.
function providerChannel(isTrusted, action, onError) {
  if (typeof isTrusted !== "function" || typeof action !== "function") {
    throw new TypeError("providerChannel needs an isTrusted check and an action.")
  }
  return async (event, ...args) => {
    let trusted = false
    try { trusted = isTrusted(event) === true } catch { trusted = false }
    const senderKey = trusted ? senderKeyOf(event) : null
    if (!senderKey) return { error: PROVIDER_MESSAGES[PROVIDER_CODES.UNTRUSTED] }
    try {
      return { value: await action(senderKey, ...args) }
    } catch (error) {
      return { error: onError ? onError(error) : PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK] }
    }
  }
}

// Fixed strings only, so an unexpected throw from anywhere in the path still reaches the renderer as
// one reviewed message rather than as a socket error carrying request context.
function sanitizeProviderError(error) {
  if (error instanceof ProviderTransportError && Object.hasOwn(PROVIDER_MESSAGES, error.code)) {
    return PROVIDER_MESSAGES[error.code]
  }
  return PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK]
}

module.exports = {
  PROVIDER_CHANNELS,
  PROVIDER_CODES,
  PROVIDER_MESSAGES,
  ProviderTransport,
  ProviderTransportError,
  SecretRedactor,
  buildHeaders,
  describeContentType,
  failureOf,
  geminiDestination,
  loopbackAddress,
  openAiDestination,
  openRequest,
  parseProviderRequest,
  parseRetryAfterMs,
  providerChannel,
  providerError,
  sanitizeProviderError,
  senderKeyOf,
}
