import assert from "node:assert/strict"
import test from "node:test"
import { addStroke, defaultLayers, pageLayers } from "../src/layers.js"
import { setupLayers } from "../src/controllers/layers.js"

globalThis.document = { createElement: (tag) => fakeElement(tag) }

function fakeElement(tag = "div") {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    disabled: false,
    type: "",
    value: "",
    checked: false,
    maxLength: 0,
    title: "",
    textContent: "",
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    setAttribute(name, value) { element[name] = value },
    getAttribute(name) { return element[name] },
    removeAttribute(name) { delete element[name] },
    closest() { return null },
    click() { element.onclick?.() },
  }
  return element
}

function createHarness({ busy = false } = {}) {
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const recorded = []
  const messages = []
  const state = { layerId: null, stroke: null }
  const page = {
    id: "page-1",
    name: "trang-1.png",
    image: { naturalWidth: 200, naturalHeight: 100 },
    boxes: [],
    retouchStrokes: [],
    layers: defaultLayers(),
  }
  const harness = { page, state, byId, recorded, messages, busy }
  let layers
  const controller = setupLayers({
    state,
    byId,
    status: (message, bad) => messages.push([message, Boolean(bad)]),
    checkpoint: (_snapshot, meta) => recorded.push(meta),
    editorSnapshot: () => ({ pages: [structuredClone(page)] }),
    render: () => layers.sync(),
    selectedPage: () => page,
    projectBusy: () => harness.busy,
    commitLiveForm: () => {},
    restoreOriginal: () => messages.push(["restored", false]),
  })
  layers = controller
  harness.layers = layers
  return harness
}

const rows = (harness, id) => harness.byId(id).children
const layerRows = (harness) => rows(harness, "layer-list")

function lastLabel(harness) {
  return harness.recorded.at(-1)?.label ?? ""
}

test("the panel lists the stack bottom to top and hides itself without a page", () => {
  const harness = createHarness()
  harness.layers.sync()
  assert.deepEqual(layerRows(harness).map((row) => row.dataset.kind), ["cleanup", "retouch", "text"])
  assert.deepEqual(layerRows(harness).map((row) => row.children[1].value), ["Nền đã xoá chữ", "Cọ vẽ tay", "Lớp chữ"])
  assert.deepEqual(rows(harness, "stroke-list").map((row) => row.textContent), ["Chưa có nét cọ nào trên trang."])
  assert.equal(harness.byId("layers-panel").hidden, false)
  assert.equal(harness.byId("add-layer").disabled, false)
  assert.equal(harness.byId("restore-original").hidden, true)
  assert.deepEqual(harness.recorded, [], "listing the stack records nothing")
})

test("visibility, rename and opacity are one named action each", () => {
  const harness = createHarness()
  harness.layers.sync()

  const eye = layerRows(harness)[0].children[0]
  eye.checked = false
  eye.onchange()
  assert.equal(harness.page.layers[0].visible, false)
  assert.equal(lastLabel(harness), 'Ẩn lớp "Nền đã xoá chữ"')
  assert.equal(harness.recorded.length, 1)

  const name = layerRows(harness)[1].children[1]
  name.value = "  Cọ chính  "
  name.onchange()
  assert.equal(harness.page.layers[1].name, "Cọ chính")
  assert.equal(lastLabel(harness), 'Đổi tên lớp "Cọ vẽ tay"')

  const opacity = layerRows(harness)[2].children[2]
  opacity.value = "40"
  opacity.onchange()
  assert.equal(harness.page.layers[2].opacity, .4)
  assert.equal(lastLabel(harness), 'Đổi độ đục lớp "Lớp chữ"')

  // An empty name is refused, the field snaps back and nothing is recorded.
  const refused = layerRows(harness)[1].children[1]
  refused.value = "   "
  const before = harness.recorded.length
  refused.onchange()
  assert.equal(harness.page.layers[1].name, "Cọ chính")
  assert.equal(harness.recorded.length, before)
  assert.equal(refused.value, "Cọ chính")
})

