import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const desktopCalls = { tasks: [], cancelled: [] }

function fakeElement(tag = "div") {
  const listeners = new Map()
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    value: "",
    checked: false,
    open: false,
    hidden: false,
    textContent: "",
    href: "",
    target: "",
    rel: "",
    focused: false,
    selected: false,
    scrolled: false,
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    addEventListener(type, handler) { listeners.set(type, handler) },
    dispatch(type, event) { return listeners.get(type)?.(event) },
    removeEventListener() {},
    setAttribute(name, value) { element[name] = value },
    getAttribute(name) { return element[name] },
    removeAttribute() {},
    querySelectorAll() { return [] },
    querySelector() { return null },
    focus() { element.focused = true },
    select() { element.selected = true },
    showModal() { element.open = true },
    close() { element.open = false },
    scrollIntoView() { element.scrolled = true },
    remove() {},
    click() { element.onclick?.() },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 } },
    closest() { return null },
    contains() { return false },
    insertBefore() {},
    cloneNode() { return fakeElement(tag) },
    requestSubmit() { element.submitted = true },
    getContext() { return { putImageData() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) } },
  }
  return element
}

function createById() {
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  return { byId, elements }
}

function installBrowserGlobals() {
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    querySelectorAll: () => [],
    querySelector: () => fakeElement(),
    addEventListener() {},
    visibilityState: "visible",
  }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.window = {
    addEventListener() {},
    confirm: () => true,
    open: () => null,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  }
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value } }
  globalThis.ImageData = class {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height }
  }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  globalThis.khungThoaiDesktop = {
    native: async () => ({ result: {} }),
    onTask(handler) { desktopCalls.tasks.push(handler) },
    cancelTask(id) { desktopCalls.cancelled.push(id) },
    projectBegin: async () => null,
  }
}

installBrowserGlobals()
const controllers = (name) => import(`../src/controllers/${name}.js`)

const baseArguments = (byId, state) => ({
  state,
  byId,
  status() {},
  checkpoint() {},
  render() {},
  renderPages() {},
  selectedPage: () => null,
  selectedBox: () => null,
  projectBusy: () => false,
  commitLiveForm() {},
  notify() {},
  listButton(label, onClick) {
    const button = fakeElement("button")
    button.textContent = label
    button.onclick = onClick
    return button
  },
  selectPage() {},
  selectBox() {},
  readTranslationSettings: () => ({}),
  isNativeReady: () => false,
})

test("task panel renders native progress, hides cancel for finished work, and keeps ten rows", async () => {
  const { byId } = createById()
  const { setupTasks } = await controllers("tasks")
  setupTasks(byId)
  assert.equal(desktopCalls.tasks.length, 1)
  const emit = desktopCalls.tasks[0]
  const panel = byId("task-panel")
  const list = byId("task-list")

  emit({ id: "a", operation: "ocr", stage: "đọc chữ", progress: 40, state: "running" })
  assert.equal(panel.hidden, false)
  assert.equal(list.children.length, 1)
  const row = list.children[0]
  assert.equal(row.children[0].textContent, "ocr · đọc chữ")
  assert.equal(row.children[1].value, 40)
  assert.equal(row.children[1].getAttribute("aria-label"), "ocr · đọc chữ")
  const cancel = row.children.find((child) => child.tagName === "BUTTON")
  assert.ok(cancel, "running tasks expose a cancel button")
  cancel.click()
  assert.deepEqual(desktopCalls.cancelled, ["a"])

  emit({ id: "a", operation: "ocr", stage: "xong", progress: 100, state: "done" })
  assert.equal(list.children[0].children.length, 2, "finished tasks drop the cancel button")

  for (let index = 0; index < 11; index++) {
    emit({ id: `job-${index}`, operation: "redraw", stage: "chạy", progress: index, state: "running" })
  }
  assert.equal(list.children.length, 10, "the panel keeps only the ten most recent tasks")
})

