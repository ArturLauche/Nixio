import assert from "node:assert/strict"
import test from "node:test"
import { readProject, writeProject } from "../src/project.js"
import {
  addLayer, addStroke, defaultLayers, moveLayer, pageLayers, renameLayer, setLayerHidden,
  setLayerOpacity,
} from "../src/layers.js"

const headerSize = 15

async function manifestOf(file) {
  const length = new DataView(await file.slice(0, headerSize).arrayBuffer()).getUint32(11, true)
  return JSON.parse(await file.slice(headerSize, headerSize + length).text())
}

function sampleProject(page = {}) {
  return {
    pages: [{
      file: new File([Uint8Array.of(1, 2, 3)], "trang-1.png"),
      name: "trang-1.png",
      boxes: [],
      unplaced: [],
      ...page,
    }],
    queue: [],
    settings: {
      "script-text": "",
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Japanese",
      "target-language": "Vietnamese",
      "translation-notes": "",
      "translation-glossary": "",
    },
    currentPage: 0,
    fit: true,
  }
}

const paint = (color) => ({ mode: "paint", size: .04, color, points: [{ x: .1, y: .1 }, { x: .2, y: .2 }] })

test("a project without layers still saves as version 2 and opens as one implicit layer per effect", async () => {
  const project = sampleProject({ retouchStrokes: [paint("#ffffff")] })
  const file = writeProject(project)
  const manifest = await manifestOf(file)
  assert.equal(manifest.version, 2)
  assert.deepEqual(manifest.pages[0].layers, undefined, "the default stack is not written")
  assert.deepEqual(manifest.pages[0].retouchStrokes, [paint("#ffffff")])

  const opened = await readProject(file)
  assert.deepEqual(pageLayers(opened.pages[0]).map(({ kind }) => kind), ["cleanup", "retouch", "text"])
  assert.deepEqual(opened.pages[0].retouchStrokes, [paint("#ffffff")])
})

test("layer visibility, opacity, names and order survive a reload at version 4", async () => {
  const page = { retouchStrokes: [], layers: defaultLayers() }
  addStroke(page, paint("#112233"))
  setLayerHidden(page.layers[0], true)
  setLayerOpacity(page.layers[2], .5)
  renameLayer(page.layers[1], "Cọ chính")
  const extra = addLayer(page, "retouch", { name: "Cọ phụ" })
  addStroke(page, paint("#445566"), extra.id)
  assert.equal(moveLayer(page, extra.id, -1), true)
  page.retouchStrokes[1].hidden = true

  const file = writeProject(sampleProject(page))
  const manifest = await manifestOf(file)
  assert.equal(manifest.version, 4)
  assert.deepEqual(manifest.pages[0].layers.map(({ kind }) => kind), ["cleanup", "retouch", "retouch", "text"])
  assert.deepEqual(manifest.pages[0].retouchStrokes.map(({ layerId }) => layerId), [page.layers[1].id, page.layers[2].id])

  const opened = await readProject(file)
  const stack = pageLayers(opened.pages[0])
  assert.deepEqual(stack.map(({ kind }) => kind), ["cleanup", "retouch", "retouch", "text"])
  assert.deepEqual(stack.map(({ id }) => id), page.layers.map(({ id }) => id))
  assert.deepEqual(stack.map(({ name }) => name), ["Nền đã xoá chữ", "Cọ chính", "Cọ phụ", "Lớp chữ"])
  assert.deepEqual(stack.map(({ visible }) => visible), [false, true, true, true])
  assert.deepEqual(stack.map(({ opacity }) => opacity), [1, 1, 1, .5])
  assert.deepEqual(opened.pages[0].retouchStrokes.map(({ layerId, hidden }) => [layerId, hidden === true]), [
    [page.layers[1].id, false],
    [page.layers[2].id, true],
  ])
})

test("a stroke layerId is dropped when the stack it names is not written", async () => {
  const page = { retouchStrokes: [] }
  const stroke = addStroke(page, paint("#ffffff"))
  assert.equal(stroke.layerId, "layer-retouch")
  const manifest = await manifestOf(writeProject(sampleProject(page)))
  assert.equal(manifest.version, 2)
  assert.deepEqual(manifest.pages[0].retouchStrokes[0].layerId, undefined, "the implicit retouch layer needs no id")

  const opened = await readProject(writeProject(sampleProject(page)))
  assert.equal(opened.pages[0].retouchStrokes[0].layerId, undefined)
})

test("a stroke that names a layer the file does not carry falls back to the implicit retouch layer", async () => {
  const page = { retouchStrokes: [{ ...paint("#ffffff"), layerId: "layer-retouch-1234abcd" }] }
  const manifest = await manifestOf(writeProject(sampleProject(page)))
  assert.equal(manifest.version, 2)
  assert.equal(manifest.pages[0].retouchStrokes[0].layerId, undefined)
})

test("a malformed layer stack cannot be saved and an unknown version is refused", async () => {
  for (const layers of [
    [{ id: "layer-cleanup", kind: "paint" }],
    [{ id: "layer-cleanup", kind: "cleanup" }, { id: "layer-cleanup", kind: "cleanup" }],
    [{ id: "layer-cleanup", kind: "cleanup", opacity: 1.5 }],
    [{ id: "layer-cleanup", kind: "cleanup", visible: "no" }],
    [{ id: "layer-cleanup", kind: "cleanup", name: "   " }],
  ]) {
    assert.throws(() => writeProject(sampleProject({ layers })), /không hợp lệ/, JSON.stringify(layers))
  }

  // An empty stack means "no explicit layers", which is the same thing as the implicit one.
  const empty = await manifestOf(writeProject(sampleProject({ layers: [], retouchStrokes: [] })))
  assert.equal(empty.version, 2)
  assert.equal(empty.pages[0].layers, undefined)

  // The version is claimed by the stack, and a build that does not know it refuses the file.
  const file = writeProject(sampleProject({ retouchStrokes: [], layers: defaultLayers().slice(1) }))
  assert.equal((await manifestOf(file)).version, 4)
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  const length = new DataView(header.buffer).getUint32(11, true)
  const metadata = JSON.parse(await file.slice(headerSize, headerSize + length).text())
  metadata.version = 9
  const manifest = new TextEncoder().encode(JSON.stringify(metadata))
  new DataView(header.buffer).setUint32(11, manifest.length, true)
  await assert.rejects(readProject(new Blob([header, manifest, file.slice(headerSize + length)])), /Phiên bản/)
})

test("hidden strokes survive a reload without dropping the stack", async () => {
  const page = { retouchStrokes: [], layers: defaultLayers() }
  addStroke(page, { ...paint("#ffffff"), hidden: true })
  const opened = await readProject(writeProject(sampleProject(page)))
  assert.deepEqual(opened.pages[0].retouchStrokes[0].hidden, true)
  assert.deepEqual(pageLayers(opened.pages[0]).map(({ kind }) => kind), ["cleanup", "retouch", "text"])
})
