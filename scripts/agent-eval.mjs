// Offline golden-output evaluation for the Nixio agent harness (#70).
//
// Every provider response comes from test/eval/fixtures/manifest.json. The real JSON
// parsers, the real translation routing (src/translation.js) and the real agent harness run
// against an in-memory fetch that refuses any endpoint the fixture environment does not
// declare. No API key and no network access are used, and every token count and cost in the
// report is labelled as simulated.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runAgentTurn } from "../src/agent-harness.js"
import { normalizedSearch } from "../src/io.js"
import { lintChapter, parseGlossary } from "../src/linter.js"
import { translateBoxesForProvider } from "../src/translation.js"

export const SUPPORTED_SCHEMA_VERSION = 1
export const EVAL_NETWORK_BLOCKED = "EVAL_NETWORK_BLOCKED"
export const EVAL_SCRIPT_UNUSED = "EVAL_SCRIPT_UNUSED"

const root = fileURLToPath(new URL("..", import.meta.url))
export const defaultFixturesDirectory = path.join(root, "test", "eval", "fixtures")

// Fixed, keyless provider settings. A fixture cannot point the evaluator at a real service
// because both these settings and the accepted endpoints below are constants.
export const offlineSettings = {
  openai: { provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "fixture-model" },
  gemini: { provider: "gemini", key: "fixture-key", model: "gemini-3.1-flash-lite" },
}

export const allowedEndpoints = {
  openai: { origin: "http://localhost:11434", pathPrefix: "/v1/chat/completions" },
  gemini: { origin: "https://generativelanguage.googleapis.com", pathPrefix: "/v1beta/models/" },
}

const CASE_KINDS = new Set(["translate", "agent"])
const PROVIDERS = new Set(["openai", "gemini"])
const RETRY_DELAY_MS = 50
const MAX_LISTED_MISMATCHES = 5
const MAX_LISTED_TOOL_CALLS = 5

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits))
}

function formatRatio(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(3)
}

function formatUsd(value) {
  return value === null || value === undefined ? "unavailable" : "$" + Number(value).toFixed(8)
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function describeCall({ name, args }) {
  return `${name}(${JSON.stringify(stableValue(args ?? {}))})`
}

function callKey({ name, args }) {
  return describeCall({ name, args })
}

/**
 * Guard every simulated provider request: only the fixture environment endpoints may run.
 * Anything else is a configuration bug and must fail loudly instead of reaching the network.
 */
export function assertAllowedEndpoint(provider, rawUrl) {
  const allowed = allowedEndpoints[provider]
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch {
    parsed = null
  }
  if (allowed && parsed && parsed.origin === allowed.origin && parsed.pathname.startsWith(allowed.pathPrefix)) {
    return parsed.href
  }
  const expected = allowed
    ? `${allowed.origin}${allowed.pathPrefix}*`
    : `a supported provider (found ${JSON.stringify(provider)})`
  const error = new Error(
    `Blocked network request to ${rawUrl}: a simulated case may only call ${expected}. ` +
    "The evaluation must stay offline and must never contact a real provider.",
  )
  error.code = EVAL_NETWORK_BLOCKED
  throw error
}

function collectSimulatedUsage(provider, reply, usage) {
  const metadata = provider === "openai" ? reply?.usage : reply?.usageMetadata
  if (!metadata || typeof metadata !== "object") return
  const prompt = provider === "openai" ? Number(metadata.prompt_tokens) : Number(metadata.promptTokenCount)
  const output = provider === "openai" ? Number(metadata.completion_tokens) : Number(metadata.candidatesTokenCount)
  if (!Number.isFinite(prompt) && !Number.isFinite(output)) return
  usage.promptTokens += Number.isFinite(prompt) ? prompt : 0
  usage.outputTokens += Number.isFinite(output) ? output : 0
  usage.responsesWithUsage += 1
}

/**
 * Serve the fixture script in order and record every interaction. Extra requests and unused
 * responses both throw so a harness/fixture mismatch can never pass silently.
 */
export function createSimulatedProvider({ id = "case", provider, script = [] } = {}) {
  if (!Array.isArray(script) || !script.length) {
    throw new Error(`Case "${id}" needs a non-empty simulated provider script.`)
  }
  const calls = []
  const usage = { promptTokens: 0, outputTokens: 0, responsesWithUsage: 0 }
  let cursor = 0
  let violation = null

  async function simulatedFetch(url, init = {}) {
    try {
      return serve(url, init)
    } catch (error) {
      violation ??= error
      throw error
    }
  }

  function serve(url, init) {
    const endpoint = assertAllowedEndpoint(provider, url)
    if (cursor >= script.length) {
      throw new Error(
        `Case "${id}" made unexpected provider request #${calls.length + 1} to ${endpoint}: ` +
        `the fixture defines ${script.length} simulated response(s). Add a script entry or fix the harness path.`,
      )
    }
    const entry = script[cursor++]
    const record = { endpoint, status: entry.status ?? 200, note: entry.note ?? null }
    calls.push(record)
    if (entry.status) {
      const headers = new Headers()
      if (entry.retryAfter !== undefined) headers.set("retry-after", String(entry.retryAfter))
      return { ok: false, status: entry.status, headers, json: async () => ({}) }
    }
    try {
      JSON.parse(String(init.body ?? ""))
    } catch {
      throw new Error(`Case "${id}" sent a non-JSON request body to ${endpoint}; the harness should send JSON.`)
    }
    if (init.method && init.method !== "POST") {
      throw new Error(`Case "${id}" used ${init.method} for ${endpoint}; simulated provider exchanges must be POST.`)
    }
    collectSimulatedUsage(provider, entry.reply, usage)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => entry.reply,
    }
  }

  return {
    fetch: simulatedFetch,
    calls,
    usage,
    assertConsumed() {
      if (violation) throw violation
      if (cursor < script.length) {
        const error = new Error(
          `Case "${id}" used ${cursor}/${script.length} simulated provider response(s): ` +
          `${script.length - cursor} fixture response(s) were never requested. The harness, settings or fixture script is out of sync.`,
        )
        error.code = EVAL_SCRIPT_UNUSED
        throw error
      }
    },
  }
}

