export const THEME_STORAGE_KEY = "khung-thoai-theme"

export function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light"
}

export function loadTheme(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY)
    if (saved === "dark" || saved === "light") return saved
  } catch {
    // Ignore storage errors.
  }
  if (typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark"
  }
  return "light"
}

export function saveTheme(theme, storage = globalThis.localStorage) {
  const normalized = normalizeTheme(theme)
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalized)
  } catch {
    // Ignore storage errors.
  }
  return normalized
}

export function applyTheme(theme, doc = globalThis.document) {
  const normalized = normalizeTheme(theme)
  if (!doc?.documentElement) return normalized
  doc.documentElement.dataset.theme = normalized
  const meta = doc.querySelector?.('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", normalized === "dark" ? "#0e1013" : "#111418")
  return normalized
}
