import { clamp, drawPage, exportPage, makeBox, textOverflows } from "./canvas.js"
import { filenameStem, groupDialogue, isImageFile, readDialogueFile, saveFile } from "./io.js"
import { alignScript, translateImage } from "./gemini.js"
import { setupLibrary } from "./library.js"
import { matchDialogue, toCoordinates, toRectangle } from "./placement.js"
import { projectExtension, projectPageLimit as pageLimit, projectSettingIds, readProject, writeProject, projectStyle } from "./project.js"

import { copyEditor, EditHistory } from "./history.js"
import { cleanupRectangle, paintCleanupMask } from "./cleanup.js"
import { remainingTranslations, translationLabel, translationSignature } from "./translation.js"

const history = new EditHistory()
const ownedUrls = new Set()
const byId = (id) => document.getElementById(id)
const stage = byId("stage")
const overlays = byId("overlays")
const pageCanvas = byId("page-canvas")
const form = byId("box-form")
const editorStatus = byId("status")
const exportButtons = [...document.querySelectorAll("[data-export]")]
const state = {
  pages: [], presets: [], pageId: null, boxId: null, queue: [], placing: false, fit: true,
  exporting: false, importing: false, translating: false, importingScript: false, openingProject: false,
}
const projectSettings = projectSettingIds.map(byId)
const defaultProjectSettings = projectSettings.map(({ value }) => value)
const projectFile = byId("project-file")
let projectName
let gesture
let pendingPaint
let previewRedraw
let translationController

const selectedPage = () => state.pages.find((page) => page.id === state.pageId)
const selectedBox = () => selectedPage()?.boxes.find((box) => box.id === state.boxId)
const selectedIndex = () => state.pages.findIndex((page) => page.id === state.pageId)
const boxFields = { text: "box-text", size: "box-size", font: "box-font", color: "box-color", align: "box-align", rotation: "box-rotation" }

function editorSnapshot() {
  return copyEditor({
    pages: state.pages, queue: state.queue, presets: state.presets,
    pageId: state.pageId, boxId: state.boxId,
    settings: Object.fromEntries(projectSettings.map(({ id, value }) => [id, value])),
  })
}

function releaseUnusedImages() {
  const snapshots = [state, ...history.past, ...history.future]
  const used = new Set(snapshots.flatMap(({ pages }) => pages.map(({ url }) => url)))
  for (const url of ownedUrls) {
    if (used.has(url)) continue
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
  }
}

function checkpoint(snapshot = editorSnapshot()) {
  history.record(snapshot)
  syncProjectActions()
}

function restoreHistory(direction) {
  if (projectBusy() || gesture) return
  const snapshot = history[direction](editorSnapshot())
  if (!snapshot) return
  const { settings, ...editor } = snapshot
  Object.assign(state, editor, { placing: false })
  projectSettings.forEach((field) => { field.value = settings[field.id] })
  render()
  releaseUnusedImages()
  status(direction === "undo" ? "Đã hoàn tác." : "Đã làm lại.")
}

byId("undo").onclick = () => restoreHistory("undo")
byId("redo").onclick = () => restoreHistory("redo")
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey ||
      event.target.closest("input, textarea, select, [contenteditable]")) return
  const key = event.key.toLowerCase()
  if (key !== "z" && key !== "y") return
  event.preventDefault()
  restoreHistory(key === "y" || event.shiftKey ? "redo" : "undo")
})
for (const field of projectSettings) {
  let before
  field.addEventListener("focus", () => { before = editorSnapshot() })
  field.addEventListener("change", () => {
    if (before && before.settings[field.id] !== field.value) checkpoint(before)
    before = editorSnapshot()
    syncTranslationActions()
  })
}

function status(message, error = false) {
  editorStatus.textContent = message
  editorStatus.toggleAttribute("data-error", error)
}

function listButton(text, onClick, label = text) {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = text
  button.setAttribute("aria-label", label)
  button.onclick = onClick
  return button
}

function setView() {
  const library = location.hash === "#library"
  byId("editor").hidden = library
  byId("library").hidden = !library
  document.querySelectorAll("nav a[data-view]").forEach((link) => {
    if ((link.dataset.view === "library") === library) link.setAttribute("aria-current", "page")
    else link.removeAttribute("aria-current")
  })
}
window.addEventListener("hashchange", setView)
setView()

function selectPage(page) {
  if (gesture) {
    const { settings, ...editor } = gesture.before
    Object.assign(state, editor)
    page = state.pages.find((item) => item.id === page?.id)
  }
  state.pageId = page?.id ?? null
  state.boxId = null
  state.placing = false
  gesture = undefined
  render()
}

