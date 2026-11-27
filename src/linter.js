import { normalizedSearch } from "./io.js"
import { parseTerminologyGraph, termRenderings } from "./terminology-graph.js"

// Each range list holds the canonical block plus the compatibility and half-width forms
// that OCR and copy-paste keep verbatim, so half-width katakana (ｱﾘｶﾞﾄｳ) and
// compatibility/extended jamo (ㅋㅋㅋ) count as untranslated source text.
const SOURCE_SCRIPT_PATTERNS = {
  Japanese: /[\u3040-\u30ff\u4e00-\u9faf\uff66-\uff9f]/,
  Korean: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\ua960-\ua97f\ud7b0-\ud7ff\uffa0-\uffdc]/,
  Chinese: /[\u4e00-\u9faf]/,
}

const PLACEHOLDER_PATTERN = /^(?:thoại\s+\d+|khung\s+thoại|text\s*\d*)$/i

// English has no exclusive script, so a leftover English line is recognised from its
// word profile instead of from code points. The two lists are deliberately one-sided:
// Vietnamese words can only suppress a report and English words can only raise one, so
// a word that exists in both languages costs recall and can never invent a violation.
const VIETNAMESE_PROBES = new Set([
  "anh", "ay", "ban", "biet", "buon", "cac", "cho", "chung", "cua", "cung", "dau", "day",
  "deu", "duoc", "em", "gi", "ghet", "het", "hieu", "khong", "kia", "lam", "minh", "mot",
  "muon", "nay", "nguoi", "nha", "nhe", "nghi", "nhu", "nhung", "noi", "nua", "ong", "phai",
  "roi", "sao", "sau", "thanh", "thay", "thi", "thoi", "tinh", "toi", "tro", "truoc", "va",
  "vui", "voi", "yeu",
])

const ENGLISH_PROBES = new Set([
  "the", "this", "that", "these", "those", "you", "your", "yours", "we", "our", "ours",
  "they", "them", "their", "theirs", "she", "her", "hers", "his", "who", "whom", "whose",
  "which", "what", "when", "where", "why", "how", "my", "mine", "someone", "somebody",
  "something", "everyone", "everybody", "everything", "anyone", "anybody", "anything",
  "nobody", "nothing", "myself", "yourself", "himself", "herself", "itself", "ourselves",
  "themselves", "is", "are", "was", "were", "be", "been", "being", "does", "did", "have",
  "has", "had", "will", "would", "shall", "should", "could", "might", "must", "cannot",
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't",
  "can't", "couldn't", "shouldn't", "it's", "that's", "what's", "let's", "i'm", "you're",
  "we're", "they're", "i've", "you've", "we've", "they've", "i'll", "you'll", "we'll",
  "they'll", "and", "or", "but", "because", "if", "then", "than", "of", "for", "from",
  "with", "without", "into", "onto", "about", "over", "under", "between", "through",
  "during", "before", "after", "again", "still", "just", "very", "really", "only", "also",
  "too", "much", "many", "more", "most", "some", "any", "all", "not", "yes", "yeah", "nope",
  "please", "thanks", "thank", "sorry", "hello", "goodbye", "hey", "welcome", "here",
  "there", "now", "never", "always", "sometimes", "maybe", "perhaps", "almost", "already",
  "good", "morning", "night", "today", "tomorrow", "yesterday", "wait", "stop", "help",
  "come", "look", "listen", "people", "boy", "girl", "man", "woman", "time", "god", "damn",
  "hell", "idiot", "stupid", "okay", "friend", "friends", "love", "hate", "kill", "die",
  "dead", "fight", "strong", "stronger", "strongest", "world", "life",
])

