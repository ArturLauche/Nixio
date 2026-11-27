import assert from "node:assert/strict"
import test from "node:test"
import { createFakeIndexedDB } from "../scripts/lib/fake-indexeddb.mjs"

const dbName = "khung-thoai-autosave"
const storeName = "snapshots"
const fontStoreName = "fonts"
const projectA = "11111111-2222-3333-4444-555555555555"
const projectB = "99999999-8888-7777-6666-555555555555"

const fake = createFakeIndexedDB()
globalThis.indexedDB = fake.indexedDB
globalThis.IDBKeyRange = fake.IDBKeyRange

let tabs = 0
// One module instance per "tab": separate writer id, epoch and connection, all
// against the same database.
async function openTab() {
  tabs += 1
  return import(`../src/web-storage.js?tab=${tabs}`)
}

const first = await openTab()

function projectBlob(projectId, pageCount = 1, payload = "x") {
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      ...(projectId ? { projectId } : {}),
      pages: Array.from({ length: pageCount }, (_, index) => ({ name: `p${index + 1}.png` })),
    }),
  )
  const header = new Uint8Array(11 + 4)
  header.set(new TextEncoder().encode("KHUNGTHOAI\n"))
  new DataView(header.buffer).setUint32(11, manifest.length, true)
  return new Blob([header, manifest, payload], { type: "application/octet-stream" })
}

async function ensureStores(version = 2) {
  await new Promise((resolve) => {
    const request = fake.indexedDB.open(dbName, version)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      if (!db.objectStoreNames.contains(fontStoreName)) db.createObjectStore(fontStoreName)
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => resolve()
  })
}

async function save(tab, projectId, payload, extra = {}) {
  return tab.saveWebSnapshot(projectBlob(projectId, extra.pageCount ?? 1, payload), {
    name: `${projectId.slice(0, 4)}.khungthoai`,
    pageCount: extra.pageCount ?? 1,
    revision: extra.revision ?? 1,
    projectId,
  })
}

async function text(file) {
  return file.text()
}

function fakeSessionStorage(writer) {
  const map = new Map(writer ? [["khung-thoai:web-writer", writer]] : [])
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  }
}

test("distinct projects keep separately recoverable snapshots", async () => {
  fake.drop(dbName)
  const second = await openTab()
  const savedA = await save(first, projectA, "project-a")
  const savedB = await save(second, projectB, "project-b")
  assert.equal(savedA.ok, true)
  assert.equal(savedB.ok, true)

  const snapshots = await second.listWebSnapshots()
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map((item) => item.projectId).sort(), [projectA, projectB].sort())

  const a = snapshots.find((item) => item.projectId === projectA)
  const b = snapshots.find((item) => item.projectId === projectB)
  assert.equal(await text(await second.loadWebSnapshot(a.id)), await text(projectBlob(projectA, 1, "project-a")))
  assert.equal(await text(await second.loadWebSnapshot(b.id)), await text(projectBlob(projectB, 1, "project-b")))
  assert.equal(a.mine, false)
  assert.equal(b.mine, true)
})

test("two tabs editing the same project keep diverging snapshots instead of overwriting", async () => {
  fake.drop(dbName)
  const tabA = await openTab()
  const tabB = await openTab()
  await save(tabA, projectA, "tab-a", { revision: 5, pageCount: 2 })
  await new Promise((resolve) => setTimeout(resolve, 2))
  await save(tabB, projectA, "tab-b", { revision: 2, pageCount: 1 })

  const snapshots = await tabA.listWebSnapshots()
  assert.equal(snapshots.length, 2, "the earlier tab snapshot must survive")
  assert.deepEqual(snapshots.map((item) => item.revision), [2, 5])
  const [newest, older] = snapshots
  assert.equal(await text(await tabA.loadWebSnapshot(newest.id)), await text(projectBlob(projectA, 1, "tab-b")))
  assert.equal(await text(await tabA.loadWebSnapshot(older.id)), await text(projectBlob(projectA, 2, "tab-a")))
  assert.deepEqual([newest.mine, older.mine], [false, true])
})