function changePage(delta) {
  const page = state.pages[selectedIndex() + delta]
  if (page) selectPage(page)
}

function movePage(index, delta) {
  if (projectBusy()) return
  const target = index + delta
  if (target < 0 || target >= state.pages.length) return
  checkpoint()
  const [page] = state.pages.splice(index, 1)
  state.pages.splice(target, 0, page)
  renderPages()
  const button = document.getElementById("move-" + page.id + "-" + delta)
  const fallback = document.getElementById("move-" + page.id + "-" + -delta)
  ;(button && !button.disabled ? button : fallback)?.focus()
}

function removePage(index) {
  if (projectBusy()) return
  checkpoint()
  const [page] = state.pages.splice(index, 1)
  if (!page) return
  if (page.id === state.pageId) selectPage(state.pages[Math.min(index, state.pages.length - 1)])
  else renderPages()
  status("Đã bỏ " + page.name + ".")
}

function projectBusy() {
  return state.openingProject || state.importing || state.importingScript || state.translating || state.exporting
}

function syncProjectActions() {
  byId("undo").disabled = projectBusy() || !history.past.length
  byId("redo").disabled = projectBusy() || !history.future.length
  byId("open-project").disabled = projectBusy()
  byId("save-project").disabled = projectBusy()
  byId("images").disabled = projectBusy()
  byId("script-file").disabled = projectBusy()
}

function syncTranslationActions() {
  byId("resume-translation").disabled = projectBusy() || !remainingTranslations(state.pages, readTranslationSettings()).length
  byId("pages").querySelectorAll(".page-job").forEach((element, index) => {
    const page = state.pages[index]
    element.dataset.state = page.translationJob?.state ?? "pending"
    element.textContent = translationLabel(page, readTranslationSettings())
  })
}

function renderPages() {
  const current = selectedIndex()
  const count = state.pages.length
  if (!state.importing && !state.openingProject) releaseUnusedImages()
  byId("page-count").textContent = count + " / " + pageLimit
  byId("page-indicator").textContent = current === -1 ? "Chưa có trang" : `Trang ${current + 1} / ${count}`
  byId("prev-page").disabled = current <= 0
  byId("next-page").disabled = current < 0 || current >= count - 1
  byId("apply-script").disabled = current < 0 || projectBusy()
  byId("translate").disabled = current < 0 || state.translating || state.openingProject
  byId("align-script").disabled = current < 0 || state.translating || state.openingProject
  byId("translate-all").disabled = !count || state.translating || state.openingProject
  byId("fit-page").disabled = current < 0
  byId("add-box").disabled = current < 0 || projectBusy()
  byId("export-all").disabled = !count || state.exporting || state.openingProject
  exportButtons.forEach((button) => { button.disabled = current < 0 || state.exporting || state.openingProject })
  syncProjectActions()
  byId("box-form").inert = state.translating || state.openingProject
  projectSettings.forEach((field) => { field.disabled = state.translating || state.openingProject })
  byId("resume-translation").disabled = projectBusy() || !remainingTranslations(state.pages, readTranslationSettings()).length
  byId("stop-translation").disabled = !state.translating
  renderPresets()
  byId("check-export").disabled = projectBusy()
  byId("pages").replaceChildren(...state.pages.map((page, index) => {
    const li = document.createElement("li")
    const button = listButton(`${index + 1}. ${page.name}`, () => selectPage(page))
    button.className = "page-name"
    if (current === index) button.setAttribute("aria-current", "true")
    const up = listButton("↑", () => movePage(index, -1), "Đưa lên " + page.name)
    up.disabled = index === 0 || projectBusy()
    up.id = "move-" + page.id + "--1"
    const down = listButton("↓", () => movePage(index, 1), "Đưa xuống " + page.name)
    down.disabled = index === count - 1 || projectBusy()
    down.id = "move-" + page.id + "-1"
    const remove = listButton("×", () => removePage(index), "Bỏ " + page.name)
    remove.disabled = projectBusy()
    const job = document.createElement("span")
    job.className = "page-job"
    job.dataset.state = page.translationJob?.state ?? "pending"
    job.textContent = translationLabel(page, readTranslationSettings())
    li.append(button, up, down, remove, job)
    return li
  }))
}

function rectStyle(element, rect) {
  for (const [name, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })) {
    element.style[name] = value * 100 + "%"
  }
  if (rect.rotation) element.style.transform = "rotate(" + rect.rotation + "deg)"
}

