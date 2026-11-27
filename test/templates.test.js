import assert from "node:assert/strict"
import test from "node:test"
import {
  BUILTIN_PROJECT_TEMPLATES,
  MAX_PROJECT_TEMPLATES,
  PROJECT_TEMPLATES_KEY,
  loadProjectTemplates,
  mergeTemplates,
  overwriteTemplate,
  parseProjectTemplatesJson,
  removeTemplate,
  renameTemplate,
  saveProjectTemplates,
  serializeProjectTemplatesJson,
  TEMPLATE_SETTING_IDS,
  upsertTemplate,
  validateTemplate,
} from "../src/templates.js"
import { readProject, readProjectIdentity, writeProject } from "../src/project.js"

function memoryStorage() {
  const map = new Map()
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null },
    setItem(k, v) { map.set(k, String(v)) },
    removeItem(k) { map.delete(k) },
  }
}

function draft(name, overrides = {}) {
  return {
    name,
    settings: {
      direction: "ltr",
      "source-language": "Korean",
      "target-language": "English",
      "translation-notes": "ghi chú",
      "translation-glossary": "김독자 = Kim Dokja",
      "gemini-model": "auto",
    },
    presets: [{ name: "Thoại", style: { size: 24, font: "Arial", color: "#111111", align: "left", rotation: 0, fill: false } }],
    fit: false,
    font: "Georgia",
    exportProfile: { format: "psd" },
    ...overrides,
  }
}

test("the catalog ships four valid built-in templates with usable defaults", () => {
  assert.equal(BUILTIN_PROJECT_TEMPLATES.length, 4)
  for (const template of BUILTIN_PROJECT_TEMPLATES) {
    assert.equal(template.builtin, true)
    assert.ok(validateTemplate(template), `${template.name} must validate`)
    assert.ok(template.presets.length >= 1)
    assert.ok(["png", "psd", "raster"].includes(template.exportProfile.format))
  }
  const manhwa = BUILTIN_PROJECT_TEMPLATES.find((item) => item.id === "manhwa-kr-en")
  assert.equal(manhwa.settings["source-language"], "Korean")
  assert.equal(manhwa.settings["target-language"], "English")
  assert.equal(manhwa.settings.direction, "ltr")
  assert.match(manhwa.settings["translation-glossary"], /김독자 = Kim Dokja/)
  assert.ok(manhwa.settings["translation-notes"])
  assert.ok(manhwa.presets.length >= 3)
  // Script text is project content, never a template default.
  assert.ok(!TEMPLATE_SETTING_IDS.includes("script-text"))
})

test("validateTemplate keeps known fields, drops the rest and rejects bad names", () => {
  const clean = validateTemplate(draft("Mẫu thử", {
    settings: { direction: "rtl", "script-text": "bỏ qua", bogus: "x", "target-language": 42 },
    fit: "yes",
    font: 'xấu"font',
    exportProfile: { format: "exe" },
    extra: "drop me",
  }))
  assert.equal(clean.name, "Mẫu thử")
  assert.equal(clean.settings.direction, "rtl")
  assert.equal(clean.settings["target-language"], undefined)
  assert.equal(clean.settings["script-text"], undefined)
  assert.equal(clean.settings.bogus, undefined)
  assert.equal(clean.fit, undefined)
  assert.equal(clean.font, undefined)
  assert.equal(clean.exportProfile, undefined)
  assert.equal(clean.extra, undefined)
  assert.ok(clean.presets.length === 1)
  assert.ok(clean.id)

  assert.equal(validateTemplate(null), null)
  assert.equal(validateTemplate("chuỗi"), null)
  assert.equal(validateTemplate({ name: "   " }), null)
  assert.equal(validateTemplate({ name: "x".repeat(81) }), null)
  // A preset with an impossible style is dropped by preset validation.
  const noPresets = validateTemplate(draft("Rỗng", { presets: [{ name: "Hỏng", style: { size: 9999 } }] }))
  assert.equal(noPresets.presets.length, 0)
})

test("user templates persist across reloads and duplicates are refused", () => {
  const storage = memoryStorage()
  let list = loadProjectTemplates(storage)
  assert.equal(list.length, BUILTIN_PROJECT_TEMPLATES.length)

  const saved = upsertTemplate(list, draft("Mẫu của tôi"))
  list = saveProjectTemplates(saved, storage)
  assert.ok(storage.getItem(PROJECT_TEMPLATES_KEY))

  // A fresh load ("restart") returns catalog + stored user template.
  const reloaded = loadProjectTemplates(storage)
  assert.equal(reloaded.length, BUILTIN_PROJECT_TEMPLATES.length + 1)
  const mine = reloaded.find((item) => item.name === "Mẫu của tôi")
  assert.equal(mine.settings["source-language"], "Korean")
  assert.equal(mine.fit, false)
  assert.equal(mine.font, "Georgia")
  assert.equal(mine.exportProfile.format, "psd")
  assert.ok(!mine.builtin)

  // Duplicate names are refused case-insensitively unless overwriting.
  assert.throws(() => upsertTemplate(reloaded, draft("mẫu CỦA tôi")), /Đã có mẫu tên/)
  const replaced = upsertTemplate(reloaded, draft("Mẫu của tôi", { fit: true }), { overwrite: true })
  assert.equal(replaced.find((item) => item.name === "Mẫu của tôi").fit, true)
  assert.equal(replaced.find((item) => item.name === "Mẫu của tôi").id, mine.id)

  const renamed = renameTemplate(reloaded, "Mẫu của tôi", "Mẫu mới")
  assert.ok(renamed.some((item) => item.name === "Mẫu mới"))
  assert.throws(() => renameTemplate(renamed, "Mẫu mới", "manga trắng đen (nhật → việt)"), /Đã có mẫu tên/)

  const removed = removeTemplate(renamed, "Mẫu mới")
  assert.ok(!removed.some((item) => item.name === "Mẫu mới"))

  // Catalog entries are read-only.
  const builtin = reloaded.find((item) => item.builtin)
  assert.throws(() => renameTemplate(reloaded, builtin.name, "Khác"), /dựng sẵn/)
  assert.throws(() => removeTemplate(reloaded, builtin.name), /dựng sẵn/)
  assert.throws(() => upsertTemplate(reloaded, draft(builtin.name)), /dựng sẵn/)
  assert.throws(() => overwriteTemplate(reloaded, builtin.name, draft("x")), /dựng sẵn/)
})

