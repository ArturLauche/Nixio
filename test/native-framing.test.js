import assert from "node:assert/strict"
import test from "node:test"
import { NativeWorker } from "../desktop/native-worker.cjs"

/*
 * KTR1 framing conformance with seeded property generation.
 *
 * Documented contract (native/README.md, "Protocol"): each frame is the ASCII magic
 * `KTR1`, a uint32 little-endian JSON byte count, a uint32 little-endian payload byte
 * count, UTF-8 JSON and then binary bytes. JSON is limited to 4 MiB and payloads to
 * 512 MiB. Replies carry `version: 1` and a boolean `ok`; failed operations return
 * `ok: false` plus `error`. A malformed frame terminates the process, while operation
 * failures keep the stream synchronized.
 *
 * Everything here is synthetic and in memory: `FramingWorker` replaces the spawned
 * transport with a child double, so the suite needs no worker executable, .NET SDK or
 * Tesseract, never starts a process and stays within a few thousand tiny buffers.
 *
 * Framing validity classes exercised below:
 *   valid                     KTR1, 2 <= JSON <= 4 MiB, 0 <= payload <= 512 MiB, reply
 *                             shape `{version: 1, ok: true}` (payload 0 bytes included)
 *   progress                  `{version: 1, event: "progress"}` replies interleaved
 *                             before the final reply, in order, on the same stream
 *   wrong-magic               a header with an unrecognized protocol identifier
 *   declared-zero-metadata    declared JSON count 0 or 1 (below the documented floor)
 *   declared-oversized-meta   declared JSON count above 4 MiB, with no body allocated
 *   declared-oversized-data   declared payload count above 512 MiB, with no body allocated
 *   truncated-header          fewer than 12 bytes, then stream teardown
 *   truncated-body            a valid header followed by a partial body, then teardown
 *   malformed-metadata        complete body whose JSON is invalid or not an `ok` reply
 *   ok-false                  protocol-level operation failure (`ok: false`)
 *   trailing-bytes            a final reply followed by bytes the stream cannot attribute
 *
 * A complete frame naming another protocol is not a framing failure: it settles as one stable
 * `NativeProtocolError` and leaves the process running, so it is covered by
 * `test/native-negotiation.test.js` instead of the teardown cases below.
 *
 * Reproduce any failure with the seed printed in its message:
 *   NIXIO_FRAMING_SEED=0x4b545231 node --test test/native-framing.test.js
 */

const MAXIMUM_METADATA = 4 * 1024 * 1024
const MAXIMUM_DATA = 512 * 1024 * 1024
const DEFAULT_SEED = 0x4b545231
const MAGIC = Buffer.from("KTR1", "ascii")
const EMPTY = Buffer.alloc(0)

const CASE_BUDGET = {
  valid: 360,
  headers: 480,
  truncated: 192,
  metadata: 240,
  failures: 96,
  trailing: 48,
}

function readSeed() {
  const raw = process.env.NIXIO_FRAMING_SEED
  if (raw === undefined || raw === "") return DEFAULT_SEED
  const value = /^0x[0-9a-f]+$/i.test(raw)
    ? Number.parseInt(raw.slice(2), 16)
    : /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`NIXIO_FRAMING_SEED must be a uint32 in decimal or 0x hex form, received "${raw}".`)
  }
  return value >>> 0
}

const SEED = readSeed()
const SEED_LABEL = `0x${SEED.toString(16).padStart(8, "0")}`
const REPRODUCE = `NIXIO_FRAMING_SEED=${SEED_LABEL} node --test test/native-framing.test.js`
const stats = { cases: 0, blocks: 0 }

/* Deterministic generation: mulberry32 plus a stable per-block seed mix. */

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function mix(seed, label) {
  let hash = 0x811c9dc5
  for (let index = 0; index < label.length; index += 1) hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193)
  return (seed ^ hash) >>> 0
}

