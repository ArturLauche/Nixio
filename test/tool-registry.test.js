import assert from "node:assert/strict"
import test from "node:test"
import { createAgentTools } from "../src/agent-tools.js"
import { createToolRegistry, DEFAULT_TOOL_TIMEOUT_MS, TOOL_CATEGORIES } from "../src/tool-registry.js"

// The 22 built-in tools #69 must keep behaving exactly as before the registry existed.
const BUILT_IN_TOOLS = [
  "web_search", "fetch_url", "get_project_state", "list_boxes", "search_chapter_text",
  "update_box", "create_box", "delete_box", "replace_chapter_text", "query_terminology",
  "update_glossary", "autofit_page", "todo_write", "submit_plan", "check_export_preflight",
  "lint_chapter_qa", "inspect_page_image", "navigate_page", "align_boxes", "distribute_boxes",
  "apply_style_preset", "ask_user",
]

function makeTools({ onAskUser, extraTools } = {}) {
  const state = { pages: [], queue: [], presets: [] }
  return createAgentTools({
    state,
    byId: () => null,
    selectedPage: () => null,
    selectedIndex: () => -1,
    checkpoint: () => {},
    render: () => {},
    onAskUser,
    extraTools,
  })
}

function readTool(overrides = {}) {
  return {
    name: "read_thing",
    category: "read",
    description: "Đọc một thứ.",
    parameters: { type: "object", properties: {} },
    run: async () => ({ summary: "ok", data: {} }),
    ...overrides,
  }
}

test("the registry describes all 22 built-in tools with their categories, timeouts and sandbox needs", () => {
  const tools = makeTools({ onAskUser: async () => ({ cancelled: true }) })
  assert.deepEqual(tools.names(), BUILT_IN_TOOLS)
  assert.deepEqual(tools.definitions().map(({ name }) => name), [
    ...BUILT_IN_TOOLS.filter((name) => name !== "submit_plan"),
  ])

  assert.deepEqual(BUILT_IN_TOOLS.map((name) => tools.categoryOf(name)), [
    "web", "web", "read", "read", "read", "write", "write", "write", "write", "read",
    "write", "write", "meta", "plan", "read", "read", "read", "read", "write", "write", "write", "interaction",
  ])
  assert.equal(tools.timeoutMs("web_search"), 18000)
  assert.equal(tools.timeoutMs("ask_user"), 0)
  assert.equal(tools.timeoutMs("update_box"), DEFAULT_TOOL_TIMEOUT_MS)
  assert.equal(tools.timeoutMs("khong_ton_tai"), DEFAULT_TOOL_TIMEOUT_MS)

  assert.deepEqual(tools.sandboxOf("web_search"), { network: true, dom: false, host: [] })
  assert.deepEqual(tools.sandboxOf("inspect_page_image"), { network: false, dom: true, host: [] })
  assert.deepEqual(tools.sandboxOf("ask_user"), { network: false, dom: false, host: ["askUser"] })
  assert.deepEqual(tools.sandboxOf("lint_chapter_qa"), { network: false, dom: false, host: [] })
  assert.equal(tools.sandboxOf("khong_ton_tai"), null)
})

test("permission flags still gate the built-in tools exactly as before", () => {
  const locked = makeTools()
  const readOnly = locked.definitions({ allowEdits: false, allowWebSearch: false }).map(({ name }) => name)
  for (const name of ["web_search", "fetch_url", "update_box", "create_box", "delete_box"]) {
    assert.equal(readOnly.includes(name), false, name)
  }
  assert.ok(readOnly.includes("get_project_state"))

  const plan = locked.definitions({ allowEdits: true, planMode: true }).map(({ name }) => name)
  assert.ok(plan.includes("submit_plan"))
  assert.equal(plan.includes("update_box"), false)

  // An interaction tool is only offered when the host registered its callback.
  assert.equal(locked.definitions().some(({ name }) => name === "ask_user"), false)
  const interactive = makeTools({ onAskUser: async () => ({ answer: "A" }) })
  assert.equal(interactive.definitions().some(({ name }) => name === "ask_user"), true)
})

test("a new tool appears in definitions() and keeps its declared category and timeout", async () => {
  let calls = 0
  const registry = createToolRegistry([
    readTool({
      name: "scan_sfx",
      category: "read",
      timeoutMs: 4321,
      isConcurrencySafe: true,
      sandbox: { dom: true },
      run: async (args) => { calls++; return { summary: "sfx", data: args } },
    }),
  ])
  assert.deepEqual(registry.names(), ["scan_sfx"])
  assert.deepEqual(registry.definitions().map(({ name }) => name), ["scan_sfx"])
  assert.equal(registry.categoryOf("scan_sfx"), "read")
  assert.equal(registry.timeoutMs("scan_sfx"), 4321)
  assert.equal(registry.isConcurrencySafe("scan_sfx"), true)
  assert.deepEqual(registry.sandboxOf("scan_sfx"), { network: false, dom: true, host: [] })

  const settled = await registry.dispatch("scan_sfx", { pageIndex: 2 })
  assert.deepEqual(settled, { ok: true, category: "read", summary: "sfx", data: { pageIndex: 2 } })
  assert.equal(calls, 1)
})

