import assert from "node:assert/strict"
import test from "node:test"
import {
  applyAcceptedChanges,
  clonePagesForDraft,
  createReviewSession,
  describeChange,
  diffGlossaryChange,
  diffPages,
  explainNoChanges,
  isRejectedChange,
  recordRejections,
  reviewActionLabel,
} from "../src/agent-review.js"
import { createAgentTools } from "../src/agent-tools.js"
import { runAgentTurn } from "../src/agent-harness.js"
import { loadProjectRejections, saveProjectRejections } from "../src/chat-storage.js"

function makePage(text = "Cũ") {
  return {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [
      { id: "b1", text, x: 0.1, y: 0.1, w: 0.3, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" },
      { id: "b2", text: "Xoá đi", x: 0.5, y: 0.5, w: 0.2, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" },
    ],
    unplaced: [],
  }
}

function makeTools(state, page, overrides = {}) {
  const calls = { checkpoint: 0, render: 0, commit: 0 }
  const tools = createAgentTools({
    state,
    byId: () => null,
    selectedPage: () => page,
    selectedIndex: () => 0,
    checkpoint: () => { calls.checkpoint++ },
    render: () => { calls.render++ },
    commitLiveForm: () => { calls.commit++ },
    makeBoxFn: (_page, rect, text) => ({ id: "b9", ...rect, text, size: 20, font: "Arial", color: "#171717" }),
    ...overrides,
  })
  return { tools, calls }
}

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  }
}

const idOf = (session, field) => session.changes.find((change) => change.field === field)?.id

test("diffPages reports one change per field with before/after and the box it belongs to", () => {
  const live = makePage()
  const draft = clonePagesForDraft([live])
  draft[0].boxes[0].text = "Mới"
  draft[0].boxes[0].size = 32
  draft[0].boxes.splice(1, 1)
  draft[0].boxes.push({ id: "b3", text: "Thêm", x: 0.2, y: 0.2, w: 0.1, h: 0.1, size: 20, font: "Arial", color: "#000000" })

  const changes = diffPages([live], draft, { toolName: "update_box", toolCallId: "c1" })

  const text = changes.find((change) => change.field === "text")
  assert.equal(text.kind, "modified")
  assert.equal(text.pageIndex, 1)
  assert.equal(text.boxId, "b1")
  assert.equal(text.before, "Cũ")
  assert.equal(text.after, "Mới")
  assert.equal(text.toolName, "update_box")

  const size = changes.find((change) => change.field === "size")
  assert.equal(size.before, 24)
  assert.equal(size.after, 32)

  assert.ok(changes.some((change) => change.kind === "removed" && change.boxId === "b2"))
  const added = changes.find((change) => change.kind === "added")
  assert.equal(added.boxId, "b3")
  assert.equal(added.after.text, "Thêm")
  assert.match(describeChange(text), /Tr\.1 · Nội dung: Cũ → Mới/)
  assert.match(describeChange(added), /Thêm khung "Thêm"/)
})

test("a review session accepts part of a turn and leaves the rejected fields untouched", () => {
  const live = makePage()
  const draft = clonePagesForDraft([live])
  draft[0].boxes[0].text = "Mới"
  draft[0].boxes[0].size = 32
  const session = createReviewSession()
  session.add(diffPages([live], draft))

  const outcome = applyAcceptedChanges({ pages: [live], session, ids: [idOf(session, "text")] })

  assert.equal(outcome.applied.length, 1)
  assert.equal(outcome.rejected.length, 1)
  assert.equal(live.boxes[0].text, "Mới")
  assert.equal(live.boxes[0].size, 24, "rejected change keeps the live value")
  assert.equal(session.summary().applied, 1)
  assert.equal(session.summary().rejected, 1)
  assert.equal(reviewActionLabel(outcome.applied, outcome.rejected), "Chấp nhận 1/2 thay đổi từ Trợ lý AI")
})

