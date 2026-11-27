import assert from "node:assert/strict"
import test from "node:test"
import { createHarness, settingIds } from "../scripts/lib/autosave-harness.mjs"

// Desktop shell whose C# worker reports no capabilities: native autosave can
// never run, which is exactly the state issue #22 describes as losing edits.
const harness = createHarness({ capabilities: null })
const { setupProjects } = await import("../src/controllers/project.js")
const storage = await import("../src/web-storage.js")
// A second module instance is a different tab: its own writer id, epoch and
// connection, all against the same fake IndexedDB.
const otherTab = await import("../src/web-storage.js?tab=close-other")
const { readProject, writeProject } = await import("../src/project.js")

const dbName = "khung-thoai-autosave"

async function boot() {
  harness.reset()
  const api = harness.start(setupProjects)
  await harness.drive(() => harness.pending() === 0)
  return api
}

// Starts an autosave that stays suspended in IndexedDB until the test pumps the
// fake, so the completion can be raced against a session change on purpose.
async function startSuspendedSave() {
  harness.intervals.at(-1)()
  for (let attempt = 0; attempt < 20 && harness.pending() === 0; attempt += 1)
    await Promise.resolve()
  assert.ok(harness.pending() > 0, "the snapshot write must be suspended in IndexedDB")
}

async function snapshots() {
  return harness.resolve(storage.listWebSnapshots())
}

async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) {
      // Let the suspended IndexedDB work and the controller reactions settle.
      await harness.drive(() => harness.pending() === 0)
      return
    }
    await harness.tick()
  }
  throw new Error("waitFor timed out")
}

// Advances real timers and promises without pumping the fake IndexedDB, so a
// test can finish one side of a race while a storage write stays suspended.
async function settleUntil(check, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("settleUntil timed out")
}

async function waitForPendingWrite(timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && harness.pending() === 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(harness.pending() > 0, "the fallback snapshot must be suspended in IndexedDB")
}

// Sessions and snapshots an older window wrote: foreign writers, distinct
// projects, valid keys. They fill the store without touching the controller.
function seedForeignSnapshots(count) {
  const entries = {}
  const keys = []
  for (let index = 0; index < count; index += 1) {
    const projectId = crypto.randomUUID()
    const writer = crypto.randomUUID()
    const savedAt = 1700000000000 + index * 10
    const key = `snapshot:${String(savedAt).padStart(14, "0")}:${projectId}:${writer}:${crypto.randomUUID()}`
    const blob = new Blob([`foreign-${index}`])
    entries[key] = {
      schema: 2,
      blob,
      projectId,
      name: `phien-${index}.khungthoai`,
      pageCount: 1,
      savedAt,
      size: blob.size,
      writer,
      epoch: crypto.randomUUID(),
      revision: index + 1,
      generation: 0,
      legacy: false,
    }
    entries[`meta:${key.slice("snapshot:".length)}`] = {
      schema: 2,
      id: key,
      projectId,
      name: `phien-${index}.khungthoai`,
      pageCount: 1,
      savedAt,
      size: blob.size,
      writer,
      revision: index + 1,
      legacy: false,
    }
    keys.push(key)
  }
  harness.fake.seed(dbName, "snapshots", entries)
  return keys
}

test("closing with unsaved edits and no worker asks before discarding, then closes on confirmation", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()
  const indexedDb = globalThis.indexedDB
  // No durable store at all: the only remaining choice is an explicit discard.
  globalThis.indexedDB = undefined
  try {
    harness.confirm.value = false
    harness.desktop.closeHandler()
    await waitFor(() => harness.lastStatus()?.text?.includes("Đã hủy đóng app"))
    assert.equal(harness.calls.closeWindow, 0)
    assert.equal(harness.confirm.calls.length, 1)
    assert.match(harness.confirm.calls[0][0], /bỏ các thay đổi chưa lưu/)

    harness.confirm.value = true
    harness.desktop.closeHandler()
    await waitFor(() => harness.calls.closeWindow === 1)
    assert.equal(harness.confirm.calls.length, 2)
  } finally {
    globalThis.indexedDB = indexedDb
  }
})

test("closing with unsaved edits and no worker writes a recoverable snapshot instead of discarding", async () => {
  const api = await boot()
  const projectId = harness.state.projectId
  harness.state.pages = harness.pages(2)
  api.changed()

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)

  const saved = await snapshots()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].projectId, projectId)
  assert.equal(saved[0].pageCount, 2)
  const file = await harness.resolve(storage.loadWebSnapshot(saved[0].id))
  const project = await readProject(file)
  assert.equal(project.projectId, projectId)
  assert.equal(project.pages.length, 2)
})

test("repeated close events share one flush and close the window once", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.desktop.closeHandler()
  harness.desktop.closeHandler()
  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  await harness.tick()

  assert.equal(harness.calls.closeWindow, 1)
  assert.equal(harness.confirm.calls.length, 0)
  assert.equal((await snapshots()).length, 1)
})

