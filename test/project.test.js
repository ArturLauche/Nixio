import assert from "node:assert/strict"
import test from "node:test"
import { readProject, writeProject } from "../src/project.js"
import { recordBoxTranslation, staleBoxes } from "../src/incremental-translation.js"

function sampleProject() {
  const rect = { x: .1, y: .2, w: .5, h: .3 }
  return {
    pages: [
      {
        file: new File([Uint8Array.of(1, 2, 3)], "trang trùng tên.png"),
        name: "trang trùng tên.png",
        boxes: [{
          ...rect, text: "Chào bạn!\nHẹn gặp lại.", size: 24, font: "Georgia", color: "#102030",
          align: "right", rotation: -30, fill: false, cleanup: true,
          originalBox: { ...rect, x: 0 },
        }],
        unplaced: [{ id: "B2", text: "Chưa đặt", source: "未配置", box: null }],
        translationContext: { signature: "settings", lines: [{ source: "未配置", text: "Chưa đặt" }] },
      },
      {
        file: new File([Uint8Array.of(4, 5)], "trang trùng tên.png", { type: "image/webp" }),
        name: "trang trùng tên.png", boxes: [], unplaced: [],
      },
    ],
    queue: ["Không tìm được trang"],
    settings: {
      "script-text": "Trang 1\nChào bạn!",
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Japanese",
      "target-language": "Vietnamese",
      "translation-notes": "Giữ nguyên tên riêng",
      "translation-glossary": "",
      "export-profile": "tapas",
      "gemini-key": "never-store-this-key",
    },
    currentPage: 1,
    fit: false,
  }
}

test("project round-trip keeps edit state and original bytes in page order without saving the API key", async () => {
  const project = sampleProject()
  const file = writeProject(project)
  assert.ok(!(await file.text()).includes(project.settings["gemini-key"]))
  const opened = await readProject(file)
  const { "gemini-key": unused, ...settings } = project.settings
  assert.deepEqual(opened.settings, settings)
  assert.deepEqual(opened.queue, project.queue)
  assert.equal(opened.currentPage, 1)
  assert.equal(opened.fit, false)
  assert.deepEqual(opened.pages[0].boxes, project.pages[0].boxes)
  assert.deepEqual(opened.pages[0].unplaced, project.pages[0].unplaced)
  assert.deepEqual(opened.pages[0].translationContext, project.pages[0].translationContext)
  for (const [index, page] of opened.pages.entries()) {
    assert.equal(page.file.name, project.pages[index].file.name)
    assert.equal(page.file.type, index === 0 ? "image/png" : "image/webp")
    assert.deepEqual(await page.file.bytes(), await project.pages[index].file.bytes())
  }
})

test("a script-only project round-trips without a selected page", async () => {
  const project = { ...sampleProject(), pages: [], currentPage: -1 }
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages, [])
  assert.equal(opened.currentPage, -1)
  assert.equal(opened.settings["script-text"], project.settings["script-text"])
})

test("project reader rejects unknown versions, malformed metadata and incomplete image payloads", async () => {
  const file = writeProject(sampleProject())
  await assert.rejects(readProject(await patchManifest(file, (metadata) => { metadata.version = 9 })), /Phiên bản/)
  await assert.rejects(readProject(await patchManifest(file, (metadata) => { metadata.currentPage = 2 })), /không hợp lệ/)
  await assert.rejects(readProject(await patchManifest(file, (metadata) => { metadata.pages[0].boxes[0].rotation = 999 })), /không hợp lệ/)
  await assert.rejects(readProject(file.slice(0, -1)), /không hợp lệ/)
  await assert.rejects(readProject(new Blob([file, "trailing bytes"])), /không hợp lệ/)
  await assert.rejects(readProject(new Blob(["not a project"])), /không hợp lệ/)
})

// The header stores the manifest length as raw bytes, so editing the manifest text in place only
// survives while those bytes happen to be ASCII. Patch the manifest and rebuild the header.
async function patchManifest(file, mutate) {
  const headerSize = 15
  const length = new DataView(await file.slice(0, headerSize).arrayBuffer()).getUint32(11, true)
  const metadata = JSON.parse(await file.slice(headerSize, headerSize + length).text())
  mutate(metadata)
  const manifest = new TextEncoder().encode(JSON.stringify(metadata))
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  new DataView(header.buffer).setUint32(11, manifest.length, true)
  return new Blob([header, manifest, file.slice(headerSize + length)])
}

