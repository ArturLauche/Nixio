import assert from "node:assert/strict"
import test from "node:test"
import {
  MAX_LINE_LENGTH,
  extractJsonObject,
  normalizeTranslation,
  readLines,
  readProviderJson,
  readRequestedTranslations,
} from "../src/llm-response.js"

const isContentError = (message) => (error) =>
  error.message === message && error.retryable === true

test("extractJsonObject reads a payload followed by a format example that also has braces (#41)", () => {
  // The reproducer from the issue: the trailing example used to be glued onto the answer, because the
  // old heuristic spanned the first `{` to the last `}`.
  const raw = '{"lines":[]}\nFormat: {"lines":[{"id":"B1","text":"..."}]}'
  assert.deepEqual(extractJsonObject(raw), { lines: [] })
  // Trailing prose around the payload is ignored, in either direction.
  assert.deepEqual(extractJsonObject('Kết quả: {"lines":[]} — xong.'), { lines: [] })
  assert.deepEqual(extractJsonObject('}` stray closing brace\n{"lines":[]}'), { lines: [] })
})

test("extractJsonObject prefers the fenced answer over a format example quoted in prose", () => {
  const raw = [
    'Return exactly this shape: {"lines":[{"id":"B1","text":"..."}]}',
    "```json",
    '{"lines":[{"id":"B1","text":"Xin chào"}]}',
    "```",
  ].join("\n")
  assert.deepEqual(extractJsonObject(raw), { lines: [{ id: "B1", text: "Xin chào" }] })
})

test("extractJsonObject keeps reasoning fences and reasoning blocks out of the answer", () => {
  const reasoningFence = [
    "```thinking",
    "Keep {B1} and {B2} in mind, then answer.",
    "```",
    "```json",
    '{"lines":[{"id":"B1","text":"Xin chào"}]}',
    "```",
  ].join("\n")
  assert.deepEqual(extractJsonObject(reasoningFence), { lines: [{ id: "B1", text: "Xin chào" }] })
  const thinkBlock = ' thinkingdraft {"lines":[]} to check</think>\n{"lines":[{"id":"B2","text":"Đi thôi"}]}'
  assert.deepEqual(extractJsonObject(thinkBlock), { lines: [{ id: "B2", text: "Đi thôi" }] })
})

test("extractJsonObject still reads a payload behind prose with an unbalanced quote", () => {
  // One stray quote in the surrounding text is prose, not the answer: the string-aware scan gives up
  // on the whole region, so a single spanning read from the first brace to the last brace is tried last.
  assert.deepEqual(extractJsonObject('He said "hello {"lines":[{"id":"B1","text":"Chào"}]}'), {
    lines: [{ id: "B1", text: "Chào" }],
  })
})
test("extractJsonObject tracks strings, escapes and nested braces instead of counting characters", () => {
  const raw = 'answer:\n{"lines":[{"id":"B1","text":"a \\" brace } and { inside","note":{"deep":[1,{"x":2}]}}]}'
  assert.deepEqual(extractJsonObject(raw), {
    lines: [{ id: "B1", text: 'a " brace } and { inside', note: { deep: [1, { x: 2 }] } }],
  })
})

test("extractJsonObject refuses a truncated answer instead of promoting a nested fragment", () => {
  // The inner object `{"id":"B1","text":"x"}` is balanced and parses. Accepting it would report a
  // partial answer as the model's result, so only a run opened at depth zero may become the answer.
  const truncated = '{"lines":[{"id":"B1","text":"x"},{"id":"B2","text":"y"'
  assert.throws(() => extractJsonObject(truncated), isContentError("LLM trả dữ liệu JSON không hợp lệ."))
  assert.throws(() => extractJsonObject('{"lines":[{"id":"B1","text":"x"}'), isContentError("LLM trả dữ liệu JSON không hợp lệ."))
  assert.throws(() => extractJsonObject("not json"), isContentError("LLM trả dữ liệu JSON không hợp lệ."))
  assert.throws(() => extractJsonObject("[1,2,3]"), isContentError("LLM trả dữ liệu JSON không hợp lệ."))
})

test("extractJsonObject reports missing output and bounded work as retryable content errors", () => {
  for (const empty of ["", "   \n\t", null, undefined, 42]) {
    assert.throws(() => extractJsonObject(empty), isContentError("LLM không trả dữ liệu."))
  }
  assert.throws(() => extractJsonObject("think without an answer<\/think>"), isContentError("LLM không trả dữ liệu."))
  // A runaway answer is bounded rather than scanned without limit.
  assert.throws(() => extractJsonObject("{".repeat(200001)), isContentError("LLM trả dữ liệu JSON không hợp lệ."))
  const manyCandidates = Array.from({ length: 33 }, (_, index) => "{bad" + index + "}").join(" ") + ' {"lines":[]}'
  assert.throws(() => extractJsonObject(manyCandidates), isContentError("LLM trả dữ liệu JSON không hợp lệ."))
})

