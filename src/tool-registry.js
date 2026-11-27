// Tool registry (Nixio #69).
//
// One descriptor per tool the agent may call:
//
//   {
//     name, description, parameters,   // the function schema the model sees
//     category,                        // read | write | web | meta | plan | interaction
//     timeoutMs,                       // 0 means "waits for a human", never timed out
//     isConcurrencySafe,               // may share one batch with other reads
//     requiresApproval(args),          // bulk or destructive operation
//     sandbox: { network, dom, host }, // what the tool needs from the host runtime
//     run(args, { signal }),           // the handler
//   }
//
// Construction validates every entry, so a descriptor that cannot work fails here with the tool named
// instead of at the first model call. `definitions`, `categoryOf`, `timeoutMs` and the dispatch path
// read the same table, which is why the agent loop never branches per tool. A name that is not
// registered is never guessed: lookups fall back to the conservative defaults the pipeline already
// used and `dispatch` answers fail-closed.

export const TOOL_CATEGORIES = Object.freeze(["read", "write", "web", "meta", "plan", "interaction"])

// Host callbacks a tool cannot run without; the registry only exposes such a tool when the caller
// registered the hook.
export const TOOL_HOST_HOOKS = Object.freeze(["askUser"])

export const DEFAULT_TOOL_TIMEOUT_MS = 12000

const SANDBOX_KEYS = new Set(["network", "dom", "host"])

function registryError(message) {
  return new Error("Tool registry: " + message)
}

function normalizeSandbox(name, raw) {
  const sandbox = raw ?? {}
  if (typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw registryError(`tool "${name}" has an invalid sandbox description.`)
  }
  for (const key of Object.keys(sandbox)) {
    if (!SANDBOX_KEYS.has(key)) throw registryError(`tool "${name}" declares unknown sandbox need "${key}".`)
  }
  const host = sandbox.host ?? []
  if (!Array.isArray(host)) throw registryError(`tool "${name}" sandbox.host must be a list.`)
  for (const hook of host) {
    if (!TOOL_HOST_HOOKS.includes(hook)) throw registryError(`tool "${name}" needs unknown host hook "${hook}".`)
  }
  return Object.freeze({
    network: sandbox.network === true,
    dom: sandbox.dom === true,
    host: Object.freeze([...new Set(host)]),
  })
}

function normalizeTool(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw registryError("every entry must be an object.")
  }
  const name = String(entry.name ?? "").trim()
  if (!name) throw registryError("every tool needs a name.")
  if (typeof entry.run !== "function") throw registryError(`tool "${name}" has no handler.`)
  const category = entry.category ?? "read"
  if (!TOOL_CATEGORIES.includes(category)) throw registryError(`tool "${name}" has unknown category "${category}".`)
  const description = String(entry.description ?? "").trim()
  if (!description) throw registryError(`tool "${name}" needs a description for the model.`)
  const parameters = entry.parameters
  if (!parameters || typeof parameters !== "object" || parameters.type !== "object") {
    throw registryError(`tool "${name}" needs a JSON-schema object for parameters.`)
  }
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw registryError(`tool "${name}" has an invalid timeout.`)
  if (entry.requiresApproval !== undefined && typeof entry.requiresApproval !== "function") {
    throw registryError(`tool "${name}" requiresApproval must be a function.`)
  }
  const sandbox = normalizeSandbox(name, entry.sandbox)
  // A web tool that cannot reach the network and an interaction tool without a host hook would both
  // be offered to the model and then fail on every call.
  if (category === "web" && !sandbox.network) throw registryError(`web tool "${name}" must declare sandbox.network.`)
  if (category === "interaction" && !sandbox.host.length) {
    throw registryError(`interaction tool "${name}" must declare the host hook it needs.`)
  }
  return Object.freeze({
    name,
    description,
    parameters,
    category,
    timeoutMs,
    isConcurrencySafe: entry.isConcurrencySafe === true,
    requiresApproval: entry.requiresApproval,
    sandbox,
    run: entry.run,
  })
}

export function createToolRegistry(entries = [], { host = {} } = {}) {
  const tools = (Array.isArray(entries) ? entries : []).map(normalizeTool)
  const byName = new Map()
  for (const tool of tools) {
    if (byName.has(tool.name)) throw registryError(`duplicate tool "${tool.name}".`)
    byName.set(tool.name, tool)
  }
  const registeredHost = host && typeof host === "object" ? host : {}

  function get(name) {
    return byName.get(String(name ?? "")) ?? null
  }

  function isAvailable(tool, flags = {}) {
    const { allowEdits = true, allowWebSearch = true, planMode = false } = flags
    if (tool.category === "web" && !allowWebSearch) return false
    if (tool.category === "write" && (!allowEdits || planMode)) return false
    if (tool.category === "plan" && !planMode) return false
    for (const hook of tool.sandbox.host) if (!registeredHost[hook]) return false
    return true
  }

  function denial(tool, flags = {}) {
    const error = flags.planMode && tool.category === "write"
      ? `Công cụ "${tool.name}" đang bị khóa trong Chế độ Kế hoạch (Plan Mode). Hãy dùng submit_plan trước.`
      : `Công cụ "${tool.name}" đang bị tắt bởi thiết lập quyền của người dùng.`
    return { ok: false, category: tool.category, error }
  }

  function resolve(toolOrName) {
    return typeof toolOrName === "string" ? get(toolOrName) : (toolOrName ?? null)
  }

  return {
    size: tools.length,
    names() {
      return tools.map((tool) => tool.name)
    },
    get,
    has(name) {
      return byName.has(String(name ?? ""))
    },
    definitions(flags = {}) {
      return tools
        .filter((tool) => isAvailable(tool, flags))
        .map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
    isAvailable(toolOrName, flags) {
      const tool = resolve(toolOrName)
      return tool ? isAvailable(tool, flags) : false
    },
    denial(toolOrName, flags) {
      const tool = resolve(toolOrName)
      return tool && !isAvailable(tool, flags) ? denial(tool, flags) : null
    },
    categoryOf(name) {
      return get(name)?.category ?? "read"
    },
    timeoutMs(name) {
      return get(name)?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    },
    isConcurrencySafe(name) {
      return get(name)?.isConcurrencySafe === true
    },
    requiresApproval(name, args) {
      return get(name)?.requiresApproval?.(args) === true
    },
    sandboxOf(name) {
      return get(name)?.sandbox ?? null
    },
    // Fail-closed dispatch: an unregistered name, a tool the user's permissions hide and a handler
    // that throws all come back as `ok: false`, so a model that invents a tool never reaches code.
    // `run` replaces the handler call for callers that must wrap it, such as the AI review draft.
    async dispatch(name, args, { flags = {}, signal, run } = {}) {
      const tool = get(name)
      if (!tool) return { ok: false, error: `Công cụ không tồn tại: ${name}` }
      if (!isAvailable(tool, flags)) return denial(tool, flags)
      try {
        const result = await (run ? run(tool, args ?? {}, { signal }) : tool.run(args ?? {}, { signal }))
        return { ok: true, category: tool.category, ...result }
      } catch (error) {
        return { ok: false, category: tool.category, error: error?.message || String(error) }
      }
    },
  }
}
