import { readProjectIdentity } from "./project.js"

const dbName = "khung-thoai-autosave"
const dbVersion = 2
const storeName = "snapshots"
const fontStoreName = "fonts"
// Records written before this module kept a single fixed key. They are migrated
// into the namespaced layout on first use and then removed.
const legacyKey = "latest"
const schema = 2
const blobPrefix = "snapshot:"
const metaPrefix = "meta:"
const maxSnapshots = 8
const maxSnapshotsPerProject = 3
const writerStorageKey = "khung-thoai:web-writer"
const channelName = "khung-thoai-autosave"

let connection = null
let migration = null
let blocked = false
let writerId = null
let epochId = null
let channel = null
let channelReady = false
const listeners = new Set()

function validWriter(value) {
  return typeof value === "string" && /^[0-9a-z-]{8,64}$/i.test(value)
}

// A tab keeps one writer id for its whole session so reloading reuses the same
// snapshot slot, while a separate tab (or a duplicated tab that shares
// sessionStorage) is detected through the per-page epoch.
function writer() {
  if (writerId) return writerId
  try {
    const stored = globalThis.sessionStorage?.getItem(writerStorageKey)
    if (validWriter(stored)) return (writerId = stored)
  } catch {
    // Private browsing can refuse sessionStorage.
  }
  writerId = crypto.randomUUID()
  try {
    globalThis.sessionStorage?.setItem(writerStorageKey, writerId)
  } catch {
    // The id only needs to live as long as this page.
  }
  return writerId
}

function epoch() {
  return (epochId ??= crypto.randomUUID())
}

export function webWriterId() {
  return writer()
}

function stamp(value) {
  return String(Math.max(0, Math.floor(value))).padStart(14, "0")
}

function snapshotKey(savedAt, projectId, owner, page) {
  return `${blobPrefix}${stamp(savedAt)}:${projectId || "legacy"}:${owner}${page ? ":" + page : ""}`
}

function metaKey(key) {
  return metaPrefix + key.slice(blobPrefix.length)
}

function parseSnapshotKey(key) {
  if (typeof key !== "string" || !key.startsWith(blobPrefix)) return null
  const [stampValue, projectKey, owner, page] = key.slice(blobPrefix.length).split(":")
  const savedAt = Number(stampValue)
  if (!Number.isFinite(savedAt) || !projectKey) return null
  return { savedAt, projectKey, writer: owner ?? "", epoch: page ?? "" }
}

function metaRecord(record, key) {
  return {
    schema,
    id: key,
    projectId: record.projectId ?? null,
    name: record.name,
    pageCount: record.pageCount,
    savedAt: record.savedAt,
    size: record.size,
    writer: record.writer,
    revision: record.revision,
    legacy: Boolean(record.legacy),
    shared: Boolean(record.shared),
  }
}

function changeChannel() {
  if (channelReady) return channel
  channelReady = true
  try {
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(channelName)
      channel.onmessage = () => {
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            // A failing listener must not break the others.
          }
        }
      }
      channel.unref?.()
    }
  } catch {
    channel = null
  }
  return channel
}

function emitChange() {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A failing listener must not break the others.
    }
  }
  try {
    changeChannel()?.postMessage({ type: "snapshots" })
  } catch {
    // Messaging is best effort; the recovery list also refreshes on focus.
  }
}

export function onWebSnapshotsChanged(listener) {
  if (typeof listener !== "function") return () => {}
  listeners.add(listener)
  changeChannel()
  return () => listeners.delete(listener)
}

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  if (connection) return connection
  const pending = new Promise((resolve) => {
    let settled = false
    const settle = (db) => {
      if (settled) return
      settled = true
      resolve(db)
    }
    let request
    blocked = false
    try {
      request = indexedDB.open(dbName, dbVersion)
    } catch {
      settle(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
      if (!db.objectStoreNames.contains(fontStoreName)) db.createObjectStore(fontStoreName)
    }
    // Another tab holds an older connection open: report the state instead of
    // hanging, so the caller can tell the user which tab to close.
    request.onblocked = () => {
      blocked = true
      settle(null)
    }
    request.onerror = () => settle(null)
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        try {
          db.close()
        } catch {
          // Already closing.
        }
        return
      }
      db.onversionchange = () => {
        try {
          db.close()
        } catch {
          // Already closing.
        }
        if (connection === pending) connection = null
        migration = null
        emitChange()
      }
      db.onclose = () => {
        if (connection === pending) connection = null
        migration = null
      }
      settle(db)
    }
  })
  connection = pending
  pending.then((db) => {
    if (!db && connection === pending) connection = null
  })
  return pending
}