test("a reload of the same tab keeps the previous page snapshot recoverable", async () => {
  fake.drop(dbName)
  globalThis.sessionStorage = fakeSessionStorage("tab-shared-writer")
  // Both page instances write in the same millisecond, which is the only case
  // where a shared writer id could overwrite the older page's slot.
  const realNow = Date.now
  Date.now = () => 1790000000000
  try {
    const page1 = await openTab()
    await save(page1, projectA, "before-reload", { revision: 1 })
    const page2 = await openTab()
    await save(page2, projectA, "after-reload", { revision: 2 })

    const snapshots = await page2.listWebSnapshots()
    assert.equal(snapshots.length, 2, "the previous page instance keeps its own slot")
    assert.equal(snapshots.filter((item) => item.mine).length, 1)
    const bodies = await Promise.all(snapshots.map(async (item) => text(await page2.loadWebSnapshot(item.id))))
    assert.deepEqual(
      [...bodies].sort(),
      [await text(projectBlob(projectA, 1, "after-reload")), await text(projectBlob(projectA, 1, "before-reload"))].sort(),
    )
    const page3 = await openTab()
    await save(page3, projectA, "third-page", { revision: 3 })
    const after = await page3.listWebSnapshots()
    assert.equal(after.length, 3)
    const afterBodies = await Promise.all(after.map(async (item) => text(await page3.loadWebSnapshot(item.id))))
    assert.deepEqual(
      [...afterBodies].sort(),
      [...bodies, await text(projectBlob(projectA, 1, "third-page"))].sort(),
    )
    const page4 = await openTab()
    assert.deepEqual(await save(page4, projectA, "fourth", { revision: 4 }), { ok: false, reason: "project-capacity" })
    assert.deepEqual(await page3.listWebSnapshots(), after)
  } finally {
    Date.now = realNow
    delete globalThis.sessionStorage
  }
})

test("legacy latest records are migrated with identity, metadata and bytes", async () => {
  fake.drop(dbName)
  await ensureStores()
  const blob = projectBlob(projectA, 3, "legacy-payload")
  fake.seed(dbName, storeName, {
    latest: { blob, name: "phien-cu.khungthoai", pageCount: 3, savedAt: 1700000000000, size: blob.size },
  })
  fake.seed(dbName, fontStoreName, {
    "Font Cũ": { family: "Font Cũ", buffer: new ArrayBuffer(4), savedAt: 1700000000000 },
  })

  const tab = await openTab()
  const snapshots = await tab.listWebSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].projectId, projectA)
  assert.equal(snapshots[0].name, "phien-cu.khungthoai")
  assert.equal(snapshots[0].pageCount, 3)
  assert.equal(snapshots[0].savedAt, 1700000000000)
  assert.equal(snapshots[0].legacy, true)
  assert.equal(await text(await tab.loadWebSnapshot(snapshots[0].id)), await text(blob))
  assert.deepEqual([...fake.stores(dbName)[storeName].keys()].filter((key) => key === "latest"), [])
  assert.deepEqual(
    (await tab.listCustomFonts()).map((item) => item.family),
    ["Font Cũ"],
    "the font store is untouched by the snapshot migration",
  )
})

test("unreadable legacy records still recover and clear without leaving the old key", async () => {
  fake.drop(dbName)
  await ensureStores()
  fake.seed(dbName, storeName, {
    latest: { blob: new Blob(["not a project"]), name: "hong.khungthoai", pageCount: 0, savedAt: 1700000001000, size: 12 },
  })

  const tab = await openTab()
  const snapshots = await tab.listWebSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].projectId, null)
  assert.equal(snapshots[0].legacy, true)
  assert.equal(await text(await tab.loadWebSnapshot(snapshots[0].id)), "not a project")

  assert.equal(await tab.clearWebSnapshot(), true)
  assert.deepEqual(await tab.listWebSnapshots(), [])
  assert.deepEqual([...fake.stores(dbName)[storeName].keys()], [])
})

test("saving again replaces the page's own slot instead of growing the store", async () => {
  fake.drop(dbName)
  const tab = await openTab()
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => (clock += 10)
  try {
    const first = await save(tab, projectA, "first", { revision: 1 })
    const second = await save(tab, projectA, "second", { revision: 2 })

    const snapshots = await tab.listWebSnapshots()
    assert.equal(snapshots.length, 1, "one page instance owns exactly one slot")
    assert.equal(snapshots[0].id, second.id)
    assert.equal(snapshots[0].revision, 2)
    assert.equal(await text(await tab.loadWebSnapshot(second.id)), await text(projectBlob(projectA, 1, "second")))
    assert.equal(await tab.loadWebSnapshot(first.id), null, "the superseded write is gone")
    assert.equal(await tab.webSnapshotAvailable(first.id, { projectId: projectA, revision: 1 }), false)
    assert.equal(await tab.webSnapshotAvailable(second.id, { projectId: projectA, revision: 2 }), true)
  } finally {
    Date.now = realNow
  }
})