test("a layer moves, duplicates and deletes from its row", () => {
  const harness = createHarness()
  addStroke(harness.page, { mode: "paint", size: .05, color: "#ffffff", points: [{ x: .1, y: .1 }] })
  harness.layers.sync()

  layerRows(harness)[0].children[3].onclick()
  assert.deepEqual(harness.page.layers.map(({ kind }) => kind), ["retouch", "cleanup", "text"])
  assert.equal(lastLabel(harness), 'Đưa lớp "Nền đã xoá chữ" lên')

  layerRows(harness)[0].children[5].onclick()
  assert.equal(harness.page.layers.length, 4)
  assert.equal(harness.page.layers[1].name, "Cọ vẽ tay (bản sao)")
  assert.equal(harness.page.retouchStrokes.length, 2, "the duplicate owns a copy of the strokes")

  layerRows(harness)[1].children[6].onclick()
  assert.equal(harness.page.layers.length, 3)
  assert.equal(harness.page.retouchStrokes.length, 1, "deleting the duplicate deletes its copy only")

  while (pageLayers(harness.page).length > 1) layerRows(harness)[0].children[6].onclick()
  const kept = harness.recorded.length
  layerRows(harness)[0].children[6].onclick()
  assert.equal(layerRows(harness).length, 1)
  assert.equal(harness.recorded.length, kept, "the last layer cannot be deleted")
  assert.deepEqual(harness.messages.at(-1), ["Một trang luôn cần ít nhất một lớp.", true])
})

test("a stroke can be selected, hidden, deleted and moved to another layer", () => {
  const harness = createHarness()
  addStroke(harness.page, { mode: "paint", size: .05, color: "#112233", points: [{ x: .1, y: .1 }] })
  addStroke(harness.page, { mode: "inpaint", size: .05, points: [{ x: .4, y: .4 }] })
  harness.layers.sync()
  assert.deepEqual(rows(harness, "stroke-list").map((row) => row.children[0].textContent), ["#1 · Cọ vẽ · 5px", "#2 · Inpaint · 5px"])

  // Selecting a stroke adds the layer picker to that row only.
  rows(harness, "stroke-list")[0].children[0].onclick()
  assert.equal(harness.state.stroke, harness.page.retouchStrokes[0])
  assert.equal(rows(harness, "stroke-list")[0].children[3].tagName, "SELECT")
  assert.equal(rows(harness, "stroke-list")[1].children.length, 3)

  const select = rows(harness, "stroke-list")[0].children[3]
  const extra = harness.byId("add-layer")
  extra.onclick()
  const added = harness.page.layers.at(-1)
  assert.equal(added.kind, "retouch")
  assert.equal(harness.state.layerId, added.id, "the new layer receives the next stroke")

  const picker = rows(harness, "stroke-list")[0].children[3]
  picker.value = added.id
  picker.onchange()
  assert.equal(harness.page.retouchStrokes[0].layerId, added.id)
  assert.match(lastLabel(harness), /Chuyển nét cọ #1 sang lớp/)

  rows(harness, "stroke-list")[1].children[1].onclick()
  assert.equal(harness.page.retouchStrokes[1].hidden, true)
  assert.equal(rows(harness, "stroke-list")[1].dataset.hidden, "true")

  rows(harness, "stroke-list")[1].children[2].onclick()
  assert.deepEqual(harness.page.retouchStrokes, [harness.page.retouchStrokes[0]])
  assert.equal(lastLabel(harness), "Xoá nét cọ #2")
  assert.equal(rows(harness, "stroke-list").length, 1)
})

test("a busy editor refuses layer edits and the original scan is one click away", () => {
  const harness = createHarness({ busy: true })
  harness.page.originalFile = { name: "scan.png" }
  harness.layers.sync()
  assert.equal(harness.byId("restore-original").hidden, false)
  assert.equal(harness.byId("add-layer").disabled, true)

  const eye = layerRows(harness)[0].children[0]
  eye.checked = false
  eye.onchange()
  assert.deepEqual(harness.recorded, [], "a busy editor records nothing")
  assert.equal(harness.page.layers[0].visible, true)

  harness.byId("add-layer").onclick()
  assert.equal(harness.page.layers.length, 3)

  harness.byId("restore-original").onclick()
  assert.deepEqual(harness.messages.at(-1), ["restored", false], "restoring is delegated to the stage")
})