function transaction(db, mode, run) {
  return new Promise((resolve) => {
    let tx
    try {
      tx = db.transaction(storeName, mode)
    } catch {
      resolve(null)
      return
    }
    const store = tx.objectStore(storeName)
    let result = null
    const capture = (value) => {
      result = value
    }
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => resolve(null)
    tx.onabort = () => resolve(null)
    try {
      run(store, capture)
    } catch {
      try {
        tx.abort()
      } catch {
        // Already finished.
      }
      resolve(null)
    }
  })
}

function readRecord(db, key) {
  return transaction(db, "readonly", (store, capture) => {
    const request = store.get(key)
    request.onsuccess = () => capture(request.result ?? null)
    request.onerror = () => capture(null)
  })
}

function writeSnapshot(db, record, key) {
  return transaction(db, "readwrite", (store, capture) => {
    const write = (target) => {
      store.put(record, target)
      store.put(metaRecord(record, target), metaKey(target))
      capture(target)
    }
    const existing = store.get(key)
    existing.onsuccess = () => {
      const previous = existing.result
      // A duplicated tab shares our writer id but runs a different page
      // instance: keep its snapshot in a separate, recoverable slot.
      const collides = previous && previous.epoch && record.epoch && previous.epoch !== record.epoch
      if (collides) record.shared = true
      write(collides ? key + ":" + record.epoch : key)
    }
    existing.onerror = () => write(key)
  })
}

function listMeta(db) {
  return transaction(db, "readonly", (store, capture) => {
    const items = []
    capture(items)
    const cursor = store.openCursor(IDBKeyRange.bound(metaPrefix, metaPrefix + "\uffff"))
    cursor.onsuccess = () => {
      const point = cursor.result
      if (!point) return
      if (point.value && typeof point.value === "object") items.push({ ...point.value, key: point.primaryKey })
      point.continue()
    }
  })
}

function snapshotKeys(db) {
  return transaction(db, "readonly", (store, capture) => {
    const keys = []
    capture(keys)
    const cursor = store.openKeyCursor(IDBKeyRange.bound(blobPrefix, blobPrefix + "\uffff"))
    cursor.onsuccess = () => {
      const point = cursor.result
      if (!point) return
      keys.push(point.primaryKey)
      point.continue()
    }
  })
}

async function prune(db, keepKey) {
  const keys = await snapshotKeys(db)
  if (!keys?.length) return
  const entries = keys
    .map((key) => ({ key, parts: parseSnapshotKey(key) }))
    .filter((entry) => entry.parts)
    .sort((a, b) => b.parts.savedAt - a.parts.savedAt)
  const keep = entries.find((entry) => entry.key === keepKey)
  const kept = []
  const perProject = new Map()
  const drop = []
  if (keep) {
    kept.push(keep)
    perProject.set(keep.parts.projectKey, 1)
  }
  for (const entry of entries) {
    if (entry.key === keepKey) continue
    const used = perProject.get(entry.parts.projectKey) ?? 0
    if (kept.length >= maxSnapshots || used >= maxSnapshotsPerProject) {
      drop.push(entry.key)
      continue
    }
    kept.push(entry)
    perProject.set(entry.parts.projectKey, used + 1)
  }
  if (!drop.length) return
  await transaction(db, "readwrite", (store) => {
    for (const key of drop) {
      store.delete(key)
      store.delete(metaKey(key))
    }
  })
}

async function migrateLegacy(db) {
  const record = await readRecord(db, legacyKey)
  if (!record?.blob) return
  const identity = await readProjectIdentity(record.blob)
  const savedAt = Number.isFinite(record.savedAt) && record.savedAt > 0 ? record.savedAt : Date.now()
  const migrated = {
    schema,
    blob: record.blob,
    projectId: identity?.projectId ?? null,
    name: typeof record.name === "string" && record.name ? record.name : "phien-web.khungthoai",
    pageCount: Number.isFinite(record.pageCount) ? record.pageCount : (identity?.pageCount ?? 0),
    savedAt,
    size: record.blob.size,
    writer: "legacy",
    epoch: "",
    revision: 0,
    generation: 0,
    legacy: true,
    shared: false,
  }
  const key = snapshotKey(savedAt, migrated.projectId, "legacy")
  const written = await transaction(db, "readwrite", (store, capture) => {
    store.put(migrated, key)
    store.put(metaRecord(migrated, key), metaKey(key))
    store.delete(legacyKey)
    capture(key)
  })
  if (written) await prune(db, written)
}

