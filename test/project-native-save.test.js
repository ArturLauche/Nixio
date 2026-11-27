import assert from "node:assert/strict"
import test from "node:test"
import { createHarness } from "../scripts/lib/autosave-harness.mjs"

// Desktop shell with a working C# worker: native autosave owns recovery and the
// close flush must reuse it instead of the browser snapshot.
const harness = createHarness({ capabilities: {} })
const { setupProjects } = await import("../src/controllers/project.js")
const storage = await import("../src/web-storage.js")

async function boot() {
  harness.reset()
  const api = harness.start(setupProjects)
  await harness.drive(() => api.ready === true)
  return api
}

async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) {
      await harness.drive(() => harness.pending() === 0)
      return
    }
    await harness.tick()
  }
  throw new Error("waitFor timed out")
}

test("a successful native autosave makes the close durable without a prompt", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.intervals.at(-1)()
  await waitFor(() => harness.calls.commits.includes("autosave"))
  assert.match(harness.byId("autosave-status").textContent, /Đã tự lưu lúc/)

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
  // The worker owns recovery: no browser fallback snapshot was needed.
  assert.deepEqual(await harness.resolve(storage.listWebSnapshots()), [])
})

test("closing flushes unsaved edits through the worker before exiting", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
  assert.ok(harness.calls.commits.includes("autosave"), "the close flush wrote a snapshot")
})

test("a failed native autosave still keeps a durable browser snapshot before closing", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()
  harness.flags.nativeFails = true

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)

  const saved = await harness.resolve(storage.listWebSnapshots())
  assert.equal(saved.length, 1)
  assert.equal(saved[0].projectId, harness.state.projectId)
})

test("a native autosave that finishes after a project switch does not mark the new session saved", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.flags.holdWrites = true
  harness.intervals.at(-1)()
  await waitFor(() => harness.calls.written.length === 1)

  harness.byId("new-project").onclick()
  await harness.drive(() => harness.calls.activate.length >= 2)
  harness.confirm.calls.length = 0
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.flags.holdWrites = false
  harness.releaseWrites()
  await waitFor(() => harness.calls.commits.length === 1)
  assert.doesNotMatch(harness.byId("autosave-status").textContent, /Đã tự lưu lúc/)

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
  assert.ok(harness.calls.commits.length >= 2, "the close flushed the new session too")
})

test("a manual native save keeps the session durable so closing needs no prompt", async () => {
  const api = await boot()
  harness.state.pages = harness.pages(1)
  api.changed()

  harness.byId("save-project").onclick()
  await waitFor(() => harness.calls.commits.includes("project"))

  harness.desktop.closeHandler()
  await waitFor(() => harness.calls.closeWindow === 1)
  assert.equal(harness.confirm.calls.length, 0)
  assert.equal(harness.calls.commits.filter((mode) => mode === "project").length, 1)
})

test("a manual native save leaves another tab's browser recovery record intact", async () => {
  const otherTab = await import("../src/web-storage.js?tab=native-other")
  const api = await boot()
  const projectId = harness.state.projectId
  const seeded = await harness.resolve(
    otherTab.saveWebSnapshot(new Blob([new Uint8Array([1, 2, 3])]), {
      projectId,
      name: "tab-khac.khungthoai",
      pageCount: 1,
      revision: 4,
    }),
  )
  assert.equal(seeded.ok, true)

  harness.state.pages = harness.pages(1)
  api.changed()
  harness.byId("save-project").onclick()
  await waitFor(() => harness.calls.commits.includes("project"))

  const kept = await harness.resolve(storage.listWebSnapshots())
  assert.equal(kept.length, 1, "the file on disk never deletes a browser snapshot")
  assert.equal(kept[0].id, seeded.id)
  assert.equal(kept[0].revision, 4)
})