function paintPreview(page) {
  const pending = drawPage(pageCanvas, page, { showCleanup: byId("show-cleanup").checked, showText: byId("show-text").checked })
  if (!pending || previewRedraw === pending) return
  previewRedraw = pending
  pending.then(() => {
    if (previewRedraw !== pending) return
    previewRedraw = null
    if (selectedPage() === page) paintPreview(page)
  })
}

function renderCanvas() {
  if (pendingPaint) {
    cancelAnimationFrame(pendingPaint)
    pendingPaint = undefined
  }
  const page = selectedPage()
  stage.hidden = !page
  byId("canvas-empty").hidden = Boolean(page)
  byId("add-box").setAttribute("aria-pressed", String(state.placing))
  stage.classList.toggle("placing", state.placing)
  stage.classList.toggle("cleaning", byId("cleanup-tool").value !== "text")
  if (!page) {
    overlays.replaceChildren()
    pageCanvas.width = 1
    pageCanvas.height = 1
    return
  }
  stage.style.width = Math.min(page.image.naturalWidth, state.fit ? 720 : Infinity) + "px"
  stage.style.maxWidth = state.fit ? "100%" : "none"
  stage.style.flexShrink = state.fit ? "1" : "0"
  paintPreview(page)
  overlays.replaceChildren(...page.boxes.map((box) => {
    const outline = listButton("", () => selectBox(box), box.text)
    outline.className = "outline"
    outline.dataset.box = box.id
    if (box.id === state.boxId) outline.setAttribute("aria-current", "true")
    rectStyle(outline, box)
    return outline
  }))
  renderCleanupOverlay()
}

function freezeCleanup(box) {
  if (box.cleanupRect) return
  const { x, y, w, h } = cleanupRectangle(box)
  box.cleanupRect = { x, y, w, h }
}

function renderCleanupOverlay() {
  const canvas = byId("cleanup-overlay")
  canvas.width = pageCanvas.width
  canvas.height = pageCanvas.height
  const box = selectedBox()
  if (!box || byId("cleanup-tool").value === "text") return
  const rect = cleanupRectangle(box)
  const left = Math.floor(rect.x * canvas.width)
  const top = Math.floor(rect.y * canvas.height)
  const mask = document.createElement("canvas")
  mask.width = Math.ceil((rect.x + rect.w) * canvas.width) - left
  mask.height = Math.ceil((rect.y + rect.h) * canvas.height) - top
  paintCleanupMask(mask, box, selectedPage().image, left, top)
  const context = mask.getContext("2d")
  context.globalCompositeOperation = "source-in"
  context.fillStyle = "#ed9f24"
  context.fillRect(0, 0, mask.width, mask.height)
  canvas.getContext("2d").drawImage(mask, left, top)
  const outline = document.createElement("div")
  outline.className = "outline cleanup-region"
  rectStyle(outline, rect)
  overlays.querySelector(".cleanup-region")?.remove()
  overlays.append(outline)
}

function renderPresets() {
  const select = byId("style-preset")
  const value = select.value
  select.replaceChildren(...state.presets.map((preset, index) => new Option(preset.name, index)))
  if (state.presets[Number(value)]) select.value = value
  byId("save-preset").disabled = !selectedBox() || projectBusy()
  byId("apply-preset").disabled = !state.presets.length || !state.pages.length || projectBusy()
  byId("delete-preset").disabled = !state.presets.length || projectBusy()
}

byId("save-preset").onclick = () => {
  const box = selectedBox()
  const name = byId("preset-name").value.trim()
  if (!box || projectBusy()) return
  if (!name) return status("Hãy nhập tên mẫu dàn chữ.", true)
  checkpoint()
  const preset = { name, style: projectStyle(box) }
  const index = state.presets.findIndex((item) => item.name === name)
  if (index < 0) state.presets.push(preset)
  else state.presets[index] = preset
  renderPresets()
  byId("style-preset").value = String(index < 0 ? state.presets.length - 1 : index)
  status("Đã lưu mẫu " + name + ".")
}
byId("apply-preset").onclick = () => {
  const preset = state.presets[Number(byId("style-preset").value)]
  if (!preset || projectBusy()) return
  const scope = byId("preset-scope").value
  const pages = scope === "chapter" ? state.pages : [selectedPage()].filter(Boolean)
  const boxes = scope === "box" ? [selectedBox()].filter(Boolean) : pages.flatMap((page) => page.boxes)
  if (!boxes.length) return status("Hãy chọn khung để áp dụng mẫu.", true)
  checkpoint()
  boxes.forEach((box) => Object.assign(box, preset.style))
  render()
  status(`Đã áp dụng mẫu cho ${boxes.length} khung.`)
}
byId("delete-preset").onclick = () => {
  if (projectBusy() || !state.presets.length) return
  checkpoint()
  state.presets.splice(Number(byId("style-preset").value), 1)
  renderPresets()
}
byId("reset-cleanup").onclick = () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  checkpoint()
  delete box.cleanupRect
  delete box.cleanupStrokes
  freezeCleanup(box)
  render()
}
byId("cleanup-tool").onchange = () => {
  state.placing = false
  renderCanvas()
  if (byId("cleanup-tool").value !== "text") status("Chọn khung thoại rồi khoanh vùng hoặc vẽ cọ trên ảnh.")
}
byId("show-cleanup").onchange = renderCanvas
byId("show-text").onchange = renderCanvas

