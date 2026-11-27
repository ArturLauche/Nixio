const { execFile } = require("node:child_process")
const path = require("node:path")
const { existsSync } = require("node:fs")
const { TextureWorker } = require("./worker.cjs")

const maximumData = 512 * 1024 * 1024
const maximumMetadata = 4 * 1024 * 1024
const frameMagic = Buffer.from("KTR1", "ascii")
// Both ends of the bridge declare this range: `src/native.js` mirrors it for the renderer and
// `native/NativeRpc.cs` answers with its own. A worker outside the range is refused before any of
// its operations is trusted, and the process is left running because it owns open project handles.
const protocolMinimum = 1
const protocolMaximum = 1
const protocolCode = "NATIVE_PROTOCOL_INCOMPATIBLE"
const protocolPrefix = "Native protocol incompatible: "

function describeRange(minimum, maximum) {
  return minimum === maximum ? String(minimum) : minimum + "-" + maximum
}

function rangeDetail(workerMinimum, workerMaximum) {
  return "worker supports " + describeRange(workerMinimum, workerMaximum) +
    ", app supports " + describeRange(protocolMinimum, protocolMaximum) + "."
}

// One stable error for every incompatible worker: the code identifies the failure and the detail
// names the versions, so callers can tell it apart from a missing build or a corrupted frame. Main
// sends this exact text over IPC, which is why the prefix is fixed.
class NativeProtocolError extends Error {
  constructor(detail) {
    super(protocolPrefix + detail)
    this.name = "NativeProtocolError"
    this.code = protocolCode
  }
}

// Read the range a reply declares and pick the version both ends speak. A reply with no range and no
// version is not a negotiation at all and returns null, so the caller's shape check refuses it.
function negotiateProtocol(reply, negotiated) {
  const version = Number.isSafeInteger(reply.protocolVersion) ? reply.protocolVersion : reply.version
  const minimum = Number.isSafeInteger(reply.minProtocol) ? reply.minProtocol : version
  const maximum = Number.isSafeInteger(reply.maxProtocol) ? reply.maxProtocol : version
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) return null
  if (minimum > maximum) return null
  // A connection that already agreed on a version keeps it: a later reply naming another framing is
  // a protocol change the exchange cannot follow.
  const target = Number.isSafeInteger(negotiated) ? negotiated : Math.min(protocolMaximum, maximum)
  if (minimum > protocolMaximum || maximum < protocolMinimum) throw new NativeProtocolError(rangeDetail(minimum, maximum))
  if (version !== target) {
    throw new NativeProtocolError("worker replied with protocol " + version + " after agreeing on " + target + ".")
  }
  return target
}

class NativeWorker extends TextureWorker {
  constructor(executable, { isolated = false } = {}) {
    super(executable)
    this.args = ["--rpc"]
    this.detached = isolated && process.platform !== "win32"
    this.isolated = isolated
    this.protocolVersion = null
    this.protocolError = null
    const ocr = path.join(path.dirname(executable), "ocr")
    const engine = path.join(ocr, "tesseract" + (process.platform === "win32" ? ".exe" : ""))
    this.environment = { ...process.env }
    if (existsSync(engine) && !process.env.KHUNG_THOAI_TESSERACT) {
      this.environment.KHUNG_THOAI_TESSERACT = engine
      this.environment.TESSDATA_PREFIX = path.join(ocr, "tessdata")
    }
  }

