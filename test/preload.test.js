import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import { PROVIDER_CHANNELS } from "../desktop/provider-transport.cjs"

const source = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8")

// Loads the real preload source against a synthetic ipcRenderer. `on` deliberately returns the emitter,
// the way Electron does, so a preload that passed the return value across the bridge would hand the
// renderer the whole IPC surface instead of an unsubscribe function.
function loadPreload() {
  const listeners = new Map()
  const invokes = []
  const exposed = []
  const ipcRenderer = {
    async invoke(channel, ...args) {
      invokes.push({ channel, args })
      return args[0] === "bad" ? { error: "Untrusted desktop frame." } : { value: { ok: true, args } }
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel).add(listener)
      return ipcRenderer
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener)
      return ipcRenderer
    },
  }
  const contextBridge = {
    exposeInMainWorld(name, api) { exposed.push({ name, api }) },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    require: (id) => {
      if (id === "electron") return { contextBridge, ipcRenderer }
      throw new Error("unexpected require: " + id)
    },
    module,
    exports: module.exports,
    console,
  }, { filename: "desktop/preload.cjs" })
  assert.equal(exposed.length, 1, "the preload did not expose exactly one bridge object")
  return { api: exposed[0].api, name: exposed[0].name, invokes, listeners, ipcRenderer }
}

test("the preload exposes the provider lifecycle channels under the app bridge", async () => {
  const { api, name, invokes } = loadPreload()
  assert.equal(name, "khungThoaiDesktop")
  for (const method of ["providerRequest", "providerStream", "providerActivate", "providerCancel", "onProviderEvent"]) {
    assert.equal(typeof api[method], "function", method + " is missing from the bridge")
  }
  await api.providerStream({ provider: "gemini" })
  await api.providerActivate("s-1")
  await api.providerCancel({ requestId: "q-1" })
  assert.deepEqual(invokes.map((entry) => entry.channel), [
    PROVIDER_CHANNELS.stream,
    PROVIDER_CHANNELS.activate,
    PROVIDER_CHANNELS.cancel,
  ])
})

test("onProviderEvent returns a detached unsubscribe and never the ipcRenderer object", () => {
  const { api, listeners, ipcRenderer } = loadPreload()
  const seen = []
  const unsubscribe = api.onProviderEvent((payload) => seen.push(payload))
  assert.equal(typeof unsubscribe, "function", "the bridge returned something other than an unsubscribe")
  assert.notEqual(unsubscribe, ipcRenderer)
  assert.equal(listeners.get(PROVIDER_CHANNELS.event).size, 1)

  const [listener] = [...listeners.get(PROVIDER_CHANNELS.event)]
  // The callback receives the payload only, never the Electron event object.
  listener({ sender: { id: 7 } }, { ticket: "s-1", type: "chunk", text: "data: a\n\n" })
  assert.deepEqual(seen, [{ ticket: "s-1", type: "chunk", text: "data: a\n\n" }])

  assert.equal(unsubscribe(), undefined)
  assert.equal(listeners.get(PROVIDER_CHANNELS.event).size, 0, "the listener stayed subscribed")
  // A second call is harmless and removes nothing else.
  assert.equal(unsubscribe(), undefined)
  assert.equal(listeners.get(PROVIDER_CHANNELS.event).size, 0)
})

test("two listeners are independent, so one stream's teardown cannot detach another", () => {
  const { api, listeners } = loadPreload()
  const first = []
  const second = []
  const stopFirst = api.onProviderEvent((payload) => first.push(payload))
  const stopSecond = api.onProviderEvent((payload) => second.push(payload))
  assert.equal(listeners.get(PROVIDER_CHANNELS.event).size, 2)
  stopFirst()
  assert.equal(listeners.get(PROVIDER_CHANNELS.event).size, 1)
  const [listener] = [...listeners.get(PROVIDER_CHANNELS.event)]
  listener({}, { ticket: "s-2", type: "end" })
  assert.deepEqual(first, [])
  assert.deepEqual(second, [{ ticket: "s-2", type: "end" }])
  stopSecond()
  assert.equal(listeners.get(PROVIDER_CHANNELS.event).size, 0)
})

test("a non-function callback registers nothing and still returns a callable teardown", () => {
  const { api, listeners } = loadPreload()
  for (const value of [undefined, null, "callback", 42]) {
    const unsubscribe = api.onProviderEvent(value)
    assert.equal(typeof unsubscribe, "function")
    assert.equal(unsubscribe(), undefined)
  }
  assert.equal(listeners.get(PROVIDER_CHANNELS.event), undefined)
})

test("invoke unwraps values and turns a main-process refusal into a rejection", async () => {
  const { api, invokes } = loadPreload()
  assert.deepEqual(await api.providerActivate("s-3"), { ok: true, args: ["s-3"] })
  await assert.rejects(api.providerRequest("bad"), /Untrusted desktop frame/)
  assert.equal(invokes[0].channel, PROVIDER_CHANNELS.activate)
})