test("find and replace renders matches, jumps to boxes, and reports replacements", async () => {
  const { byId } = createById()
  const { setupDialogs } = await controllers("dialogs")
  const state = {
    pages: [{
      id: "p1",
      name: "page-1",
      boxes: [{ id: "b1", text: "Anh trai" }],
      unplaced: [{ text: "anh" }],
    }],
  }
  const events = []
  let busy = false
  const api = setupDialogs({
    ...baseArguments(byId, state),
    status: (message, error) => events.push(["status", message, error]),
    checkpoint: () => events.push(["checkpoint"]),
    render: () => events.push(["render"]),
    selectPage: (page) => events.push(["page", page.id]),
    selectBox: (box) => events.push(["box", box.id]),
    projectBusy: () => busy,
    commitLiveForm: () => events.push(["commit"]),
  })
  const dialog = byId("find-replace-dialog")
  const query = byId("find-query")
  const results = byId("find-results")

  api.openFind()
  assert.equal(dialog.open, true)
  assert.equal(query.focused, true)
  assert.equal(query.selected, true)
  assert.equal(byId("find-summary").textContent, "Nhập từ khóa để tìm trong toàn bộ chương.")
  assert.equal(results.children.length, 0)
  assert.deepEqual(events, [["commit"]])

  query.value = "anh"
  api.renderFindResults()
  assert.equal(byId("find-summary").textContent, "Tìm thấy 1 kết quả trong 1 mục.")
  assert.equal(results.children.length, 1)
  const matchButton = results.children[0].children[0]
  assert.match(matchButton.textContent, /^Trang 1 · Anh trai/)
  matchButton.click()
  assert.equal(dialog.open, false)
  assert.deepEqual(events.slice(-2), [["page", "p1"], ["box", "b1"]])

  byId("find-unplaced").checked = true
  api.renderFindResults()
  assert.equal(byId("find-summary").textContent, "Tìm thấy 2 kết quả trong 2 mục.")
  results.children[1].children[0].click()
  assert.equal(byId("queue-section").scrolled, true, "unplaced matches scroll the queue into view")

  byId("replace-text").value = "Em"
  query.value = "Anh"
  events.length = 0
  byId("replace-all-btn").onclick()
  assert.deepEqual(events.slice(0, 3), [["commit"], ["checkpoint"], ["render"]])
  assert.equal(state.pages[0].boxes[0].text, "Em trai")
  assert.equal(state.pages[0].unplaced[0].text, "Em")
  assert.deepEqual(events.at(-1), ["status", "Đã thay 2 vị trí trong 2 mục.", undefined])

  events.length = 0
  query.value = ""
  query.focused = false
  byId("replace-all-btn").onclick()
  assert.deepEqual(events, [], "validation errors render inside the dialog, not the status bar")
  assert.equal(byId("find-error").textContent, "Hãy nhập nội dung cần tìm.")
  assert.equal(query.getAttribute("aria-invalid"), "true")
  assert.equal(query.focused, true)

  query.value = "anh"
  query.oninput()
  assert.equal(byId("find-error").textContent, "")

  busy = true
  events.length = 0
  api.openFind()
  byId("replace-all-btn").onclick()
  assert.deepEqual(events, [
    ["status", "Hãy chờ tác vụ hiện tại hoàn tất.", true],
    ["status", "Hãy chờ tác vụ hiện tại hoàn tất.", true],
  ], "busy projects explain why find and replace did nothing")
  assert.equal(byId("open-shortcuts").onclick, api.openShortcuts)
})

test("the find dialog ships an in-dialog alert region for validation errors", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
  const dialog = html.slice(
    html.indexOf('id="find-replace-dialog"'),
    html.indexOf('id="shortcuts-dialog"'),
  )
  assert.match(dialog, /<p id="find-error"[^>]*role="alert"/)
  assert.match(html, /id="open-find"[^>]*Ctrl\+H \/ Ctrl\+F/)
})

test("chat setup exposes its panel controls and resolves the active skill", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  const { setupChat } = await controllers("chat")
  const api = setupChat({
    ...baseArguments(byId, state),
    editorSnapshot: () => ({}),
    selectedIndex: () => 0,
    onSkillChange() {},
    registerFontName() {},
    renderFontOptions() {},
    restoreHistory() {},
  })
  assert.deepEqual(Object.keys(api).sort(), ["close", "getActiveSkill", "open", "refreshModelBadge", "syncProjectSession"])
  assert.equal(typeof api.getActiveSkill().id, "string")
  api.open()
  api.close()
})

test("export setup binds the script exporter and ignores exports without pages", async () => {
  const { byId } = createById()
  const state = { pages: [], exporting: false, openingProject: false }
  const statuses = []
  const { setupExports } = await controllers("export")
  setupExports({ ...baseArguments(byId, state), status: (message, error) => statuses.push([message, error]) })
  const scriptButton = byId("export-script")
  assert.equal(typeof scriptButton.onclick, "function")
  scriptButton.onclick()
  assert.deepEqual(statuses, [])
})

test("gesture setup tracks pressed space and updates the zoom label", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  const { setupGestures } = await controllers("gestures")
  const api = setupGestures({
    ...baseArguments(byId, state),
    stage: fakeElement(),
    overlays: fakeElement(),
    pageCanvas: fakeElement(),
    viewport: fakeElement(),
    editorSnapshot: () => ({}),
    toggleSelectBox() {},
    addBox() {},
    freezeCleanup() {},
    rectStyle: () => ({}),
    paintPreview() {},
    renderCleanupOverlay() {},
    renderCanvas() {},
    renderInspector() {},
    changePage() {},
  })
  assert.equal(api.getSpaceHeld(), false)
  api.setSpaceHeld(true)
  assert.equal(api.getSpaceHeld(), true)
  api.updateZoomDisplay()
  assert.equal(byId("zoom-level").textContent, "100%")
  state.zoom = 1.5
  api.updateZoomDisplay()
  assert.equal(byId("zoom-level").textContent, "150%")
  assert.equal(api.abortGesture(), null)
  api.cancelPendingPaint()
})

