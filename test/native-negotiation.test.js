import assert from "node:assert/strict"
import test from "node:test"
import worker from "../desktop/native-worker.cjs"

/*
 * Protocol negotiation between the renderer, the Electron client and the C# worker (issue #58).
 *
 * The documented contract is that both ends name the protocol range they speak. A request carries
 * `protocol: { min, max }`, a reply carries `protocolVersion`, `minProtocol` and `maxProtocol`, and
 * `capabilities` adds the same range plus `operationVersions`, so a feature is detected from the
 * reply instead of being assumed. A worker whose range does not overlap the app's, or that changes
 * framing after the exchange agreed on a version, produces one stable `NativeProtocolError`; the
 * process is not killed, because the persistent worker owns open project handles. Only a corrupted
 * frame terminates it.
 *
 * Everything here is synthetic: `NegotiatingWorker` replaces the spawned transport with a child
 * double and the renderer runs against a `khungThoaiDesktop` double, so the suite needs no worker
 * executable, .NET SDK, Tesseract or Electron.
 */

const MAGIC = Buffer.from("KTR1", "ascii")
const PROTOCOL_CODE = "NATIVE_PROTOCOL_INCOMPATIBLE"
const PROTOCOL_PREFIX = "Native protocol incompatible: "

// `src/native.js` captures `globalThis.khungThoaiDesktop` when it is evaluated, so the double is
// installed first and each test swaps only the method it calls.
const desktopDouble = { native: async () => ({ result: null }) }
globalThis.khungThoaiDesktop = desktopDouble
const renderer = await import("../src/native.js")

/* Frames and replies. */

function json(value) {
  return Buffer.from(JSON.stringify(value))
}

function frameBytes(metadata, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(12)
  MAGIC.copy(header, 0, 0, 4)
  header.writeUInt32LE(metadata.length, 4)
  header.writeUInt32LE(payload.length, 8)
  return Buffer.concat([header, metadata, payload])
}

function replyFrame(reply, payload = Buffer.alloc(0)) {
  return frameBytes(json(reply), payload)
}

/* The transport double: bytes are written to an in-memory child and replies are fed back through the
 * production `read()` entry point, exactly as the stdout listener does. */

function childDouble(id) {
  const child = {
    id,
    killed: 0,
    writes: [],
    stdin: {
      write(chunk, callback) {
        child.writes.push(Buffer.from(chunk))
        callback?.()
      },
      on() {},
    },
    stdout: { on() {} },
    on() {},
    kill() { child.killed += 1 },
  }
  return child
}

class NegotiatingWorker extends worker.NativeWorker {
  constructor() {
    super(process.execPath)
    this.started = []
  }

  start() {
    const child = childDouble(this.started.length)
    this.started.push(child)
    this.child = child
    return child
  }
}

async function drain(turns = 8) {
  for (let index = 0; index < turns; index += 1) await null
}

// Wait until the request under test has been written to the transport, so the suite never depends on
// how many microtask turns the queue needs on a given runtime.
async function sent(w, turns = 64) {
  const target = (w.child?.writes.length ?? 0) + 3
  for (let turn = 0; turn < turns; turn += 1) {
    if (w.child && w.child.writes.length >= target) return w.child
    await null
  }
  return assert.fail("the request was never written to the transport")
}

function observe(w, operation = "capabilities") {
  const state = { settled: 0, value: undefined, error: undefined }
  const promise = w.call(operation, {}, new Uint8Array(0))
  promise.then(
    (value) => { state.settled += 1; state.value = value },
    (error) => { state.settled += 1; state.error = error },
  )
  return { promise, state }
}

function failureOf(action) {
  try { action() } catch (error) { return error }
  return assert.fail("the call must throw")
}

function describeRange(minimum, maximum) {
  return minimum === maximum ? String(minimum) : minimum + "-" + maximum
}

function rangeDetail(workerMinimum, workerMaximum) {
  return PROTOCOL_PREFIX + "worker supports " + describeRange(workerMinimum, workerMaximum) +
    ", app supports " + describeRange(worker.PROTOCOL_MIN, worker.PROTOCOL_MAX) + "."
}

/* Negotiation in the Electron client. */