test("stored data that collides with the catalog or is corrupt falls back safely", () => {
  const storage = memoryStorage()
  storage.setItem(PROJECT_TEMPLATES_KEY, "không phải json")
  assert.deepEqual(loadProjectTemplates(storage).map((item) => item.name),
    BUILTIN_PROJECT_TEMPLATES.map((item) => item.name))

  // A stored template reusing a builtin name can never shadow the catalog.
  storage.setItem(PROJECT_TEMPLATES_KEY, JSON.stringify({
    version: 1,
    templates: [draft(BUILTIN_PROJECT_TEMPLATES[0].name), draft("Riêng")],
  }))
  const list = loadProjectTemplates(storage)
  assert.equal(list.filter((item) => item.name === BUILTIN_PROJECT_TEMPLATES[0].name).length, 1)
  assert.equal(list.find((item) => item.name === BUILTIN_PROJECT_TEMPLATES[0].name).builtin, true)
  assert.ok(list.some((item) => item.name === "Riêng"))
})

test("template JSON export/import round-trips and rejects bad payloads", () => {
  const list = mergeTemplates(BUILTIN_PROJECT_TEMPLATES, [draft("Xuất thử")])
  const json = serializeProjectTemplatesJson(list)
  const parsed = parseProjectTemplatesJson(json)
  assert.equal(parsed.length, list.length)
  assert.deepEqual(parsed.map((item) => item.name), list.map((item) => item.name))
  const mine = parsed.find((item) => item.name === "Xuất thử")
  assert.equal(mine.settings["translation-glossary"], "김독자 = Kim Dokja")
  assert.equal(mine.exportProfile.format, "psd")
  // Exported builtins come back as ordinary user templates on import.
  assert.ok(!mine.builtin)

  // Bare array payloads are accepted too.
  assert.equal(parseProjectTemplatesJson(JSON.stringify([draft("Lẻ")])).length, 1)
  assert.throws(() => parseProjectTemplatesJson("not json"), /JSON hợp lệ/)
  assert.throws(() => parseProjectTemplatesJson(JSON.stringify({ version: 1 })), /templates/)
  assert.throws(() => parseProjectTemplatesJson(JSON.stringify({ templates: [{ name: "" }] })), /hợp lệ/)
})

test("mergeTemplates respects the cap and never lets user data shadow builtins", () => {
  const many = Array.from({ length: MAX_PROJECT_TEMPLATES + 5 }, (_, index) => draft(`Mẫu ${index + 1}`))
  const merged = mergeTemplates(BUILTIN_PROJECT_TEMPLATES, many)
  assert.equal(merged.length, MAX_PROJECT_TEMPLATES)
  const clash = mergeTemplates(BUILTIN_PROJECT_TEMPLATES, [draft(BUILTIN_PROJECT_TEMPLATES[1].name, { fit: false })])
  assert.equal(clash.length, BUILTIN_PROJECT_TEMPLATES.length)
  assert.equal(clash[1].fit, BUILTIN_PROJECT_TEMPLATES[1].fit)
})

test("project files record the template id in manifest v3", async () => {
  const project = {
    pages: [],
    queue: [],
    settings: {
      "script-text": "",
      direction: "ltr",
      "gemini-model": "auto",
      "source-language": "Korean",
      "target-language": "English",
      "translation-notes": "",
      "translation-glossary": "",
    },
    currentPage: -1,
    fit: true,
    presets: [],
    templateId: "manhwa-kr-en",
  }
  const file = writeProject(project)
  assert.equal((await readProjectIdentity(file)).version, 3)
  const opened = await readProject(file)
  assert.equal(opened.templateId, "manhwa-kr-en")

  // Without a template and without memory the file stays version 2.
  const plain = writeProject({ ...project, templateId: undefined })
  assert.equal((await readProjectIdentity(plain)).version, 2)
  assert.equal((await readProject(plain)).templateId, undefined)

  assert.throws(() => writeProject({ ...project, templateId: 42 }), /không hợp lệ/)
  assert.throws(() => writeProject({ ...project, templateId: "x".repeat(101) }), /không hợp lệ/)
})