test("an accepted turn applies as one step and an untouched box survives rejection", () => {
  const live = makePage()
  const draft = clonePagesForDraft([live])
  draft[0].boxes[0].text = "Mới"
  draft[0].boxes.push({ id: "b3", text: "Thêm", size: 20, font: "Arial", color: "#000000" })
  const session = createReviewSession()
  session.add(diffPages([live], draft))

  const rejectedFirst = applyAcceptedChanges({ pages: [live], session, ids: [] })
  assert.equal(rejectedFirst.applied.length, 0)
  assert.equal(live.boxes.length, 2)
  assert.equal(live.boxes[0].text, "Cũ")

  const applied = applyAcceptedChanges({ pages: [live], session, ids: session.changes.map((change) => change.id) })
  assert.equal(applied.applied.length, 2)
  assert.equal(live.boxes[0].text, "Mới")
  assert.equal(live.boxes.length, 3)
  assert.equal(session.summary().applied, 2)
})

test("rejection memory blocks the same proposal and allows a different one", () => {
  const rejected = { kind: "modified", pageId: "p1", boxId: "b1", field: "text", before: "Cũ", after: "Mới" }
  const log = recordRejections([], [rejected])

  assert.equal(isRejectedChange(log, rejected), true)
  assert.equal(isRejectedChange(log, { ...rejected, after: "Khác" }), false)
  assert.equal(isRejectedChange(log, { ...rejected, boxId: "b2" }), false)
  assert.equal(log.length, 1)

  recordRejections(log, [rejected])
  assert.equal(log.length, 1, "the same proposal is not recorded twice")
})

test("a staged write tool never mutates live state, never checkpoints and never renders", async () => {
  const page = makePage()
  const state = { pages: [page], presets: [], pageId: "p1", boxId: "b1", selectedBoxIds: new Set(["b1"]), queue: [] }
  const { tools, calls } = makeTools(state, page)
  const session = createReviewSession()
  tools.beginReview(session)

  const result = await tools.execute("update_box", { boxId: "b1", text: "Mới", size: 32 }, { callId: "c1" })

  assert.equal(result.ok, true)
  assert.match(result.summary, /chờ duyệt/)
  assert.equal(page.boxes[0].text, "Cũ", "live text waits for approval")
  assert.equal(page.boxes[0].size, 24, "live style waits for approval")
  assert.equal(calls.checkpoint, 0, "no history entry before approval")
  assert.equal(calls.render, 0, "the draft is never painted")
  assert.equal(calls.commit, 1, "the open form is committed once, before the draft is taken")
  assert.equal(session.summary().pending, 2)
  assert.match(result.modelText, /CHƯA áp dụng/)

  const outcome = applyAcceptedChanges({ pages: state.pages, session, ids: session.changes.map((c) => c.id) })
  assert.equal(outcome.applied.length, 2)
  assert.equal(page.boxes[0].text, "Mới")
  assert.equal(page.boxes[0].size, 32)
})

test("a change rejected in an earlier turn is flagged instead of being applied again", async () => {
  const page = makePage()
  const state = { pages: [page], presets: [], pageId: "p1", boxId: "b1", selectedBoxIds: new Set(["b1"]), queue: [] }
  const { tools } = makeTools(state, page)

  const first = createReviewSession()
  tools.beginReview(first)
  await tools.execute("update_box", { boxId: "b1", text: "Mới" })
  const rejected = applyAcceptedChanges({ pages: state.pages, session: first, ids: [] }).rejected
  tools.endReview()
  const log = recordRejections([], rejected)
  assert.equal(page.boxes[0].text, "Cũ")

  const second = createReviewSession()
  tools.beginReview(second, { rejections: log })
  const again = await tools.execute("update_box", { boxId: "b1", text: "Mới" })
  assert.equal(second.changes.length, 1)
  assert.equal(second.changes[0].blocked, true)
  assert.match(again.summary, /đã bị từ chối trước đó/)
  assert.match(again.modelText, /trùng với thay đổi người dùng đã từ chối/)
  assert.equal(page.boxes[0].text, "Cũ")

  // A different replacement is a new proposal and is staged normally.
  const third = createReviewSession()
  tools.beginReview(third, { rejections: log })
  await tools.execute("update_box", { boxId: "b1", text: "Khác" })
  assert.equal(third.changes[0].blocked, false)
  tools.endReview()
})