function selectBox(box) {
  state.boxId = box.id
  renderCanvas()
  renderInspector()
}

function renderInspector() {
  const page = selectedPage()
  const box = selectedBox()
  const boxes = page?.boxes ?? []
  renderPresets()
  byId("cleanup-inspector").hidden = !box
  byId("reset-cleanup").disabled = projectBusy()
  byId("box-count").textContent = boxes.length
  byId("inspector-empty").hidden = Boolean(box)
  form.hidden = !box
  if (box) {
    for (const [key, id] of Object.entries(boxFields)) byId(id).value = box[key]
    byId("box-fill").checked = box.fill
    byId("box-cleanup").checked = Boolean(box.cleanup)
  }
  byId("boxes").replaceChildren(...boxes.map((item) => {
    const li = document.createElement("li")
    const button = listButton(item.text, () => selectBox(item))
    if (box?.id === item.id) button.setAttribute("aria-current", "true")
    li.append(button)
    return li
  }))
  const queue = [
    ...state.queue.map((text, index) => ({ text, remove: () => state.queue.splice(index, 1) })),
    ...(page?.unplaced ?? []).map((line, index) => ({
      ...line, remove: () => page.unplaced.splice(index, 1),
    })),
  ]
  byId("queue-section").hidden = !queue.length
  byId("queue").replaceChildren(...queue.map((line) => {
    const li = document.createElement("li")
    const button = listButton(line.text, () => {
      if (!selectedPage() || projectBusy()) return
      checkpoint()
      line.remove()
      addBox({ x: .32, y: .4, w: .36, h: .16 }, line.text, false)
    })
    button.disabled = !page || projectBusy()
    li.append(button)
    return li
  }))
}

function render() {
  renderPages()
  renderCanvas()
  renderInspector()
}

async function openImage(file) {
  const url = URL.createObjectURL(file)
  ownedUrls.add(url)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    if (image.naturalWidth * image.naturalHeight > 28000000) throw new Error("Ảnh vượt giới hạn kích thước.")
    return { id: crypto.randomUUID(), name: file.name, file, image, url, boxes: [], unplaced: [] }
  } catch (error) {
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
    throw error
  }
}

byId("save-project").onclick = () => {
  if (projectBusy()) return
  try {
    const settings = Object.fromEntries(projectSettings.map(({ id, value }) => [id, value]))
    const file = writeProject({ pages: state.pages, presets: state.presets, queue: state.queue, settings, currentPage: selectedIndex(), fit: state.fit })
    const name = projectName ?? filenameStem(state.pages[0]?.name ?? "khung-thoai")
    saveFile(file, name + projectExtension)
    status("Đã tạo tệp dự án.")
  } catch (error) {
    status("Không lưu được dự án. " + error.message, true)
  }
}

byId("open-project").onclick = () => {
  if (!projectBusy()) projectFile.click()
}

projectFile.onchange = async () => {
  const file = projectFile.files[0]
  projectFile.value = ""
  if (!file || projectBusy()) return
  const loaded = []
  state.openingProject = true
  renderPages()
  status("Đang mở dự án…")
  try {
    const project = await readProject(file)
    for (const field of projectSettings) {
      if (field.options && ![...field.options].some(({ value }) => value === project.settings[field.id])) {
        throw new Error("Tệp dự án chứa thiết lập chưa được hỗ trợ.")
      }
    }
    for (const saved of project.pages) {
      let page
      try {
        page = await openImage(saved.file)
      } catch {
        throw new Error("Không đọc được ảnh trong dự án: " + saved.file.name)
      }
      page.boxes = saved.boxes.map((box) => ({ ...box, id: crypto.randomUUID() }))
      page.unplaced = saved.unplaced
      page.translationContext = saved.translationContext
      page.translationJob = saved.translationJob
      loaded.push(page)
    }
    const hasContent = state.pages.length || state.presets.length || state.queue.length ||
      projectSettings.some(({ value }, index) => value !== defaultProjectSettings[index])
    if (hasContent && !window.confirm("Mở dự án này sẽ thay thế phiên biên tập hiện tại. Tiếp tục?")) {
      status("Đã hủy mở dự án.")
      return
    }
    history.clear()
    state.pages = loaded
    state.queue = project.queue
    state.presets = project.presets
    state.fit = project.fit
    updateFitLabel()
    projectSettings.forEach((field) => { field.value = project.settings[field.id] })
    projectName = filenameStem(file.name)
    selectPage(loaded[project.currentPage])
    status(`Đã mở dự án với ${loaded.length} trang.`)
  } catch (error) {
    status("Không mở được dự án. " + error.message, true)
  } finally {
    releaseUnusedImages()
    state.openingProject = false
    renderPages()
  }
}