// Any accented Latin letter means the line was localised, and any non-Latin letter means
// it was translated into a script the source never uses. Either way it is not raw English.
const LATIN_ACCENT = /[\u00c0-\u024f\u1e00-\u1eff]/
const NON_LATIN_LETTER = /(?![\p{Script=Latin}])[\p{L}]/u
const WORD_TOKEN = /[\p{L}\p{M}\p{N}]+(?:['\u2019][\p{L}\p{M}\p{N}]+)*/gu
const ASCII_WORD = /^[A-Za-z][A-Za-z'\u2019]*$/

function normalizedTokens(text) {
  return (text.match(WORD_TOKEN) ?? []).map((token) => normalizedSearch(token.replace(/\u2019/g, "'")))
}

// A leftover English line is reported only when two independent English markers appear as
// whole words, or when the box still carries its own source text and the text was not
// rewritten at all. Names, loan words, short noises and single words never qualify.
function detectUntranslatedEnglish(text, sourceText = "") {
  const value = String(text ?? "").normalize("NFC").trim()
  if (!value || LATIN_ACCENT.test(value) || NON_LATIN_LETTER.test(value)) return false
  const words = (value.match(WORD_TOKEN) ?? []).filter((token) => ASCII_WORD.test(token))
  if (words.length < 2 || value.replace(/[^A-Za-z]/g, "").length < 6) return false
  const tokens = normalizedTokens(value)
  if (tokens.some((token) => VIETNAMESE_PROBES.has(token))) return false
  const markers = new Set(tokens.filter((token) => ENGLISH_PROBES.has(token)))
  const source = typeof sourceText === "string" ? sourceText.trim() : ""
  if (source && normalizedSearch(source) === normalizedSearch(value)) {
    // Keeping a whole Title Case line verbatim is how a proper-noun or term line is
    // legitimately carried over, so identity alone only counts for running text.
    const titleCaseOnly = words.every((word) => /^\p{Lu}/u.test(word))
    if (!titleCaseOnly || markers.size > 0) return true
  }
  return markers.size >= 2
}

function createSourceLeakCheck(sourceLanguage, targetLanguage) {
  if (!sourceLanguage || sourceLanguage === targetLanguage) return null
  const pattern = SOURCE_SCRIPT_PATTERNS[sourceLanguage]
  if (pattern) return (text) => pattern.test(text)
  if (sourceLanguage === "English") return (text, sourceText) => detectUntranslatedEnglish(text, sourceText)
  return null
}

// The flat projection of the terminology graph: the canonical pairs, in file order, which is
// all a plain glossary reader ever needed.
export function parseGlossary(glossaryText) {
  return parseTerminologyGraph(glossaryText).terms.map(({ source, target }) => ({ source, target }))
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function clipText(text, max = 44) {
  const clean = String(text || "").replace(/\s+/g, " ").trim()
  return clean.length > max ? clean.slice(0, max) + "…" : clean
}

function matchesWholeWord(normalizedHaystack, normalizedNeedle) {
  return new RegExp(`(?<![a-z0-9_])${escapeRegExp(normalizedNeedle)}(?![a-z0-9_])`, "i").test(normalizedHaystack)
}

function caseFolded(text) {
  return String(text ?? "").normalize("NFC").toLowerCase()
}

// True when the glossary target carries letters that only a correct translation keeps, so
// a diacritic-free occurrence in the text is drift rather than ordinary casing variation.
function carriesDiacritics(target) {
  return normalizedSearch(target) !== caseFolded(target).trim()
}

// A glossary target is an explicit proper noun or term when the glossary spells every word
// with a capital ("Gojo Satoru", "Lãnh Địa Triển Khai"). A target such as "Đi thôi" is
// capitalised only because it happens to be listed, so its casing says nothing at all.
function isTitleCaseTerm(target) {
  const words = target.match(/[\p{L}\p{M}]+/gu) ?? []
  return words.length >= 2 && words.every((word) => /^\p{Lu}/u.test(word))
}

// A source form is matched as a whole word when it is written in the ASCII range, and as a
// plain substring otherwise, which is how Han and kana terms behave in running text.
function matchesSourceForm(text, form) {
  if (form.length < 2) return false
  const isAscii = /^[a-z0-9 _-]+$/i.test(form)
  return isAscii
    ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(form)}(?![\\p{L}\\p{N}_])`, "iu").test(text)
    : text.includes(form)
}

// A variant or an alias resolves to its term, so any listed source form counts as the term.
function sourceFormIn(text, term) {
  return [term.source, ...term.aliases].find((form) => matchesSourceForm(text, form)) ?? ""
}

// Casing belongs to the spelling of a declared name; for a phrase or an honorific the capital
// only mirrors its position in the glossary, so the heuristic applies to plain terms only.
function casingIsMeaningful(term) {
  if (term.partOfSpeech === "name") return true
  if (term.partOfSpeech !== "term") return false
  return isTitleCaseTerm(term.target)
}

// Two terms linked by a conflict relation are alternative address forms: a line that mixes
// them breaks the register the pair encodes (kính ngữ versus cách nói suồng sã).
function conflictingTerm(term, text, termsById, renderingsById) {
  const own = renderingsById.get(term.id)?.accepted ?? []
  if (!own.some((rendering) => text.includes(rendering))) return null
  for (const id of term.relations.conflict) {
    const other = termsById.get(id)
    if (!other) continue
    const others = renderingsById.get(other.id)?.accepted ?? []
    if (!others.some((rendering) => text.includes(rendering))) continue
    if (others.some((rendering) => own.includes(rendering))) continue
    return other
  }
  return null
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
  const graph = parseTerminologyGraph(glossaryText)
  const terms = graph.terms
  const termsById = new Map(terms.map((term) => [term.id, term]))
  const renderingsById = new Map(terms.map((term) => [term.id, termRenderings(term)]))
  const checkSourceLeak = createSourceLeakCheck(sourceLanguage, targetLanguage)
  const englishSource = sourceLanguage === "English"
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

      if (checkSourceLeak?.(trimmed, box.source)) {
        pushIssue({
          type: "untranslated_source",
          severity: "warning",
          pageIndex,
          pageName: page.name,
          boxId: box.id,
          snippet: clipText(trimmed),
          message: englishSource
            ? `Còn sót câu tiếng Anh chưa dịch trong "${clipText(trimmed)}".`
            : `Còn sót ký tự gốc (${sourceLanguage}) chưa dịch trong "${clipText(trimmed)}".`,
        })
      }

      const normText = normalizedSearch(trimmed)
      for (const term of terms) {
        const { accepted, forbidden, translationRequired } = renderingsById.get(term.id)
        // A forbidden rendering is wrong wherever it appears, so it is reported first.
        const banned = forbidden.find((rendering) => trimmed.includes(rendering))
        if (banned) {
          pushIssue({
            type: "glossary_violation",
            severity: "warning",
            pageIndex,
            pageName: page.name,
            boxId: box.id,
            snippet: clipText(trimmed),
            message: `"${banned}" là dạng bị cấm của "${term.source}"; phải dùng "${term.target}".`,
            suggestion: term.target,
          })
          break
        }
        // Any listed source form - the term itself or an alias - counts as the term, but a
        // listed rendering of any accepted shape satisfies the translation requirement.
        const sourceForm = translationRequired ? sourceFormIn(trimmed, term) : ""
        if (sourceForm && !accepted.some((rendering) => trimmed.includes(rendering))) {
          pushIssue({
            type: "glossary_violation",
            severity: "warning",
            pageIndex,
            pageName: page.name,
            boxId: box.id,
            snippet: clipText(trimmed),
            message: `Thuật ngữ "${sourceForm}" chưa đổi sang "${term.target}".`,
            suggestion: term.target,
          })
          break
        }
        // Conflicting address terms carry the register of the pair: mixing them in one line
        // breaks the kính ngữ the glossary declares.
        const conflict = conflictingTerm(term, trimmed, termsById, renderingsById)
        if (conflict) {
          pushIssue({
            type: "glossary_violation",
            severity: "warning",
            pageIndex,
            pageName: page.name,
            boxId: box.id,
            snippet: clipText(trimmed),
            message: `Xung đột xưng hô: "${term.target}" và "${conflict.target}" không dùng cùng một câu.`,
            suggestion: term.target,
          })
          break
        }
        const normTarget = normalizedSearch(term.target)
        if (normTarget.length < 3) continue
        // Accent drift: the term is present once diacritics are stripped, so the accents
        // were dropped. Casing is not part of this check — a lower-case occurrence of a
        // term listed with an initial capital is ordinary Vietnamese, not an error.
        if (carriesDiacritics(term.target) && !caseFolded(trimmed).includes(caseFolded(term.target).trim())) {
          if (matchesWholeWord(normText, normTarget)) {
            pushIssue({
              type: "glossary_violation",
              severity: "warning",
              pageIndex,
              pageName: page.name,
              boxId: box.id,
              snippet: clipText(trimmed),
              message: `Thuật ngữ "${term.target}" bị mất dấu trong "${clipText(trimmed)}".`,
              suggestion: term.target,
            })
            break
          }
        }
        // Casing drift stays meaningful only for an explicit proper noun or term, where a
        // capital is part of the spelling rather than a sentence position.
        if (casingIsMeaningful(term) && !trimmed.normalize("NFC").includes(term.target.normalize("NFC"))) {
          if (matchesWholeWord(normText, normTarget)) {
            pushIssue({
              type: "glossary_violation",
              severity: "warning",
              pageIndex,
              pageName: page.name,
              boxId: box.id,
              snippet: clipText(trimmed),
              message: `Tên/thuật ngữ lệch chuẩn chữ hoa hoặc dấu so với "${term.target}".`,
              suggestion: term.target,
            })
            break
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