test("the request offers the protocol range both ends declare and a compatible reply keeps the process", async (t) => {
  assert.equal(worker.PROTOCOL_MIN, renderer.PROTOCOL_MIN, "the renderer and the client must declare the same range")
  assert.equal(worker.PROTOCOL_MAX, renderer.PROTOCOL_MAX)
  assert.ok(Number.isSafeInteger(worker.PROTOCOL_MIN) && worker.PROTOCOL_MIN <= worker.PROTOCOL_MAX)

  const w = new NegotiatingWorker()
  t.after(() => w.close())
  const observed = observe(w)
  const child = await sent(w)

  const [header, metadata, payload] = child.writes
  assert.equal(header.length, 12)
  assert.ok(header.subarray(0, 4).equals(MAGIC), "the negotiation happens inside the KTR1 frame")
  assert.equal(payload.length, 0)
  const request = JSON.parse(metadata.toString("utf8"))
  assert.equal(request.version, worker.PROTOCOL_MIN)
  assert.deepEqual(request.protocol, { min: worker.PROTOCOL_MIN, max: worker.PROTOCOL_MAX })
  assert.equal(request.operation, "capabilities")

  w.read(replyFrame({
    version: worker.PROTOCOL_MIN, ok: true,
    protocolVersion: worker.PROTOCOL_MIN, minProtocol: worker.PROTOCOL_MIN, maxProtocol: worker.PROTOCOL_MAX,
    operations: ["png"], operationVersions: { png: worker.PROTOCOL_MIN }, languages: [],
  }))
  await drain()

  assert.equal(observed.state.settled, 1)
  assert.equal(observed.state.error, undefined, "an overlapping range settles the request")
  assert.equal(observed.state.value.result.protocolVersion, worker.PROTOCOL_MIN)
  assert.equal(w.protocolVersion, worker.PROTOCOL_MIN, "the agreed version is cached for the connection")
  assert.equal(w.protocolError, null)
  assert.equal(w.child, child, "a compatible reply keeps the process")
  assert.equal(child.killed, 0)
})

test("a worker reporting an older range fails once with the stable error and keeps its file handles", async (t) => {
  const w = new NegotiatingWorker()
  t.after(() => w.close())

  // A transfer this process owns: the handle lives in the worker, so killing it loses the transfer.
  const transfer = observe(w, "fileBegin")
  const child = await sent(w)
  w.read(replyFrame({ version: worker.PROTOCOL_MIN, ok: true, id: "t1" }))
  await drain()
  assert.equal(transfer.state.value.result.id, "t1")

  const observed = observe(w)
  await sent(w)
  w.read(replyFrame({ version: 0, ok: true, minProtocol: 0, maxProtocol: 0 }))
  await drain()

  assert.equal(observed.state.settled, 1, "the request settles instead of hanging")
  const error = observed.state.error
  assert.ok(error instanceof worker.NativeProtocolError)
  assert.equal(error.name, "NativeProtocolError")
  assert.equal(error.code, PROTOCOL_CODE)
  assert.equal(error.message, rangeDetail(0, 0))
  assert.equal(w.requestInFlight, null, "no half-parsed exchange is left in flight")
  assert.equal(w.queued, 0)
  assert.equal(w.child, child, "the process holding the open file handle must survive")
  assert.equal(child.killed, 0)

  // Later requests reuse the one stable error and write nothing into the abandoned stream.
  const writes = child.writes.length
  const repeated = await w.call("fileAppend", { id: "t1" }, new Uint8Array(0)).then(() => null, (failure) => failure)
  assert.equal(repeated, error, "every later request fails on the same error")
  assert.equal(child.writes.length, writes, "an abandoned exchange receives no further bytes")
  assert.equal(w.started.length, 1)

  // Bytes from the abandoned exchange must not tear the process down either.
  w.read(replyFrame({ version: 0, ok: true }))
  assert.equal(w.child, child)
  assert.equal(child.killed, 0)

  w.close()
  assert.equal(child.killed, 1, "closing the app still terminates the worker")
  assert.equal(w.child, null)
})

test("a worker reporting a newer range fails with the same stable error and names both versions", async (t) => {
  const w = new NegotiatingWorker()
  t.after(() => w.close())
  const observed = observe(w)
  const child = await sent(w)

  w.read(replyFrame({ version: 2, ok: true, protocolVersion: 2, minProtocol: 2, maxProtocol: 3, operations: ["png"] }))
  await drain()

  assert.equal(observed.state.settled, 1)
  assert.equal(observed.state.error.code, PROTOCOL_CODE)
  assert.equal(observed.state.error.message, rangeDetail(2, 3))
  assert.match(observed.state.error.message, /worker supports 2-3, app supports 1/)
  assert.equal(w.child, child, "a newer worker is not killed for being newer")
  assert.equal(child.killed, 0)
  assert.equal(w.requestInFlight, null)
})

test("a worker that changes framing after agreeing ends the exchange on the same stable error", async (t) => {
  const w = new NegotiatingWorker()
  t.after(() => w.close())

  const first = observe(w)
  const child = await sent(w)
  w.read(replyFrame({ version: 1, ok: true, protocolVersion: 1, minProtocol: 1, maxProtocol: 2 }))
  await drain()
  assert.equal(first.state.error, undefined, "the overlapping range agrees on the app's version")
  assert.equal(w.protocolVersion, 1)

  const second = observe(w)
  await sent(w)
  w.read(replyFrame({ version: 2, ok: true, protocolVersion: 2, minProtocol: 1, maxProtocol: 2 }))
  await drain()

  assert.equal(second.state.settled, 1)
  assert.equal(second.state.error.code, PROTOCOL_CODE)
  assert.equal(second.state.error.message, PROTOCOL_PREFIX + "worker replied with protocol 2 after agreeing on 1.")
  assert.equal(w.protocolVersion, 1, "the agreed version does not drift with the reply")
  assert.equal(w.child, child)
  assert.equal(child.killed, 0)
  assert.equal(w.requestInFlight, null)
})

