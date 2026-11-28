import assert from "node:assert/strict"
import test from "node:test"

import { createTranslator } from "../src/i18n.js"
import { readFile } from "node:fs/promises"
import { announce } from "../src/live-region.js"

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")

// src/main.js is a browser entry module, so its page rule is read out of the real source instead of
// being mirrored: the function under test is the one the app ships.
function mainFunction(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start > 0, `main.js must define ${name}`)
  const end = main.indexOf("\n}\n", start)
  assert.ok(end > start, `${name} must be a top-level function`)
  return main.slice(start, end + 3)
}

function markupTag(id) {
  const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`).exec(markup)?.[0]
  assert.ok(tag, `${id} must exist in index.html`)
  return tag
}

function installRegionDocument() {
  const nodes = new Map()
  globalThis.document = { getElementById: (id) => nodes.get(id) ?? null }
  return (id) => {
    const node = { id, textContent: "" }
    nodes.set(id, node)
    return node
  }
}

test("announce fills the shipped regions, trims its text and skips a repeated sentence", () => {
  const add = installRegionDocument()
  const polite = add("live-region")
  let text = ""
  let writes = 0
  Object.defineProperty(polite, "textContent", {
    get: () => text,
    set: (value) => { writes += 1; text = value },
  })

  announce("  Trang 2 / 5: 2.png  ")
  assert.equal(polite.textContent, "Trang 2 / 5: 2.png")
  announce("Trang 2 / 5: 2.png")
  assert.equal(writes, 1, "the same sentence is not written twice")
  announce("Trang 1 / 5: 1.png")
  assert.equal(writes, 2)

  announce("   ")
  assert.equal(polite.textContent, "Trang 1 / 5: 1.png", "an empty message announces nothing")
})

test("announce sends an assertive message to the alert region and never throws without regions", () => {
  const add = installRegionDocument()
  const alert = add("live-region-alert")
  announce("Không tải được Tesseract.", { assertive: true })
  assert.equal(alert.textContent, "Không tải được Tesseract.")

  globalThis.document = { getElementById: () => null }
  assert.doesNotThrow(() => announce("Không có vùng thông báo."))
})

test("the shipped markup ships one polite and one assertive live region", () => {
  const polite = markupTag("live-region")
  assert.match(polite, /role="status"/)
  assert.match(polite, /aria-live="polite"/)
  assert.match(polite, /aria-atomic="true"/)
  const alert = markupTag("live-region-alert")
  assert.match(alert, /role="alert"/)
  assert.match(alert, /class="sr-only"/)
})

test("the chat composer has a name instead of only a placeholder", () => {
  const label = /<label class="sr-only" for="chat-input">([^<]+)<\/label>/.exec(markup)
  assert.ok(label, "the composer textarea needs a label element")
  assert.match(label[1].trim(), /Tin nhắn/)
  assert.match(markupTag("chat-input"), /placeholder=/, "the placeholder stays a hint, not the name")
})

test("every tool-rail button carries the accessible name its tooltip shows", () => {
  const buttons = markup.match(/<button type="button" class="rail-btn"[^>]*>/g) ?? []
  assert.ok(buttons.length >= 10, "the rail keeps its ten tools")
  for (const tag of buttons) {
    const label = /aria-label="([^"]*)"/.exec(tag)?.[1]
    const title = /title="([^"]*)"/.exec(tag)?.[1]
    assert.ok(label, `a rail button has no accessible name: ${tag}`)
    assert.equal(label, title, "the accessible name repeats the tooltip text")
  }
})

test("the native status line is a polite live region in the markup", () => {
  const status = markupTag("native-status")
  assert.match(status, /role="status"/)
  assert.match(status, /aria-live="polite"/)
})

test("a page change announces the name of the page, not only its index", () => {
  const pages = [{ id: "p1", name: "1.png" }, { id: "p2", name: "2.png" }]
  const announcementFor = (index) => new Function(
    "selectedIndex",
    "state",
    "t",
    `${mainFunction("pageAnnouncement")}\nreturn pageAnnouncement`,
  )(() => index, { pages }, createTranslator("vi").t)

  assert.equal(announcementFor(1)(), "Trang 2 / 2: 2.png")
  assert.equal(announcementFor(-1)(), "Chưa có trang")
  assert.match(mainFunction("selectPage"), /announce\(pageAnnouncement\(\)\)/)
})

test("the native status line turns into an alert when the worker reports an OCR error", async () => {
  const nodes = new Map()
  const element = (id) => {
    const node = {
      id,
      children: [],
      dataset: {},
      hidden: false,
      disabled: false,
      value: "",
      textContent: "",
      append(...items) { node.children.push(...items) },
      replaceChildren(...items) { node.children = items },
      setAttribute(name, value) { node[name] = String(value) },
      getAttribute(name) { return node[name] },
      removeAttribute(name) { delete node[name] },
      addEventListener() {},
      querySelectorAll() { return [] },
      focus() {},
    }
    return node
  }
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id))
    return nodes.get(id)
  }
  globalThis.document = {
    createElement: (tag) => element(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    visibilityState: "visible",
  }
  globalThis.window = {
    addEventListener() {},
    confirm: () => true,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.Option = class {
    constructor(text, value) { this.text = text; this.value = value }
  }
  globalThis.khungThoaiDesktop = {
    native: async () => ({ result: { ocrError: "Không tải được Tesseract.", languages: [] } }),
    projectActivate: async () => ({}),
    projectStatus: async () => ({}),
  }

  const { setupProjects } = await import("../src/controllers/project.js")
  setupProjects({
    state: { pages: [], projectId: undefined },
    byId,
    status() {},
    checkpoint() {},
    render() {},
    renderPages() {},
    renderInspector() {},
    renderCanvas() {},
    selectedPage: () => null,
    selectedBox: () => null,
    projectBusy: () => false,
    commitLiveForm() {},
    notify() {},
    notifyOverflowIfAny() {},
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
    registerFontName() {},
    renderFontOptions() {},
  })

  const statusLine = byId("native-status")
  assert.equal(statusLine.getAttribute("role"), "status", "the checking state is a polite status")
  assert.equal(statusLine.getAttribute("aria-live"), "polite")
  assert.match(statusLine.textContent, /worker C#/)

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(statusLine.getAttribute("role"), "alert", "an OCR error is announced assertively")
  assert.equal(statusLine.getAttribute("aria-live"), "assertive")
  assert.equal(statusLine.textContent, "Không tải được Tesseract.")
})
