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

// Every entry carries a session-durable id plus a label, so a notification (and later a
// labeled timeline) can address one exact action instead of the current stack depth.
let historyInstances = 0

export class EditHistory {
  constructor(limit = 40) {
    this.limit = limit
    this.past = []
    this.future = []
    this.revision = 0
    this.sessionId = ++historyInstances
    this.actionSeq = 0
  }

  makeEntry(editor, { label = "", kind = "" } = {}, id = "") {
    return {
      id: id || `edit_${++this.actionSeq}`,
      label: typeof label === "string" ? label : "",
      kind: typeof kind === "string" ? kind : "",
      snapshot: copyEditor(editor),
    }
  }

  record(editor, meta) {
    const entry = this.makeEntry(editor, meta)
    this.past.push(entry)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
    this.revision++
    return { id: entry.id, label: entry.label, kind: entry.kind, revision: this.revision, session: this.sessionId }
  }

  undo(editor) {
    if (!this.past.length) return null
    const entry = this.past.pop()
    this.future.push(this.makeEntry(editor, { label: entry.label, kind: entry.kind }, entry.id))
    this.revision++
    return entry.snapshot
  }

  redo(editor) {
    if (!this.future.length) return null
    const entry = this.future.pop()
    this.past.push(this.makeEntry(editor, { label: entry.label, kind: entry.kind }, entry.id))
    this.revision++
    return entry.snapshot
  }

  clear() {
    this.past = []
    this.future = []
    this.revision++
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