test("extractJsonObject accepts a label so each adapter keeps its own wording", () => {
  assert.throws(() => extractJsonObject("nope", { label: "Gemini" }), isContentError("Gemini trả dữ liệu JSON không hợp lệ."))
  assert.throws(() => extractJsonObject("", { label: "Gemini" }), isContentError("Gemini không trả dữ liệu."))
})

test("readLines rejects a malformed or oversized line list as a retryable content error", () => {
  assert.deepEqual(readLines({ lines: [{ id: "B1", text: "Xin chào" }] }), [{ id: "B1", text: "Xin chào" }])
  for (const parsed of [null, {}, { lines: {} }, { lines: [{ id: "B1" }] }, { lines: [{ text: 1 }] },
    { lines: [{ text: "x".repeat(MAX_LINE_LENGTH + 1) }] }]) {
    assert.throws(() => readLines(parsed), isContentError("LLM trả danh sách thoại sai định dạng."))
  }
  assert.throws(() => readLines({}, { label: "Gemini" }), isContentError("Gemini trả danh sách thoại sai định dạng."))
})

test("readRequestedTranslations maps every requested ID once and collapses whitespace", () => {
  const translations = readRequestedTranslations(
    [{ id: "B1", text: "  Chào   buổi\n sáng " }, { id: "B2", text: "Đi thôi" }],
    ["B1", "B2"],
  )
  assert.deepEqual([...translations], [["B1", "Chào buổi sáng"], ["B2", "Đi thôi"]])
  assert.equal(normalizeTranslation(null), "")
  assert.equal(normalizeTranslation("  a\tb  "), "a b")
})

test("readRequestedTranslations refuses a blank translation instead of keeping the source text (#24)", () => {
  for (const text of ["", "   ", "\n\t", null, undefined]) {
    assert.throws(
      () => readRequestedTranslations([{ id: "B1", text }], ["B1"]),
      isContentError("LLM trả bản dịch rỗng cho B1. Hãy thử lại."),
    )
  }
  // One blank among otherwise valid lines still fails the whole answer.
  assert.throws(
    () => readRequestedTranslations([{ id: "B1", text: "Chào" }, { id: "B2", text: " " }], ["B1", "B2"]),
    isContentError("LLM trả bản dịch rỗng cho B2. Hãy thử lại."),
  )
  assert.throws(
    () => readRequestedTranslations([{ id: "B1", text: " " }], ["B1"], { label: "Gemini" }),
    isContentError("Gemini trả bản dịch rỗng cho B1. Hãy thử lại."),
  )
})

test("readRequestedTranslations rejects a missing, duplicated or invented ID", () => {
  const expected = "LLM trả thiếu hoặc trùng mã thoại. Hãy thử lại."
  assert.throws(() => readRequestedTranslations([{ id: "B1", text: "Chào" }], ["B1", "B2"]), isContentError(expected))
  assert.throws(
    () => readRequestedTranslations([{ id: "B1", text: "Chào" }, { id: "B1", text: "Chào" }], ["B1"]),
    isContentError(expected),
  )
  assert.throws(
    () => readRequestedTranslations([{ id: "B1", text: "Chào" }, { id: "B3", text: "Thêm" }], ["B1"]),
    isContentError(expected),
  )
  assert.throws(() => readRequestedTranslations([{ text: "no id" }], ["B1"]), isContentError(expected))
  // The requested ID is compared as text, so a numeric answer for a numeric request still matches.
  assert.deepEqual([...readRequestedTranslations([{ id: 1, text: "Chào" }], ["1"])], [["1", "Chào"]])
})

test("readProviderJson turns an unreadable body into a retryable content error but keeps an abort", async () => {
  const brokenBody = { json: async () => { throw new SyntaxError("Unexpected token <") } }
  await assert.rejects(
    () => readProviderJson(brokenBody, { label: "Gemini" }),
    isContentError("Gemini trả phản hồi JSON không hợp lệ."),
  )
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" })
  await assert.rejects(() => readProviderJson({ json: async () => { throw abort } }), (error) => error === abort)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => readProviderJson({ json: async () => { throw new Error("stream closed") } }, { signal: controller.signal }),
    (error) => error.message === "stream closed",
  )
})
