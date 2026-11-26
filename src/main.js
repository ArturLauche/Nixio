import { clamp, drawPage, exportPage, makeBox } from "./canvas.js"
import { filenameStem, groupDialogue, isImageFile, readDialogueFile, saveFile } from "./io.js"
import { alignScript, translateImage } from "./gemini.js"
import { setupLibrary } from "./library.js"
import { matchDialogue, toCoordinates, toRectangle } from "./placement.js"

const byId = (id) => document.getElementById(id)
const stage = byId("stage")
const overlays = byId("overlays")
const pageCanvas = byId("page-canvas")
const form = byId("box-form")
const editorStatus = byId("status")
const pageLimit = 50
const exportButtons = [...document.querySelectorAll("[data-export]")]
const state = { pages: [], pageId: null, boxId: null, queue: [], placing: false, fit: true, exporting: false, importing: false, translating: false }
let gesture
let pendingPaint
let previewRedraw

const selectedPage = () => state.pages.find((page) => page.id === state.pageId)
const selectedBox = () => selectedPage()?.boxes.find((box) => box.id === state.boxId)
const selectedIndex = () => state.pages.findIndex((page) => page.id === state.pageId)
const boxFields = { text: "box-text", size: "box-size", font: "box-font", color: "box-color", align: "box-align", rotation: "box-rotation" }

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
  const target = index + delta
  if (target < 0 || target >= state.pages.length) return
  const [page] = state.pages.splice(index, 1)
  state.pages.splice(target, 0, page)
  renderPages()
  document.getElementById("move-" + page.id + "-" + delta)?.focus()
}

function removePage(index) {
  const [page] = state.pages.splice(index, 1)
  if (!page) return
  URL.revokeObjectURL(page.url)
  if (page.id === state.pageId) selectPage(state.pages[Math.min(index, state.pages.length - 1)])
  else renderPages()
  status("Đã bỏ " + page.name + ".")
}