/**
 * Narrow stub registry with the same surface as createAgentTools. Only the tools declared by
 * the fixture exist, every call is recorded, and results are declarative fixture data, so the
 * harness gets no real editor state and no side effects.
 */
export function createStubToolRegistry(caseDef) {
  const declared = Array.isArray(caseDef.tools) ? caseDef.tools : []
  const byName = new Map(declared.map(tool => [tool.name, tool]))
  const calls = []
  const enabled = (tool, { allowEdits = true, allowWebSearch = true, planMode = false } = {}) => {
    if (tool.category === "web" && !allowWebSearch) return false
    if (tool.category === "write" && (!allowEdits || planMode)) return false
    return true
  }
  const boxes = Array.isArray(caseDef.boxes) ? caseDef.boxes : []
  return {
    calls,
    definitions(flags = {}) {
      return declared
        .filter(tool => enabled(tool, flags))
        .map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
    categoryOf(name) {
      return byName.get(name)?.category ?? "read"
    },
    isConcurrencySafe(name) {
      return byName.get(name)?.concurrencySafe === true
    },
    timeoutMs() {
      return 2000
    },
    needsApproval() {
      return false
    },
    getRuntimeSnapshot() {
      return {
        pageCount: 1,
        currentPageIndex: 1,
        currentPageName: caseDef.page?.name ?? "01.png",
        currentPageSize: `${caseDef.page?.width ?? 800}×${caseDef.page?.height ?? 1200}px`,
        boxCount: boxes.length,
        overflowCount: 0,
        unplacedCount: 0,
        queueCount: 0,
        glossaryCount: String(caseDef.glossary ?? "").split(/\r?\n/).filter(line => line.trim()).length,
        presetNames: [],
        notesPreview: caseDef.notes ?? "",
      }
    },
    getTodos() {
      return []
    },
    getPlan() {
      return null
    },
    async execute(name, args = {}) {
      const tool = byName.get(name)
      if (!tool) return { ok: false, error: `Công cụ không tồn tại: ${name}` }
      const call = { name, args: JSON.parse(JSON.stringify(args)) }
      calls.push(call)
      const result = tool.result ?? {}
      return {
        ok: true,
        category: tool.category ?? "read",
        summary: result.summary ?? "",
        data: result.data ?? {},
        ...(typeof result.modelText === "string" && { modelText: result.modelText }),
      }
    },
  }
}

function buildCaseSettings(caseDef) {
  return {
    ...offlineSettings[caseDef.provider],
    source: caseDef.sourceLanguage,
    target: caseDef.targetLanguage,
    direction: caseDef.direction ?? "rtl",
    notes: caseDef.notes ?? "",
    glossary: caseDef.glossary ?? "",
  }
}

function buildPage(caseDef) {
  const page = caseDef.page ?? {}
  const name = page.name ?? "01.png"
  return {
    id: "page-1",
    name,
    image: { naturalWidth: page.width ?? 800, naturalHeight: page.height ?? 1200 },
    file: { name, type: "image/png", size: 2048 },
    boxes: (caseDef.boxes ?? []).map(({ id, text }) => ({ id, text })),
    unplaced: [],
  }
}

function installFileReaderShim() {
  const original = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AEVALFIXTURE"
      queueMicrotask(() => this.onload())
    }
  }
  return () => {
    if (original === undefined) delete globalThis.FileReader
    else globalThis.FileReader = original
  }
}

