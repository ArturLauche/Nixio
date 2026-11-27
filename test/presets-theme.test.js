import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_STARTER_PRESETS,
  GLOBAL_PRESETS_KEY,
  loadGlobalPresets,
  mergePresets,
  parsePresetsJson,
  saveGlobalPresets,
  serializePresetsJson,
  validatePreset,
} from "../src/presets.js"
import { applyTheme, loadTheme, normalizeTheme, saveTheme, THEME_STORAGE_KEY } from "../src/theme.js"

function memoryStorage() {
  const map = new Map()
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null },
    setItem(k, v) { map.set(k, String(v)) },
    removeItem(k) { map.delete(k) },
  }
}

test("global presets seed starter defaults, persist updates, and merge cleanly", () => {
  const storage = memoryStorage()
  const initial = loadGlobalPresets(storage)
  assert.equal(initial.length, DEFAULT_STARTER_PRESETS.length)
  assert.equal(initial[0].name, "Thoại thường")

  const custom = {
    name: "Hộp tường thuật",
    style: { size: 22, font: "Georgia", color: "#111111", align: "left", rotation: 0, fill: true, fillColor: "#f7f4e9" },
  }
  const merged = mergePresets(initial, [
    custom,
    { name: "thoại thường", style: { ...initial[0].style, size: 30 } },
    { name: "", style: initial[0].style },
  ])
  assert.equal(merged.length, DEFAULT_STARTER_PRESETS.length + 1)
  assert.equal(merged[0].style.size, 30)
  assert.equal(merged.at(-1).name, "Hộp tường thuật")

  saveGlobalPresets(merged, storage)
  assert.ok(storage.getItem(GLOBAL_PRESETS_KEY))
  const reloaded = loadGlobalPresets(storage)
  assert.equal(reloaded.length, merged.length)
  assert.equal(reloaded[0].style.size, 30)

  // Explicitly saving empty array keeps it empty (does not re-seed defaults).
  saveGlobalPresets([], storage)
  assert.deepEqual(loadGlobalPresets(storage), [])
  assert.equal(validatePreset({ name: "Bad", style: { size: 9999 } }), null)
})

test("serializePresetsJson and parsePresetsJson round-trip and reject invalid payloads", () => {
  const json = serializePresetsJson(DEFAULT_STARTER_PRESETS)
  const parsed = parsePresetsJson(json)
  assert.equal(parsed.length, DEFAULT_STARTER_PRESETS.length)
  assert.equal(parsed[3].name, "SFX (Viền + Bóng)")

  // Supports bare array format too.
  const bare = parsePresetsJson(JSON.stringify([DEFAULT_STARTER_PRESETS[0]]))
  assert.equal(bare.length, 1)

  assert.throws(() => parsePresetsJson("not json"), /JSON hợp lệ/)
  assert.throws(() => parsePresetsJson(JSON.stringify({ version: 1 })), /presets/)
  assert.throws(() => parsePresetsJson(JSON.stringify({ presets: [{ name: "" }] })), /hợp lệ/)
})

test("theme helpers normalize, persist, and apply dark/light mode to DOM", () => {
  const storage = memoryStorage()
  assert.equal(normalizeTheme("dark"), "dark")
  assert.equal(normalizeTheme("unknown"), "light")

  saveTheme("dark", storage)
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark")
  assert.equal(loadTheme(storage), "dark")

  let metaContent = ""
  const fakeDoc = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === 'meta[name="theme-color"]') {
        return { setAttribute(_attr, value) { metaContent = value } }
      }
      return null
    },
  }
  applyTheme("dark", fakeDoc)
  assert.equal(fakeDoc.documentElement.dataset.theme, "dark")
  assert.equal(metaContent, "#0e1013")

  applyTheme("light", fakeDoc)
  assert.equal(fakeDoc.documentElement.dataset.theme, "light")
  assert.equal(metaContent, "#111418")
})
