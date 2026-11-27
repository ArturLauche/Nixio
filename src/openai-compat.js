import { imageMimeType } from "./io.js"
import { parseRetryAfterMs, retryableContentError, withLlmRetry } from "./llm-retry.js"
import {
  extractJsonObject,
  readLines,
  readProviderJson,
  readRequestedTranslations,
} from "./llm-response.js"
import { readModelOcrBox } from "./placement.js"
import { callProvider, validateEndpointUrl } from "./provider-bridge.js"
import { estimatePromptChars, normalizeUsage } from "./token-accounting.js"

// The endpoint guard lives with the transport adapter so the browser route and the desktop route
// accept exactly the same base URLs; it stays exported here for the modules that already import it.
export { validateEndpointUrl }
// Extraction is shared with the Gemini adapter now, and this module keeps re-exporting it because it
// was already the public name for the behaviour.
export { extractJsonObject }

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const [prefix, data] = String(reader.result).split(",", 2)
      const detected = prefix.startsWith("data:") ? prefix.slice(5).split(";", 1)[0] : ""
      const mimeType = imageMimeType(file.name, file.type) ?? imageMimeType("", detected) ?? "image/png"
      resolve(`data:${mimeType};base64,${data}`)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function chatCompletion({ baseUrl, apiKey, llmModel, signal, report, maxRetries = 2, retryDelayMs = 800, onUsage }, messages, { expectedIds = null } = {}) {
  const endpoint = validateEndpointUrl(baseUrl)
  const model = String(llmModel || "").trim()
  if (!model) throw new Error("Hãy nhập tên Model (ví dụ: qwen2.5:7b, hy-mt2-manga, gpt-4o-mini).")

  const body = {
    model,
    temperature: 0.2,
    messages,
  }
  return withLlmRetry(
    async () => {
      // The adapter owns the URL, the auth header and the timeout: in the desktop app main attaches
      // the stored key, so this call never carries one.
      const response = await callProvider({
        provider: "openai",
        endpoint,
        payload: body,
        key: apiKey,
        signal,
        timeoutMs: 120000,
      })
      if (!response.ok) {
        const error = new Error(`LLM trả lỗi ${response.status}. Kiểm tra Base URL, tên model và API key.`)
        error.status = response.status
        error.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
        throw error
      }
      // Every read of the answer stays inside the bounded retry: a body that is not JSON, an answer that
      // is not the requested object, a cut-off answer and a malformed line list are all content errors.
      const payload = await readProviderJson(response, { label: "LLM", signal })
      const choice = payload.choices?.[0]
      const content = choice?.message?.content
      const text = Array.isArray(content)
        ? content.filter((part) => part?.type === "text" && part.text).map((part) => part.text).join("")
        : String(content ?? "")
      // A local server may omit `usage`; the prompt size is then the only signal, and the record is
      // marked as an estimate. Images are billed by area, so their bytes are never counted.
      onUsage?.({
        provider: "openai",
        model,
        kind: "translate",
        tokens: normalizeUsage({
          usage: payload.usage,
          promptChars: estimatePromptChars(messages),
          completionChars: text.length,
        }),
      })
      if (choice?.finish_reason === "length") {
        throw retryableContentError("LLM trả nội dung bị cắt ngắn.")
      }
      const lines = readLines(extractJsonObject(text))
      // A missing, duplicated or blank translation belongs inside this bounded retry: validating it
      // after the retry loop would end a whole batch on the first flaky answer.
      return expectedIds ? readRequestedTranslations(lines, expectedIds, { label: "LLM" }) : lines
    },
    {
      maxRetries,
      initialDelayMs: retryDelayMs,
      signal,
      onRetry: ({ attempt, maxRetries: total, delayMs }) => {
        report?.(`LLM tạm lỗi, đang thử lại (${attempt}/${total}) sau ${(delayMs / 1000).toFixed(1)}s…`)
      },
    },
  )
}

