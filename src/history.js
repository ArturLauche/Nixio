import { shareInpaintOrigins } from "./retouch.js"

// Images and Files stay shared. Only editable data is copied into history.
export function copyEditor(editor) {
  return {
    ...structuredClone({ ...editor, pages: undefined }),
    pages: editor.pages.map(({ image, file, url, ...data }) => {
      const copy = structuredClone(data)
      shareInpaintOrigins(data.retouchStrokes, copy.retouchStrokes)
      return { ...copy, image, file, url }
    }),
  }
}

// Every action is named so the timeline and the one-click undo can address it. The UI stage
// supplies real labels; this fallback covers the checkpoints that do not name themselves yet.
export const DEFAULT_ACTION_LABEL = "Chỉnh sửa"

// Jump target for the newest boundary: the state after every recorded action.
export const HISTORY_HEAD = "head"

// Jump target for the oldest boundary: the state before the oldest recorded action. No row can
// name it, because a row always names the state after its own action.
export const HISTORY_START = "start"

function actionLabel(token) {
  return token?.label ? `"${token.label}"` : "thao tác này"
}

// Vietnamese copy for a one-click undo that no longer addresses the newest action.
function refuse(reason, token) {
  const label = actionLabel(token)
  const messages = {
    missing: `Không còn ${label} trong lịch sử hoàn tác.`,
    busy: `Chưa thể hoàn tác ${label} vì đang có tác vụ khác chạy. Hãy đợi tác vụ xong rồi thử lại.`,
    gesturing: `Chưa thể hoàn tác ${label} khi đang kéo/thao tác trên ảnh. Hãy kết thúc thao tác đó rồi thử lại.`,
    pending: `Chưa thể hoàn tác ${label} khi còn chỉnh sửa chưa lưu. Hãy hoàn tất chỉnh sửa đó, hoặc dùng Ctrl+Z để hoàn tác thay đổi gần nhất.`,
    undone: `Thao tác ${label} đã được hoàn tác rồi. Nhấn Ctrl+Y nếu muốn làm lại.`,
    rewound: `Lịch sử đã được hoàn tác/làm lại sau ${label} nên không thể hoàn tác một chạm. Nhấn Ctrl+Z nếu muốn hoàn tác thay đổi gần nhất.`,
    superseded: `Đã có chỉnh sửa khác sau ${label} nên không thể hoàn tác một chạm. Nhấn Ctrl+Z nếu muốn hoàn tác thay đổi gần nhất.`,
  }
  return { ok: false, reason, message: messages[reason] ?? messages.missing }
}

// Timeline search folds Vietnamese diacritics so "lam sach" still finds "Làm sạch".
function fold(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
}

// Every entry carries a session-durable id, a name, a timestamp and a boundary snapshot, so a
// notification or a timeline row can address one exact action instead of a stack depth.
//
// Playhead contract: `past` lists applied actions oldest-first and `future` is a stack whose last
// entry is the next redo. An entry's snapshot is always the boundary state it owns:
//   - in `past` it is the state immediately BEFORE the action;
//   - in `future` it is the state immediately AFTER the action.
// Moving an action between the stacks rewrites that boundary, which is why the id, label, kind,
// timestamp and group travel with the entry while the snapshot is recomputed. A label therefore
// names the action, and the timeline position it addresses is the state just before that action
// runs: jump() restores "everything up to, but not including, the named action".
let historyInstances = 0

export class EditHistory {
  constructor(limit = 40, { now = Date.now } = {}) {
    this.limit = limit
    this.past = []
    this.future = []
    this.revision = 0
    this.sessionId = ++historyInstances
    this.actionSeq = 0
    this.now = now
    this.openGroup = ""
  }

  makeEntry(editor, { label = "", kind = "", at, group = "" } = {}, id = "") {
    return {
      id: id || `edit_${++this.actionSeq}`,
      label: typeof label === "string" && label.trim() ? label : DEFAULT_ACTION_LABEL,
      kind: typeof kind === "string" ? kind : "",
      at: Number.isFinite(at) ? at : this.now(),
      group: typeof group === "string" ? group : "",
      snapshot: copyEditor(editor),
    }
  }

  // Records one named action. `group` is a caller-owned id for a single continuous editing
  // session: records that repeat the newest group update that entry instead of stacking one entry
  // per keystroke, while the snapshot stays the state before the whole group.
  record(editor, meta) {
    const { label, kind, group } = meta ?? {}
    const groupId = typeof group === "string" ? group : ""
    if (groupId && groupId === this.openGroup && this.past.length) {
      const head = this.past.at(-1)
      if (typeof label === "string" && label.trim()) head.label = label
      if (typeof kind === "string" && kind) head.kind = kind
      this.revision++
      return this.token(head)
    }
    const entry = this.makeEntry(editor, meta)
    this.past.push(entry)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
    this.openGroup = groupId
    this.revision++
    return this.token(entry)
  }