function lintTranslatedBoxes(caseDef, actualText) {
  const boxes = [...actualText.entries()].map(([id, text]) => ({ id, text }))
  if (!boxes.length) return null
  const result = lintChapter(
    [{ name: caseDef.page?.name ?? "01.png", boxes }],
    {
      glossaryText: caseDef.glossary ?? "",
      sourceLanguage: caseDef.sourceLanguage,
      targetLanguage: caseDef.targetLanguage,
    },
  )
  return {
    boxes: boxes.length,
    total: result.total,
    byType: result.byType,
    issues: result.issues,
  }
}

// Glossary compliance combines the production linter's drift/source checks with a
// completeness check: when the reference translation uses an approved glossary target,
// the output must keep that target instead of silently dropping the term.
function auditGlossary(caseDef, expectedTranslations, actualText, lint) {
  if (!lint) return { compliance: null, lintViolations: [], missingTerms: [] }
  const lintViolations = lint.issues
    .filter(issue => issue.type === "glossary_violation")
    .map(issue => ({ boxId: issue.boxId, message: issue.message }))
  const entries = parseGlossary(caseDef.glossary ?? "")
    .filter(entry => entry.target.length >= 2)
    .filter(entry => normalizedSearch(entry.source) !== normalizedSearch(entry.target))
  const missingTerms = []
  for (const [boxId, actual] of actualText.entries()) {
    const reference = expectedTranslations[boxId]
    if (typeof reference !== "string") continue
    const normalizedReference = normalizedSearch(reference)
    const normalizedActual = normalizedSearch(actual)
    for (const entry of entries) {
      const normalizedTarget = normalizedSearch(entry.target)
      if (normalizedReference.includes(normalizedTarget) && !normalizedActual.includes(normalizedTarget)) {
        missingTerms.push({ boxId, term: entry.target })
      }
    }
  }
  const violating = new Set([
    ...lintViolations.map(item => item.boxId),
    ...missingTerms.map(item => item.boxId),
  ])
  return {
    compliance: round(1 - violating.size / lint.boxes),
    lintViolations,
    missingTerms,
  }
}

function scoreToolCalls(expectedCalls, actualCalls) {
  const expected = expectedCalls.map(({ name, args }) => ({ name, args: args ?? {} }))
  const actual = actualCalls.map(({ name, args }) => ({ name, args: args ?? {} }))
  const usedExpected = new Array(expected.length).fill(false)
  const matchedActual = new Array(actual.length).fill(false)
  let matched = 0
  actual.forEach((call, index) => {
    const key = callKey(call)
    const slot = expected.findIndex((candidate, candidateIndex) => !usedExpected[candidateIndex] && callKey(candidate) === key)
    if (slot < 0) return
    usedExpected[slot] = true
    matchedActual[index] = true
    matched += 1
  })
  const missing = expected.filter((_call, index) => !usedExpected[index]).map(describeCall)
  const unexpected = actual.filter((_call, index) => !matchedActual[index]).map(describeCall)
  return {
    precision: actual.length === 0 ? 1 : round(matched / actual.length),
    recall: expected.length === 0 ? 1 : round(matched / expected.length),
    sequenceMatches: expected.length === actual.length
      && expected.every((call, index) => callKey(call) === callKey(actual[index])),
    expected: expected.length,
    actual: actual.length,
    matched,
    missing: missing.slice(0, MAX_LISTED_TOOL_CALLS),
    unexpected: unexpected.slice(0, MAX_LISTED_TOOL_CALLS),
  }
}