test("another writer's repeated saves never rotate out a slow tab's snapshot", async () => {
  fake.drop(dbName)
  const slow = await openTab()
  const fast = await openTab()
  const saved = await save(slow, projectA, "slow-tab", { revision: 1, pageCount: 2 })

  const realNow = Date.now
  let clock = realNow()
  Date.now = () => (clock += 10)
  try {
    // The fast tab keeps saving its own project, which used to evict the older
    // snapshot of the slow tab once the global or per-project cap was reached.
    for (let index = 0; index < 12; index += 1) await save(fast, projectB, `fast-${index}`, { revision: index + 1 })
  } finally {
    Date.now = realNow
  }

  const snapshots = await slow.listWebSnapshots()
  assert.equal(snapshots.length, 2, "one slot for each writer, nothing rotated")
  const kept = snapshots.find((item) => item.projectId === projectA)
  assert.equal(kept.id, saved.id)
  assert.equal(await text(await slow.loadWebSnapshot(kept.id)), await text(projectBlob(projectA, 2, "slow-tab")))
  assert.equal(snapshots.find((item) => item.projectId === projectB).revision, 12)
})

test("capacity that cannot be safely reclaimed is refused without touching stored snapshots", async () => {
  fake.drop(dbName)
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => (clock += 10)
  try {
    const tabs = await Promise.all(Array.from({ length: 9 }, () => openTab()))
    const projects = Array.from({ length: 8 }, () => crypto.randomUUID())
    const accepted = []
    for (let index = 0; index < 8; index += 1) {
      accepted.push(await save(tabs[index], projects[index], `project-${index}`))
    }
    assert.ok(accepted.every((item) => item.ok), "the first eight sessions fit")

    const before = await tabs[0].listWebSnapshots()
    const refused = await save(tabs[8], crypto.randomUUID(), "one-too-many")
    assert.deepEqual(refused, { ok: false, reason: "capacity" })
    const after = await tabs[0].listWebSnapshots()
    assert.deepEqual(after.map((item) => item.id), before.map((item) => item.id), "nothing was evicted")
    for (const item of before) assert.ok(await tabs[0].loadWebSnapshot(item.id), "every snapshot still loads")

    // The same tab can still save: its own slot is replaced, not added.
    const rewritten = await save(tabs[0], projects[0], "own-slot")
    assert.equal(rewritten.ok, true, "replacing an owned slot needs no new capacity")
    const rewrittenList = await tabs[0].listWebSnapshots()
    assert.equal(rewrittenList.length, 8)
    assert.ok(rewrittenList.some((item) => item.id === rewritten.id))
  } finally {
    Date.now = realNow
  }
})

test("a fourth session of one project is refused instead of replacing another tab", async () => {
  fake.drop(dbName)
  const tabs = await Promise.all(Array.from({ length: 4 }, () => openTab()))
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await save(tabs[index], projectA, `tab-${index}`, { revision: index + 1 })).ok, true)
  }
  const before = await tabs[0].listWebSnapshots()
  assert.equal(before.length, 3)

  const refused = await save(tabs[3], projectA, "fourth")
  assert.deepEqual(refused, { ok: false, reason: "project-capacity" })
  assert.deepEqual((await tabs[0].listWebSnapshots()).map((item) => item.id), before.map((item) => item.id))

  // Fresh saves from an accepted session still work while the project is full.
  assert.equal((await save(tabs[1], projectA, "tab-1-again", { revision: 9 })).ok, true)
  assert.equal((await tabs[0].listWebSnapshots()).length, 3)
})

test("records written by the previous candidate are readable, counted and never replaced", async () => {
  fake.drop(dbName)
  await ensureStores()
  // The earlier draft keyed each write by timestamp and writer only, so a reader
  // must still understand those keys and treat them as another session.
  const oldKey = `snapshot:01790000000000:${projectA}:55555555-6666-7777-8888-999999999999`
  const oldBlob = projectBlob(projectA, 2, "older-candidate")
  fake.seed(dbName, storeName, {
    [oldKey]: {
      schema: 1,
      blob: oldBlob,
      projectId: projectA,
      name: "cu.khungthoai",
      pageCount: 2,
      savedAt: 1790000000000,
      size: oldBlob.size,
      writer: "55555555-6666-7777-8888-999999999999",
      revision: 4,
      generation: 0,
      legacy: false,
      shared: true,
    },
    [`meta:${oldKey.slice("snapshot:".length)}`]: {
      schema: 1,
      id: oldKey,
      projectId: projectA,
      name: "cu.khungthoai",
      pageCount: 2,
      savedAt: 1790000000000,
      size: oldBlob.size,
      writer: "55555555-6666-7777-8888-999999999999",
      revision: 4,
      legacy: false,
      shared: true,
    },
  })

  const tab = await openTab()
  const snapshots = await tab.listWebSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].id, oldKey)
  assert.equal(await text(await tab.loadWebSnapshot(oldKey)), await text(oldBlob))

  // A new session of the same project has no claim on that record.
  const saved = await save(tab, projectA, "current", { revision: 1 })
  assert.equal(saved.ok, true)
  const both = await tab.listWebSnapshots()
  assert.deepEqual(both.map((item) => item.id).sort(), [oldKey, saved.id].sort())
})

