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
  // where a shared writer id could overwrite the older slot.
  const realNow = Date.now
  Date.now = () => 1790000000000
  try {
    const page1 = await openTab()
    await save(page1, projectA, "before-reload", { revision: 1 })
    const page2 = await openTab()
    await save(page2, projectA, "after-reload", { revision: 2 })

    const snapshots = await page2.listWebSnapshots()
    assert.equal(snapshots.length, 2)
    assert.ok(snapshots.every((item) => item.mine), "the tab reuses one writer id")
    const loaded = await Promise.all(
      snapshots.map(async (item) => ({ shared: item.shared, body: await text(await page2.loadWebSnapshot(item.id)) })),
    )
    assert.deepEqual(
      loaded.map((item) => item.body).sort(),
      [await text(projectBlob(projectA, 1, "after-reload")), await text(projectBlob(projectA, 1, "before-reload"))].sort(),
    )
    assert.equal(loaded.filter((item) => item.shared).length, 1, "only the newer page moved to its own slot")
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

test("the snapshot store is bounded per project and overall", async () => {
  fake.drop(dbName)
  const tab = await openTab()
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => (clock += 10)
  try {
    for (let index = 0; index < 5; index += 1) await save(tab, projectA, `a${index}`, { revision: index + 1 })
    let snapshots = await tab.listWebSnapshots()
    assert.equal(snapshots.length, 3, "at most three snapshots per project")
    assert.deepEqual(snapshots.map((item) => item.revision), [5, 4, 3])

    const others = Array.from({ length: 6 }, (_, index) => crypto.randomUUID())
    for (const projectId of others) await save(tab, projectId, "other")
    snapshots = await tab.listWebSnapshots()
    assert.equal(snapshots.length, 8, "at most eight snapshots overall")
    const projects = new Set(snapshots.map((item) => item.projectId))
    assert.deepEqual([...projects].sort(), [projectA, ...others].sort().filter((id, index, all) => all.indexOf(id) === index))
  } finally {
    Date.now = realNow
  }
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