function integer(rng, minimum, maximum) {
  return minimum + Math.floor(rng() * (maximum - minimum + 1))
}

function pick(rng, values) {
  return values[Math.floor(rng() * values.length)]
}

function bytes(rng, length) {
  const buffer = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) buffer[index] = integer(rng, 0, 255)
  return buffer
}

/* Chunk boundaries: a single coalesced chunk, 1-3 byte fragments, or 1-19 byte fragments. */

function split(rng, length) {
  const mode = rng()
  if (mode < 0.25) return length ? [length] : []
  const maximum = mode < 0.6 ? 3 : 19
  const sizes = []
  let remaining = length
  while (remaining > 0) {
    const size = Math.min(remaining, integer(rng, 1, maximum))
    sizes.push(size)
    remaining -= size
  }
  return sizes
}

/* Frames and replies. */

function json(value) {
  return Buffer.from(JSON.stringify(value))
}

function frameBytes({ magic = MAGIC, metadata = EMPTY, payload = EMPTY, metadataLength = metadata.length, dataLength = payload.length } = {}) {
  const header = Buffer.alloc(12)
  magic.copy(header, 0, 0, 4)
  header.writeUInt32LE(metadataLength, 4)
  header.writeUInt32LE(dataLength, 8)
  return Buffer.concat([header, metadata, payload])
}

function finalFrame(payload = EMPTY) {
  return frameBytes({ metadata: json({ version: 1, ok: true, operation: "capabilities" }), payload })
}

function progressFrames(rng, count) {
  const events = []
  const frames = []
  for (let step = 0; step < count; step += 1) {
    const event = { progress: integer(rng, 0, 100), stage: pick(rng, ["OCR", "Redraw", "Inpaint"]) }
    events.push(event)
    frames.push(frameBytes({ metadata: Buffer.from(JSON.stringify({ version: 1, event: "progress", ...event })) }))
  }
  return { events, frames }
}

const HEADER_CLASSES = ["wrong-magic", "declared-zero-metadata", "declared-oversized-metadata", "declared-oversized-data"]

/*
 * A malformed header must be rejected from the 12 header bytes alone. The declared
 * lengths below never come with a body, so a parser that allocated before validating
 * would leave the request unsettled (and allocate hundreds of megabytes).
 */
function planHeader(rng, index) {
  const kind = HEADER_CLASSES[index % HEADER_CLASSES.length]
  const noise = integer(rng, 1, 64)
  if (kind === "wrong-magic") {
    const magic = Buffer.from(pick(rng, ["KTR2", "ktr1", "TEST"]))
    return { kind, bytes: frameBytes({ magic, metadataLength: 2 }) }
  }
  if (kind === "declared-zero-metadata") {
    return { kind, bytes: frameBytes({ metadataLength: integer(rng, 0, 1), dataLength: noise }).subarray(0, 12) }
  }
  if (kind === "declared-oversized-metadata") {
    return { kind, bytes: frameBytes({ metadataLength: MAXIMUM_METADATA + noise, dataLength: integer(rng, 0, 16) }).subarray(0, 12) }
  }
  return { kind, bytes: frameBytes({ metadataLength: integer(rng, 2, 32), dataLength: MAXIMUM_DATA + noise }).subarray(0, 12) }
}

function planValid(rng) {
  const { events, frames } = progressFrames(rng, integer(rng, 0, 3))
  const payload = bytes(rng, integer(rng, 0, 64))
  const stream = Buffer.concat([...frames, finalFrame(payload)])
  return { events, payload, stream, sizes: split(rng, stream.length) }
}

const UNSUPPORTED_REPLY = /Unsupported native response/