function buildMetrics(caseDef, { translated, turn, steps }) {
  const expectedTranslations = caseDef.expected?.translations ?? {}
  const expectedIds = Object.keys(expectedTranslations)
  const actualText = new Map()
  if (caseDef.kind === "translate" && Array.isArray(translated)) {
    for (const line of translated) {
      if (line?.boxId && typeof line.text === "string" && line.text.trim()) actualText.set(line.boxId, line.text)
    }
  }
  if (caseDef.kind === "agent" && turn) {
    for (const entry of turn.toolTrace) {
      if (entry.ok && entry.name === "update_box"
        && typeof entry.args?.boxId === "string" && typeof entry.args?.text === "string" && entry.args.text.trim()) {
        actualText.set(entry.args.boxId, entry.args.text)
      }
    }
  }

  const idCoverage = expectedIds.length
    ? round(expectedIds.filter(id => actualText.has(id)).length / expectedIds.length)
    : null

  let referenceMatches = null
  if (expectedIds.length) {
    const mismatches = []
    let matched = 0
    for (const id of expectedIds) {
      const actual = actualText.get(id)
      if (actual !== undefined && normalizeText(actual) === normalizeText(expectedTranslations[id])) {
        matched += 1
        continue
      }
      mismatches.push({ id, expected: expectedTranslations[id], actual: actual ?? null })
    }
    referenceMatches = {
      matched,
      total: expectedIds.length,
      ratio: round(matched / expectedIds.length),
      mismatches: mismatches.slice(0, MAX_LISTED_MISMATCHES),
    }
  }

  const lint = lintTranslatedBoxes(caseDef, actualText)
  const glossary = auditGlossary(caseDef, expectedTranslations, actualText, lint)
  const expectedCalls = Array.isArray(caseDef.expected?.toolCalls) ? caseDef.expected.toolCalls : []
  const actualCalls = caseDef.kind === "agent" && turn
    ? turn.toolTrace.map(({ name, args }) => ({ name, args }))
    : []

  return {
    idCoverage,
    referenceMatches,
    glossaryCompliance: glossary.compliance,
    glossary,
    lint,
    tools: scoreToolCalls(expectedCalls, actualCalls),
    steps,
    answer: turn?.answer ?? null,
  }
}

function gateFailures(caseDef, metrics) {
  const failures = []
  const gates = caseDef.gates ?? {}
  const checkRatio = (label, value, minimum) => {
    if (value === null || value === undefined || !Number.isFinite(minimum)) return
    if (value < minimum) failures.push(`${label} ${formatRatio(value)} is below the required ${formatRatio(minimum)}`)
  }
  checkRatio("ID coverage", metrics.idCoverage, gates.minIdCoverage)
  checkRatio("glossary compliance", metrics.glossaryCompliance, gates.minGlossaryCompliance)
  checkRatio("reference match ratio", metrics.referenceMatches?.ratio ?? null, gates.minReferenceMatches)
  checkRatio("tool precision", metrics.tools.precision, gates.minToolPrecision)
  checkRatio("tool recall", metrics.tools.recall, gates.minToolRecall)

  if (gates.requireToolSequence && !metrics.tools.sequenceMatches) {
    failures.push("tool call order does not match the expected sequence")
  }
  if (Number.isFinite(gates.maxUntranslatedSource)) {
    const leaked = metrics.lint?.byType.untranslated_source ?? 0
    if (leaked > gates.maxUntranslatedSource) {
      failures.push(`${leaked} translated box(es) still contain source-script text (allowed ${gates.maxUntranslatedSource})`)
    }
  }
  if (metrics.referenceMatches && metrics.referenceMatches.ratio < (gates.minReferenceMatches ?? 0)) {
    for (const mismatch of metrics.referenceMatches.mismatches) {
      failures.push(`reference mismatch for box ${mismatch.id}: expected ${JSON.stringify(mismatch.expected)} but got ${JSON.stringify(mismatch.actual)}`)
    }
  }
  for (const call of metrics.tools.missing) failures.push(`missing expected tool call ${call}`)
  for (const call of metrics.tools.unexpected) failures.push(`unexpected tool call ${call}`)
  if (caseDef.kind === "agent" && caseDef.expected?.answer !== undefined) {
    const expectedAnswer = normalizeText(caseDef.expected.answer)
    const actualAnswer = normalizeText(metrics.answer)
    if (actualAnswer !== expectedAnswer) {
      failures.push(`answer mismatch: expected ${JSON.stringify(caseDef.expected.answer)} but got ${JSON.stringify(metrics.answer)}`)
    }
  }
  return failures
}

function tokenReport(usage, testRates) {
  const available = usage.responsesWithUsage > 0
  const rateLabel = testRates?.label ?? "No fixture test rates are declared, so no cost estimate is available."
  return {
    simulated: true,
    available,
    promptTokens: available ? usage.promptTokens : null,
    outputTokens: available ? usage.outputTokens : null,
    totalTokens: available ? usage.promptTokens + usage.outputTokens : null,
    estimatedCostUsd: available && testRates
      ? round((usage.promptTokens / 1e6) * testRates.inputPerMillionTokensUsd
        + (usage.outputTokens / 1e6) * testRates.outputPerMillionTokensUsd, 8)
      : null,
    note: available
      ? `Simulated token counts from the fixture responses. Cost uses fixture test rates: ${rateLabel}`
      : "The simulated responses carried no usage metadata, so token cost is unavailable.",
  }
}