test("an unknown tool fails closed instead of running an unclassified handler", async () => {
  const registry = createToolRegistry([readTool()])
  assert.equal(registry.get("delete_everything"), null)
  assert.equal(registry.has("delete_everything"), false)
  assert.equal(registry.definitions().length, 1)
  // Conservative defaults for callers that only classify, never a permission grant.
  assert.equal(registry.categoryOf("delete_everything"), "read")
  assert.equal(registry.timeoutMs("delete_everything"), DEFAULT_TOOL_TIMEOUT_MS)
  assert.equal(registry.isConcurrencySafe("delete_everything"), false)
  assert.equal(registry.requiresApproval("delete_everything", {}), false)

  const missing = await registry.dispatch("delete_everything", {})
  assert.equal(missing.ok, false)
  assert.match(missing.error, /không tồn tại/)
})

test("dispatch refuses a tool the flags hide and reports a throwing handler", async () => {
  const registry = createToolRegistry([
    readTool({ name: "edit_thing", category: "write", run: async () => { throw new Error("hỏng") } }),
  ])
  const plan = await registry.dispatch("edit_thing", {}, { flags: { planMode: true } })
  assert.equal(plan.ok, false)
  assert.equal(plan.category, "write")
  assert.match(plan.error, /Chế độ Kế hoạch/)

  const readOnly = await registry.dispatch("edit_thing", {}, { flags: { allowEdits: false } })
  assert.match(readOnly.error, /thiết lập quyền/)

  const failed = await registry.dispatch("edit_thing", {}, {})
  assert.deepEqual(failed, { ok: false, category: "write", error: "hỏng" })
})

test("an extra tool joins definitions() through createAgentTools on the same terms as a built-in", async () => {
  const tools = makeTools({
    extraTools: [readTool({ name: "scan_sfx", category: "web", timeoutMs: 4000, sandbox: { network: true } })],
  })
  assert.equal(tools.names().length, BUILT_IN_TOOLS.length + 1)
  assert.equal(tools.timeoutMs("scan_sfx"), 4000)
  assert.equal(tools.definitions().some(({ name }) => name === "scan_sfx"), true)
  assert.equal(tools.definitions({ allowWebSearch: false }).some(({ name }) => name === "scan_sfx"), false)

  const settled = await tools.execute("scan_sfx", {}, { allowWebSearch: true })
  assert.equal(settled.ok, true)
  assert.equal(settled.category, "web")

  // It cannot shadow or duplicate a built-in, and it is still validated.
  assert.throws(() => makeTools({ extraTools: [readTool({ name: "list_boxes" })] }), /duplicate tool "list_boxes"/)
  assert.throws(() => makeTools({ extraTools: [readTool({ name: "broken", run: null })] }), /has no handler/)
})

test("registry construction rejects entries that cannot work", () => {
  assert.throws(() => createToolRegistry([readTool(), readTool()]), /duplicate tool "read_thing"/)
  assert.throws(() => createToolRegistry([readTool({ run: undefined })]), /has no handler/)
  assert.throws(() => createToolRegistry([readTool({ name: "  " })]), /needs a name/)
  assert.throws(() => createToolRegistry([readTool({ category: "admin" })]), /unknown category "admin"/)
  assert.throws(() => createToolRegistry([readTool({ description: "" })]), /needs a description/)
  assert.throws(() => createToolRegistry([readTool({ parameters: {} })]), /JSON-schema object/)
  assert.throws(() => createToolRegistry([readTool({ timeoutMs: -1 })]), /invalid timeout/)
  assert.throws(() => createToolRegistry([readTool({ timeoutMs: "fast" })]), /invalid timeout/)
  assert.throws(() => createToolRegistry([readTool({ requiresApproval: true })]), /requiresApproval must be a function/)
  assert.throws(() => createToolRegistry([readTool({ sandbox: { shell: true } })]), /unknown sandbox need "shell"/)
  assert.throws(() => createToolRegistry([readTool({ sandbox: { host: ["teleport"] } })]), /unknown host hook "teleport"/)

  // A web tool without network access, and an interaction tool with no host hook, cannot work.
  assert.throws(
    () => createToolRegistry([readTool({ name: "lookup", category: "web" })]),
    /web tool "lookup" must declare sandbox.network/,
  )
  assert.throws(
    () => createToolRegistry([readTool({ name: "confirm", category: "interaction" })]),
    /interaction tool "confirm" must declare the host hook/,
  )
  assert.deepEqual(TOOL_CATEGORIES, ["read", "write", "web", "meta", "plan", "interaction"])
})
