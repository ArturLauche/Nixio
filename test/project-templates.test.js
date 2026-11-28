import assert from "node:assert/strict"
import test from "node:test"
import { createHarness } from "../scripts/lib/autosave-harness.mjs"
import { EditHistory } from "../src/history.js"
import { PROJECT_TEMPLATES_KEY } from "../src/templates.js"

const harness = createHarness({ capabilities: null })
const { setupProjects } = await import("../src/controllers/project.js")

let store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
}

async function boot() {
  harness.reset()
  const history = new EditHistory()
  let api
  api = harness.start(setupProjects, {
    history,
    checkpoint(snapshot, meta) {
      return history.record(snapshot ?? {
        pages: harness.state.pages,
        queue: harness.state.queue,
        presets: harness.state.presets,
        settings: Object.fromEntries(api.projectSettings.map(({ id, value }) => [id, value])),
      }, meta)
    },
  })
  await harness.drive(() => harness.pending() === 0)
  return { api, history }
}

const setting = (api, id) => api.projectSettings.find((field) => field.id === id).value
const setSetting = (api, id, value) => {
  api.projectSettings.find((field) => field.id === id).value = value
}

test("applying a built-in template fills settings, presets and defaults as one history entry", async () => {
  const { api, history } = await boot()
  const { state } = harness
  state.pages = harness.pages(1)
  state.fit = false
  state.defaultFont = "Courier"
  setSetting(api, "source-language", "Chinese")

  harness.byId("open-templates").onclick()
  assert.ok(harness.byId("template-select").children.length > 0, "the dialog lists the catalog")
  harness.byId("template-select").value = "Manhwa (Hàn → Anh)"
  harness.byId("apply-template").onclick()

  assert.equal(history.size, 1, "exactly one history entry")
  const entry = history.past.at(-1)
  assert.equal(entry.kind, "template")
  assert.match(entry.label, /Manhwa/)
  // The recorded boundary still holds the pre-apply settings, so undo restores them.
  assert.equal(entry.snapshot.settings["source-language"], "Chinese")

  assert.equal(setting(api, "source-language"), "Korean")
  assert.equal(setting(api, "target-language"), "English")
  assert.equal(setting(api, "direction"), "ltr")
  assert.match(setting(api, "translation-glossary"), /김독자/)
  assert.ok(setting(api, "translation-notes"))
  assert.equal(state.templateId, "manhwa-kr-en")
  assert.equal(state.fit, true)
  assert.equal(state.defaultFont, "Arial")
  assert.ok(state.presets.length >= 3, "template presets were merged in")
  assert.equal(harness.byId("zip-format").value, "png")
  // Pages and their files are untouched.
  assert.equal(state.pages.length, 1)
  assert.equal(state.pages[0].name, "trang-1.png")
  assert.match(harness.lastStatus().text, /Đã áp dụng mẫu dự án/)
})

test("saving current settings as a template persists it across a reload", async () => {
  const { api } = await boot()
  setSetting(api, "source-language", "Chinese")
  setSetting(api, "translation-glossary", "林檎 = Táo")

  harness.byId("open-templates").onclick()
  harness.byId("template-name").value = "Mẫu thử nghiệm"
  harness.byId("save-template").onclick()
  assert.match(harness.lastStatus().text, /Đã lưu mẫu dự án/)
  const stored = JSON.parse(store.get(PROJECT_TEMPLATES_KEY))
  assert.equal(stored.templates.length, 1)
  assert.equal(stored.templates[0].name, "Mẫu thử nghiệm")
  assert.equal(stored.templates[0].settings["source-language"], "Chinese")

  // A fresh boot ("restart") lists the stored template next to the catalog.
  const second = await boot()
  harness.byId("open-templates").onclick()
  const names = harness.byId("template-select").children.map((option) => option.value)
  assert.ok(names.includes("Mẫu thử nghiệm"))
  assert.ok(names.includes("Manhwa (Hàn → Anh)"))

  // Rename, then overwrite with the current settings, then delete.
  harness.byId("template-select").value = "Mẫu thử nghiệm"
  harness.byId("template-name").value = "Mẫu đổi tên"
  harness.byId("rename-template").onclick()
  assert.match(harness.lastStatus().text, /đổi tên/)
  assert.ok(JSON.parse(store.get(PROJECT_TEMPLATES_KEY)).templates.some((item) => item.name === "Mẫu đổi tên"))

  setSetting(second.api, "source-language", "Japanese")
  setSetting(second.api, "translation-notes", "Ghi chú ghi đè")
  harness.byId("overwrite-template").onclick()
  assert.match(harness.lastStatus().text, /ghi đè/)
  const overwritten = JSON.parse(store.get(PROJECT_TEMPLATES_KEY)).templates.find((item) => item.name === "Mẫu đổi tên")
  assert.equal(overwritten.settings["source-language"], "Japanese")
  assert.equal(overwritten.settings["translation-notes"], "Ghi chú ghi đè")

  harness.confirm.value = true
  harness.byId("delete-template").onclick()
  assert.match(harness.lastStatus().text, /Đã xóa mẫu/)
  assert.ok(!JSON.parse(store.get(PROJECT_TEMPLATES_KEY)).templates.length)
})

test("new project with a template resets the session then applies it", async () => {
  const { api, history } = await boot()
  const { state } = harness
  state.pages = harness.pages(1)
  state.queue = ["câu chờ"]
  setSetting(api, "source-language", "English")
  setSetting(api, "target-language", "English")
  setSetting(api, "direction", "rtl")

  harness.byId("open-templates").onclick()
  harness.byId("template-select").value = "4-koma (Nhật → Việt)"
  harness.byId("new-project-template").onclick()

  assert.equal(state.pages.length, 0)
  assert.equal(state.queue.length, 0)
  assert.equal(state.templateId, "four-koma")
  assert.equal(setting(api, "source-language"), "Japanese")
  assert.equal(setting(api, "target-language"), "Vietnamese")
  assert.equal(setting(api, "direction"), "ltr")
  // history was cleared by the reset, then the apply landed as one entry.
  assert.equal(history.size, 1)
  assert.match(harness.lastStatus().text, /Đã áp dụng mẫu dự án/)
})