export async function evaluateCase(caseDef, { testRates = null } = {}) {
  const provider = createSimulatedProvider({ id: caseDef.id, provider: caseDef.provider, script: caseDef.script })
  const page = buildPage(caseDef)
  const settings = buildCaseSettings(caseDef)
  const registry = createStubToolRegistry(caseDef)
  const originalFetch = globalThis.fetch
  const restoreFileReader = caseDef.provider === "gemini" && caseDef.kind === "translate"
    ? installFileReaderShim()
    : () => {}

  globalThis.fetch = provider.fetch
  let translated = null
  let turn = null
  let thrown = null
  try {
    if (caseDef.kind === "translate") {
      translated = await translateBoxesForProvider(
        caseDef.provider,
        page,
        page.boxes,
        { ...settings, report: () => {}, retryDelayMs: RETRY_DELAY_MS },
      )
    } else {
      turn = await runAgentTurn({
        userMessage: caseDef.userMessage,
        settings,
        tools: registry,
        maxSteps: caseDef.gates?.maxSteps ?? 6,
        onEvent: () => {},
      })
    }
  } catch (error) {
    thrown = error
  } finally {
    globalThis.fetch = originalFetch
    restoreFileReader()
  }

  let scriptError = null
  try {
    provider.assertConsumed()
  } catch (error) {
    scriptError = error
  }

  const steps = caseDef.kind === "translate" ? provider.calls.length : (turn?.steps ?? provider.calls.length)
  const expectedErrorMatched = Boolean(thrown && caseDef.expectError && new RegExp(caseDef.expectError, "u").test(thrown.message))
  const failures = []

  if (thrown && !expectedErrorMatched) failures.push(`unexpected error: ${thrown.message}`)
  if (!thrown && caseDef.expectError) {
    failures.push(`expected an error matching /${caseDef.expectError}/ but the case completed without one`)
  }
  if (scriptError && (scriptError !== thrown || expectedErrorMatched)) failures.push(scriptError.message)

  const metrics = thrown
    ? {
      idCoverage: null,
      referenceMatches: null,
      glossaryCompliance: null,
      glossary: null,
      lint: null,
      tools: scoreToolCalls(caseDef.expected?.toolCalls ?? [], []),
      steps,
      answer: null,
    }
    : buildMetrics(caseDef, { translated, turn, steps })

  if (!thrown && !caseDef.expectError) failures.push(...gateFailures(caseDef, metrics))
  if (caseDef.expected?.steps !== undefined && metrics.steps !== caseDef.expected.steps) {
    failures.push(`used ${metrics.steps} step(s) but expected ${caseDef.expected.steps}`)
  }
  if (Number.isFinite(caseDef.gates?.maxSteps) && metrics.steps > caseDef.gates.maxSteps) {
    failures.push(`used ${metrics.steps} step(s) but the case budget is ${caseDef.gates.maxSteps}`)
  }

  return {
    id: caseDef.id,
    kind: caseDef.kind,
    provider: caseDef.provider,
    status: failures.length ? "fail" : "pass",
    steps,
    expectedSteps: caseDef.expected?.steps ?? null,
    answer: metrics.answer,
    expectedError: caseDef.expectError
      ? { pattern: caseDef.expectError, actual: thrown?.message ?? null, matched: expectedErrorMatched }
      : null,
    metrics: {
      idCoverage: metrics.idCoverage,
      referenceMatches: metrics.referenceMatches,
      glossaryCompliance: metrics.glossaryCompliance,
      glossary: metrics.glossary,
      lint: metrics.lint && { ...metrics.lint, issues: metrics.lint.issues.slice(0, 3) },
      tools: metrics.tools,
    },
    tokens: tokenReport(provider.usage, testRates),
    providerCalls: provider.calls,
    toolTrace: turn ? turn.toolTrace.map(({ name, args, ok }) => ({ name, args, ok })) : registry.calls,
    failures,
  }
}

function validateTestRates(testRates) {
  const problems = []
  if (!testRates || typeof testRates !== "object" || Array.isArray(testRates)) {
    return ["testRates must be an object when present"]
  }
  if (typeof testRates.label !== "string" || testRates.label.length < 60) {
    problems.push("testRates.label must explain (60+ characters) that these rates are synthetic fixture rates and not provider prices")
  }
  for (const key of ["inputPerMillionTokensUsd", "outputPerMillionTokensUsd"]) {
    if (typeof testRates[key] !== "number" || !Number.isFinite(testRates[key]) || testRates[key] < 0) {
      problems.push(`testRates.${key} must be a non-negative number`)
    }
  }
  return problems
}

function validateScriptEntry(entry, index, push) {
  const prefix = `script[${index}]`
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return push(`${prefix} must be an object`)
  const hasReply = entry.reply !== undefined
  const hasStatus = entry.status !== undefined
  if (hasReply === hasStatus) return push(`${prefix} needs exactly one of "reply" or "status"`)
  if (hasStatus) {
    if (!Number.isInteger(entry.status) || entry.status < 400) push(`${prefix}.status must be an integer HTTP error status >= 400`)
    if (entry.retryAfter !== undefined && typeof entry.retryAfter !== "string" && typeof entry.retryAfter !== "number") {
      push(`${prefix}.retryAfter must be a string or number`)
    }
  } else if (!entry.reply || typeof entry.reply !== "object" || Array.isArray(entry.reply)) {
    push(`${prefix}.reply must be the simulated JSON body object`)
  }
  if (entry.note !== undefined && typeof entry.note !== "string") push(`${prefix}.note must be a string`)
  return undefined
}