test("split compare handle takes focus on drag and adjusts the curtain from keys", async () => {
  const { byId } = createById()
  const state = { pages: [], splitPos: 50 }
  const { setupGestures } = await controllers("gestures")
  setupGestures({
    ...baseArguments(byId, state),
    stage: fakeElement(),
    overlays: fakeElement(),
    pageCanvas: fakeElement(),
    viewport: fakeElement(),
    editorSnapshot: () => ({}),
    toggleSelectBox() {},
    addBox() {},
    freezeCleanup() {},
    rectStyle: () => ({}),
    paintPreview() {},
    renderCleanupOverlay() {},
    renderCanvas() {},
    renderInspector() {},
    changePage() {},
  })
  const handle = byId("split-handle")

  const pointerEvent = {
    pointerId: 1, clientX: 62,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }
  handle.dispatch("pointerdown", pointerEvent)
  assert.equal(handle.focused, true, "dragging the curtain moves focus to the handle")
  assert.equal(state.splitPos, 62, "pointer position maps to curtain percent")
  assert.equal(handle.getAttribute("aria-valuenow"), "62")
  assert.equal(handle.getAttribute("aria-valuetext"), "Rèm ở 62%")

  const keyEvent = (key, shiftKey = false) => ({
    key, shiftKey,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  })
  const right = keyEvent("ArrowRight")
  handle.dispatch("keydown", right)
  assert.equal(state.splitPos, 64)
  assert.equal(right.stopped, true, "handle keys must not bubble to page/document handlers")
  const up = keyEvent("ArrowUp", true)
  handle.dispatch("keydown", up)
  assert.equal(state.splitPos, 54, "Shift+Arrow jumps 10%")
  handle.dispatch("keydown", keyEvent("End"))
  assert.equal(state.splitPos, 100)
  handle.dispatch("keydown", keyEvent("Home"))
  assert.equal(state.splitPos, 0)
})

test("OCR setup wires its dialog controls and stops without a selected page", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  const { setupOcr } = await controllers("ocr")
  setupOcr({ ...baseArguments(byId, state), notifyOverflowIfAny() {} })
  assert.equal(typeof byId("preview-ocr").onclick, "function")
  assert.equal(typeof byId("run-local-ocr").onclick, "function")
  assert.equal(typeof byId("cancel-ocr").onclick, "function")
  await byId("run-local-ocr").onclick()
  assert.equal(state.processingNative, undefined)
  byId("cancel-ocr").onclick()
  assert.equal(byId("ocr-review").open, false)
})

test("project setup assigns a project id and exposes dirty state helpers", async () => {
  const { byId } = createById()
  const state = { pages: [], projectId: undefined }
  const { setupProjects } = await controllers("project")
  const api = setupProjects({
    ...baseArguments(byId, state),
    projectSettings: [],
    defaultProjectSettings: {},
    history: { clear() {}, push() {} },
    openImage() {},
    selectedIndex: () => 0,
    updateFitLabel() {},
    releaseUnusedImages() {},
    hasGesture: () => false,
    onCapabilities() {},
    onProjectSwitch() {},
  })
  assert.match(state.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(api.ready, false)
  assert.equal(typeof api.changed, "function")
  assert.equal(typeof api.refreshDirty, "function")
  assert.equal(typeof byId("new-project").onclick, "function")
})

test("translation setup reads provider, endpoint, and target settings from the form", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  byId("translation-provider").value = "openai"
  byId("llm-base-url").value = " http://localhost:11434/v1 "
  byId("llm-model").value = "llama"
  byId("source-language").value = "ja"
  byId("target-language").value = "vi"
  byId("translation-notes").value = " ghi chú "
  const { setupTranslation } = await controllers("translation")
  const api = setupTranslation({
    ...baseArguments(byId, state),
    renderInspector() {},
    renderCanvas() {},
    pageForScript: () => null,
    applyTranslation() {},
    onSettingsChange() {},
    notifyOverflowIfAny() {},
  })
  const settings = api.settings()
  assert.equal(settings.provider, "openai")
  assert.equal(settings.baseUrl, "http://localhost:11434/v1")
  assert.equal(settings.llmModel, "llama")
  assert.equal(settings.source, "ja")
  assert.equal(settings.target, "vi")
  assert.equal(settings.notes, "ghi chú")
  assert.equal(typeof settings.skillPrompt, "string")
})