test("glossary edits are staged as one change and only written on acceptance", async () => {
  const page = makePage()
  const state = { pages: [page], presets: [], pageId: "p1", boxId: "b1", selectedBoxIds: new Set(["b1"]), queue: [] }
  const field = { id: "translation-glossary", value: "五条悟 = Gojo", dispatchEvent() { field.dispatched = true } }
  const { tools } = makeTools(state, page, { byId: (id) => (id === "translation-glossary" ? field : null) })
  const session = createReviewSession()
  tools.beginReview(session)

  const result = await tools.execute("update_glossary", { entries: ["夏油 = Geto"] })

  assert.equal(result.ok, true)
  assert.equal(field.value, "五条悟 = Gojo", "the field waits for approval")
  assert.equal(field.dispatched, undefined, "no live input event while staging")
  assert.equal(session.changes.length, 1)
  assert.equal(session.changes[0].kind, "glossary")
  assert.match(session.changes[0].after, /Geto/)

  applyAcceptedChanges({ pages: state.pages, session, ids: session.changes.map((c) => c.id), glossaryField: field })
  assert.match(field.value, /Geto/)
  assert.equal(field.dispatched, true)
})

test("runAgentTurn stages tool edits instead of applying them", async (t) => {
  const originalFetch = globalThis.fetch
  const page = makePage()
  const state = { pages: [page], presets: [], pageId: "p1", boxId: "b1", selectedBoxIds: new Set(["b1"]), queue: [] }
  const { tools } = makeTools(state, page)
  const session = createReviewSession()
  tools.beginReview(session)

  let call = 0
  globalThis.fetch = async () => {
    call++
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "update_box", arguments: JSON.stringify({ boxId: "b1", text: "Mới" }) },
              }],
            },
          }],
        }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Đã đề xuất thay đổi." } }] }) }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await runAgentTurn({
    userMessage: "Đổi lời thoại khung 1",
    settings: { provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" },
    tools,
  })

  assert.equal(result.editsMade, 1)
  assert.equal(page.boxes[0].text, "Cũ", "the turn applied nothing")
  assert.equal(session.summary().pending, 1)
  assert.match(session.changes[0].before, /Cũ/)
  tools.endReview()
})

test("a turn that changes nothing always names a reason", () => {
  assert.match(explainNoChanges({ planMode: true }), /Chế độ Kế hoạch/)
  assert.match(explainNoChanges({ allowEdits: false }), /tắt "Cho phép sửa khung/)
  assert.match(explainNoChanges({ writeCalls: 0 }), /không gọi công cụ ghi nào/)
  assert.match(explainNoChanges({ writeCalls: 1 }), /không tạo ra khác biệt/)
  assert.match(explainNoChanges({ blocked: 2 }), /2 thay đổi trùng/)
  assert.match(explainNoChanges({ budgetBlocked: true, writeCalls: 0 }), /hạn mức chi phí/)
  assert.match(explainNoChanges({}), /không có thay đổi nào được áp dụng/i)
})

test("rejections persist per project so a reopened project still remembers them", () => {
  const storage = memoryStorage()
  const log = recordRejections([], [{ kind: "modified", pageId: "p1", boxId: "b1", field: "text", after: "Mới" }])

  assert.equal(saveProjectRejections("proj-1", log, storage), true)
  const restored = loadProjectRejections("proj-1", storage)
  assert.equal(restored.length, 1)
  assert.equal(restored[0].key, "p1|b1|text|modified")
  assert.equal(isRejectedChange(restored, { pageId: "p1", boxId: "b1", field: "text", kind: "modified", after: "Mới" }), true)
  assert.deepEqual(loadProjectRejections("proj-2", storage), [])

  saveProjectRejections("proj-1", [], storage)
  assert.deepEqual(loadProjectRejections("proj-1", storage), [])
})

test("a diff with no visible change stays empty and the glossary diff ignores untouched text", () => {
  const live = makePage()
  const draft = clonePagesForDraft([live])
  assert.deepEqual(diffPages([live], draft), [])
  assert.equal(diffGlossaryChange("a = b", "a = b"), null)
  assert.equal(diffGlossaryChange("a = b", "a = b\nc = d").kind, "glossary")
})