async function importPages(files) {
  if (projectBusy()) return []
  state.importing = true
  syncProjectActions()
  const loaded = []
  const rejected = []
  try {
    for (const file of files) {
      if (state.pages.length + loaded.length >= pageLimit || !isImageFile(file)) {
        rejected.push(file.name)
        continue
      }
      try {
        loaded.push(await openImage(file))
      } catch {
        rejected.push(file.name)
      }
    }
    if (loaded.length) checkpoint()
    state.pages.push(...loaded)
    if (loaded.length && !selectedPage()) selectPage(loaded[0])
    else render()
    if (rejected.length) {
      status(`Đã thêm ${loaded.length} ảnh. Bỏ qua ${rejected.length} tệp do định dạng, kích thước hoặc giới hạn 50 trang.`, true)
    } else if (loaded.length) {
      status(`Đã thêm ${loaded.length} ảnh.`)
    }
    return loaded
  } finally {
    state.importing = false
    renderPages()
    releaseUnusedImages()
    byId("images").value = ""
  }
}
byId("images").onchange = (event) => importPages([...event.target.files])
const dropzone = byId("dropzone")
dropzone.ondragover = (event) => {
  event.preventDefault()
  dropzone.classList.add("dragging")
}
dropzone.ondragleave = () => dropzone.classList.remove("dragging")
dropzone.ondrop = (event) => {
  event.preventDefault()
  dropzone.classList.remove("dragging")
  importPages([...event.dataTransfer.files])
}
setupLibrary(async (files) => {
  const pages = await importPages(files)
  if (!pages.length) throw new Error("Không còn chỗ hoặc không đọc được ảnh.")
  selectPage(pages[0])
  location.hash = "editor"
})

byId("prev-page").onclick = () => changePage(-1)
byId("next-page").onclick = () => changePage(1)
function updateFitLabel() {
  byId("fit-page").textContent = state.fit ? "Vừa trang" : "Kích thước gốc"
}
byId("fit-page").onclick = () => {
  state.fit = !state.fit
  updateFitLabel()
  renderCanvas()
}
byId("script-file").onchange = async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file || projectBusy()) return
  state.importingScript = true
  syncProjectActions()
  try {
    const script = await readDialogueFile(file)
    checkpoint()
    byId("script-text").value = script
    status("Đã đọc " + file.name + ".")
  } catch (error) {
    status("Không nhập được kịch bản. " + error.message, true)
  } finally {
    state.importingScript = false
    renderPages()
  }
}

function distribute(page, lines, direction) {
  const columns = lines.length > 4 ? 2 : 1
  const rows = Math.ceil(lines.length / columns)
  const width = columns === 1 ? .48 : .4
  const height = Math.min(.16, .79 / rows)
  return lines.map((line, index) => {
    const column = index % columns
    const x = columns === 1 ? .26 : direction === "rtl" ? .55 - column * .49 : .06 + column * .49
    const y = .07 + Math.floor(index / columns) * (.86 / rows)
    const box = makeBox(page, { x, y, w: width, h: height }, line)
    box.size = clamp(Math.round(Math.min(box.size, height * page.image.naturalHeight * .44)), 8, 400)
    return box
  })
}

function pageForScript(reference, current) {
  if (reference === null) return current
  if (typeof reference === "number") return state.pages[reference]
  return state.pages.find((page) => page.name.toLowerCase() === reference)
}

byId("apply-script").onclick = () => {
  const current = selectedPage()
  const groups = groupDialogue(byId("script-text").value)
  if (projectBusy()) return
  if (!current || !groups.length) return status("Hãy thêm ảnh và nhập lời thoại.", true)
  checkpoint()
  const unplaced = []
  let placed = 0
  for (const { reference, lines } of groups) {
    const page = pageForScript(reference, current)
    if (!page) {
      unplaced.push(...lines)
      continue
    }
    const available = Math.max(0, 24 - page.boxes.length)
    const chosen = lines.slice(0, available)
    page.boxes.push(...distribute(page, chosen, byId("direction").value))
    placed += chosen.length
    unplaced.push(...lines.slice(available))
  }
  state.queue.push(...unplaced)
  render()
  status(`Đã đặt ${placed} câu. ${unplaced.length} câu chờ đặt thủ công.`)
}