test("version 2 persists independent cleanup strokes, presets and interrupted translation jobs", async () => {
  const project = sampleProject()
  const box = project.pages[0].boxes[0]
  box.cleanupRect = { x: .2, y: .2, w: .3, h: .4 }
  box.cleanupExpand = -2
  box.cleanupStrokes = [{ mode: "erase", size: .05, points: [{ x: .25, y: .3 }, { x: .3, y: .35 }] }]
  project.presets = [{ name: "Thoại", style: { size: box.size, font: box.font, color: box.color, align: box.align, rotation: box.rotation, fill: box.fill } }]
  project.pages[0].translationJob = { kind: "translate", signature: "saved", state: "running" }
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages[0].boxes[0], box)
  assert.deepEqual(opened.presets, project.presets)
  assert.equal(opened.pages[0].translationJob.state, "pending")
})

test("a box stamp is saved, so a reopened project knows which boxes are stale", async () => {
  const project = sampleProject()
  const settings = {
    provider: "gemini", model: "auto", source: "Japanese", target: "Vietnamese",
    notes: "", direction: "ltr", glossary: "先生 = thầy",
  }
  const box = project.pages[0].boxes[0]
  box.text = "Chào bạn!"
  recordBoxTranslation(box, { source: "こんにちは、先生", settings, page: project.pages[0] })
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages[0].boxes[0].translationStamp, box.translationStamp)
  assert.deepEqual(opened.pages[0].boxes[0].translationStamp.terms, [["先生", "thầy"]])
  assert.deepEqual(staleBoxes(opened.pages[0], settings), [])
  assert.deepEqual(staleBoxes(opened.pages[0], { ...settings, glossary: "先生 = thầy giáo" }).map(({ text }) => text), ["Chào bạn!"])
  // A project saved without stamps — another build, another machine — has nothing to compare.
  delete opened.pages[0].boxes[0].translationStamp
  assert.equal(staleBoxes(opened.pages[0], settings).length, 1)
})

test("a malformed box stamp cannot be saved", () => {
  const project = sampleProject()
  project.pages[0].boxes[0].translationStamp = { hash: "không phải hex", source: "", output: "", terms: [] }
  assert.throws(() => writeProject(project), /không hợp lệ/)
})

test("version 1 projects open with empty presets, a default profile and an empty glossary", async () => {
  const project = sampleProject()
  const file = writeProject(project)
  const headerSize = 15
  const length = new DataView(await file.slice(0, headerSize).arrayBuffer()).getUint32(11, true)
  const metadata = JSON.parse(await file.slice(headerSize, headerSize + length).text())
  metadata.version = 1
  delete metadata.presets
  delete metadata.settings["translation-glossary"]
  delete metadata.settings["export-profile"]
  const manifest = new TextEncoder().encode(JSON.stringify(metadata))
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  new DataView(header.buffer).setUint32(11, manifest.length, true)
  const oldFile = new Blob([header, manifest, file.slice(headerSize + length)])
  const opened = await readProject(oldFile)
  assert.equal(opened.settings["translation-glossary"], "")
  // A file that predates export profiles opens with the original-size profile, never a missing one.
  assert.equal(opened.settings["export-profile"], "goc")
  assert.deepEqual(opened.presets, [])
  assert.equal(opened.pages[0].boxes[0].text, project.pages[0].boxes[0].text)
})

test("invalid masks and preset styles cannot be saved", () => {
  const project = sampleProject()
  project.pages[0].boxes[0].cleanupStrokes = [{ mode: "erase", size: .1, points: [] }]
  assert.throws(() => writeProject(project), /không hợp lệ/)
  delete project.pages[0].boxes[0].cleanupStrokes
  project.presets = [{ name: "Broken", style: { ...project.pages[0].boxes[0], size: -2 } }]
  assert.throws(() => writeProject(project), /không hợp lệ/)
})

