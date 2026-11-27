// Per-project translation style guide (Nixio #68). The guide is a small structured
// record stored in the .khungthoai manifest, compiled into a bounded deterministic
// prompt block for every translation request, and checked by a zero-token linter
// that reports violations with page/box coordinates.

export const styleGuideFieldIds = ["register", "pronouns", "quotes", "casing", "sfx", "notes"]

const TEXT_LIMITS = { pronouns: 400, notes: 1200 }
const PROMPT_TEXT_LIMITS = { pronouns: 240, notes: 500 }

const invalidGuide = () => new Error("Hướng dẫn phong cách của dự án không hợp lệ.")

export const styleGuideFields = [
  {
    id: "register",
    label: "Giọng điệu / văn phong",
    promptLabel: "Giọng điệu",
    kind: "select",
    options: [
      { value: "natural", label: "Tự nhiên, đời thường", prompt: "Giọng điệu tự nhiên như hội thoại đời thường; câu ngắn, tránh văn phong sách vở." },
      { value: "formal", label: "Trang trọng, kính cẩn", prompt: "Giọng điệu trang trọng, kính cẩn; dùng từ Hán-Việt và danh xưng lịch sự." },
      { value: "casual", label: "Thân mật, suồng sã", prompt: "Giọng điệu thân mật, suồng sã; tự do dùng tiểu từ cảm xúc." },
      { value: "dramatic", label: "Kịch tính, nhấn cảm xúc", prompt: "Giọng điệu kịch tính, nhấn mạnh cảm xúc và nhịp câu." },
    ],
  },
  {
    id: "pronouns",
    label: "Xưng hô & đại từ",
    promptLabel: "Xưng hô và đại từ",
    kind: "text",
    maxLength: TEXT_LIMITS.pronouns,
    placeholder: "VD: nhân vật chính xưng tớ/cậu, phản diện dùng ngươi/ta…",
  },
  {
    id: "quotes",
    label: "Dấu ngoặc kép",
    promptLabel: "Dấu ngoặc kép",
    kind: "select",
    options: [
      { value: "curly", label: "Ngoặc cong “…”", prompt: "Dùng dấu ngoặc kép cong “…” cho lời thoại; không dùng ngoặc kép thẳng." },
      { value: "straight", label: "Ngoặc thẳng \"…\"", prompt: "Dùng dấu ngoặc kép thẳng \"…\" cho lời thoại." },
      { value: "corner", label: "Ngoặc góc 「…」", prompt: "Dùng dấu ngoặc góc 「…」 cho lời thoại." },
      { value: "guillemet", label: "Ngoặc «…»", prompt: "Dùng dấu ngoặc «…» cho lời thoại." },
    ],
  },
  {
    id: "casing",
    label: "Cách viết hoa",
    promptLabel: "Cách viết hoa",
    kind: "select",
    options: [
      { value: "sentence", label: "Chỉ viết hoa chữ đầu câu", prompt: "Chỉ viết hoa chữ cái đầu mỗi câu; không viết hoa toàn bộ từ." },
      { value: "title", label: "Viết hoa đầu mỗi từ", prompt: "Viết hoa chữ cái đầu mỗi từ." },
    ],
  },
  {
    id: "sfx",
    label: "Âm thanh / SFX",
    promptLabel: "Âm thanh / SFX",
    kind: "select",
    options: [
      { value: "keep", label: "Giữ nguyên tượng thanh", prompt: "Giữ nguyên âm thanh tượng thanh (SFX) trong bản dịch." },
      { value: "translate", label: "Dịch tượng thanh sang tiếng Việt", prompt: "Luôn dịch âm thanh tượng thanh (SFX) sang tượng thanh tiếng Việt tự nhiên; không giữ chữ tượng thanh gốc." },
      { value: "drop", label: "Lược bỏ âm thanh/SFX", prompt: "Lược bỏ âm thanh tượng thanh (SFX); không đưa âm thanh vào bản dịch." },
    ],
  },
  {
    id: "notes",
    label: "Ghi chú thêm",
    promptLabel: "Ghi chú",
    kind: "text",
    maxLength: TEXT_LIMITS.notes,
    rows: 3,
    placeholder: "Quy tắc riêng khác của dự án…",
  },
]

const fieldById = new Map(styleGuideFields.map((field) => [field.id, field]))
const optionByValue = new Map(styleGuideFields.map((field) => [
  field.id,
  new Map((field.options ?? []).map((option) => [option.value, option])),
]))

function clip(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim()
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean
}

