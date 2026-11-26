import JSZip from "jszip"

export const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"])
const imageExtensions = /\.(png|jpe?g|webp)$/i

export function isImageFile(file) {
  return imageTypes.has(file.type) || (!file.type && imageExtensions.test(file.name))
}

function xmlDocument(source) {
  const doc = new DOMParser().parseFromString(source, "application/xml")
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Tài liệu XML không đọc được.")
  return doc
}

function named(node, name) {
  return Array.from(node.getElementsByTagNameNS("*", name))
}

function textNodes(node) {
  return named(node, "t").map((text) => text.textContent).join("")
}

async function zipXml(zip, pathname) {
  const entry = zip.file(pathname)
  if (!entry) throw new Error("Không tìm thấy dữ liệu trong tài liệu.")
  return xmlDocument(await entry.async("string"))
}

function columnIndex(cell) {
  const reference = cell.getAttribute("r")?.match(/^[A-Z]+/)?.[0]
  if (!reference) return null
  return [...reference].reduce((value, ch) => value * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

async function spreadsheetText(zip) {
  const sheets = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
  const path = sheets.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0]
  if (!path) throw new Error("Tệp XLSX không có bảng tính.")
  const worksheet = await zipXml(zip, path)
  const strings = zip.file("xl/sharedStrings.xml")
    ? named(await zipXml(zip, "xl/sharedStrings.xml"), "si").map(textNodes)
    : []
  const rows = named(worksheet, "row").map((row) => {
    const values = []
    for (const cell of named(row, "c")) {
      const value = named(cell, "v")[0]?.textContent ?? ""
      const type = cell.getAttribute("t")
      values[columnIndex(cell) ?? values.length] = (type === "s" ? strings[Number(value)] : type === "inlineStr" ? textNodes(cell) : value) ?? ""
    }
    return values
  })
  const headings = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase())
  const script = headings.findIndex((cell) => ["translation", "bản dịch", "thoại", "text"].includes(cell))
  const page = headings.findIndex((cell) => ["page", "trang", "ảnh"].includes(cell))
  if (script < 0) return rows.map((row) => row.filter(Boolean).join(" ")).filter(Boolean).join("\n")
  let previousPage = ""
  return rows.slice(1).flatMap((row) => {
    const dialogue = row[script]?.trim()
    if (!dialogue) return []
    const currentPage = (page >= 0 ? row[page]?.trim() : "") || previousPage
    const heading = currentPage && currentPage !== previousPage ? ( /^\d+$/.test(currentPage) ? "Trang " + currentPage : "[" + currentPage + "]") : ""
    previousPage = currentPage
    return heading ? [heading, dialogue] : [dialogue]
  }).join("\n")
}

export async function readDialogueFile(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error("Tệp kịch bản vượt quá 2 MB.")
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (extension === "txt") return file.text()
  if (extension !== "docx" && extension !== "xlsx") throw new Error("Chọn một tệp TXT, DOCX hoặc XLSX.")
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  if (extension === "xlsx") return spreadsheetText(zip)
  return named(await zipXml(zip, "word/document.xml"), "p").map(textNodes).filter(Boolean).join("\n")
}

export function groupDialogue(source) {
  const groups = [{ reference: null, lines: [] }]
  for (const line of source.split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean) continue
    const heading = clean.match(/^\[(.+)\]$/)?.[1] ?? clean
    const numbered = heading.match(/^(?:trang|page)\s+(\d+)\s*:?$/i)
    if (numbered || imageExtensions.test(heading)) {
      groups.push({ reference: numbered ? Number(numbered[1]) - 1 : heading.toLowerCase(), lines: [] })
    } else {
      groups.at(-1).lines.push(clean)
    }
  }
  return groups.filter(({ lines }) => lines.length)
}

export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function filenameStem(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 120) || "trang"
}

export function normalizedSearch(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replaceAll("đ", "d").trim()
}