function renderPages() {
  const current = selectedIndex()
  const count = state.pages.length
  byId("page-count").textContent = count + " / " + pageLimit
  byId("page-indicator").textContent = current === -1 ? "Chưa có trang" : `Trang ${current + 1} / ${count}`
  byId("prev-page").disabled = current <= 0
  byId("next-page").disabled = current < 0 || current >= count - 1
  byId("apply-script").disabled = current < 0
  byId("translate").disabled = current < 0 || state.translating
  byId("align-script").disabled = current < 0 || state.translating
  byId("translate-all").disabled = !count || state.translating
  byId("fit-page").disabled = current < 0
  byId("add-box").disabled = current < 0
  byId("export-all").disabled = !count || state.exporting
  exportButtons.forEach((button) => { button.disabled = current < 0 || state.exporting })
  byId("pages").replaceChildren(...state.pages.map((page, index) => {
    const li = document.createElement("li")
    const button = listButton(`${index + 1}. ${page.name}`, () => selectPage(page))
    button.className = "page-name"
    if (current === index) button.setAttribute("aria-current", "true")
    const up = listButton("↑", () => movePage(index, -1), "Đưa lên " + page.name)
    up.disabled = index === 0
    up.id = "move-" + page.id + "--1"
    const down = listButton("↓", () => movePage(index, 1), "Đưa xuống " + page.name)
    down.disabled = index === count - 1
    down.id = "move-" + page.id + "-1"
    li.append(button, up, down, listButton("×", () => removePage(index), "Bỏ " + page.name))
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
  const pending = drawPage(pageCanvas, page)
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
}

function selectBox(box) {
  state.boxId = box.id
  renderCanvas()
  renderInspector()
}

function renderInspector() {
  const page = selectedPage()
  const box = selectedBox()
  const boxes = page?.boxes ?? []
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
      if (!selectedPage()) return
      line.remove()
      addBox({ x: .32, y: .4, w: .36, h: .16 }, line.text)
    })
    button.disabled = !page
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
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    if (image.naturalWidth * image.naturalHeight > 28000000) throw new Error("Ảnh vượt giới hạn kích thước.")
    return { id: crypto.randomUUID(), name: file.name, file, image, url, boxes: [], unplaced: [] }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

async function importPages(files) {
  if (state.importing) return []
  state.importing = true
  byId("images").disabled = true
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
    byId("images").disabled = false
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
byId("fit-page").onclick = () => {
  state.fit = !state.fit
  byId("fit-page").textContent = state.fit ? "Vừa trang" : "Kích thước gốc"
  renderCanvas()
}
byId("script-file").onchange = async (event) => {
  const file = event.target.files[0]
  if (!file) return
  try {
    byId("script-text").value = await readDialogueFile(file)
    status("Đã đọc " + file.name + ".")
  } catch (error) {
    status("Không nhập được kịch bản. " + error.message, true)
  } finally {
    event.target.value = ""
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
  if (!current || !groups.length) return status("Hãy thêm ảnh và nhập lời thoại.", true)
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

function addBox(rectangle, line) {
  const page = selectedPage()
  if (!page) return
  const box = makeBox(page, rectangle, line)
  page.boxes.push(box)
  state.boxId = box.id
  state.placing = false
  renderCanvas()
  renderInspector()
  status("Đã thêm khung chữ.")
}

byId("add-box").onclick = () => {
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
  if (event.button !== 0) return
  const origin = point(event)
  const box = selectedPage()?.boxes.find((item) => item.id === event.target.dataset.box)
  if (!box && !state.placing) return
  event.preventDefault()
  stage.setPointerCapture(event.pointerId)
  if (box) {
    selectBox(box)
    gesture = { pointer: event.pointerId, box, origin, start: { x: box.x, y: box.y } }
    return
  }
  const draft = document.createElement("div")
  draft.className = "outline draft"
  overlays.append(draft)
  gesture = { pointer: event.pointerId, origin, draft }
})

stage.addEventListener("pointermove", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  const cursor = point(event)
  if (gesture.box) {
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
  if (completed.draft) addBox(placement(completed.origin, point(event)))
})
stage.addEventListener("pointercancel", (event) => {
  if (gesture?.pointer !== event.pointerId) return
  if (gesture.box) Object.assign(gesture.box, gesture.start)
  gesture = undefined
  renderCanvas()
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
  const text = byId("box-text").value.trim()
  if (!text) return status("Hãy nhập nội dung khung.", true)
  for (const [key, id] of Object.entries(boxFields)) box[key] = byId(id).value
  box.text = text
  box.size = Number(box.size)
  box.rotation = Number(box.rotation)
  box.fill = byId("box-fill").checked
  box.cleanup = byId("box-cleanup").checked
  renderCanvas()
  renderInspector()
  status("Đã lưu khung.")
}

byId("delete-box").onclick = () => {
  const page = selectedPage()
  if (!page || !state.boxId) return
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

async function processWithGemini(pages, read, action) {
  const key = byId("gemini-key").value.trim()
  if (state.translating || !pages.length) return
  if (!key) return status("Hãy nhập khóa API Gemini.", true)
  const settings = {
    key,
    model: byId("gemini-model").value,
    source: byId("source-language").value,
    target: byId("target-language").value,
    notes: byId("translation-notes").value.trim(),
    direction: byId("direction").value,
  }
  const signature = JSON.stringify([settings.source, settings.target, settings.notes, settings.direction])
  const previousPage = state.pages[state.pages.indexOf(pages[0]) - 1]
  let context = previousPage?.translationContext?.signature === signature ? previousPage.translationContext.lines : []
  let completed = 0
  let placed = 0
  let skipped = 0
  state.translating = true
  renderPages()
  try {
    for (const page of pages) {
      if (!state.pages.includes(page)) continue
      const report = (message) => status(page.name + " · " + message)
      const lines = await read(page, { ...settings, context, report })
      if (!state.pages.includes(page)) continue
      if (lines.length) {
        placed += applyTranslation(page, lines)
        skipped += page.unplaced.length
        context = [...context, ...lines.filter(({ source }) => source).map(({ source, text }) => ({
          source: source.slice(0, 240), text: text.slice(0, 240),
        }))].slice(-8)
      }
      page.translationContext = { signature, lines: context }
      completed++
      if (selectedPage() === page) {
        renderCanvas()
        renderInspector()
      }
    }
    status(`Đã ${action} ${completed}/${pages.length} trang. ${placed} câu đã đặt và ${skipped} câu chờ đặt.`)
  } catch (error) {
    status(`Đã ${action} ${completed}/${pages.length} trang. ${error.message}`, true)
  } finally {
    state.translating = false
    renderPages()
  }
}
byId("translate").onclick = () => processWithGemini([selectedPage()].filter(Boolean), translateImage, "dịch")
byId("translate-all").onclick = () => processWithGemini([...state.pages], translateImage, "dịch")
byId("align-script").onclick = () => {
  const page = selectedPage()
  if (!page) return
  const lines = groupDialogue(byId("script-text").value)
    .filter(({ reference }) => pageForScript(reference, page) === page)
    .flatMap(({ lines }) => lines)
  if (!lines.length) return status("Hãy nhập kịch bản cho trang này.", true)
  processWithGemini([page], (selected, settings) => alignScript(selected, settings, lines), "ghép")
}

function extensionFor(format) {
  return format === "png" ? "png" : "psd"
}

async function performExport(action) {
  if (state.exporting) return
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

for (const button of exportButtons) {
  button.onclick = () => {
    const page = selectedPage()
    const format = button.dataset.export
    if (!page) return
    performExport(async () => {
      status("Đang xuất trang…")
      saveFile(await exportPage(page, format), filenameStem(page.name) + "." + extensionFor(format))
    })
  }
}

const zipDialog = byId("zip-dialog")
byId("export-all").onclick = () => {
  zipDialog.returnValue = ""
  zipDialog.showModal()
}
zipDialog.addEventListener("close", () => {
  if (zipDialog.returnValue !== "export") return
  const pages = state.pages.map((page) => ({ ...page, boxes: page.boxes.map((box) => ({ ...box })) }))
  const format = byId("zip-format").value
  performExport(async () => {
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    for (const [index, page] of pages.entries()) {
      status(`Đang xuất trang ${index + 1} / ${pages.length}…`)
      const name = String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name)
      zip.file(name + "." + extensionFor(format), await exportPage(page, format))
    }
    saveFile(await zip.generateAsync({ type: "blob" }), "khung-thoai-" + format + ".zip")
  })
})

render()