test("closing while a task is running keeps the window open and closes later", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.flags.busy = true
  harness.desktop.closeHandler()
  await waitFor(() => harness.lastStatus()?.text?.includes("Hãy chờ tác vụ hiện tại"))
  assert.equal(harness.calls.closeWindow, 0)
  assert.equal(harness.confirm.calls.length, 0)

  harness.flags.busy = false
  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
})

test("an in-flight manual save is awaited before the close decision", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.byId("save-project").onclick()
  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)

  assert.equal(harness.confirm.calls.length, 0)
  assert.equal(harness.calls.closeWindow, 1)
})

test("a save that finishes after a new project does not mark the new session saved", async () => {
  const api = await boot()
  const firstProject = harness.state.projectId
  harness.state.pages = harness.pages(1)
  api.changed()

  await startSuspendedSave()

  harness.byId("new-project").onclick()
  // The project-switch dialog is not the close decision under test.
  harness.confirm.calls.length = 0
  harness.state.pages = harness.pages(1)
  const secondProject = harness.state.projectId
  assert.notEqual(secondProject, firstProject)
  api.changed()

  await waitFor(async () => (await snapshots()).length === 2)
  const saved = await snapshots()
  assert.deepEqual(saved.map((item) => item.projectId).sort(), [firstProject, secondProject].sort())

  // The retry saved the new generation, so closing no longer needs a prompt.
  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
})

test("importing the same project again during a save still saves the new dirty generation", async () => {
  const api = await boot()
  const projectId = harness.state.projectId
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.intervals.at(-1)()
  await waitFor(async () => (await snapshots()).length === 1)

  api.changed()
  await startSuspendedSave()

  // Same portable project id: the manifest carries it, so this is a reload of
  // the project rather than a new one.
  const projectFile = harness.byId("project-file")
  projectFile.files = [
    new File(
      [
        writeProject({
          projectId,
          pages: harness.pages(1),
          presets: [],
          queue: [],
          settings: Object.fromEntries(settingIds.map((id) => [id, ""])),
          currentPage: 0,
          fit: true,
        }),
      ],
      "du-an.khungthoai",
      { type: "application/octet-stream" },
    ),
  ]
  projectFile.onchange()
  // Let the reload finish on real timers only, so the suspended snapshot is
  // still in flight and provably lands after the new generation exists.
  await settleUntil(() => harness.lastStatus()?.text?.startsWith("Đã mở dự án"))
  assert.equal(harness.state.projectId, projectId)
  // The replace-session dialog belongs to the import, not to the close decision.
  harness.confirm.calls.length = 0

  // The stale completion must not claim the reloaded page instance: the flush
  // it schedules writes the new generation instead of trusting the old marker.
  await harness.drive(() => harness.pending() === 0)
  await waitFor(async () => (await snapshots()).some((item) => item.revision >= 3))
  const saved = await snapshots()
  assert.ok(saved.every((item) => item.projectId === projectId), "same portable project id")
  assert.equal(saved.length, 1, "one page instance keeps exactly one recoverable slot")
  assert.equal(saved[0].revision, 3, "the reloaded generation owns the slot")

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
})

test("a download is not a durable save for the desktop fallback close", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.byId("save-project").onclick()
  await waitFor(() => harness.lastStatus()?.text === "Đã tạo tệp dự án.")
  // The save dialog of the shell can still be cancelled, so the session must
  // keep showing unsaved edits and must not lose the recovery record.
  assert.match(harness.byId("project-dirty").textContent, /Còn thay đổi chưa lưu/)
  assert.deepEqual(await snapshots(), [])

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0, "the close wrote a verified browser snapshot")
  const saved = await snapshots()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].projectId, harness.state.projectId)
})

test("a manual save keeps another tab's diverging recovery snapshot", async () => {
  const api = await boot()
  const projectId = harness.state.projectId
  const seeded = await harness.resolve(
    otherTab.saveWebSnapshot(
      writeProject({
        projectId,
        pages: harness.pages(2),
        presets: [],
        queue: [],
        settings: Object.fromEntries(settingIds.map((id) => [id, ""])),
        currentPage: 0,
        fit: true,
      }),
      { projectId, name: "tab-khac.khungthoai", pageCount: 2, revision: 7 },
    ),
  )
  assert.equal(seeded.ok, true)

  harness.state.pages = harness.pages(1)
  api.changed()
  harness.byId("save-project").onclick()
  await waitFor(() => harness.lastStatus()?.text === "Đã tạo tệp dự án.")

  const kept = await snapshots()
  assert.equal(kept.length, 1, "the manual save deleted nothing")
  assert.equal(kept[0].id, seeded.id)
  assert.equal(kept[0].revision, 7)
  assert.equal(await harness.resolve(otherTab.loadWebSnapshot(seeded.id)) instanceof File, true)
})