function validateToolDefinition(tool, index, push) {
  const prefix = `tools[${index}]`
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return push(`${prefix} must be an object`)
  if (typeof tool.name !== "string" || !tool.name.trim()) push(`${prefix}.name must be a non-empty string`)
  if (typeof tool.description !== "string" || !tool.description.trim()) push(`${prefix}.description must be a non-empty string`)
  if (!tool.parameters || typeof tool.parameters !== "object") push(`${prefix}.parameters must be a JSON schema object`)
  if (tool.category !== undefined && !["read", "write", "web"].includes(tool.category)) {
    push(`${prefix}.category must be read, write or web`)
  }
  if (tool.concurrencySafe !== undefined && typeof tool.concurrencySafe !== "boolean") {
    push(`${prefix}.concurrencySafe must be a boolean`)
  }
  if (tool.result !== undefined && (!tool.result || typeof tool.result !== "object")) {
    push(`${prefix}.result must be an object when present`)
  }
  return undefined
}

export function validateCorpus(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["the corpus root must be a JSON object"]
  }
  const problems = []
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be ${SUPPORTED_SCHEMA_VERSION} (found ${JSON.stringify(manifest.schemaVersion)}); ` +
      "bump SUPPORTED_SCHEMA_VERSION in scripts/agent-eval.mjs when the fixture schema changes",
    )
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    problems.push("description must be a string")
  }
  if (manifest.testRates !== undefined) problems.push(...validateTestRates(manifest.testRates))
  if (!Array.isArray(manifest.cases) || !manifest.cases.length) {
    problems.push("cases must be a non-empty array")
    return problems
  }

  const ids = new Set()
  manifest.cases.forEach((caseDef, index) => {
    const prefix = `case ${index + 1}${caseDef?.id ? ` ("${caseDef.id}")` : ""}`
    const push = message => problems.push(`${prefix}: ${message}`)
    if (!caseDef || typeof caseDef !== "object" || Array.isArray(caseDef)) return push("must be an object")
    if (typeof caseDef.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseDef.id)) {
      push("id must be kebab-case")
    } else if (ids.has(caseDef.id)) {
      push(`duplicate id "${caseDef.id}"`)
    } else {
      ids.add(caseDef.id)
    }
    if (!CASE_KINDS.has(caseDef.kind)) push(`kind must be one of ${[...CASE_KINDS].join(", ")}`)
    if (!PROVIDERS.has(caseDef.provider)) push(`provider must be one of ${[...PROVIDERS].join(", ")}`)
    for (const key of ["sourceLanguage", "targetLanguage"]) {
      if (typeof caseDef[key] !== "string" || !caseDef[key].trim()) push(`${key} must be a non-empty string`)
    }
    if (caseDef.glossary !== undefined && typeof caseDef.glossary !== "string") push("glossary must be a string")
    if (caseDef.notes !== undefined && typeof caseDef.notes !== "string") push("notes must be a string")
    if (caseDef.expectError !== undefined) {
      if (typeof caseDef.expectError !== "string") {
        push("expectError must be a regular expression string")
      } else {
        try {
          new RegExp(caseDef.expectError, "u")
        } catch (error) {
          push(`expectError is not a valid regular expression: ${error.message}`)
        }
      }
    }

    const boxIds = new Set()
    if (!Array.isArray(caseDef.boxes)) {
      push("boxes must be an array")
    } else {
      caseDef.boxes.forEach((box, boxIndex) => {
        if (!box || typeof box.id !== "string" || !box.id.trim()) return push(`boxes[${boxIndex}].id must be a non-empty string`)
        if (boxIds.has(box.id)) push(`boxes[${boxIndex}].id "${box.id}" is duplicated`)
        boxIds.add(box.id)
        if (typeof box.text !== "string" || !box.text.trim()) push(`boxes[${boxIndex}].text must be a non-empty string`)
        return undefined
      })
    }

    if (!Array.isArray(caseDef.script) || !caseDef.script.length) {
      push("script must be a non-empty array of simulated provider responses")
    } else {
      caseDef.script.forEach((entry, entryIndex) => validateScriptEntry(entry, entryIndex, push))
    }

    if (!caseDef.gates || typeof caseDef.gates !== "object" || Array.isArray(caseDef.gates)) {
      push("gates must be an object")
    } else {
      if (!Number.isInteger(caseDef.gates.maxSteps) || caseDef.gates.maxSteps < 1) {
        push("gates.maxSteps must be a positive integer")
      }
      for (const key of ["minIdCoverage", "minGlossaryCompliance", "minReferenceMatches", "minToolPrecision", "minToolRecall"]) {
        const value = caseDef.gates[key]
        if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) push(`gates.${key} must be between 0 and 1`)
      }
      if (caseDef.gates.requireToolSequence !== undefined && typeof caseDef.gates.requireToolSequence !== "boolean") {
        push("gates.requireToolSequence must be a boolean")
      }
      if (caseDef.gates.maxUntranslatedSource !== undefined
        && (!Number.isInteger(caseDef.gates.maxUntranslatedSource) || caseDef.gates.maxUntranslatedSource < 0)) {
        push("gates.maxUntranslatedSource must be a non-negative integer")
      }
    }

    if (!caseDef.expected || typeof caseDef.expected !== "object" || Array.isArray(caseDef.expected)) {
      return push("expected must be an object")
    }
    if (caseDef.expected.steps !== undefined && (!Number.isInteger(caseDef.expected.steps) || caseDef.expected.steps < 1)) {
      push("expected.steps must be a positive integer")
    }

    if (caseDef.kind === "translate") {
      if (caseDef.expected.toolCalls !== undefined) push("translate cases must not declare expected.toolCalls")
      if (caseDef.tools !== undefined && (!Array.isArray(caseDef.tools) || caseDef.tools.length)) {
        push("translate cases must not declare tools")
      }
      const translations = caseDef.expected.translations
      if (!translations || typeof translations !== "object" || Array.isArray(translations)) {
        push("translate cases need expected.translations keyed by box id")
      } else {
        const missing = [...boxIds].filter(id => typeof translations[id] !== "string" || !translations[id].trim())
        if (missing.length) push(`expected.translations is missing reference text for ${missing.join(", ")}`)
        const unknown = Object.keys(translations).filter(id => !boxIds.has(id))
        if (unknown.length) push(`expected.translations references unknown box id(s) ${unknown.join(", ")}`)
      }
    } else {
      if (typeof caseDef.userMessage !== "string" || !caseDef.userMessage.trim()) {
        push("agent cases need a non-empty userMessage")
      }
      if (!Array.isArray(caseDef.tools) || !caseDef.tools.length) {
        push("agent cases need a non-empty tools array")
      } else {
        caseDef.tools.forEach((tool, toolIndex) => validateToolDefinition(tool, toolIndex, push))
        const declared = new Set(caseDef.tools.map(tool => tool?.name))
        if (!Array.isArray(caseDef.expected.toolCalls)) {
          push("agent cases need expected.toolCalls")
        } else {
          caseDef.expected.toolCalls.forEach((call, callIndex) => {
            if (!call || typeof call.name !== "string") return push(`expected.toolCalls[${callIndex}].name must be a string`)
            if (!declared.has(call.name)) push(`expected.toolCalls[${callIndex}] uses undeclared tool "${call.name}"`)
            if (call.args !== undefined && (typeof call.args !== "object" || Array.isArray(call.args))) {
              return push(`expected.toolCalls[${callIndex}].args must be an object`)
            }
            return undefined
          })
        }
      }
      if (caseDef.expected.answer !== undefined && typeof caseDef.expected.answer !== "string") {
        push("expected.answer must be a string")
      }
      if (caseDef.expected.translations !== undefined) {
        const translations = caseDef.expected.translations
        if (!translations || typeof translations !== "object" || Array.isArray(translations)) {
          push("expected.translations must be an object when present")
        } else {
          const unknown = Object.keys(translations).filter(id => !boxIds.has(id))
          if (unknown.length) push(`expected.translations references unknown box id(s) ${unknown.join(", ")}`)
        }
      }
    }
    return undefined
  })
  return problems
}

export async function loadCorpus(fixturesDirectory = defaultFixturesDirectory) {
  const file = path.join(fixturesDirectory, "manifest.json")
  let raw
  try {
    raw = await readFile(file, "utf8")
  } catch (error) {
    throw new Error(`Cannot read the agent eval corpus at ${file}: ${error.message}`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Agent eval corpus ${file} is not valid JSON: ${error.message}`)
  }
  const problems = validateCorpus(manifest)
  if (problems.length) {
    throw new Error(`Agent eval corpus ${file} is invalid:\n- ${problems.join("\n- ")}`)
  }
  return manifest
}

