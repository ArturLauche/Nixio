import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { NotificationStore, createNotificationCenter } from "../src/notifications.js"

test("NotificationStore adds, deduplicates by key, caps visible/history, and tracks unread", () => {
  const store = new NotificationStore({ maxItems: 5, maxVisible: 2 })
  let events = 0
  store.subscribe(() => { events++ })

  const a = store.add({ kind: "info", title: "A", message: "first", key: "k1" })
  assert.ok(a)
  assert.equal(store.unreadCount(), 1)
  assert.equal(store.snapshot().visible.length, 1)

  // Updating with same key replaces in place without growing list
  const a2 = store.add({ kind: "warning", title: "A2", message: "updated", key: "k1" })
  assert.equal(a2.id, a.id)
  assert.equal(store.snapshot().items.length, 1)
  assert.equal(store.snapshot().items[0].title, "A2")

  store.add({ kind: "success", title: "B", message: "second" })
  store.add({ kind: "error", title: "C", message: "third" })
  assert.equal(store.snapshot().items.length, 3)
  assert.equal(store.snapshot().visible.length, 2) // capped at maxVisible=2
  assert.equal(store.unreadCount(), 3)

  // Silent toast goes to history/unread without appearing in visible toasts
  const silent = store.add({ kind: "info", title: "Silent", message: "bg", silentToast: true })
  assert.equal(store.snapshot().visible.some((v) => v.id === silent.id), false)
  assert.equal(store.snapshot().items[0].id, silent.id)

  store.markRead(silent.id)
  assert.equal(store.unreadCount(), 3)

  store.markAllRead()
  assert.equal(store.unreadCount(), 0)

  store.dismissToast(store.snapshot().visible[0].id)
  assert.equal(store.snapshot().visible.length, 1)

  store.clearAll()
  assert.equal(store.snapshot().items.length, 0)
  assert.equal(store.snapshot().visible.length, 0)
  assert.ok(events > 0)
})

function fakeElement() {
  const element = {
    children: [],
    hidden: false,
    textContent: "",
    className: "",
    hovered: false,
    matches(selector) { return selector === ":hover" && element.hovered },
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    setAttribute() {},
    getAttribute() {},
  }
  return element
}

function installToastDocument() {
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement())
    return elements.get(id)
  }
  globalThis.document = {
    createElement: () => fakeElement(),
    addEventListener() {},
  }
  return { byId, elements }
}

test("a keyed update restarts the toast hide timer with the new duration", () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const { byId } = installToastDocument()
    const store = new NotificationStore()
    const center = createNotificationCenter({ byId, store })

    center.notify({ key: "app-update", kind: "success", title: "Đã cập nhật", message: "bản mới nhất", durationMs: 4500 })
    const updated = center.notify({ key: "app-update", kind: "error", title: "Lỗi cập nhật", message: "thử lại", durationMs: 9000 })
    assert.equal(store.snapshot().items.length, 1, "the keyed update replaces the item")

    mock.timers.tick(4500)
    assert.equal(store.snapshot().visible[0]?.id, updated.id, "the updated toast keeps its new, longer lifetime")

    mock.timers.tick(4500)
    assert.equal(store.snapshot().visible.length, 0, "the restarted timer dismisses it after the full duration")
  } finally {
    mock.timers.reset()
  }
})

test("a re-render resumes the hide timer of a hovered toast that lost its pointer", () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const { byId } = installToastDocument()
    const store = new NotificationStore()
    const center = createNotificationCenter({ byId, store })
    const toastContainer = byId("toast-container")

    const item = center.notify({ kind: "error", title: "Lỗi dịch", message: "thử lại", durationMs: 9000 })
    const mounted = toastContainer.children[0]
    mounted.onmouseenter()
    mock.timers.tick(9000)
    assert.equal(store.snapshot().visible.length, 1, "hover pauses the hide timer")

    store.markRead(item.id)
    assert.notEqual(toastContainer.children[0], mounted, "the re-render mounts a fresh card")
    mock.timers.tick(9000)
    assert.equal(store.snapshot().visible.length, 0, "a re-render must not pin a toast forever")
  } finally {
    mock.timers.reset()
  }
})

test("a re-rendered toast stays paused while the pointer is still over the fresh card", () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const { byId } = installToastDocument()
    const store = new NotificationStore()
    const center = createNotificationCenter({ byId, store })
    const toastContainer = byId("toast-container")
    document.createElement = () => {
      const element = fakeElement()
      element.hovered = true
      return element
    }

    const item = center.notify({ kind: "warning", title: "Chậm", message: "đang chờ", durationMs: 7500 })
    store.markRead(item.id)
    mock.timers.tick(7500)
    assert.equal(store.snapshot().visible.length, 1, "the mounted card still reports hover")

    const card = toastContainer.children[0]
    card.hovered = false
    card.onmouseleave()
    mock.timers.tick(7500)
    assert.equal(store.snapshot().visible.length, 0, "leaving the fresh card restarts the timer")
  } finally {
    mock.timers.reset()
  }
})
