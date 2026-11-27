import { createTranslator, DEFAULT_LOCALE } from "../i18n.js"
import { findMatches, replaceMatches } from "../tools.js"
import { normalizeStyleGuide, styleGuideFields } from "../style-guide.js"

export function setupDialogs({
  state,
  byId,
  t = createTranslator(DEFAULT_LOCALE).t,
  status,
  checkpoint,
  render,
  selectPage,
  selectBox,
  listButton,
  projectBusy,
  commitLiveForm,
  editorSnapshot,
  onStyleGuideChange,
}) {
  const findDialog = byId("find-replace-dialog")
  const shortcutsDialog = byId("shortcuts-dialog")
  const styleGuideDialog = byId("style-guide-dialog")
  const styleGuideHost = byId("style-guide-fields")
  let styleGuideBefore = null

  function styleGuideControl(field) {
    const label = document.createElement("label")
    label.className = "field"
    const title = document.createElement("span")
    title.textContent = field.label
    label.append(title)
    let control
    if (field.kind === "select") {
      control = document.createElement("select")
      control.id = "sg-" + field.id
      control.append(new Option(t("dialogs.styleGuide.defaultOption"), ""))
      for (const option of field.options) control.append(new Option(option.label, option.value))
    } else if (field.rows) {
      control = document.createElement("textarea")
      control.id = "sg-" + field.id
      control.rows = field.rows
      control.placeholder = field.placeholder ?? ""
    } else {
      control = document.createElement("input")
      control.id = "sg-" + field.id
      control.type = "text"
      control.placeholder = field.placeholder ?? ""
    }
    if (field.maxLength) control.maxLength = field.maxLength
    label.append(control)
    return label
  }

  if (styleGuideHost) {
    styleGuideHost.replaceChildren(...styleGuideFields.map(styleGuideControl))
  }

  function readStyleGuideForm() {
    const raw = {}
    for (const field of styleGuideFields) {
      const control = byId("sg-" + field.id)
      if (!control) continue
      const value = String(control.value ?? "").trim()
      if (value) raw[field.id] = value
    }
    return normalizeStyleGuide(raw)
  }

  function fillStyleGuideForm(guide) {
    const clean = normalizeStyleGuide(guide) ?? {}
    for (const field of styleGuideFields) {
      const control = byId("sg-" + field.id)
      if (control) control.value = clean[field.id] ?? ""
    }
  }

  function openStyleGuide() {
    if (projectBusy()) return status(t("status.busy"), true)
    commitLiveForm?.()
    styleGuideBefore = editorSnapshot?.()
    fillStyleGuideForm(state.styleGuide)
    if (!styleGuideDialog.open) styleGuideDialog.showModal()
  }

  function saveStyleGuide() {
    const guide = readStyleGuideForm()
    if (JSON.stringify(guide) === JSON.stringify(normalizeStyleGuide(state.styleGuide))) {
      styleGuideDialog.close()
      return
    }
    state.styleGuide = guide
    checkpoint(styleGuideBefore, { label: t("dialogs.styleGuide.historyLabel"), kind: "settings" })
    onStyleGuideChange?.()
    styleGuideDialog.close()
    status(t(guide ? "dialogs.styleGuide.saved" : "dialogs.styleGuide.cleared"))
  }

  byId("open-style-guide").onclick = openStyleGuide
  byId("save-style-guide").onclick = saveStyleGuide
  byId("clear-style-guide").onclick = () => fillStyleGuideForm(null)
  byId("close-style-guide").onclick = () => styleGuideDialog.close()

  function findOptions() {
    return {
      caseSensitive: byId("find-case").checked,
      wholeWord: byId("find-word").checked,
      includeUnplaced: byId("find-unplaced").checked,
    }
  }

  function findError(message) {
    const error = byId("find-error")
    if (!error) return
    error.textContent = message ?? ""
    if (message) byId("find-query").setAttribute("aria-invalid", "true")
    else byId("find-query").removeAttribute("aria-invalid")
  }

  function renderFindResults() {
    const query = byId("find-query").value
    const results = byId("find-results")
    if (!query) {
      byId("find-summary").textContent = t("find.prompt")
      results.replaceChildren()
      return
    }
    const matches = findMatches(state.pages, query, findOptions())
    const totalOccurrences = matches.reduce((sum, item) => sum + item.count, 0)
    byId("find-summary").textContent = matches.length
      ? t("find.summary", { occurrences: totalOccurrences, items: matches.length })
      : t("find.none")
    results.replaceChildren(
      ...matches.map((match) => {
        const li = document.createElement("li")
        const prefix = t("find.pagePrefix", { page: match.pageIndex + 1 })
          + (match.isUnplaced ? t("find.unplacedSuffix") : "") + " · "
        li.append(
          listButton(prefix + match.text.slice(0, 80), () => {
            findDialog.close()
            const page = state.pages[match.pageIndex]
            if (!page) return
            selectPage(page)
            if (!match.isUnplaced) {
              const box = page.boxes.find((item) => item.id === match.boxId)
              if (box) selectBox(box)
            } else {
              byId("queue-section").scrollIntoView({ block: "nearest" })
            }
          }),
        )
        return li
      }),
    )
  }

  function openFind() {
    if (projectBusy()) return status(t("status.busy"), true)
    findError(null)
    commitLiveForm?.()
    if (!findDialog.open) findDialog.showModal()
    renderFindResults()
    byId("find-query").focus()
    byId("find-query").select()
  }

  function openShortcuts() {
    if (!shortcutsDialog.open) shortcutsDialog.showModal()
  }

  byId("open-find").onclick = openFind
  byId("close-find").onclick = () => findDialog.close()
  byId("find-query").oninput = () => {
    findError(null)
    renderFindResults()
  }
  byId("find-case").onchange = renderFindResults
  byId("find-word").onchange = renderFindResults
  byId("find-unplaced").onchange = renderFindResults

  byId("replace-all-btn").onclick = () => {
    if (projectBusy()) return status(t("status.busy"), true)
    const query = byId("find-query").value
    if (!query) {
      findError(t("find.needQuery"))
      byId("find-query").focus()
      return
    }
    findError(null)
    const replacement = byId("replace-text").value
    commitLiveForm?.()
    const matches = findMatches(state.pages, query, findOptions())
    if (!matches.length) return status(t("find.noMatch"))
    checkpoint(undefined, { label: t("find.historyLabel", { query }), kind: "find" })
    const { replacedItems, replacedOccurrences, skippedEmpty } = replaceMatches(
      state.pages,
      query,
      replacement,
      findOptions(),
    )
    render()
    renderFindResults()
    const extra = skippedEmpty ? t("find.replacedSkipped", { count: skippedEmpty }) : ""
    status(t("find.replaced", { occurrences: replacedOccurrences, items: replacedItems, extra }))
  }

  byId("open-shortcuts").onclick = openShortcuts
  byId("close-shortcuts").onclick = () => shortcutsDialog.close()

  return { openFind, openShortcuts, openStyleGuide, renderFindResults }
}