export async function evaluateAgentCorpus({ fixturesDirectory = defaultFixturesDirectory } = {}) {
  const manifest = await loadCorpus(fixturesDirectory)
  const cases = []
  for (const caseDef of manifest.cases) {
    cases.push(await evaluateCase(caseDef, { testRates: manifest.testRates ?? null }))
  }
  const failures = cases.flatMap(item => item.failures.map(failure => `case "${item.id}": ${failure}`))
  const withTokens = cases.filter(item => item.tokens.available)
  const estimatedCosts = cases.map(item => item.tokens.estimatedCostUsd).filter(value => value !== null)
  return {
    schemaVersion: manifest.schemaVersion,
    generatedBy: "scripts/agent-eval.mjs",
    fixtures: path.relative(root, path.join(fixturesDirectory, "manifest.json")).replaceAll("\\", "/"),
    offline: true,
    providerResponses: "simulated",
    testRates: manifest.testRates ?? null,
    totals: {
      cases: cases.length,
      passed: cases.filter(item => item.status === "pass").length,
      failed: cases.filter(item => item.status === "fail").length,
      casesWithTokenUsage: withTokens.length,
      simulatedPromptTokens: withTokens.reduce((sum, item) => sum + item.tokens.promptTokens, 0),
      simulatedOutputTokens: withTokens.reduce((sum, item) => sum + item.tokens.outputTokens, 0),
      estimatedCostUsd: estimatedCosts.length ? round(estimatedCosts.reduce((sum, value) => sum + value, 0), 8) : null,
    },
    gates: { passed: failures.length === 0, failures },
    cases,
  }
}