  call(operation, options = {}, data = new Uint8Array(), onProgress) {
    if (!this.available) return Promise.reject(new Error("Chưa biên dịch worker C#. Chạy npm run desktop:native."))
    // An incompatible worker may still be running for its file handles, so later requests fail on the
    // same error instead of writing into an exchange the worker already abandoned.
    if (this.protocolError) return Promise.reject(this.protocolError)
    if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1 || data.byteLength > maximumData || this.queued >= 8) {
      return Promise.reject(new Error("Tác vụ native vượt giới hạn dữ liệu hoặc hàng đợi."))
    }
    // The request names the range this build accepts, so a newer or older worker can answer with its
    // own instead of failing with a shared "unsupported" message.
    const metadata = Buffer.from(JSON.stringify({
      version: this.protocolVersion ?? protocolMinimum,
      operation,
      options,
      protocol: { min: protocolMinimum, max: protocolMaximum },
    }))
    if (metadata.length > maximumMetadata) return Promise.reject(new Error("Metadata native quá lớn."))
    this.queued++
    // Copy at enqueue time so later edits cannot mutate an in-flight request.
    const bytes = Buffer.from(data)
    const run = () => this.request(metadata, bytes, operation === "ocr" ? 90000 : 120000, onProgress)
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result.finally(() => { this.queued-- })
  }

  redraw(sample) {
    if (!sample || typeof sample !== "object" || !sample.width || !sample.height || !sample.inner || !sample.pixels) {
      return Promise.resolve(null)
    }
    const { pixels, ...options } = sample
    return this.call("redraw", options, pixels).then(({ data }) => data.length ? data : null).catch(() => null)
  }

  request(metadata, bytes, timeout, onProgress) {
    if (!this.child) this.start()
    const child = this.child
    const header = Buffer.alloc(12)
    header.write("KTR1")
    header.writeUInt32LE(metadata.length, 4)
    header.writeUInt32LE(bytes.length, 8)
    return new Promise((resolve, reject) => {
      this.requestInFlight = {
        resolve, reject, deadline: setTimeout(() => this.stop(new Error("Native worker timed out.")), timeout),
        onProgress, header: Buffer.alloc(12), offset: 0, data: null, metadataLength: 0,
      }
      const fail = (error) => { if (error && this.child === child) this.stop(error) }
      child.stdin.write(header, fail)
      child.stdin.write(metadata, fail)
      child.stdin.write(bytes, fail)
    })
  }

  stop(error) {
    const child = this.child
    if (this.isolated && child?.pid) {
      if (process.platform === "win32") {
        if (this.killing) return
        this.killing = true
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
          this.killing = false
          super.stop(error)
        })
        return
      } else {
        try { process.kill(-child.pid, "SIGKILL") } catch {}
      }
    }
    super.stop(error)
  }

  read(chunk) {
    const pending = this.requestInFlight
    if (!pending) {
      // An abandoned exchange owns no request, so bytes that arrive later must not tear down a
      // process kept alive for its file handles.
      if (this.protocolError) return
      return this.stop(new Error("Unexpected native response."))
    }
    if (!pending.data) {
      const count = Math.min(12 - pending.offset, chunk.length)
      chunk.copy(pending.header, pending.offset, 0, count)
      pending.offset += count
      if (pending.offset < 12) return
      const metadataLength = pending.header.readUInt32LE(4)
      const size = pending.header.readUInt32LE(8)
      // Byte-for-byte: an "ascii" comparison would mask the high bit and accept 0xCB as "K".
      if (!pending.header.subarray(0, 4).equals(frameMagic) ||
          metadataLength < 2 || metadataLength > maximumMetadata || size > maximumData) {
        return this.stop(new Error("Invalid native response frame."))
      }
      pending.metadataLength = metadataLength
      pending.data = Buffer.alloc(metadataLength + size)
      pending.offset = 0
      chunk = chunk.subarray(count)
    }
    const count = Math.min(chunk.length, pending.data.length - pending.offset)
    chunk.copy(pending.data, pending.offset, 0, count)
    pending.offset += count
    const rest = chunk.subarray(count)
    if (pending.offset !== pending.data.length) return
    try {
      const result = JSON.parse(pending.data.toString("utf8", 0, pending.metadataLength))
      if (result.event === "progress" && result.version === (this.protocolVersion ?? protocolMinimum)) {
        pending.offset = 0
        pending.data = null
        pending.onProgress?.(result.progress, result.stage)
        if (rest.length) this.read(rest)
        return
      }
      this.requestInFlight = null
      clearTimeout(pending.deadline)
      const negotiated = negotiateProtocol(result, this.protocolVersion)
      if (typeof result.ok !== "boolean") throw new Error("Unsupported native response.")
      if (negotiated !== null) this.protocolVersion = negotiated
      if (!result.ok) pending.reject(new Error(result.error))
      else pending.resolve({ result, data: pending.data.subarray(pending.metadataLength) })
      if (rest.length) this.stop(new Error("Unexpected bytes after native response."))
    } catch (error) {
      clearTimeout(pending.deadline)
      this.requestInFlight = null
      pending.reject(error)
      // A complete frame naming another protocol leaves the stream synchronized: the exchange ends,
      // the error is remembered, and the process survives instead of being killed mid-transfer.
      if (error instanceof NativeProtocolError) { this.protocolError = error; return }
      this.stop(error)
    }
  }
}

module.exports = { NativeWorker, NativeProtocolError, negotiateProtocol, PROTOCOL_MIN: protocolMinimum, PROTOCOL_MAX: protocolMaximum }
