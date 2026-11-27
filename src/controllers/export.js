import { copyEditor } from "../history.js"
import { exportPage, textOverflows } from "../canvas.js"
import { filenameStem, saveFile } from "../io.js"
import { translationSignature } from "../translation.js"
import { exportDialogueScript } from "../tools.js"
import { lintChapter } from "../linter.js"
import {
  describeExportProfile,
  exportManifest,
  exportManifestFileName,
  loadGlobalExportProfileId,
  planExportSlices,
  resolveExportProfile,
  serializeExportManifest,
} from "../export-presets.js"
import { renderExportSlices } from "../webtoon.js"

export function setupExports({
  state,
  byId,
  status,
  renderPages,
  selectedPage,
  selectPage,
  selectBox,
  listButton,
  projectBusy,
  readTranslationSettings,
  commitLiveForm,
  notify,
}) {
  const exportButtons = [...document.querySelectorAll("[data-export]")]
  function extensionFor(format) {
    return format === "png" ? "png" : "psd"
  }

  const profileSelect = byId("export-profile")
  function activeProfile() {
    return resolveExportProfile(profileSelect?.value || loadGlobalExportProfileId())
  }
  function syncProfileSummary() {
    const summary = byId("export-profile-summary")
    if (!summary) return
    try {
      summary.textContent = describeExportProfile(activeProfile())
    } catch (error) {
      summary.textContent = error.message
    }
  }
  profileSelect?.addEventListener("change", syncProfileSummary)
  syncProfileSummary()

  // A composed page has to come back as an image before the profile can scale and cut it. The
  // message names the reason instead of failing on an undefined global.
  async function decodePageImage(blob) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("Trình duyệt này không giải mã được ảnh để chia mảnh theo hồ sơ.")
    }
    return createImageBitmap(blob)
  }

  async function exportProfileZip(pages, profile) {
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    const plans = []
    let order = 1
    for (const [index, page] of pages.entries()) {
      status(`Đang xuất trang ${index + 1}/${pages.length} theo hồ sơ ${profile.name}…`)
      const bitmap = await decodePageImage(await exportPage(page, "png"))
      try {
        const plan = planExportSlices(profile, {
          width: bitmap.width,
          height: bitmap.height,
          order,
          pageName: page.name,
        })
        const files = await renderExportSlices(bitmap, plan, {
          onSlice: ({ index: sliceIndex, total, fileName, width, height }) => {
            status(`Trang ${index + 1}/${pages.length} · mảnh ${sliceIndex}/${total}: ${fileName} (${width}×${height} px).`)
          },
        })
        for (const file of files) zip.file(file.name, file)
        plans.push({ pageName: page.name, plan })
        order += files.length
      } finally {
        bitmap.close?.()
      }
    }
    zip.file(
      exportManifestFileName,
      serializeExportManifest(exportManifest({ profile, plans })),
    )
    saveFile(await zip.generateAsync({ type: "blob" }), `khung-thoai-${profile.id}.zip`)
    return plans.reduce((total, { plan }) => total + plan.slices.length, 0)
  }

  async function performExport(action, summaryLabel) {
    if (state.exporting || state.openingProject) return
    state.exporting = true
    renderPages()
    try {
      const outcome = await action()
      if (outcome === false) return
      const label = typeof summaryLabel === "function" ? summaryLabel() : summaryLabel
      status("Đã tạo tệp xuất.")
      if (label) {
        notify?.({
          kind: "success",
          title: "Xuất tệp hoàn tất",
          message: label,
          key: "export-done",
        })
      }
    } catch (error) {
      status("Xuất thất bại. " + error.message, true)
      notify?.({
        kind: "error",
        title: "Xuất tệp thất bại",
        message: error.message,
        key: "export-done",
      })
    } finally {
      state.exporting = false
      renderPages()
    }
  }

  const preflightDialog = byId("preflight-dialog")
  let pendingExport
  function exportIssues(pages) {
    const issues = []
    const settings = readTranslationSettings()
    const signature = translationSignature(settings)
    const context = document.createElement("canvas").getContext("2d")
    if (state.queue.length)
      issues.push({ text: `${state.queue.length} câu chưa đặt trong chương.` })
    for (const page of pages) {
      const prefix = page.name + " · "
      if (page.unplaced.length)
        issues.push({
          page,
          text: prefix + `${page.unplaced.length} câu chưa đặt.`,
        })
      if (page.translationJob?.state === "error")
        issues.push({
          page,
          text: prefix + "Lỗi dịch. " + page.translationJob.error,
        })
      if (page.translationJob?.state === "pending")
        issues.push({ page, text: prefix + "Chưa xử lý xong lượt dịch." })
      if (
        page.translationJob?.state === "done" &&
        page.translationJob.signature !== signature
      ) {
        issues.push({
          page,
          text: prefix + "Thiết lập dịch đã đổi sau lần xử lý gần nhất.",
        })
      }
      for (const box of page.boxes) {
        if (textOverflows(page, box, context))
          issues.push({
            page,
            box,
            text: prefix + "Chữ tràn khung · " + box.text.slice(0, 70),
          })
      }
    }
    const qa = lintChapter(pages, {
      glossaryText: settings.glossary ?? "",
      sourceLanguage: settings.source ?? "Japanese",
      targetLanguage: settings.target ?? "Vietnamese",
      maxIssues: 40,
    })
    for (const item of qa.issues) {
      if (item.severity !== "warning") continue
      const page = pages[item.pageIndex - 1]
      const box = page?.boxes.find((b) => b.id === item.boxId)
      issues.push({
        page,
        box,
        text: `${item.pageName} · QA: ${item.message}`,
      })
    }
    return issues
  }

  function showPreflight(issues, action) {
    pendingExport = action
    byId("continue-export").hidden = !action
    byId("preflight-summary").textContent = issues.length
      ? `Có ${issues.length} mục cần kiểm tra.`
      : "Các trang đã sẵn sàng để xuất."
    byId("preflight-issues").replaceChildren(
      ...issues.map((issue) => {
        const li = document.createElement("li")
        li.append(
          listButton(issue.text, () => {
            preflightDialog.close()
            location.hash = "editor"
            if (issue.page) selectPage(issue.page)
            if (issue.box) selectBox(issue.box)
            if (!issue.page)
              byId("queue-section").scrollIntoView({ block: "nearest" })
            status(issue.text)
          }),
        )
        return li
      }),
    )
    preflightDialog.showModal()
  }

  function requestExport(pages, action) {
    if (projectBusy()) return
    commitLiveForm?.()
    const issues = exportIssues(pages)
    if (issues.length) showPreflight(issues, action)
    else action()
  }
  byId("check-export").onclick = () => {
    commitLiveForm?.()
    showPreflight(exportIssues(state.pages))
  }
  byId("close-preflight").onclick = () => preflightDialog.close()
  byId("continue-export").onclick = () => {
    const action = pendingExport
    preflightDialog.close()
    action?.()
  }
  preflightDialog.addEventListener("close", () => {
    pendingExport = null
  })

  for (const button of exportButtons) {
    button.onclick = () => {
      const page = selectedPage()
      const format = button.dataset.export
      if (!page) return
      requestExport([page], () =>
        performExport(async () => {
          status("Đang xuất trang…")
          const snapshot = copyEditor({ pages: [page] }).pages[0]
          saveFile(
            await exportPage(snapshot, format),
            filenameStem(page.name) + "." + extensionFor(format),
          )
        }),
      )
    }
  }

  const zipDialog = byId("zip-dialog")
  byId("export-all").onclick = () => {
    zipDialog.returnValue = ""
    syncProfileSummary()
    zipDialog.showModal()
  }
  zipDialog.addEventListener("close", () => {
    if (zipDialog.returnValue !== "export") return
    const format = byId("zip-format").value
    let profile
    try {
      profile = activeProfile()
    } catch (error) {
      return status(error.message, true)
    }
    let sliceCount = 0
    const run = () =>
      performExport(
        async () => {
          const pages = copyEditor({ pages: state.pages }).pages
          if (format === "profile") {
            sliceCount = await exportProfileZip(pages, profile)
            return
          }
          const { default: JSZip } = await import("jszip")
          const zip = new JSZip()
          for (const [index, page] of pages.entries()) {
            status(`Đang xuất trang ${index + 1} / ${pages.length}…`)
            const name =
              String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name)
            zip.file(
              name + "." + extensionFor(format),
              await exportPage(page, format),
            )
          }
          saveFile(
            await zip.generateAsync({ type: "blob" }),
            "khung-thoai-" + format + ".zip",
          )
        },
        () =>
          format === "profile"
            ? `Đã xuất ${sliceCount} mảnh theo hồ sơ ${profile.name}.`
            : `Đã xuất gói ZIP ${format.toUpperCase()} gồm ${state.pages.length} trang.`,
      )
    // The profile decides whether the preflight report runs before the archive is built.
    if (profile.preflight) requestExport(state.pages, run)
    else run()
  })

  const exportScriptBtn = byId("export-script")
  if (exportScriptBtn) {
    exportScriptBtn.onclick = () => {
      if (projectBusy() || !state.pages.length) return
      commitLiveForm?.()
      const format = byId("export-script-format").value
      const content = exportDialogueScript(state.pages, format)
      if (!content) return status("Chưa có lời thoại nào để xuất.", true)
      const mime =
        format === "json"
          ? "application/json;charset=utf-8"
          : format === "csv"
            ? "text/csv;charset=utf-8"
            : "text/plain;charset=utf-8"
      const stem = filenameStem(state.pages[0]?.name ?? "kich-ban")
      saveFile(new Blob([content], { type: mime }), `${stem}-kich-ban.${format}`)
      status(`Đã xuất kịch bản (${format.toUpperCase()}).`)
    }
  }
}