async function ready() {
  const db = await openDb()
  if (!db) return null
  if (!migration) migration = migrateLegacy(db).catch(() => {})
  await migration
  return db
}

function failureReason() {
  if (typeof indexedDB === "undefined") return "unsupported"
  return blocked ? "blocked" : "unavailable"
}

export function webStorageState() {
  return { supported: typeof indexedDB !== "undefined", blocked }
}

export async function saveWebSnapshot(blob, meta = {}) {
  if (!blob) return { ok: false, reason: "error" }
  const db = await ready()
  if (!db) return { ok: false, reason: failureReason() }
  const savedAt = Date.now()
  let projectId = typeof meta.projectId === "string" && meta.projectId ? meta.projectId : null
  if (!projectId) projectId = (await readProjectIdentity(blob))?.projectId ?? null
  const record = {
    schema,
    blob,
    projectId,
    name: meta.name || "phien-web.khungthoai",
    pageCount: Number.isFinite(meta.pageCount) ? meta.pageCount : 0,
    savedAt,
    size: blob.size,
    writer: writer(),
    epoch: epoch(),
    revision: Number.isFinite(meta.revision) ? meta.revision : 0,
    generation: Number.isFinite(meta.generation) ? meta.generation : 0,
    legacy: false,
    shared: false,
  }
  const key = await writeSnapshot(db, record, snapshotKey(savedAt, projectId, record.writer))
  if (!key) return { ok: false, reason: "error" }
  await prune(db, key)
  emitChange()
  return { ok: true, id: key, savedAt }
}

export async function listWebSnapshots() {
  const db = await ready()
  if (!db) return []
  const metas = await listMeta(db)
  return (metas ?? [])
    .filter((item) => typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      projectId: item.projectId ?? null,
      name: item.name || "phien-web.khungthoai",
      pageCount: Number.isFinite(item.pageCount) ? item.pageCount : 0,
      savedAt: Number.isFinite(item.savedAt) ? item.savedAt : 0,
      size: Number.isFinite(item.size) ? item.size : 0,
      revision: Number.isFinite(item.revision) ? item.revision : 0,
      legacy: Boolean(item.legacy),
      shared: Boolean(item.shared),
      writer: item.writer ?? null,
      mine: item.writer === writer(),
    }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

export async function loadWebSnapshot(id) {
  const db = await ready()
  if (!db) return null
  let target = typeof id === "string" && id ? id : (await listWebSnapshots())[0]?.id ?? null
  if (!target) return null
  const record = await readRecord(db, target)
  if (!record?.blob) return null
  const file = new File([record.blob], record.name || "phien-web.khungthoai", { type: "application/octet-stream" })
  file.recovery = true
  file.snapshotId = target
  if (record.projectId) file.projectId = record.projectId
  return file
}

export async function clearWebSnapshot(id) {
  const db = await ready()
  if (!db) return false
  let targets
  let includeLegacy = false
  if (typeof id === "string" && id) targets = [id]
  else {
    targets = (await snapshotKeys(db)) ?? []
    includeLegacy = true
  }
  if (!targets.length && !includeLegacy) return false
  const cleared = await transaction(db, "readwrite", (store, capture) => {
    for (const key of targets) {
      store.delete(key)
      store.delete(metaKey(key))
    }
    if (includeLegacy) store.delete(legacyKey)
    capture(true)
  })
  if (cleared) emitChange()
  return Boolean(cleared)
}

export async function clearWebSnapshotsForProject(projectId) {
  if (!projectId) return false
  const db = await ready()
  if (!db) return false
  const keys = (await snapshotKeys(db)) ?? []
  const targets = keys.filter((key) => parseSnapshotKey(key)?.projectKey === projectId)
  if (!targets.length) return true
  const cleared = await transaction(db, "readwrite", (store, capture) => {
    for (const key of targets) {
      store.delete(key)
      store.delete(metaKey(key))
    }
    capture(true)
  })
  if (cleared) emitChange()
  return Boolean(cleared)
}

export async function saveCustomFont(family, buffer) {
  const db = await ready()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(fontStoreName, "readwrite")
      tx.objectStore(fontStoreName).put({ family, buffer, savedAt: Date.now() }, family)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

export async function listCustomFonts() {
  const db = await ready()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(fontStoreName, "readonly")
      const req = tx.objectStore(fontStoreName).getAll()
      req.onsuccess = () => {
        const items = Array.isArray(req.result) ? req.result : []
        resolve(items.filter((item) => item?.family && item.buffer))
      }
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

export async function deleteCustomFont(family) {
  const db = await ready()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(fontStoreName, "readwrite")
      tx.objectStore(fontStoreName).delete(family)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}
