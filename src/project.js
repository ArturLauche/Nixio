import { imageMimeType, imageTypes } from "./io.js"

export const projectExtension = ".khungthoai"
export const projectPageLimit = 50
export const projectSettingIds = ["script-text", "direction", "gemini-model", "source-language", "target-language", "translation-notes"]

const encoder = new TextEncoder()
// The header stores the UTF-8 manifest length. The original image bytes follow in page order.
const magic = encoder.encode("KHUNGTHOAI\n")
const headerSize = magic.length + 4
const manifestLimit = 16 * 1024 * 1024
const invalidProject = () => new Error("Cấu trúc tệp dự án Khung Thoại không hợp lệ.")
const isText = (value) => typeof value === "string"
const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max

function rectangle(rect) {
  const { x, y, w, h } = rect ?? {}
  if (![x, y, w, h].every(isFraction) || w === 0 || h === 0 || x + w > 1 + Number.EPSILON || y + h > 1 + Number.EPSILON) {
    throw invalidProject()
  }
  return { x, y, w, h }
}

function projectBox(box) {
  const { text, size, font, color, align, rotation, fill, cleanup = false, originalBox } = box ?? {}
  if (!isText(text) || !inRange(size, 8, 400) || !["Arial", "Georgia", "Verdana", "Times New Roman"].includes(font) ||
      !isText(color) || !/^#[\da-f]{6}$/i.test(color) || !["left", "center", "right"].includes(align) ||
      !inRange(rotation, -180, 180) || typeof fill !== "boolean" || typeof cleanup !== "boolean") {
    throw invalidProject()
  }
  return {
    ...rectangle(box), text, size, font, color, align, rotation, fill, cleanup,
    ...(originalBox && { originalBox: rectangle(originalBox) }),
  }
}

function projectLine(line) {
  const { id, text, source, box } = line ?? {}
  if (!isText(id) || !isText(text) || (source !== undefined && !isText(source)) ||
      (box !== null && (!Array.isArray(box) || box.length !== 4 ||
        !box.every((value) => Number.isInteger(value) && inRange(value, 0, 1000)) ||
        box[2] <= box[0] || box[3] <= box[1]))) {
    throw invalidProject()
  }
  return { id, text, source, box }
}

function projectContext(context) {
  if (context === undefined) return undefined
  if (!isText(context?.signature) || !Array.isArray(context.lines) || context.lines.length > 8 ||
      !context.lines.every((line) => isText(line?.source) && isText(line.text))) {
    throw invalidProject()
  }
  return { signature: context.signature, lines: context.lines.map(({ source, text }) => ({ source, text })) }
}

function projectPage(page) {
  const { name, type, size, boxes, unplaced, translationContext } = page ?? {}
  if (!isText(name) || !name || !imageTypes.has(type) || !Number.isSafeInteger(size) || size <= 0 ||
      !Array.isArray(boxes) || !Array.isArray(unplaced)) {
    throw invalidProject()
  }
  return { name, type, size, boxes: boxes.map(projectBox), unplaced: unplaced.map(projectLine), translationContext: projectContext(translationContext) }
}

function projectData({ pages, queue, settings, currentPage, fit }) {
  if (!Array.isArray(pages) || pages.length > projectPageLimit ||
      !Array.isArray(queue) || !queue.every(isText) || !projectSettingIds.every((id) => isText(settings?.[id])) ||
      !Number.isInteger(currentPage) || (pages.length ? currentPage < 0 || currentPage >= pages.length : currentPage !== -1) ||
      typeof fit !== "boolean") {
    throw invalidProject()
  }
  return { pages: pages.map(projectPage), queue, settings: Object.fromEntries(projectSettingIds.map((id) => [id, settings[id]])), currentPage, fit }
}

export function writeProject(project) {
  const pages = project.pages.map(({ file, name, boxes, unplaced, translationContext }) => ({
    name, type: imageMimeType(name, file.type), size: file.size, boxes, unplaced, translationContext,
  }))
  const manifest = encoder.encode(JSON.stringify({ version: 1, ...projectData({ ...project, pages }) }))
  if (manifest.length > manifestLimit) throw new Error("Dữ liệu biên tập của dự án vượt quá 16 MB.")
  const header = new Uint8Array(headerSize)
  header.set(magic)
  new DataView(header.buffer).setUint32(magic.length, manifest.length, true)
  return new Blob([header, manifest, ...project.pages.map(({ file }) => file)], { type: "application/octet-stream" })
}

export async function readProject(file) {
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  if (header.length !== headerSize || !magic.every((byte, index) => header[index] === byte)) throw invalidProject()
  const length = new DataView(header.buffer).getUint32(magic.length, true)
  let offset = headerSize + length
  if (!length || length > manifestLimit || offset > file.size) throw invalidProject()

  let manifest
  try {
    const bytes = await file.slice(headerSize, offset).arrayBuffer()
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw invalidProject()
  }
  if (!Number.isInteger(manifest?.version) || manifest.version < 1) throw invalidProject()
  if (manifest.version !== 1) throw new Error("Phiên bản tệp dự án này chưa được hỗ trợ.")
  const project = projectData(manifest)
  if (project.pages.reduce((total, page) => total + page.size, offset) !== file.size) throw invalidProject()
  const pages = project.pages.map(({ name, type, size, ...page }) => {
    const bytes = file.slice(offset, offset + size)
    offset += size
    return { ...page, file: new File([bytes], name, { type }) }
  })
  return { ...project, pages }
}
