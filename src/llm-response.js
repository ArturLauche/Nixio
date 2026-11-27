// Reading one model answer, shared by both provider adapters.
//
// A vision or local model answers in prose far more often than the prompt asks, and a malformed answer
// is a transient content failure rather than a dead end. This module is the single place that decides
// what an answer means — the JSON object the model actually intended, the line list it must contain,
// and the translations that were requested — so the OpenAI-compatible adapter and the Gemini adapter
// cannot drift apart. Every failure here is a `retryableContentError`, which is what lets
// `withLlmRetry` give a flaky answer the same bounded second chance as a 5xx.

import { retryableContentError } from "./llm-retry.js"

export const MAX_LINE_LENGTH = 2000

// Work bounds: a runaway or hostile answer must not turn extraction into an unbounded scan, so the
// length that is scanned, the number of objects inspected and the number of fences tried are capped.
const MAX_SCAN_CHARACTERS = 200000
const MAX_OBJECT_CANDIDATES = 32
const MAX_FENCES = 16

const invalidJson = (label) => retryableContentError(label + " trả dữ liệu JSON không hợp lệ.")

// Reasoning blocks emitted by local reasoning models (DeepSeek/Qwen) are dropped before extraction,
// because their prose routinely contains braces that are not the answer.
function stripReasoning(rawText) {
  return rawText.replace(/[\s\S]*?<\/think>/gi, "").trim()
}

// Visit every balanced `{...}` run that starts at the top level of `text`. A brace inside a string
// literal, an escaped quote and a nested object all stay inside the same run, and a stray `}` in prose
// is ignored. Because only a run opened at depth zero is offered, a fragment nested inside a truncated
// answer can never be mistaken for a complete object. `visit` returns false to stop early.
function scanObjects(text, visit) {
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === "{") {
      if (depth === 0) start = index
      depth += 1
    } else if (character === "}" && depth > 0) {
      depth -= 1
      if (depth === 0) {
        const stop = visit(text.slice(start, index + 1)) === false
        start = -1
        if (stop) return
      }
    }
  }
}

function parseObject(candidate) {
  try {
    const value = JSON.parse(candidate)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// The first intended object in one region: the whole region first, because that is the clean answer,
// then every top-level balanced run in document order. Document order is what keeps a trailing format
// example from winning over the payload that precedes it.
function firstObject(region) {
  const direct = parseObject(region)
  if (direct) return direct
  let found = null
  let inspected = 0
  scanObjects(region, (candidate) => {
    inspected += 1
    if (inspected > MAX_OBJECT_CANDIDATES) return false
    found = parseObject(candidate)
    return found === null
  })
  return found
}

export function extractJsonObject(rawText, { label = "LLM" } = {}) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw retryableContentError(label + " không trả dữ liệu.")
  }
  // The length is bounded before any regular expression runs, so a runaway answer cannot turn the
  // reasoning strip into a quadratic scan.
  if (rawText.length > MAX_SCAN_CHARACTERS) throw invalidJson(label)
  const cleaned = stripReasoning(rawText)
  if (!cleaned) throw retryableContentError(label + " không trả dữ liệu.")

  // A fence says which text the model meant as its answer, so fences are read before the surrounding
  // prose. Scanning every fence, not only the first, is what lets a reasoning fence precede the JSON.
  const fencePattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi
  let match = fencePattern.exec(cleaned)
  let examined = 0
  while (match && examined < MAX_FENCES) {
    examined += 1
    const fenced = firstObject(match[1].trim())
    if (fenced) return fenced
    match = fencePattern.exec(cleaned)
  }

  const found = firstObject(cleaned)
  if (found) return found

  // Last resort: a single unbalanced quote in the surrounding prose makes the string-aware scan treat
  // the rest of the answer as one string, so the whole span is tried once. This is the span the
  // previous heuristic read, and it cannot resurrect a nested fragment: the span always starts at the
  // first `{` and ends at the last `}`, so an unbalanced region fails to parse instead of yielding the
  // complete object nested inside it.
  const firstBrace = cleaned.indexOf("{")
  const lastBrace = cleaned.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const spanning = parseObject(cleaned.slice(firstBrace, lastBrace + 1))
    if (spanning) return spanning
  }
  throw invalidJson(label)
}

// The line list every schema in this app asks for. A non-array `lines`, a non-string `text` or an
// oversized line is a malformed result, so it is retried instead of being written into the project.
export function readLines(parsed, { label = "LLM" } = {}) {
  const lines = parsed?.lines
  if (!Array.isArray(lines) ||
      lines.some((item) => typeof item?.text !== "string" || item.text.length > MAX_LINE_LENGTH)) {
    throw retryableContentError(label + " trả danh sách thoại sai định dạng.")
  }
  return lines
}

export function normalizeTranslation(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

// Every requested ID has to come back exactly once, and a translation that is empty or only
// whitespace is a failed translation rather than a reason to keep the source text. Falling back to the
// source reported the page as translated while the balloon still showed the original, so both a bad
// ID map and a blank translation are content errors: the bounded retry gets a chance to fix them and an
// exhausted batch fails loudly instead of claiming success.
export function readRequestedTranslations(lines, requestedIds, { label = "LLM" } = {}) {
  const requested = new Set(requestedIds)
  const translations = new Map()
  for (const item of lines) {
    const id = String(item?.id ?? "").trim()
    if (!requested.has(id) || translations.has(id)) {
      throw retryableContentError(label + " trả thiếu hoặc trùng mã thoại. Hãy thử lại.")
    }
    translations.set(id, normalizeTranslation(item.text))
  }
  if (translations.size !== requested.size) {
    throw retryableContentError(label + " trả thiếu hoặc trùng mã thoại. Hãy thử lại.")
  }
  for (const [id, text] of translations) {
    if (!text) throw retryableContentError(label + " trả bản dịch rỗng cho " + id + ". Hãy thử lại.")
  }
  return translations
}

// A provider body that is not JSON at all — an HTML error page, an interposed proxy page — is the same
// class of transient content failure as a model answer that is not the requested shape. A cancellation
// is rethrown untouched so an aborted request never turns into a retry.
export async function readProviderJson(response, { label = "LLM", signal } = {}) {
  try {
    return await response.json()
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) throw error
    throw retryableContentError(label + " trả phản hồi JSON không hợp lệ.")
  }
}