export function formatSummary(report) {
  const header = ["case", "provider", "kind", "steps", "id cov", "glossary", "tool P/R", "ref", "tokens", "est. cost"]
  const rows = report.cases.map(item => [
    item.id,
    item.provider,
    item.kind,
    String(item.steps),
    item.metrics.idCoverage === null ? "-" : formatRatio(item.metrics.idCoverage),
    item.metrics.glossaryCompliance === null ? "-" : formatRatio(item.metrics.glossaryCompliance),
    `${formatRatio(item.metrics.tools.precision)}/${formatRatio(item.metrics.tools.recall)}`,
    item.metrics.referenceMatches ? `${item.metrics.referenceMatches.matched}/${item.metrics.referenceMatches.total}` : "-",
    item.tokens.available ? String(item.tokens.totalTokens) : "unavailable",
    item.tokens.available ? formatUsd(item.tokens.estimatedCostUsd) : "unavailable",
  ])
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map(row => row[column].length)))
  const line = cells => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()
  const output = [
    `Offline agent evaluation — fixture schema v${report.schemaVersion}, ${report.providerResponses} provider responses, no network access`,
    line(header),
    ...rows.map(line),
    "",
    `${report.totals.passed}/${report.totals.cases} cases passed` +
      (report.totals.failed ? `, ${report.totals.failed} failed` : "") +
      ` · ${report.totals.casesWithTokenUsage}/${report.totals.cases} cases report simulated tokens` +
      ` (${report.totals.simulatedPromptTokens} prompt + ${report.totals.simulatedOutputTokens} output)` +
      ` · estimated ${formatUsd(report.totals.estimatedCostUsd)} at fixture test rates`,
  ]
  if (report.testRates?.label) output.push(`Cost note: ${report.testRates.label}`)
  output.push(report.gates.passed
    ? "All fixture gates passed."
    : `${report.gates.failures.length} gate failure(s); fix the regression or update the golden fixture.`)
  return output.join("\n")
}

function parseArgs(argv) {
  const options = { fixtures: defaultFixturesDirectory, output: null, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }
    if (arg === "--fixtures" || arg === "--output") {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} needs a value`)
      if (arg === "--fixtures") options.fixtures = path.resolve(value)
      else options.output = path.resolve(value)
      continue
    }
    throw new Error(`Unknown argument "${arg}". Use --fixtures <dir>, --output <file> or --help.`)
  }
  return options
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log([
      "Usage: node scripts/agent-eval.mjs [--fixtures <dir>] [--output <file>]",
      "",
      "Scores test/eval/fixtures/manifest.json fully offline with simulated provider responses:",
      "glossary compliance, ID coverage, tool precision/recall, step budget and simulated token cost.",
      "Exit code 1 means at least one fixture gate failed.",
    ].join("\n"))
    return 0
  }
  const report = await evaluateAgentCorpus({ fixturesDirectory: options.fixtures })
  console.log(formatSummary(report))
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true })
    await writeFile(options.output, JSON.stringify(report, null, 2) + "\n")
    console.log(`Wrote ${options.output}`)
  }
  for (const failure of report.gates.failures) console.error(`FAIL ${failure}`)
  return report.gates.passed ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code },
    error => {
      console.error(`Agent eval failed: ${error.message}`)
      process.exitCode = 1
    },
  )
}
