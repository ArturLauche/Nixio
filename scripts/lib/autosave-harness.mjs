// Harness for src/controllers/project.js: fake DOM, a controllable desktop
// bridge and an IndexedDB fake whose callbacks the test drives by hand, so
// close/autosave races are deterministic instead of timing dependent.

import { createFakeIndexedDB } from "./fake-indexeddb.mjs"

export const settingIds = [
  "script-text",
  "direction",
  "gemini-model",
  "source-language",
  "target-language",
  "translation-notes",
  "translation-glossary",
]

function fakeElement(id = "") {
  const listeners = new Map()
  const element = {
    id,
    tagName: "DIV",
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    children: [],
    style: {},
    dataset: {},
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...nodes) {
      element.children.push(...nodes)
    },
    replaceChildren(...nodes) {
      element.children = nodes
    },
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener() {},
    setAttribute(name, value) {
      element[name] = value
    },
    getAttribute(name) {
      return element[name]
    },
    removeAttribute() {},
    showModal() {},
    close() {},
    remove() {},
    focus() {},
    select() {},
    click() {
      return element.onclick?.()
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 }
    },
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
    },
    insertBefore() {},
  }
  return element
}

export function createHarness({ capabilities = null, native = true } = {}) {
  const scheduleQueue = []
  const schedule = (run) => scheduleQueue.push(run)
  const fake = createFakeIndexedDB({ schedule })

  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const documentListeners = new Map()
  const windowListeners = new Map()
  const intervals = []

  globalThis.document = {
    body: fakeElement("body"),
    getElementById: byId,
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener(type, handler) {
      documentListeners.set(type, handler)
    },
    visibilityState: "visible",
  }
  globalThis.window = {
    confirm: (...args) => {
      confirm.calls.push(args)
      return confirm.value
    },
    addEventListener(type, handler) {
      windowListeners.set(type, handler)
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    open: () => null,
  }
  globalThis.Option = class {
    constructor(text, value) {
      this.text = text
      this.value = value
    }
  }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.URL.createObjectURL = () => "blob:harness"
  globalThis.URL.revokeObjectURL = () => {}
  globalThis.indexedDB = fake.indexedDB
  globalThis.IDBKeyRange = fake.IDBKeyRange
  globalThis.setInterval = (handler) => {
    intervals.push(handler)
    return intervals.length
  }
  globalThis.clearInterval = () => {}
  // src/io.js revokes download URLs after 30 s; a host timer that long must not
  // keep the test process alive after the suite finishes.
  const hostSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (handler, delay, ...args) => {
    const timer = hostSetTimeout(handler, delay, ...args)
    if (delay >= 1000) timer?.unref?.()
    return timer
  }

  const confirm = { value: true, calls: [] }
  const calls = {
    closeWindow: 0,
    activate: [],
    begin: [],
    commits: [],
    cancels: [],
    written: [],
  }
  const statuses = []
  const notifications = []
  const transfers = new Map()
  const flags = { busy: false, gesture: false, holdWrites: false }
  const writeWaiters = []

  const desktop = {
    native: async (operation) => {
      if (operation !== "capabilities") throw new Error("unexpected native operation " + operation)
      if (capabilities === undefined) throw new Error("worker missing")
      return { result: capabilities }
    },
    onClose(handler) {
      desktop.closeHandler = handler
    },
    closeWindow: async () => {
      calls.closeWindow += 1
    },
    projectActivate: async (id) => {
      calls.activate.push(id)
    },
    projectStatus: async () => ({ recovery: false, backup: false, projects: 0 }),
    projectList: async () => [],
    projectBegin: async (mode, name, projectId) => {
      calls.begin.push({ mode, name, projectId })
      if (flags.nativeFails) return null
      const id = `transfer-${calls.begin.length}`
      transfers.set(id, mode)
      return { id }
    },
    projectWrite: async (id, operation) => {
      calls.written.push({ id, operation })
      if (flags.holdWrites)
        await new Promise((resolve) => {
          writeWaiters.push(resolve)
        })
      if (operation === "fileCommit") calls.commits.push(transfers.get(id))
      if (operation === "fileCancel") calls.cancels.push(transfers.get(id))
      if (flags.nativeWriteFails) throw new Error("worker crashed")
      return {}
    },
    projectDiscardOpen: async () => {},
    projectCancelRead: async () => {},
    projectOpen: async () => null,
    projectRead: async () => new Uint8Array(),
  }
  globalThis.khungThoaiDesktop = native ? desktop : undefined

  const state = {
    pages: [],
    presets: [],
    queue: [],
    fit: true,
    selectedBoxIds: new Set(),
    projectId: undefined,
    savingProject: false,
    openingProject: false,
  }

  function pages(count = 1) {
    return Array.from({ length: count }, (_, index) => ({
      file: new File([Uint8Array.of(index + 1, 2, 3)], `trang-${index + 1}.png`, { type: "image/png" }),
      name: `trang-${index + 1}.png`,
      boxes: [],
      unplaced: [],
    }))
  }

  function reset() {
    fake.reset()
    state.pages = []
    state.presets = []
    state.queue = []
    state.fit = true
    state.projectId = undefined
    statuses.length = 0
    notifications.length = 0
    confirm.value = true
    confirm.calls.length = 0
    flags.busy = false
    flags.gesture = false
    flags.nativeFails = false
    flags.nativeWriteFails = false
    flags.holdWrites = false
    writeWaiters.length = 0
    calls.closeWindow = 0
    calls.activate.length = 0
    calls.begin.length = 0
    calls.commits.length = 0
    calls.cancels.length = 0
    calls.written.length = 0
    transfers.clear()
    desktop.closeHandler = null
  }

  function start(setupProjects, overrides = {}) {
    const projectSettings = settingIds.map((id) => ({ id, value: "" }))
    projectSettings.find((field) => field.id === "direction").value = "ltr"
    projectSettings.find((field) => field.id === "gemini-model").value = "auto"
    projectSettings.find((field) => field.id === "source-language").value = "Japanese"
    projectSettings.find((field) => field.id === "target-language").value = "Vietnamese"
    const defaults = projectSettings.map(({ value }) => value)
    const api = setupProjects({
      state,
      byId,
      projectSettings,
      defaultProjectSettings: defaults,
      history: { clear() {} },
      openImage: async (file) => ({
        file,
        name: file.name,
        boxes: [],
        unplaced: [],
      }),
      selectPage() {},
      selectedIndex: () => (state.pages.length ? 0 : -1),
      updateFitLabel() {},
      releaseUnusedImages() {},
      renderPages() {},
      status(text, isError) {
        statuses.push({ text, isError: Boolean(isError) })
      },
      projectBusy: () => flags.busy,
      hasGesture: () => flags.gesture,
      onCapabilities() {},
      commitLiveForm() {},
      registerFontName() {},
      renderFontOptions() {},
      notify: (notification) => notifications.push(notification),
      onProjectSwitch() {},
      ...overrides,
    })
    api.projectSettings = projectSettings
    return api
  }

  const timers = () => new Promise((resolve) => setTimeout(resolve, 0))

  async function tick(limit = 2000) {
    let progressed = 0
    while (scheduleQueue.length && progressed++ < limit) {
      const run = scheduleQueue.shift()
      run()
      await Promise.resolve()
    }
    await timers()
  }

  async function drive(predicate, timeout = 3000) {
    const deadline = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("drive timed out")
      await tick()
    }
    await tick()
  }

  function lastStatus() {
    return statuses.at(-1)
  }

  function releaseWrites() {
    for (const resolve of writeWaiters.splice(0)) resolve()
  }

  // Storage calls are suspended on the manual scheduler, so a test has to pump
  // the fake while the promise settles.
  async function resolve(promise) {
    const outcome = { done: false }
    promise.then(
      (value) => {
        outcome.value = value
        outcome.done = true
      },
      (error) => {
        outcome.error = error
        outcome.done = true
      },
    )
    await drive(() => outcome.done)
    if (outcome.error) throw outcome.error
    return outcome.value
  }

  return {
    fake,
    byId,
    elements,
    documentListeners,
    windowListeners,
    intervals,
    desktop,
    state,
    calls,
    statuses,
    notifications,
    confirm,
    flags,
    pages,
    reset,
    start,
    tick,
    drive,
    lastStatus,
    releaseWrites,
    resolve,
    pending: () => scheduleQueue.length,
    schedule,
  }
}