test("version 2 persists rich typography styles, shadow, custom font names and retouch strokes", async () => {
  const project = sampleProject()
  Object.assign(project.pages[0].boxes[0], {
    font: "Comic Neue",
    bold: true,
    italic: true,
    uppercase: true,
    vertical: true,
    lineHeight: 1.4,
    strokeWidth: 3,
    strokeColor: "#00ffaa",
    shadowBlur: 6,
    shadowColor: "#222222",
    fillColor: "#111111",
    fillShape: "ellipse",
  })
  project.pages[0].retouchStrokes = [
    { mode: "paint", size: .04, color: "#eeeeee", opacity: .8, points: [{ x: .1, y: .1 }, { x: .2, y: .2 }] },
    { mode: "clone", size: .06, offsetX: -.05, offsetY: .05, points: [{ x: .4, y: .4 }] },
    { mode: "inpaint", size: .05, points: [{ x: .5, y: .5 }, { x: .55, y: .52 }] },
  ]
  const opened = await readProject(writeProject(project))
  assert.deepEqual(opened.pages[0].boxes[0], project.pages[0].boxes[0])
  assert.deepEqual(opened.pages[0].retouchStrokes, project.pages[0].retouchStrokes)
})

test("portable projects retain their recovery identity while older projects can omit it", async () => {
  const project = sampleProject()
  project.projectId = "d26b25ce-44de-4fcb-a04a-9c63d471527a"
  assert.equal((await readProject(writeProject(project))).projectId, project.projectId)
  project.projectId = "../escape"
  assert.throws(() => writeProject(project), /không hợp lệ/)
})

// Nixio #76. The triage decisions travel with the project, so a reopened board shows the reviews
// that were already taken. A file without them (version 1 to 3) still opens, and a malformed
// decision rejects the file instead of silently dropping a review.
async function readManifest(file) {
  const headerSize = 15
  const length = new DataView(await file.slice(0, headerSize).arrayBuffer()).getUint32(11, true)
  return { headerSize, length, manifest: JSON.parse(await file.slice(headerSize, headerSize + length).text()) }
}

async function rewriteManifest(file, change) {
  const { headerSize, length, manifest } = await readManifest(file)
  change(manifest)
  const bytes = new TextEncoder().encode(JSON.stringify(manifest))
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  new DataView(header.buffer).setUint32(11, bytes.length, true)
  return new Blob([header, bytes, file.slice(headerSize + length)])
}

test("QA triage decisions round-trip in a version 4 manifest, and older files still open", async () => {
  const project = sampleProject()
  const qaReview = {
    version: 1,
    entries: [
      { id: "1:1:punctuation_spacing", state: "fixed", note: "Đã sửa dấu câu", updatedAt: 1712 },
      { id: "1:0:glossary_violation:gojo-satoru", state: "ignored", note: "Biên tập giữ nguyên", updatedAt: 1713 },
    ],
  }
  const file = writeProject({ ...project, qaReview })
  assert.equal((await readManifest(file)).manifest.version, 4)
  assert.deepEqual((await readProject(file)).qaReview, qaReview)

  // A project without decisions claims nothing a build that predates them cannot read.
  assert.equal((await readManifest(writeProject(project))).manifest.version, 2)

  // A file written before the board existed has no field at all, and still opens.
  const older = await rewriteManifest(file, (manifest) => {
    manifest.version = 3
    delete manifest.qaReview
  })
  const reopened = await readProject(older)
  assert.equal(reopened.qaReview, undefined)
  assert.equal(reopened.pages.length, project.pages.length)
})

test("a malformed QA decision cannot be saved", () => {
  const project = sampleProject()
  const entry = { id: "1:0:empty_or_placeholder", state: "fixed", note: "", updatedAt: 3 }
  assert.doesNotThrow(() => writeProject({ ...project, qaReview: { version: 1, entries: [entry] } }))
  assert.throws(
    () => writeProject({ ...project, qaReview: { version: 1, entries: [{ ...entry, state: "ignored" }] } }),
    /không hợp lệ/,
  )
  assert.throws(
    () => writeProject({ ...project, qaReview: { version: 1, entries: [{ ...entry, state: "xong" }] } }),
    /không hợp lệ/,
  )
  assert.throws(
    () => writeProject({ ...project, qaReview: { version: 2, entries: [] } }),
    /không hợp lệ/,
  )
  assert.throws(
    () => writeProject({ ...project, qaReview: { version: 1, entries: [entry, { ...entry }] } }),
    /không hợp lệ/,
  )
})
