import {
  applyDocumentLocale,
  applyDocumentTitle,
  applyTranslations,
  createTranslator,
  loadLocale,
  LOCALES,
  saveLocale,
} from "../i18n.js"

// The header picker is the only control here: it applies the saved locale when the app boots and
// re-renders the static markup in place on every change, so no reload is involved.
export function setupLocale({ byId, doc = globalThis.document, storage = globalThis.localStorage, onChange } = {}) {
  let locale = loadLocale(storage)
  let translator = createTranslator(locale)

  function render() {
    applyDocumentLocale(doc, locale)
    applyDocumentTitle(doc, translator.t)
    applyTranslations(doc, translator.t)
    const select = byId("locale-select")
    if (!select) return
    // Options come from the registry, so a community pack shows up without a markup edit.
    select.replaceChildren(
      ...Object.values(LOCALES).map((meta) => {
        const option = doc.createElement("option")
        option.value = meta.code
        option.textContent = meta.label
        return option
      }),
    )
    select.value = locale
  }

  function setLocale(next) {
    const saved = saveLocale(next, storage)
    if (saved === locale) {
      render()
      return locale
    }
    locale = saved
    translator = createTranslator(locale)
    render()
    onChange?.(locale)
    return locale
  }

  byId("locale-select")?.addEventListener("change", (event) => setLocale(event?.target?.value ?? locale))
  render()

  return {
    get locale() {
      return locale
    },
    t: (key, params) => translator.t(key, params),
    setLocale,
    refresh: render,
  }
}