// Canonical form: only known fields, only allowed option values, text clipped to
// its bound. `strict` rejects malformed input instead of dropping it, which the
// project-file reader uses so a corrupt guide fails the file like any other field.
export function normalizeStyleGuide(input, { strict = false } = {}) {
  if (input === undefined || input === null) return null
  let raw = input
  if (typeof raw === "string") {
    const text = raw.trim()
    if (!text) return null
    try {
      raw = JSON.parse(text)
    } catch {
      if (strict) throw invalidGuide()
      return null
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw invalidGuide()
    return null
  }
  const guide = {}
  for (const field of styleGuideFields) {
    const value = raw[field.id]
    if (value === undefined || value === null) continue
    if (field.kind === "select") {
      if (value === "") continue
      const option = optionByValue.get(field.id)?.get(value)
      if (!option) {
        if (strict) throw invalidGuide()
        continue
      }
      guide[field.id] = option.value
      continue
    }
    if (typeof value !== "string") {
      if (strict) throw invalidGuide()
      continue
    }
    const text = clip(value, field.maxLength)
    if (text) guide[field.id] = text
  }
  return Object.keys(guide).length ? guide : null
}

// Bounded, deterministic prompt block: fixed field order, fixed wording, absent
// fields contribute nothing, so two equal guides always compile to the same text.
export function styleGuidePrompt(input) {
  const guide = normalizeStyleGuide(input)
  if (!guide) return ""
  const lines = ["Quy tắc phong cách dịch của dự án (bắt buộc tuân thủ):"]
  for (const field of styleGuideFields) {
    const value = guide[field.id]
    if (!value) continue
    if (field.kind === "select") {
      lines.push(`- ${field.promptLabel}: ${optionByValue.get(field.id).get(value).prompt}`)
    } else {
      lines.push(`- ${field.promptLabel}: ${clip(value, PROMPT_TEXT_LIMITS[field.id] ?? 240)}`)
    }
  }
  return lines.join("\n")
}

const QUOTE_STYLES = {
  curly: { label: "ngoặc cong “…”", allowed: new Set(["“", "”", "‘", "’"]) },
  straight: { label: "ngoặc thẳng \"…\"", allowed: new Set(["\"", "'"]) },
  corner: { label: "ngoặc góc 「…」", allowed: new Set(["「", "」", "『", "』"]) },
  guillemet: { label: "ngoặc «…»", allowed: new Set(["«", "»"]) },
}
const ALL_QUOTE_CHARS = new Set(["“", "”", "‘", "’", "\"", "'", "「", "」", "『", "』", "«", "»"])

const WORD_TOKEN = /[\p{L}\p{M}\p{N}]+/gu
const HAS_LOWER = /\p{Ll}/u
const HAS_UPPER = /\p{Lu}/u

function quoteViolations(text, style) {
  const allowed = QUOTE_STYLES[style]?.allowed
  if (!allowed) return null
  const offenders = [...new Set([...text].filter((char) => ALL_QUOTE_CHARS.has(char) && !allowed.has(char)))]
  return offenders.length ? offenders : null
}

function casingWords(text, style) {
  const words = text.match(WORD_TOKEN) ?? []
  if (style === "sentence") {
    return words.filter((word) =>
      word.length >= 3 && HAS_UPPER.test(word) && !HAS_LOWER.test(word) && /\p{L}/u.test(word))
  }
  if (style === "title") {
    return words.filter((word) => /^\p{Ll}/u.test(word))
  }
  return []
}

// A probable sound effect is a short unspaced token: all-caps shout ("RẦM!"),
// doubled terminal punctuation ("BÙM!!"), or a repeated mark ("ザー").
function looksLikeSfx(text) {
  const value = String(text ?? "").trim()
  if (!value || /\s/.test(value) || value.length > 24 || !/\p{L}/u.test(value)) return false
  return !HAS_LOWER.test(value) || /[!！?？]{2,}|[〜~]{2,}/.test(value)
}

export function lintStyleGuide(pages = [], input, { maxIssues = 80 } = {}) {
  const guide = normalizeStyleGuide(input)
  const issues = []
  const byType = { quote_style: 0, casing: 0, sfx: 0 }
  if (!guide) return { total: 0, byType, issues }

  const pushIssue = (issue) => {
    byType[issue.type] = (byType[issue.type] ?? 0) + 1
    if (issues.length < maxIssues) issues.push(issue)
  }

  const quoteStyle = guide.quotes ? QUOTE_STYLES[guide.quotes] : null
  const sfxPolicy = guide.sfx && guide.sfx !== "keep" ? guide.sfx : null

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p]
    const pageIndex = p + 1
    for (const box of page.boxes ?? []) {
      const trimmed = String(box.text ?? "").trim()
      if (!trimmed) continue
      const base = { pageIndex, pageName: page.name, boxId: box.id, snippet: clip(trimmed) }

      if (quoteStyle) {
        const offenders = quoteViolations(trimmed, guide.quotes)
        if (offenders) {
          pushIssue({
            type: "quote_style",
            severity: "warning",
            ...base,
            message: `Dấu ngoặc ${offenders.join(" ")} không theo quy tắc ${quoteStyle.label} của dự án.`,
          })
        }
      }

      if (guide.casing) {
        const words = casingWords(trimmed, guide.casing)
        if (words.length) {
          const shown = words.slice(0, 3).map((word) => `"${clip(word, 20)}"`).join(", ")
          pushIssue({
            type: "casing",
            severity: "warning",
            ...base,
            message: guide.casing === "sentence"
              ? `Từ viết hoa toàn bộ ${shown} trái quy tắc chỉ viết hoa chữ đầu câu của dự án.`
              : `${words.length} từ chưa viết hoa đầu chữ theo quy tắc viết hoa của dự án (${shown}${words.length > 3 ? ", …" : ""}).`,
          })
        }
      }

      if (sfxPolicy && looksLikeSfx(trimmed)) {
        pushIssue({
          type: "sfx",
          severity: "warning",
          ...base,
          message: sfxPolicy === "translate"
            ? `Âm thanh/SFX "${clip(trimmed)}" cần được dịch sang tiếng Việt theo quy tắc của dự án.`
            : `Âm thanh/SFX "${clip(trimmed)}" cần lược bỏ theo quy tắc của dự án.`,
        })
      }
    }
  }

  const total = Object.values(byType).reduce((sum, n) => sum + n, 0)
  return { total, byType, issues }
}