/* Predicates instead of engine messages: JSON syntax wording differs between Node versions. */
const MALFORMED_METADATA = [
  { name: "invalid-json", metadata: Buffer.from('{"version":1,'), check: (error) => error instanceof SyntaxError },
  { name: "invalid-utf8", metadata: Buffer.from([0xff, 0xfe, 0xfd]), check: (error) => error instanceof SyntaxError },
  { name: "json-array", metadata: Buffer.from("[]"), check: (error) => UNSUPPORTED_REPLY.test(error.message) },
  { name: "json-null", metadata: Buffer.from("null"), check: (error) => error instanceof TypeError },
  { name: "non-boolean-ok", metadata: Buffer.from('{"version":1,"ok":"yes"}'), check: (error) => UNSUPPORTED_REPLY.test(error.message) },
]

/* The transport double: bytes are written to an in-memory child and replies are fed
 * back through the production `read()` entry point, exactly as the stdout listener does. */

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

class FramingWorker extends NativeWorker {
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

/* Async driving helpers. The parser is synchronous per chunk, so a fixed number of
 * microtask turns is enough to observe a settlement without timers or sleeps. */

async function drain(turns = 8) {
  for (let index = 0; index < turns; index += 1) await null
}

/* Wait until the request under test has actually been written to the transport, so the
 * suite never depends on how many microtask turns the queue needs on a given runtime. */
async function sent(worker, turns = 64) {
  const target = (worker.child?.writes.length ?? 0) + 3
  for (let turn = 0; turn < turns; turn += 1) {
    if (worker.child && worker.child.writes.length >= target) return worker.child
    await null
  }
  return assert.fail("the request was never written to the transport")
}

function observe(worker, { operation = "capabilities", options = {}, data = new Uint8Array(0) } = {}) {
  const events = []
  const state = { settled: 0, value: undefined, error: undefined }
  const promise = worker.call(operation, options, data, (progress, stage) => events.push({ progress, stage }))
  promise.then(
    (value) => { state.settled += 1; state.value = value },
    (error) => { state.settled += 1; state.error = error },
  )
  return { events, state }
}

function feed(worker, stream, sizes) {
  let offset = 0
  for (const size of sizes) {
    if (!worker.requestInFlight) return
    const end = Math.min(stream.length, offset + size)
    worker.read(stream.subarray(offset, end))
    offset = end
  }
  if (offset < stream.length && worker.requestInFlight) worker.read(stream.subarray(offset))
}

function assertRequestFrame(writes) {
  assert.ok(writes.length >= 3, "a request is written as header, metadata and payload")
  const [header, metadata, payload] = writes.slice(-3)
  assert.equal(header.length, 12)
  assert.ok(header.subarray(0, 4).equals(MAGIC), "the request header carries the exact KTR1 magic")
  assert.equal(header.readUInt32LE(4), metadata.length)
  assert.equal(header.readUInt32LE(8), payload.length)
  const request = JSON.parse(metadata.toString("utf8"))
  assert.equal(request.version, 1)
  assert.equal(typeof request.operation, "string")
}

function assertNoOrphans(worker) {
  assert.equal(worker.child, null, "the transport must not stay attached")
  assert.ok(worker.started.length > 0, "the suite must have started a transport")
  for (const child of worker.started) assert.ok(child.killed > 0, `transport ${child.id} was left running`)
}

/* Case runner: every failure names the seed and the case that produced it. */

function withReproducer(error, block, index) {
  const detail = error instanceof Error ? error.message : String(error)
  const wrapped = new Error(`KTR1 framing seed=${SEED_LABEL} case=${block}#${index}\n  ${detail}\n  Reproduce: ${REPRODUCE}`)
  wrapped.cause = error
  return wrapped
}

async function runCases(block, count, body) {
  const rng = random(mix(SEED, block))
  for (let index = 0; index < count; index += 1) {
    stats.cases += 1
    try {
      await body(rng, index)
    } catch (error) {
      throw withReproducer(error, block, index)
    }
  }
  stats.blocks += 1
}

test(`KTR1 framing: ${CASE_BUDGET.valid} seeded replies settle once and keep payload bytes across chunk boundaries`, async (t) => {
  const worker = new FramingWorker()
  t.after(() => {
    worker.close()
    assertNoOrphans(worker)
  })
  await runCases("valid", CASE_BUDGET.valid, async (rng) => {
    const plan = planValid(rng)
    const observed = observe(worker)
    const child = await sent(worker)
    assertRequestFrame(child.writes)

    feed(worker, plan.stream, plan.sizes)
    await drain()

    assert.equal(observed.state.settled, 1, "a valid reply settles the request exactly once")
    assert.equal(observed.state.error, undefined, "a valid reply must not reject")
    assert.deepEqual(observed.events, plan.events, "progress events arrive in order and exactly once")
    assert.deepEqual([...observed.state.value.data], [...plan.payload], "payload bytes survive reassembly")
    assert.equal(worker.requestInFlight, null)
    assert.equal(worker.queued, 0)
    assert.equal(child.killed, 0, "a valid reply keeps the stream alive")
  })
  t.diagnostic(`seed=${SEED_LABEL} cases=${CASE_BUDGET.valid}`)
})

test(`KTR1 framing: ${CASE_BUDGET.headers} malformed headers reject before any body, terminate the transport and recover`, async (t) => {
  const worker = new FramingWorker()
  t.after(() => {
    worker.close()
    assertNoOrphans(worker)
  })
  await runCases("headers", CASE_BUDGET.headers, async (rng, index) => {
    const plan = planHeader(rng, index)
    const observed = observe(worker)
    const child = await sent(worker)
    const started = worker.started.length

    feed(worker, plan.bytes, split(rng, plan.bytes.length))
    await drain()

    assert.equal(observed.state.settled, 1, `${plan.kind} settles the request exactly once`)
    assert.match(observed.state.error.message, /Invalid native response frame/, `${plan.kind} rejects as a malformed frame`)
    assert.equal(worker.requestInFlight, null, `${plan.kind} must not stay in flight`)
    assert.equal(worker.queued, 0)
    assert.equal(worker.child, null, `${plan.kind} terminates the transport`)
    assert.equal(child.killed, 1, `${plan.kind} kills the child instead of leaking it`)
    assert.equal(worker.started.length, started, `${plan.kind} does not restart before the next request`)

    const recovery = observe(worker)
    await sent(worker)
    assert.equal(worker.started.length, started + 1, "the next request starts a fresh transport")
    const payload = bytes(rng, integer(rng, 0, 8))
    feed(worker, finalFrame(payload), split(rng, finalFrame(payload).length))
    await drain()
    assert.equal(recovery.state.settled, 1)
    assert.equal(recovery.state.error, undefined, "a fresh transport serves the next request")
    assert.deepEqual([...recovery.state.value.data], [...payload])
  })
  t.diagnostic(`seed=${SEED_LABEL} cases=${CASE_BUDGET.headers}`)
})

test(`KTR1 framing: ${CASE_BUDGET.truncated} truncated frames reject through teardown without leaking state`, async (t) => {
  const worker = new FramingWorker()
  t.after(() => {
    worker.close()
    assertNoOrphans(worker)
  })
  await runCases("truncated", CASE_BUDGET.truncated, async (rng, index) => {
    const kind = index % 2 ? "truncated-body" : "truncated-header"
    let stream
    if (kind === "truncated-header") {
      stream = finalFrame(bytes(rng, 4)).subarray(0, integer(rng, 0, 11))
    } else {
      const whole = finalFrame(bytes(rng, integer(rng, 0, 24)))
      stream = whole.subarray(0, integer(rng, 12, whole.length - 1))
    }
    const observed = observe(worker)
    const child = await sent(worker)
    const started = worker.started.length

    feed(worker, stream, split(rng, stream.length))
    await drain()
    assert.equal(observed.state.settled, 0, `${kind} stays pending until the stream ends`)

    worker.stop(new Error("Native worker exited."))
    await drain()

    assert.equal(observed.state.settled, 1, `${kind} settles exactly once on teardown`)
    assert.match(observed.state.error.message, /Native worker exited/)
    assert.equal(worker.requestInFlight, null)
    assert.equal(worker.queued, 0)
    assert.equal(worker.child, null)
    assert.equal(child.killed, 1, `${kind} must not leave an orphan transport`)
    assert.equal(worker.started.length, started, `${kind} teardown does not restart by itself`)

    const recovery = observe(worker)
    await sent(worker)
    assert.equal(worker.started.length, started + 1)
    feed(worker, finalFrame(), [12])
    await drain()
    assert.equal(recovery.state.settled, 1)
    assert.equal(recovery.state.error, undefined, "teardown leaves the worker restartable")
  })
  t.diagnostic(`seed=${SEED_LABEL} cases=${CASE_BUDGET.truncated}`)
})

test(`KTR1 framing: ${CASE_BUDGET.metadata} malformed or unsupported replies reject and terminate the transport`, async (t) => {
  const worker = new FramingWorker()
  t.after(() => {
    worker.close()
    assertNoOrphans(worker)
  })
  await runCases("metadata", CASE_BUDGET.metadata, async (rng, index) => {
    const variant = MALFORMED_METADATA[index % MALFORMED_METADATA.length]
    const payload = bytes(rng, integer(rng, 0, 8))
    const stream = frameBytes({ metadata: variant.metadata, payload })
    const observed = observe(worker)
    const child = await sent(worker)
    const started = worker.started.length

    feed(worker, stream, split(rng, stream.length))
    await drain()

    assert.equal(observed.state.settled, 1, `${variant.name} settles exactly once`)
    assert.ok(observed.state.error instanceof Error, `${variant.name} rejects with an Error`)
    assert.ok(variant.check(observed.state.error), `${variant.name} rejects with its documented error: ${observed.state.error.message}`)
    assert.equal(worker.requestInFlight, null)
    assert.equal(worker.queued, 0)
    assert.equal(worker.child, null, `${variant.name} terminates the transport`)
    assert.equal(child.killed, 1)
    assert.equal(worker.started.length, started)

    const recovery = observe(worker)
    await sent(worker)
    feed(worker, finalFrame(), split(rng, 12))
    await drain()
    assert.equal(recovery.state.settled, 1)
    assert.equal(recovery.state.error, undefined)
  })
  t.diagnostic(`seed=${SEED_LABEL} cases=${CASE_BUDGET.metadata}`)
})

test(`KTR1 framing: ${CASE_BUDGET.failures} ok:false replies reject and keep the same stream synchronized`, async (t) => {
  const worker = new FramingWorker()
  t.after(() => {
    worker.close()
    assertNoOrphans(worker)
  })
  await runCases("failures", CASE_BUDGET.failures, async (rng) => {
    const message = pick(rng, ["Unknown native operation.", "Invalid redraw region.", "Dữ liệu native không hợp lệ."])
    const stream = frameBytes({ metadata: json({ version: 1, ok: false, error: message }), payload: bytes(rng, integer(rng, 0, 16)) })
    const observed = observe(worker)
    const child = await sent(worker)
    const started = worker.started.length

    feed(worker, stream, split(rng, stream.length))
    await drain()

    assert.equal(observed.state.settled, 1, "an operation failure settles the request exactly once")
    assert.equal(observed.state.error.message, message, "the worker error text reaches the caller")
    assert.equal(worker.requestInFlight, null)
    assert.equal(worker.queued, 0)
    assert.equal(worker.child, child, "ok:false must not terminate the transport")
    assert.equal(child.killed, 0, "ok:false must not kill the child")
    assert.equal(worker.started.length, started, "ok:false must not restart the transport")

    const payload = bytes(rng, integer(rng, 0, 8))
    const next = observe(worker)
    await sent(worker)
    assert.equal(worker.child, child, "the next request reuses the synchronized stream")
    assert.equal(worker.started.length, started)
    feed(worker, finalFrame(payload), split(rng, finalFrame(payload).length))
    await drain()
    assert.equal(next.state.settled, 1)
    assert.equal(next.state.error, undefined, "the stream serves the request after ok:false")
    assert.deepEqual([...next.state.value.data], [...payload])
  })
  t.diagnostic(`seed=${SEED_LABEL} cases=${CASE_BUDGET.failures}`)
})

test(`KTR1 framing: ${CASE_BUDGET.trailing} replies followed by unattributable bytes settle once and terminate`, async (t) => {
  const worker = new FramingWorker()
  t.after(() => {
    worker.close()
    assertNoOrphans(worker)
  })
  await runCases("trailing", CASE_BUDGET.trailing, async (rng, index) => {
    const sameChunk = index % 2 === 0
    const payload = bytes(rng, integer(rng, 0, 16))
    const frame = finalFrame(payload)
    const extra = bytes(rng, integer(rng, 1, 16))
    const observed = observe(worker)
    const child = await sent(worker)
    const started = worker.started.length

    if (sameChunk) {
      worker.read(Buffer.concat([frame, extra]))
    } else {
      feed(worker, frame, [12, 1, 2, 4096])
      await drain()
      assert.equal(observed.state.settled, 1, "the final reply settles before trailing bytes arrive")
      worker.read(extra)
    }
    await drain()

    assert.equal(observed.state.settled, 1, "trailing bytes must not settle the request twice")
    assert.equal(observed.state.error, undefined, "the framed reply still resolves with its payload")
    assert.deepEqual([...observed.state.value.data], [...payload])
    assert.equal(worker.requestInFlight, null)
    assert.equal(worker.queued, 0)
    assert.equal(worker.child, null, "an unattributable stream is terminated")
    assert.equal(child.killed, 1)
    assert.equal(worker.started.length, started)

    const recovery = observe(worker)
    await sent(worker)
    assert.equal(worker.started.length, started + 1)
    feed(worker, finalFrame(), [12])
    await drain()
    assert.equal(recovery.state.settled, 1)
    assert.equal(recovery.state.error, undefined)
  })
  t.diagnostic(`seed=${SEED_LABEL} cases=${CASE_BUDGET.trailing}`)
})

test("KTR1 framing: the suite stays above 1000 cases, regenerates from its seed and names the seed in failures", (t) => {
  const budget = Object.values(CASE_BUDGET).reduce((total, count) => total + count, 0)
  assert.ok(budget >= 1000, `the suite must generate at least 1000 cases, found ${budget}`)

  const sample = (value) => {
    const valid = random(mix(value, "valid"))
    const headers = random(mix(value, "headers"))
    return Array.from({ length: 8 }, (unused, index) => ({ valid: planValid(valid), header: planHeader(headers, index) }))
  }
  assert.deepEqual(sample(SEED), sample(SEED), "the same seed regenerates the same cases")
  assert.notDeepEqual(sample((SEED + 1) >>> 0), sample(SEED), "a different seed generates different cases")

  const failure = (() => {
    try {
      throw withReproducer(new Error("conformance assertion failed"), "valid", 7)
    } catch (error) {
      return error
    }
  })()
  assert.match(failure.message, new RegExp(`seed=${SEED_LABEL}`))
  assert.match(failure.message, /case=valid#7/)
  assert.match(failure.message, /conformance assertion failed/)
  assert.ok(failure.message.includes(`Reproduce: ${REPRODUCE}`), "a failure carries the exact rerun command")
  assert.equal(failure.cause.message, "conformance assertion failed", "the original error is preserved as the cause")

  if (stats.blocks === Object.keys(CASE_BUDGET).length) {
    assert.ok(stats.cases >= 1000, `every block ran, so at least 1000 cases must have executed, found ${stats.cases}`)
  }
  t.diagnostic(`seed=${SEED_LABEL} cases=${stats.cases}/${budget} blocks=${stats.blocks}/${Object.keys(CASE_BUDGET).length}`)
})
