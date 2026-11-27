import { alignScript, translateBoxesGemini, translateImage } from "./gemini.js"
import { alignScriptOpenAi, translateBoxesOpenAi, translateImageOpenAi } from "./openai-compat.js"

export function translationNotes({ notes, skillPrompt }) {
  return skillPrompt ? [notes, skillPrompt].filter(Boolean).join("\n\n") : notes
}

export function translationSignature(settings) {
  const base = [settings.source, settings.target, translationNotes(settings), settings.direction, settings.model, settings.glossary]
  if (settings.provider && settings.provider !== "gemini") {
    base.push(settings.provider, settings.baseUrl ?? "", settings.llmModel ?? "")
  }
  return JSON.stringify(base)
}

export function remainingTranslations(pages, settings) {
  const signature = translationSignature(settings)
  const first = pages.findIndex(({ translationJob: job }) =>
    job?.kind !== "translate" || job.state !== "done" || job.signature !== signature)
  return first < 0 ? [] : pages.slice(first)
}

export function translationLabel(page, settings) {
  const job = page.translationJob
  if (!job) return "Chưa dịch"
  if (job.state === "running") return "Đang xử lý"
  if (job.state === "error") return "Lỗi · " + job.error
  if (job.state === "pending") return "Chờ xử lý"
  if (job.signature !== translationSignature(settings)) return "Thiết lập đã đổi"
  return job.kind === "align" ? "Đã ghép kịch bản" : "Đã dịch"
}

// One row per provider id, next to the adapters it maps, so the controller never writes a provider
// branch of its own. An id this table does not know keeps the old behaviour: Gemini.
const translationAdapters = new Map([
  ["gemini", { image: translateImage, alignScript, boxes: translateBoxesGemini }],
  // The OpenAI-compatible box adapter reads the boxes alone, so the page it does not use is dropped
  // here instead of at every call site.
  ["openai", { image: translateImageOpenAi, alignScript: alignScriptOpenAi, boxes: (_page, boxes, settings) => translateBoxesOpenAi(boxes, settings) }],
])

export function translationAdapter(providerId) {
  return translationAdapters.get(providerId) ?? translationAdapters.get("gemini")
}

export function imageTranslatorForProvider(providerId) {
  return translationAdapter(providerId).image
}

export function scriptAlignerForProvider(providerId) {
  return translationAdapter(providerId).alignScript
}

// Single provider branch for box-level translation, shared by the UI controller and the
// offline evaluation harness so both exercise the same routing.
export async function translateBoxesForProvider(provider, page, boxes, settings) {
  return translationAdapter(provider).boxes(page, boxes, settings)
}