  undo(editor) {
    if (!this.past.length) return null
    const entry = this.past.at(-1)
    const restored = this.makeEntry(editor, entry, entry.id)
    this.past.pop()
    this.future.push(restored)
    this.openGroup = ""
    this.revision++
    return entry.snapshot
  }

  redo(editor) {
    if (!this.future.length) return null
    const entry = this.future.at(-1)
    const restored = this.makeEntry(editor, entry, entry.id)
    this.future.pop()
    this.past.push(restored)
    this.openGroup = ""
    this.revision++
    return entry.snapshot
  }

  // Moves the playhead to the boundary just before `id`, to HISTORY_START for the state before the
  // oldest action, or to HISTORY_HEAD for the newest state. Unknown, cleared and evicted ids leave
  // the timeline untouched, and the jump itself is atomic: the live state is copied before either
  // stack moves, so a failed clone changes nothing.
  jump(id, editor) {
    const target = id === HISTORY_HEAD ? this.size : id === HISTORY_START ? 0 : this.indexOf(id)
    if (target < 0) return { ok: false, reason: "unknown", entry: null, snapshot: null }
    if (target === this.past.length) {
      return { ok: false, reason: "current", entry: this.descriptor(target), snapshot: null }
    }
    const live = copyEditor(editor)
    if (target < this.past.length) {
      const moving = this.past.slice(target)
      const restored = moving[0].snapshot
      const rebuilt = moving.map((entry, offset) => ({
        ...entry,
        snapshot: offset + 1 < moving.length ? moving[offset + 1].snapshot : live,
      }))
      this.past = this.past.slice(0, target)
      this.future = [...this.future, ...rebuilt.reverse()]
      this.openGroup = ""
      this.revision++
      return { ok: true, reason: "", entry: this.descriptor(target), snapshot: restored }
    }
    const moving = this.future.splice(this.future.length - (target - this.past.length)).reverse()
    const restored = moving.at(-1).snapshot
    this.past = [
      ...this.past,
      ...moving.map((entry, offset) => ({ ...entry, snapshot: offset ? moving[offset - 1].snapshot : live })),
    ]
    this.openGroup = ""
    this.revision++
    return { ok: true, reason: "", entry: this.descriptor(target), snapshot: restored }
  }

  clear() {
    this.past = []
    this.future = []
    this.openGroup = ""
    this.revision++
  }

  get size() {
    return this.past.length + this.future.length
  }

  token(entry) {
    return {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      at: entry.at,
      revision: this.revision,
      session: this.sessionId,
    }
  }

  // Chronological entry lookup: applied actions first, then the undone ones in redo order.
  action(index) {
    if (!Number.isInteger(index) || index < 0) return null
    if (index < this.past.length) return this.past[index]
    return this.future[this.future.length - 1 - (index - this.past.length)] ?? null
  }

  indexOf(id) {
    if (typeof id !== "string" || !id) return -1
    for (let index = 0; index < this.size; index++) {
      if (this.action(index)?.id === id) return index
    }
    return -1
  }

  // Lightweight row for the timeline panel: no snapshot, so listing cannot keep assets alive.
  descriptor(index) {
    const entry = this.action(index)
    if (!entry) return null
    return {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      at: entry.at,
      index,
      applied: index < this.past.length,
    }
  }

  entries({ query = "", applied } = {}) {
    const needle = fold(String(query ?? "").trim())
    const list = []
    for (let index = 0; index < this.size; index++) {
      const row = this.descriptor(index)
      if (typeof applied === "boolean" && row.applied !== applied) continue
      if (needle && !fold(`${row.label}\n${row.kind}`).includes(needle)) continue
      list.push(row)
    }
    return list
  }

  snapshots() {
    return [...this.past, ...this.future].map((entry) => entry.snapshot)
  }
}

// A one-click undo stays safe only while the token still names the newest recorded action
// and nothing moved the timeline since the notification was issued.
export function checkUndoToken(history, token, { busy = false, gesturing = false, pending = false } = {}) {
  const id = typeof token?.id === "string" ? token.id : ""
  if (!id || token.session !== history.sessionId) return refuse("missing", token)
  if (busy) return refuse("busy", token)
  if (gesturing) return refuse("gesturing", token)
  const newest = history.past.at(-1)
  if (history.future.some((entry) => entry.id === id)) return refuse("undone", token)
  if (newest?.id === id) {
    if (history.revision !== token.revision) return refuse("rewound", token)
    if (pending) return refuse("pending", token)
    return { ok: true, reason: "", message: "" }
  }
  if (history.past.some((entry) => entry.id === id)) return refuse("superseded", token)
  return refuse("missing", token)
}