function addBox(rectangle, line, record = true) {
  const page = selectedPage()
  if (!page) return
  if (projectBusy()) return
  if (record) checkpoint()
  const box = makeBox(page, rectangle, line)
  page.boxes.push(box)
  state.boxId = box.id
  state.placing = false
  renderCanvas()
  renderInspector()
  status("Đã thêm khung chữ.")
}

byId("add-box").onclick = () => {
  byId("cleanup-tool").value = "text"
  state.placing = !state.placing
  renderCanvas()
  if (state.placing) {
    stage.focus()
    status("Bấm hoặc kéo trên ảnh để đặt khung, hoặc nhấn Enter.")
  } else {
    status("Đã thoát chế độ đặt khung.")
  }
}
function point(event) {
  const area = pageCanvas.getBoundingClientRect()
  return { x: clamp((event.clientX - area.left) / area.width, 0, 1), y: clamp((event.clientY - area.top) / area.height, 0, 1) }
}

function placement(a, b) {
  const w = Math.abs(a.x - b.x)
  const h = Math.abs(a.y - b.y)
  if (w < .015 && h < .015) return { x: clamp(a.x - .17, 0, .66), y: clamp(a.y - .08, 0, .84), w: .34, h: .16 }
  return { x: Math.min(a.x, b.x, .97), y: Math.min(a.y, b.y, .97), w: Math.max(.03, w), h: Math.max(.03, h) }
}

stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || projectBusy()) return
  const origin = point(event)
  const tool = byId("cleanup-tool").value
  const box = tool === "text" ? selectedPage()?.boxes.find((item) => item.id === event.target.dataset.box) : selectedBox()
  if (!box && !state.placing) return
  event.preventDefault()
  stage.setPointerCapture(event.pointerId)
  const before = editorSnapshot()
  if (tool !== "text") {
    if (!box) return
    freezeCleanup(box)
    box.cleanup = true
    if (tool !== "region") {
      const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
      const stroke = { mode: tool, size: size / Math.min(pageCanvas.width, pageCanvas.height), points: [origin] }
      box.cleanupStrokes ??= []
      box.cleanupStrokes.push(stroke)
      gesture = { pointer: event.pointerId, box, stroke, before }
      renderCleanupOverlay()
      return
    }
  } else if (box) {
    selectBox(box)
    if (box.cleanup) freezeCleanup(box)
    gesture = { pointer: event.pointerId, box, origin, start: { x: box.x, y: box.y }, before }
    return
  }
  const draft = document.createElement("div")
  draft.className = "outline draft"
  overlays.append(draft)
  gesture = { pointer: event.pointerId, origin, draft, cleanupBox: tool === "region" ? box : null, before }
})

stage.addEventListener("pointermove", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  const cursor = point(event)
  if (gesture.stroke) {
    gesture.stroke.points.push(cursor)
    renderCleanupOverlay()
  } else if (gesture.box) {
    const { box, origin, start } = gesture
    box.x = clamp(start.x + cursor.x - origin.x, 0, 1 - box.w)
    box.y = clamp(start.y + cursor.y - origin.y, 0, 1 - box.h)
    const outline = overlays.querySelector('[aria-current="true"]')
    if (outline) rectStyle(outline, box)
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  } else {
    rectStyle(gesture.draft, placement(gesture.origin, cursor))
  }
})

stage.addEventListener("pointerup", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  const completed = gesture
  gesture = undefined
  if (completed.draft || completed.stroke || completed.box.x !== completed.start.x || completed.box.y !== completed.start.y) {
    checkpoint(completed.before)
  }
  if (completed.cleanupBox) {
    completed.cleanupBox.cleanupRect = placement(completed.origin, point(event))
    completed.cleanupBox.cleanupStrokes = []
  } else if (completed.draft) {
    addBox(placement(completed.origin, point(event)), undefined, false)
  }
  render()
})
stage.addEventListener("pointercancel", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  const { before } = gesture
  gesture = undefined
  const { settings, ...editor } = before
  Object.assign(state, editor)
  render()
})

stage.addEventListener("keydown", (event) => {
  if (event.target !== stage) return
  if (event.key === "Enter") {
    event.preventDefault()
    addBox({ x: .33, y: .42, w: .34, h: .16 })
    byId("box-text").focus()
  } else if (event.key === "Escape") {
    state.placing = false
    renderCanvas()
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const rtl = byId("direction").value === "rtl"
    changePage((event.key === "ArrowLeft") === rtl ? 1 : -1)
    event.preventDefault()
  }
})

