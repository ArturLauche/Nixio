// In-memory IndexedDB subset for the Node test runner. It models the parts
// src/web-storage.js relies on: versioned opens with onblocked/onversionchange,
// readwrite transactions serialized per database, key ranges and cursors.
// Real same-origin behaviour between tabs is covered by
// scripts/autosave-browser.mjs instead.

function copy(value) {
  if (value === null || typeof value !== "object") return value
  if (typeof Blob !== "undefined" && value instanceof Blob) return value
  if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return value
  if (Array.isArray(value)) return value.map(copy)
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = copy(item)
  return result
}

function matchRange(range, key) {
  if (!range) return true
  if (range.lower !== undefined && key < range.lower) return false
  if (range.upper !== undefined && key > range.upper) return false
  return true
}

export function createFakeIndexedDB({ schedule = (run) => queueMicrotask(run) } = {}) {
  const databases = new Map()

  const database = (name) => {
    let record = databases.get(name)
    if (!record) {
      record = { version: 0, stores: new Map(), connections: new Set(), waiting: [], writeTail: Promise.resolve() }
      databases.set(name, record)
    }
    return record
  }

  function finish(tx) {
    if (tx.done || tx.aborted) return
    if (tx.pending > 0 || tx.queue.length) return
    schedule(() => {
      if (tx.done || tx.aborted || tx.pending > 0 || tx.queue.length) return
      tx.done = true
      tx.release?.()
      tx.oncomplete?.()
    })
  }

  function createTransaction(tx, data) {
    const readOnly = tx.mode === "readonly"
    const defer = (run) => {
      if (readOnly || tx.gateOpen) run()
      else tx.queue.push(run)
    }
    const request = (work) => {
      const req = { onsuccess: null, onerror: null, result: undefined, error: null }
      tx.pending++
      defer(() =>
        schedule(() => {
          try {
            req.result = work()
          } catch (error) {
            req.error = error
            tx.error = error
            tx.pending--
            tx.onerror?.()
            return
          }
          req.onsuccess?.()
          tx.pending--
          finish(tx)
        }),
      )
      return req
    }
    const cursorRequest = (withValue) => {
      const req = { onsuccess: null, onerror: null, result: undefined, error: null }
      const keys = [...data.keys()].filter((key) => matchRange(tx.range, key)).sort()
      let index = 0
      const deliver = () => {
        const key = keys[index++]
        if (key === undefined) {
          req.result = null
          req.onsuccess?.()
          return
        }
        const cursor = { key, primaryKey: key, value: withValue ? copy(data.get(key)) : undefined }
        cursor.continue = () => {
          tx.pending++
          defer(() =>
            schedule(() => {
              deliver()
              tx.pending--
              finish(tx)
            }),
          )
        }
        req.result = cursor
        req.onsuccess?.()
      }
      tx.pending++
      defer(() =>
        schedule(() => {
          deliver()
          tx.pending--
          finish(tx)
        }),
      )
      return req
    }
    return {
      range: tx.range,
      get: (key) => request(() => copy(data.get(key))),
      put: (value, key) =>
        request(() => {
          if (readOnly) throw new Error("ReadOnlyError")
          data.set(key, copy(value))
          return key
        }),
      delete: (key) =>
        request(() => {
          if (readOnly) throw new Error("ReadOnlyError")
          data.delete(key)
        }),
      getAll: () => request(() => [...data.values()].map(copy)),
      getAllKeys: () => request(() => [...data.keys()].sort()),
      openCursor: (range) => {
        tx.range = range
        return cursorRequest(true)
      },
      openKeyCursor: (range) => {
        tx.range = range
        return cursorRequest(false)
      },
    }
  }

  function createDatabase(name, record) {
    const connection = {
      name,
      get version() {
        return record.version
      },
      objectStoreNames: {
        contains: (store) => record.stores.has(store),
        get length() {
          return record.stores.size
        },
      },
      createObjectStore(store) {
        if (record.stores.has(store)) throw new Error("ConstraintError")
        record.stores.set(store, new Map())
        return { name: store }
      },
      transaction(stores, mode = "readonly") {
        const names = Array.isArray(stores) ? stores : [stores]
        for (const store of names) if (!record.stores.has(store)) throw new Error("NotFoundError")
        if (!names.length) throw new Error("InvalidAccessError")
        const tx = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          pending: 0,
          done: false,
          aborted: false,
          queue: [],
          gateOpen: mode === "readonly",
          objectStore(store) {
            return createTransaction(tx, record.stores.get(store))
          },
          abort() {
            if (tx.done || tx.aborted) return
            tx.aborted = true
            tx.release?.()
            schedule(() => tx.onabort?.())
          },
        }
        if (mode !== "readonly") {
          const previous = record.writeTail
          let release
          tx.gate = new Promise((resolve) => {
            release = resolve
          })
          tx.release = () => release()
          record.writeTail = previous.then(() => tx.gate)
          previous.then(() => {
            if (tx.aborted || tx.done) {
              tx.release()
              return
            }
            tx.gateOpen = true
            for (const run of tx.queue.splice(0)) run()
            finish(tx)
          })
        }
        return tx
      },
      close() {
        if (!record.connections.delete(connection)) return
        drain(name, record)
      },
      onversionchange: null,
      onclose: null,
    }
    record.connections.add(connection)
    return connection
  }

  function install(name, record, request, wanted) {
    const upgrade = wanted > record.version
    record.version = wanted
    const connection = createDatabase(name, record)
    schedule(() => {
      request.result = connection
      if (upgrade) request.onupgradeneeded?.()
      schedule(() => request.onsuccess?.())
    })
  }

  function drain(name, record) {
    if (record.connections.size) return
    const next = record.waiting.shift()
    if (!next) return
    install(name, record, next.request, next.wanted)
  }

  function open(name, version) {
    const request = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
      result: undefined,
      error: null,
      transaction: null,
    }
    const record = database(name)
    const wanted = version ?? (record.version || 1)
    if (wanted < record.version) {
      request.error = new Error("VersionError")
      schedule(() => request.onerror?.())
      return request
    }
    if (wanted > record.version && record.connections.size) {
      for (const connection of record.connections) schedule(() => connection.onversionchange?.())
      record.waiting.push({ request, wanted })
      schedule(() => {
        if (record.connections.size) request.onblocked?.()
        else drain(name, record)
      })
      return request
    }
    install(name, record, request, wanted)
    return request
  }

  const indexedDB = {
    open,
    deleteDatabase(name) {
      const request = { onsuccess: null, onerror: null, onblocked: null, result: undefined, error: null }
      const record = databases.get(name)
      if (record && record.connections.size) {
        for (const connection of record.connections) schedule(() => connection.onversionchange?.())
        request.error = new Error("BlockedError")
        schedule(() => request.onerror?.())
        return request
      }
      databases.delete(name)
      schedule(() => request.onsuccess?.())
      return request
    },
  }

  const IDBKeyRange = {
    bound: (lower, upper) => ({ lower, upper }),
    only: (value) => ({ lower: value, upper: value }),
    lowerBound: (lower) => ({ lower, upper: undefined }),
    upperBound: (upper) => ({ lower: undefined, upper }),
  }

  return {
    indexedDB,
    IDBKeyRange,
    reset() {
      for (const record of databases.values()) {
        for (const store of record.stores.values()) store.clear()
      }
    },
    // Forgets the database entirely, like a fresh origin.
    drop(name) {
      databases.delete(name)
    },
    // Direct seeding/dumping so tests can build records an older build wrote.
    seed(name, store, entries) {
      const record = database(name)
      const data = record.stores.get(store)
      if (!data) throw new Error(`Unknown store ${store}`)
      for (const [key, value] of Object.entries(entries)) data.set(key, copy(value))
    },
    stores(name) {
      const record = database(name)
      return Object.fromEntries([...record.stores].map(([store, data]) => [store, new Map(data)]))
    },
    version(name) {
      return database(name).version
    },
    connections(name) {
      return database(name).connections.size
    },
  }
}
