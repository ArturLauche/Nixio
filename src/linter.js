import { normalizedSearch } from "./io.js"

const SOURCE_SCRIPT_PATTERNS = {
  Japanese: /[\u3040-\u30ff\u4e00-\u9faf]/,
  Korean: /[\uac00-\ud7af\u1100-\u11ff]/,
  Chinese: /[\u4e00-\u9faf]/,
}

const PLACEHOLDER_PATTERN = /^(?:thoại\s+\d+|khung\s+thoại|text\s*\d*)$/i

export function parseGlossary(glossaryText) {
  const entries = []
  const seen = new Set()
  for (const rawLine of String(glossaryText || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith("//")) continue
    const sep = line.includes("=") ? "=" : line.includes("->") ? "->" : line.includes(":") ? ":" : null
    if (!sep) continue
    const idx = line.indexOf(sep)
    const source = line.slice(0, idx).trim()
    const target = line.slice(idx + sep.length).trim()
    if (!source || !target) continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ source, target })
  }
  return entries
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function clipText(text, max = 44) {
  const clean = String(text || "").replace(/\s+/g, " ").trim()
  return clean.length > max ? clean.slice(0, max) + "…" : clean
}

export function autoFixPunctuation(text) {
  return String(text || "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\.{4,}/g, "...")
    .replace(/(^|\n)[ \t]+|[ \t]+(?=\n|$)/g, "$1")
    .trim()
}

export function lintChapter(
  pages = [],
  { glossaryText = "", sourceLanguage = "Japanese", targetLanguage = "Vietnamese", maxIssues = 80 } = {},
) {
  const glossary = parseGlossary(glossaryText)
  const checkSourceScript = targetLanguage !== sourceLanguage ? SOURCE_SCRIPT_PATTERNS[sourceLanguage] : null
  const issues = []
  const byType = {
    untranslated_source: 0,
    glossary_violation: 0,
    empty_or_placeholder: 0,
    punctuation_spacing: 0,
  }

  const pushIssue = (issue) => {
    byType[issue.type] = (byType[issue.type] ?? 0) + 1
    if (issues.length < maxIssues) issues.push(issue)
  }

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]
    const pageIndex = p + 1
    for (const box of page.boxes ?? []) {
      const raw = String(box.text ?? "")
      const trimmed = raw.trim()

      if (!trimmed || PLACEHOLDER_PATTERN.test(trimmed)) {
        pushIssue({
          type: "empty_or_placeholder",
          severity: "warning",
          pageIndex,
          pageName: page.name,
          boxId: box.id,
          snippet: clipText(trimmed || "(trống)"),
          message: !trimmed ? "Khung thoại bị trống nội dung." : `Khung còn nội dung mẫu "${clipText(trimmed)}".`,
        })
        continue
      }

      if (checkSourceScript && checkSourceScript.test(trimmed)) {
        pushIssue({
          type: "untranslated_source",
          severity: "warning",
          pageIndex,
          pageName: page.name,
          boxId: box.id,
          snippet: clipText(trimmed),
          message: `Còn sót ký tự gốc (${sourceLanguage}) chưa dịch trong "${clipText(trimmed)}".`,
        })
      }

      const normText = normalizedSearch(trimmed)
      for (const entry of glossary) {
        if (entry.source.length >= 2 && entry.source.toLowerCase() !== entry.target.toLowerCase()) {
          const isAscii = /^[a-z0-9 _-]+$/i.test(entry.source)
          const sourceMatched = isAscii
            ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(entry.source)}(?![\\p{L}\\p{N}_])`, "iu").test(trimmed)
            : trimmed.includes(entry.source)
          if (sourceMatched && !trimmed.includes(entry.target)) {
            pushIssue({
              type: "glossary_violation",
              severity: "warning",
              pageIndex,
              pageName: page.name,
              boxId: box.id,
              snippet: clipText(trimmed),
              message: `Thuật ngữ "${entry.source}" chưa đổi sang "${entry.target}".`,
              suggestion: entry.target,
            })
            break
          }
        }
        // Check stripped-diacritic / casing drift for proper nouns (target >= 3 chars, starts uppercase).
        if (entry.target.length >= 3 && /^[\p{Lu}]/u.test(entry.target)) {
          const normTarget = normalizedSearch(entry.target)
          if (normTarget.length >= 3) {
            const normRe = new RegExp(`(?<![a-z0-9_])${escapeRegExp(normTarget)}(?![a-z0-9_])`, "i")
            if (normRe.test(normText) && !trimmed.includes(entry.target)) {
              pushIssue({
                type: "glossary_violation",
                severity: "warning",
                pageIndex,
                pageName: page.name,
                boxId: box.id,
                snippet: clipText(trimmed),
                message: `Tên/thuật ngữ lệch chuẩn chữ hoa hoặc dấu so với "${entry.target}".`,
                suggestion: entry.target,
              })
              break
            }
          }
        }
      }

      if (/[ \t]{2,}|[ \t]+[,.;:!?]|\.{4,}/.test(trimmed)) {
        pushIssue({
          type: "punctuation_spacing",
          severity: "info",
          pageIndex,
          pageName: page.name,
          boxId: box.id,
          snippet: clipText(trimmed),
          message: `Lỗi khoảng trắng hoặc dấu câu thừa trong "${clipText(trimmed)}".`,
          suggestion: autoFixPunctuation(trimmed),
        })
      }
    }
  }

  const total = Object.values(byType).reduce((sum, n) => sum + n, 0)
  return { total, byType, issues }
}