form.onsubmit = (event) => {
  event.preventDefault()
  const box = selectedBox()
  if (!box) return
  if (projectBusy()) return
  const text = byId("box-text").value.trim()
  if (!text) return status("Hãy nhập nội dung khung.", true)
  checkpoint()
  for (const [key, id] of Object.entries(boxFields)) box[key] = byId(id).value
  box.text = text
  box.size = Number(box.size)
  box.rotation = Number(box.rotation)
  box.fill = byId("box-fill").checked
  box.cleanup = byId("box-cleanup").checked
  if (box.cleanup) freezeCleanup(box)
  renderPages()
  renderCanvas()
  renderInspector()
  status("Đã lưu khung.")
}

byId("delete-box").onclick = () => {
  const page = selectedPage()
  if (!page || !state.boxId || projectBusy()) return
  checkpoint()
  page.boxes = page.boxes.filter((box) => box.id !== state.boxId)
  state.boxId = null
  renderCanvas()
  renderInspector()
  status("Đã xóa khung.")
}

function applyTranslation(page, lines) {
  const regions = page.boxes.length ? page.boxes.map((box) => ({ box: toCoordinates(box.originalBox ?? box), existing: box }))
    : lines.filter((line) => line.box).map((line) => ({ box: line.box }))
  const { placed, unplaced } = matchDialogue(lines, regions)
  for (const { line, region } of placed) {
    const box = region.existing ?? makeBox(page, toRectangle(region.box), line.text)
    box.text = line.text
    box.originalBox = toRectangle(line.box)
    if (!region.existing) {
      box.fill = false
      box.cleanup = true
      page.boxes.push(box)
    }
  }
  page.unplaced = unplaced
  return placed.length
}

function readTranslationSettings() {
  return {
    model: byId("gemini-model").value,
    source: byId("source-language").value,
    target: byId("target-language").value,
    notes: byId("translation-notes").value.trim(),
    direction: byId("direction").value,
    glossary: byId("translation-glossary").value.trim(),
  }
}

async function processWithGemini(pages, read, action, kind = "translate") {
  const key = byId("gemini-key").value.trim()
  if (projectBusy() || !pages.length) return
  if (!key) return status("Hãy nhập khóa API Gemini.", true)
  const settings = { ...readTranslationSettings(), key }
  const signature = translationSignature(settings)
  const previousPage = state.pages[state.pages.indexOf(pages[0]) - 1]
  let context = previousPage?.translationContext?.signature === signature ? previousPage.translationContext.lines : []
  let completed = 0
  let placed = 0
  let skipped = 0
  checkpoint()
  translationController = new AbortController()
  state.translating = true
  for (const page of pages) page.translationJob = { kind, signature, state: "pending" }
  renderPages()
  renderInspector()
  let activePage
  try {
    for (const page of pages) {
      activePage = page
      page.translationJob = { kind, signature, state: "running" }
      renderPages()
      const report = (message) => status(page.name + " · " + message)
      const lines = await read(page, { ...settings, context, report, signal: translationController.signal })
      translationController.signal.throwIfAborted()
      if (lines.length) {
        placed += applyTranslation(page, lines)
        skipped += page.unplaced.length
        context = [...context, ...lines.filter(({ source }) => source).map(({ source, text }) => ({
          source: source.slice(0, 240), text: text.slice(0, 240),
        }))].slice(-8)
      } else {
        page.unplaced = []
      }
      page.translationContext = { signature, lines: context }
      page.translationJob = { kind, signature, state: "done" }
      completed++
      if (selectedPage() === page) {
        renderCanvas()
        renderInspector()
      }
    }
    status(`Đã ${action} ${completed}/${pages.length} trang. ${placed} câu đã đặt và ${skipped} câu chờ đặt.`)
  } catch (error) {
    const stopped = translationController.signal.aborted
    if (activePage) activePage.translationJob = {
      kind, signature, state: stopped ? "pending" : "error", error: stopped ? undefined : error.message,
    }
    status(stopped ? `Đã dừng sau ${completed} trang. Có thể tiếp tục dịch chương.` :
      `Đã ${action} ${completed}/${pages.length} trang. ${error.message}`, !stopped)
  } finally {
    state.translating = false
    translationController = null
    render()
  }
}
byId("translate").onclick = () => processWithGemini([selectedPage()].filter(Boolean), translateImage, "dịch")
byId("translate-all").onclick = () => processWithGemini([...state.pages], translateImage, "dịch")
byId("resume-translation").onclick = () => processWithGemini(remainingTranslations(state.pages, readTranslationSettings()), translateImage, "dịch")
byId("stop-translation").onclick = () => translationController?.abort()
byId("align-script").onclick = () => {
  const page = selectedPage()
  if (!page) return
  const lines = groupDialogue(byId("script-text").value)
    .filter(({ reference }) => pageForScript(reference, page) === page)
    .flatMap(({ lines }) => lines)
  if (!lines.length) return status("Hãy nhập kịch bản cho trang này.", true)
  processWithGemini([page], (selected, settings) => alignScript(selected, settings, lines), "ghép", "align")
}