/* Negotiation in the renderer. */

test("the renderer accepts a worker built before the handshake and refuses a newer or older range", async () => {
  const legacy = { protocol: 1, operations: ["png", "ocr"], languages: ["eng"] }
  desktopDouble.native = async () => ({ result: legacy })
  assert.deepEqual(await renderer.nativeCapabilities(true), legacy, "a reply without a range is the version this build serves")
  assert.equal(renderer.negotiatedProtocol({}), renderer.PROTOCOL_MIN)
  assert.equal(renderer.nativeProtocolError(), null)

  for (const [reply, detail] of [
    [{ version: 2, ok: true, protocolVersion: 2, minProtocol: 2, maxProtocol: 3 }, rangeDetail(2, 3)],
    [{ version: 0, ok: true, minProtocol: 0, maxProtocol: 0 }, rangeDetail(0, 0)],
  ]) {
    const requested = []
    desktopDouble.native = async (operation) => { requested.push(operation); return { result: reply } }
    assert.equal(await renderer.nativeCapabilities(true), null, "an incompatible worker degrades to the renderer path")

    const failure = renderer.nativeProtocolError()
    assert.ok(failure instanceof renderer.NativeProtocolError)
    assert.equal(failure.code, PROTOCOL_CODE)
    assert.equal(failure.message, detail, "the renderer builds the same message the client build does")
    const fromClient = failureOf(() => worker.negotiateProtocol(reply, null))
    assert.equal(fromClient.message, failure.message, "both layers describe the same worker the same way")

    await assert.rejects(renderer.runNativeTask("png", {}, new Uint8Array(0)), (error) => error === failure)
    assert.deepEqual(requested, ["capabilities"], "no operation is attempted on an incompatible worker")
  }

  desktopDouble.native = async () => { throw new Error("Chưa biên dịch worker C#. Chạy npm run desktop:native.") }
  assert.equal(await renderer.nativeCapabilities(true), null)
  assert.equal(renderer.nativeProtocolError(), null, "a missing build keeps its own hint instead of a protocol error")
})

test("an incompatible worker reported over IPC keeps the same stable error for later tasks", async () => {
  const message = rangeDetail(2, 2)
  desktopDouble.native = async () => { throw new Error(message) }
  assert.equal(await renderer.nativeCapabilities(true), null, "the IPC rejection degrades instead of crashing the renderer")

  const failure = renderer.nativeProtocolError()
  assert.equal(failure.name, "NativeProtocolError")
  assert.equal(failure.code, PROTOCOL_CODE)
  assert.equal(failure.message, message, "the message main sent survives the IPC boundary unchanged")
  assert.equal(renderer.isNativeProtocolError(failure), true)
  assert.equal(renderer.isNativeProtocolError(new Error("Native worker exited.")), false)

  await assert.rejects(renderer.runNativeTask("ocr", {}, new Uint8Array(0)), (error) => error === failure)
})

test("an incompatible worker leaves the renderer export output unchanged", async (t) => {
  const original = globalThis.document
  t.after(() => {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
    globalThis.khungThoaiDesktop = desktopDouble
  })
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, painted: [] }
      canvas.getContext = () => ({
        clearRect: () => canvas.painted.push("clear"),
        drawImage: () => canvas.painted.push("draw"),
      })
      canvas.toBlob = (resolve, type) => resolve({
        type, width: canvas.width, height: canvas.height, painted: canvas.painted.join(","),
      })
      return canvas
    },
  }
  const { exportPage } = await import("../src/canvas.js")
  const page = { image: { naturalWidth: 2, naturalHeight: 3 }, boxes: [], retouchStrokes: [] }

  const requested = []
  desktopDouble.native = async (operation) => {
    requested.push(operation)
    return { result: { version: 2, ok: true, minProtocol: 2, maxProtocol: 3 } }
  }
  await renderer.nativeCapabilities(true)
  const degraded = await exportPage(page, "png")

  // The same page without a desktop shell at all: the renderer composite is the reference output.
  globalThis.khungThoaiDesktop = undefined
  const reference = await exportPage(page, "png")

  assert.deepEqual(degraded, reference, "the fallback must produce the same page")
  assert.deepEqual(requested, ["capabilities"], "the native png operation is never attempted")
  assert.equal(renderer.nativeProtocolError().code, PROTOCOL_CODE)
})
