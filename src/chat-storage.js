// Per-project chat session persistence (inspired by DeepSeek Harness `session-persistence`).

import { normalizeTurnRecord } from "./agent-replay.js"

const SESSIONS_KEY = "khung-thoai-chat-sessions"
const TURN_RECORDS_KEY = "khung-thoai-chat-turn-records"
const MAX_PROJECTS = 12
const MAX_MESSAGES = 24
// A turn record is already capped field by field; this is the second wall, so eight long turns cannot
// push the origin out of quota and silently lose the chat session next to them.
const MAX_TURN_RECORDS = 8
const MAX_TURN_RECORD_CHARS = 512 * 1024

function readAll(storage = globalThis.localStorage, key = SESSIONS_KEY) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || "null")
    if (!parsed || typeof parsed !== "object") return {}
    return parsed
  } catch {
    return {}
  }
}

function writeAll(map, storage = globalThis.localStorage, key = SESSIONS_KEY) {
  try {
    // Keep only the most recently updated MAX_PROJECTS entries.
    const entries = Object.entries(map)
      .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
      .slice(0, MAX_PROJECTS)
    storage?.setItem(key, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Ignore storage quota errors in private browsing.
  }
}

export function loadProjectChatSession(projectId, storage = globalThis.localStorage) {
  if (!projectId) return { history: [], todos: [] }
  const all = readAll(storage)
  const entry = all[projectId]
  if (!entry || typeof entry !== "object") return { history: [], todos: [] }
  const history = Array.isArray(entry.history)
    ? entry.history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .slice(-MAX_MESSAGES)
    : []
  const todos = Array.isArray(entry.todos)
    ? entry.todos.filter((t) => t && typeof t.content === "string" && ["pending", "in_progress", "completed"].includes(t.status))
    : []
  return { history, todos, updatedAt: entry.updatedAt || 0 }
}

export function saveProjectChatSession(projectId, { history = [], todos = [] } = {}, storage = globalThis.localStorage) {
  if (!projectId) return false
  const all = readAll(storage)
  const cleanHistory = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 6000), ...(m.compacted && { compacted: true }) }))
  const cleanTodos = todos
    .filter((t) => t && typeof t.content === "string" && ["pending", "in_progress", "completed"].includes(t.status))
    .slice(0, 20)
  if (!cleanHistory.length && !cleanTodos.length) {
    delete all[projectId]
  } else {
    all[projectId] = { history: cleanHistory, todos: cleanTodos, updatedAt: Date.now() }
  }
  writeAll(all, storage)
  return true
}

export function clearProjectChatSession(projectId, storage = globalThis.localStorage) {
  if (!projectId) return
  const all = readAll(storage)
  if (projectId in all) {
    delete all[projectId]
    writeAll(all, storage)
  }
}

/**
 * Store one turn transcript next to the chat session. The record was redacted and capped while it was
 * being collected; it is normalized again here so a record that arrives from elsewhere cannot smuggle
 * a key or an oversized field into project storage.
 */
export function saveProjectTurnRecord(projectId, record, storage = globalThis.localStorage) {
  if (!projectId || !record) return false
  const clean = normalizeTurnRecord(record)
  if (!clean.id) return false
  const all = readAll(storage, TURN_RECORDS_KEY)
  const entry = all[projectId] && typeof all[projectId] === "object" ? all[projectId] : {}
  const previous = Array.isArray(entry.records) ? entry.records : []
  const candidates = [clean, ...previous.filter((item) => item?.id !== clean.id)]
  const kept = []
  let used = 0
  for (const item of candidates) {
    let size = 0
    try {
      size = JSON.stringify(item).length
    } catch {
      continue
    }
    if (size > MAX_TURN_RECORD_CHARS) continue
    if (kept.length >= MAX_TURN_RECORDS || (kept.length && used + size > MAX_TURN_RECORD_CHARS)) break
    kept.push(item)
    used += size
  }
  if (!kept.length) return false
  all[projectId] = { records: kept, updatedAt: Date.now() }
  writeAll(all, storage, TURN_RECORDS_KEY)
  return true
}

export function loadProjectTurnRecords(projectId, storage = globalThis.localStorage) {
  if (!projectId) return []
  const entry = readAll(storage, TURN_RECORDS_KEY)[projectId]
  if (!entry || !Array.isArray(entry.records)) return []
  const records = []
  for (const item of entry.records.slice(0, MAX_TURN_RECORDS)) {
    try {
      records.push(normalizeTurnRecord(item))
    } catch {
      // One unreadable record must not hide the rest of the history.
    }
  }
  return records
}

export function findProjectTurnRecord(projectId, id, storage = globalThis.localStorage) {
  const records = loadProjectTurnRecords(projectId, storage)
  const wanted = String(id || "latest").trim()
  if (!wanted || wanted === "latest") return records[0] ?? null
  return records.find((record) => record.id === wanted) ?? null
}

export function clearProjectTurnRecords(projectId, storage = globalThis.localStorage) {
  if (!projectId) return
  const all = readAll(storage, TURN_RECORDS_KEY)
  if (projectId in all) {
    delete all[projectId]
    writeAll(all, storage, TURN_RECORDS_KEY)
  }
}