function extensionFor(format) {
  return format === "png" ? "png" : "psd"
}

async function performExport(action) {
  if (state.exporting || state.openingProject) return
  state.exporting = true
  renderPages()
  try {
    await action()
    status("Đã tạo tệp xuất.")
  } catch (error) {
    status("Xuất thất bại. " + error.message, true)
  } finally {
    state.exporting = false
    renderPages()
  }
}

const preflightDialog = byId("preflight-dialog")
let pendingExport
function exportIssues(pages) {
  const issues = []
  if (state.queue.length) issues.push({ text: `${state.queue.length} câu chưa đặt trong chương.` })
  for (const page of pages) {
    const prefix = page.name + " · "
    if (page.unplaced.length) issues.push({ page, text: prefix + `${page.unplaced.length} câu chưa đặt.` })
    if (page.translationJob?.state === "error") issues.push({ page, text: prefix + "Lỗi dịch. " + page.translationJob.error })
    if (page.translationJob?.state === "pending") issues.push({ page, text: prefix + "Chưa xử lý xong lượt dịch." })
    if (page.translationJob?.state === "done" && page.translationJob.signature !== translationSignature(readTranslationSettings())) {
      issues.push({ page, text: prefix + "Thiết lập dịch đã đổi sau lần xử lý gần nhất." })
    }
    for (const box of page.boxes) {
      if (textOverflows(page, box)) issues.push({ page, box, text: prefix + "Chữ tràn khung · " + box.text.slice(0, 70) })
    }
  }
  return issues
}

function showPreflight(issues, action) {
  pendingExport = action
  byId("continue-export").hidden = !action
  byId("preflight-summary").textContent = issues.length ? `Có ${issues.length} mục cần kiểm tra.` : "Các trang đã sẵn sàng để xuất."
  byId("preflight-issues").replaceChildren(...issues.map((issue) => {
    const li = document.createElement("li")
    li.append(listButton(issue.text, () => {
      preflightDialog.close()
      location.hash = "editor"
      if (issue.page) selectPage(issue.page)
      if (issue.box) selectBox(issue.box)
      if (!issue.page) byId("queue-section").scrollIntoView({ block: "nearest" })
      status(issue.text)
    }))
    return li
  }))
  preflightDialog.showModal()
}

function requestExport(pages, action) {
  if (projectBusy()) return
  const issues = exportIssues(pages)
  if (issues.length) showPreflight(issues, action)
  else action()
}
byId("check-export").onclick = () => showPreflight(exportIssues(state.pages))
byId("close-preflight").onclick = () => preflightDialog.close()
byId("continue-export").onclick = () => {
  const action = pendingExport
  preflightDialog.close()
  action?.()
}
preflightDialog.addEventListener("close", () => { pendingExport = null })

for (const button of exportButtons) {
  button.onclick = () => {
    const page = selectedPage()
    const format = button.dataset.export
    if (!page) return
    requestExport([page], () => performExport(async () => {
      status("Đang xuất trang…")
      const snapshot = copyEditor({ pages: [page] }).pages[0]
      saveFile(await exportPage(snapshot, format), filenameStem(page.name) + "." + extensionFor(format))
    }))
  }
}

const zipDialog = byId("zip-dialog")
byId("export-all").onclick = () => {
  zipDialog.returnValue = ""
  zipDialog.showModal()
}
zipDialog.addEventListener("close", () => {
  if (zipDialog.returnValue !== "export") return
  const format = byId("zip-format").value
  requestExport(state.pages, () => performExport(async () => {
    const pages = copyEditor({ pages: state.pages }).pages
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    for (const [index, page] of pages.entries()) {
      status(`Đang xuất trang ${index + 1} / ${pages.length}…`)
      const name = String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name)
      zip.file(name + "." + extensionFor(format), await exportPage(page, format))
    }
    saveFile(await zip.generateAsync({ type: "blob" }), "khung-thoai-" + format + ".zip")
  }))
})

render()
