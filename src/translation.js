export function translationSignature(settings) {
  return JSON.stringify([settings.source, settings.target, settings.notes, settings.direction, settings.model, settings.glossary])
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