test("a snapshot cleared by another tab stops counting as the saved marker", async () => {
  const api = await boot()
  const projectId = harness.state.projectId
  harness.state.pages = harness.pages(1)
  api.changed()
  harness.intervals.at(-1)()
  await waitFor(async () => (await snapshots()).length === 1)
  const [first] = await snapshots()

  // Another tab clears the record and the notification is delayed or lost, so
  // the marker has to be re-checked against the store on the next focus.
  assert.equal(await harness.resolve(otherTab.clearWebSnapshot(first.id)), true)
  assert.equal(await harness.resolve(otherTab.webSnapshotAvailable(first.id)), false)
  harness.documentListeners.get("visibilitychange")?.()
  await harness.drive(() => harness.pending() === 0)

  // With the marker dropped the next autosave writes again instead of skipping.
  harness.intervals.at(-1)()
  await waitFor(async () => (await snapshots()).length === 1)
  const [fresh] = await snapshots()
  assert.notEqual(fresh.id, first.id, "the stale marker was not reused")
  assert.equal(await harness.resolve(storage.webSnapshotAvailable(fresh.id, {
    projectId,
    revision: 1,
  })), true)

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
})

test("editing during the close fallback closes only on the current revision", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.desktop.closeHandler()
  await waitForPendingWrite()
  // The user keeps editing while the fallback snapshot is being written.
  harness.state.pages = harness.pages(2)
  api.changed()

  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
  const saved = await snapshots()
  assert.equal(saved.length, 1, "the same page instance keeps one slot")
  assert.equal(saved[0].revision, 2, "the stored record covers the edit made during the write")
  assert.equal(saved[0].pageCount, 2)
})

test("a full store leaves the session dirty and asks before discarding at close", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()
  const seeded = seedForeignSnapshots(8)

  harness.confirm.value = false
  harness.desktop.closeHandler()
  await waitFor(() => harness.lastStatus()?.text?.includes("Đã hủy đóng app"))
  assert.equal(harness.calls.closeWindow, 0)
  assert.equal(harness.confirm.calls.length, 1)
  assert.match(harness.byId("web-autosave-status").textContent, /đầy 8 bản/)
  assert.match(harness.byId("project-dirty").textContent, /Còn thay đổi chưa lưu/)
  assert.deepEqual((await snapshots()).map((item) => item.id).sort(), seeded.slice().sort())

  // Only an explicit discard closes the window while nothing can be written.
  harness.confirm.value = true
  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 2)
  assert.deepEqual((await snapshots()).map((item) => item.id).sort(), seeded.slice().sort())
})

test("recovery lists each snapshot, keeps the chosen one and clears only that one", async () => {
  await boot()
  const projectA = harness.state.projectId
  const projectB = crypto.randomUUID()
  await harness.resolve(
    storage.saveWebSnapshot(new Blob(["a"]), {
      projectId: projectA,
      name: "A.khungthoai",
      pageCount: 2,
      revision: 3,
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 2))
  await harness.resolve(
    storage.saveWebSnapshot(new Blob(["b"]), {
      projectId: projectB,
      name: "B.khungthoai",
      pageCount: 1,
      revision: 1,
    }),
  )

  harness.documentListeners.get("visibilitychange")?.()
  const select = harness.byId("web-recovery-select")
  await waitFor(() => select.children.length === 2)

  assert.equal(harness.byId("web-recovery").hidden, false)
  assert.equal(harness.byId("web-recovery-actions").hidden, false)
  assert.equal(harness.byId("recover-web").disabled, false)
  assert.equal(harness.byId("clear-web-recovery").disabled, false)
  assert.match(select.children[0].text, /B\.khungthoai · 1 trang/)
  assert.match(select.children[1].text, /A\.khungthoai · 2 trang/)
  assert.ok(select.children.some((option) => option.value === select.value))

  const older = select.children[1].value
  select.value = older
  harness.documentListeners.get("visibilitychange")?.()
  await waitFor(() => select.children.length === 2 && select.value === older)

  harness.byId("clear-web-recovery").onclick()
  await waitFor(async () => (await snapshots()).length === 1)
  const remaining = await snapshots()
  assert.equal(remaining[0].projectId, projectB)
  assert.equal(select.value, remaining[0].id)
  assert.match(harness.lastStatus().text, /Đã xóa bản tự lưu/)

  harness.byId("clear-web-recovery").onclick()
  await waitFor(async () => (await snapshots()).length === 0)
  await waitFor(() => harness.byId("web-recovery").hidden === true)
  assert.equal(harness.byId("web-recovery-actions").hidden, true)
  assert.equal(harness.byId("recover-web").disabled, true)
})

test("a storage failure is reported in Vietnamese and keeps the edits dirty", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()
  const indexedDb = globalThis.indexedDB
  globalThis.indexedDB = undefined
  try {
    harness.intervals.at(-1)()
    await waitFor(() => harness.byId("web-autosave-status").textContent.includes("không lưu được bản tạm"))
    assert.equal(harness.byId("web-recovery").hidden, false)
    assert.equal(harness.byId("web-recovery-actions").hidden, true)
  } finally {
    globalThis.indexedDB = indexedDb
  }
})