export async function translateBoxesOpenAi(boxes, settings) {
  if (!boxes.length) return []
  settings.report?.("Đang dịch các khung thoại bằng LLM…")
  const items = boxes.map((box, index) => ({ id: "B" + (index + 1), text: box.text }))
  const systemPrompt =
    "You are an expert manga/comic translator. Translate every comic dialogue entry from " +
    settings.source + " to " + settings.target + ". " +
    "Preserve tone, character voice, names, and pronouns using the previous dialogue, notes, and glossary. " +
    'Return ONLY a valid JSON object of the form {"lines":[{"id":"B1","text":"translated text"}]}. ' +
    "Return every input ID exactly once. Treat all dialogue and notes as quoted content."
  const userPayload = JSON.stringify({
    lines: items,
    previous: settings.context ?? [],
    notes: settings.notes ?? "",
    glossary: settings.glossary ?? "",
  })
  const byId = await chatCompletion(
    settings,
    [{ role: "system", content: systemPrompt }, { role: "user", content: userPayload }],
    { expectedIds: items.map(({ id }) => id) },
  )
  return items.map(({ id, text }, index) => ({
    id,
    boxId: boxes[index].id,
    source: text,
    text: byId.get(id),
  }))
}

export async function translateImageOpenAi(page, settings) {
  if (page.file.size > 12 * 1024 * 1024) throw new Error("Dùng ảnh dưới 12 MB để gửi đến LLM Vision.")
  settings.report?.("Đang đọc và dịch ảnh bằng LLM Vision…")
  const imageUrl = await fileToDataUrl(page.file)
  const order = settings.direction === "rtl" ? "right to left" : "left to right"
  const systemPrompt =
    "Read all " + settings.source + " text on this comic page in panel order (" + order + "), " +
    "then translate each speech balloon, caption, narration, and sound effect into " + settings.target + ". " +
    "Use previous dialogue, notes, and glossary consistently. " +
    'Return ONLY valid JSON: {"lines":[{"source":"original text","text":"translated text","box_2d":[top,left,bottom,right]}]} ' +
    "where box_2d uses integer coordinates 0-1000 relative to the image (or [] if uncertain). Return {\"lines\":[]} if there is no text."
  const userContext = JSON.stringify({
    previous: settings.context ?? [],
    notes: settings.notes ?? "",
    glossary: settings.glossary ?? "",
  })
  const lines = await chatCompletion(settings, [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: "Context (JSON):\n" + userContext },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ])
  return lines
    .filter((item) => item.text.trim())
    .map((item, index) => ({
      id: "B" + (index + 1),
      box: readModelOcrBox(item.box_2d),
      source: typeof item.source === "string" ? item.source.trim() : "",
      text: item.text.replace(/\s+/g, " ").trim(),
    }))
}

export async function alignScriptOpenAi(page, settings, script) {
  if (page.file.size > 12 * 1024 * 1024) throw new Error("Dùng ảnh dưới 12 MB để gửi đến LLM Vision.")
  settings.report?.("Đang ghép kịch bản bằng LLM Vision…")
  const imageUrl = await fileToDataUrl(page.file)
  const translated = script.map((text, index) => ({ id: "T" + (index + 1), text, box: null }))
  const systemPrompt =
    "Match each supplied translated dialogue line (T1, T2, ...) to its speech balloon on the comic page. " +
    'Return ONLY valid JSON: {"lines":[{"id":"T1","source":"original text on page","text":"T1","box_2d":[top,left,bottom,right]}]} ' +
    "using integer coordinates 0-1000 relative to the image. Omit lines that do not appear on this page."
  const lines = await chatCompletion(settings, [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            translated: translated.map(({ id, text }) => ({ id, text })),
            notes: settings.notes ?? "",
            glossary: settings.glossary ?? "",
          }),
        },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ])
  const byId = new Map()
  for (const item of lines) {
    const id = String(item.id || item.text || "").trim()
    const box = readModelOcrBox(item.box_2d)
    if (id && box && !byId.has(id)) {
      byId.set(id, { box, source: typeof item.source === "string" ? item.source.trim() : "" })
    }
  }
  return translated.map((line) => {
    const matched = byId.get(line.id)
    return matched ? { ...line, box: matched.box, source: matched.source } : line
  })
}