test("an old connection blocks the upgrade, reports it, and recovers after it closes", async () => {
  fake.drop(dbName)
  await new Promise((resolve) => {
    const request = fake.indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      if (!db.objectStoreNames.contains(fontStoreName)) db.createObjectStore(fontStoreName)
    }
    request.onsuccess = () => resolve(request.result)
  }).then((connection) => {
    globalThis.blockingConnection = connection
  })

  const tab = await openTab()
  const blocked = await save(tab, projectA, "blocked")
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, "blocked")
  assert.equal(tab.webStorageState().blocked, true)

  globalThis.blockingConnection.close()
  delete globalThis.blockingConnection
  const recovered = await save(tab, projectA, "after-unblock")
  assert.equal(recovered.ok, true)
  assert.equal((await tab.listWebSnapshots()).length, 1)
})

test("a schema upgrade in another connection detaches this tab without throwing", async () => {
  fake.drop(dbName)
  const tab = await openTab()
  assert.equal((await save(tab, projectA, "before-upgrade")).ok, true)

  await new Promise((resolve) => {
    const request = fake.indexedDB.open(dbName, 3)
    request.onupgradeneeded = () => {}
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => resolve()
  })

  assert.equal(tab.webStorageState().blocked, false)
  const afterUpgrade = await save(tab, projectA, "after-upgrade")
  assert.equal(afterUpgrade.ok, false)
  assert.equal(afterUpgrade.reason, "unavailable")
  assert.equal(tab.webStorageState().supported, true)
})

test("custom fonts stay readable next to namespaced snapshots", async () => {
  fake.drop(dbName)
  const tab = await openTab()
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer
  assert.equal(await tab.saveCustomFont("Font Mới", buffer), true)
  assert.equal((await save(tab, projectB, "with-font")).ok, true)

  const fonts = await tab.listCustomFonts()
  assert.equal(fonts.length, 1)
  assert.equal(fonts[0].family, "Font Mới")
  assert.equal(fonts[0].buffer.byteLength, 4)
  assert.equal(await tab.deleteCustomFont("Font Mới"), true)
  assert.deepEqual(await tab.listCustomFonts(), [])
})

test("listing without IndexedDB degrades to no snapshots instead of throwing", async () => {
  const indexedDb = globalThis.indexedDB
  globalThis.indexedDB = undefined
  try {
    const tab = await openTab()
    assert.deepEqual(await tab.listWebSnapshots(), [])
    const saved = await tab.saveWebSnapshot(new Blob(["x"]), { name: "x.khungthoai" })
    assert.equal(saved.ok, false)
    assert.equal(saved.reason, "unsupported")
    assert.equal(await tab.loadWebSnapshot(), null)
    assert.equal(await tab.clearWebSnapshot(), false)
    assert.deepEqual(tab.webStorageState(), { supported: false, blocked: false })
  } finally {
    globalThis.indexedDB = indexedDb
  }
})

test("a saved marker is only confirmed for the exact stored revision", async () => {
  fake.drop(dbName)
  const tab = await openTab()
  const saved = await tab.saveWebSnapshot(projectBlob(projectA, 1, "marker"), {
    projectId: projectA,
    name: "a.khungthoai",
    pageCount: 1,
    revision: 4,
    generation: 2,
  })
  assert.equal(await tab.webSnapshotAvailable(saved.id, { projectId: projectA, revision: 4, generation: 2 }), true)
  assert.equal(await tab.webSnapshotAvailable(saved.id, { projectId: projectA, revision: 5 }), false, "a newer edit is not covered")
  assert.equal(await tab.webSnapshotAvailable(saved.id, { projectId: projectA, revision: 4, generation: 3 }), false, "a newer page instance is not covered")
  assert.equal(await tab.webSnapshotAvailable(saved.id, { projectId: projectB, revision: 4 }), false, "another project is not covered")
  assert.equal(await tab.webSnapshotAvailable("snapshot:missing", { revision: 4 }), false)
  assert.equal(await tab.webSnapshotAvailable(null), false)
})
