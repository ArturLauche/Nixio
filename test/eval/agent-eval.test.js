import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  EVAL_NETWORK_BLOCKED,
  EVAL_SCRIPT_UNUSED,
  SUPPORTED_SCHEMA_VERSION,
  createSimulatedProvider,
  createStubToolRegistry,
  defaultFixturesDirectory,
  evaluateAgentCorpus,
  formatSummary,
  loadCorpus,
  validateCorpus,
} from "../../scripts/agent-eval.mjs"
import { parseGlossary } from "../../src/linter.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const cli = path.join(root, "scripts", "agent-eval.mjs")

async function tempCorpus(t, mutate = () => {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "nixio-agent-eval-"))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await cp(defaultFixturesDirectory, folder, { recursive: true })
  const file = path.join(folder, "manifest.json")
  const manifest = JSON.parse(await readFile(file, "utf8"))
  mutate(manifest)
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n")
  return folder
}

function caseById(report, id) {
  const found = report.cases.find(item => item.id === id)
  assert.ok(found, `missing case ${id}`)
  return found
}

test("the eval corpus is versioned, self-consistent and covers both providers", async () => {
  const manifest = await loadCorpus()
  assert.equal(manifest.schemaVersion, SUPPORTED_SCHEMA_VERSION)
  assert.deepEqual(validateCorpus(manifest), [])
  assert.ok(manifest.cases.length >= 5)
  assert.deepEqual([...new Set(manifest.cases.map(item => item.provider))].sort(), ["gemini", "openai"])
  assert.deepEqual([...new Set(manifest.cases.map(item => item.kind))].sort(), ["agent", "translate"])
  assert.match(manifest.testRates.label, /not provider prices/)

  for (const caseDef of manifest.cases) {
    const ids = caseDef.boxes.map(box => box.id)
    assert.equal(new Set(ids).size, ids.length, `${caseDef.id} has duplicate box ids`)
    for (const box of caseDef.boxes) assert.equal(box.id, box.id.trim())
    if (caseDef.glossary.trim()) assert.ok(parseGlossary(caseDef.glossary).length > 0, `${caseDef.id} glossary does not parse`)
    if (caseDef.kind === "translate") {
      assert.deepEqual(Object.keys(caseDef.expected.translations).sort(), [...ids].sort())
    } else {
      for (const call of caseDef.expected.toolCalls) {
        assert.ok(caseDef.tools.some(tool => tool.name === call.name), `${caseDef.id} uses undeclared tool ${call.name}`)
      }
    }
  }

  const problems = validateCorpus({ ...manifest, schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /schemaVersion must be 1/)
  assert.match(validateCorpus({ ...manifest, cases: [] }).join("\n"), /cases must be a non-empty array/)
  assert.match(validateCorpus(["not a corpus"])[0], /JSON object/)
})

test("the default corpus passes every gate offline with simulated token costs", async () => {
  const originalFetch = globalThis.fetch
  const report = await evaluateAgentCorpus()
  assert.equal(globalThis.fetch, originalFetch, "the evaluation must restore the real fetch")
  assert.equal(report.offline, true)
  assert.equal(report.providerResponses, "simulated")
  assert.equal(report.schemaVersion, SUPPORTED_SCHEMA_VERSION)
  assert.equal(report.gates.passed, true, report.gates.failures.join("\n"))
  assert.equal(report.totals.failed, 0)

  for (const item of report.cases) {
    assert.equal(item.status, "pass", item.failures.join("\n"))
    assert.equal(item.tokens.simulated, true)
    assert.equal(item.tokens.available, true)
    assert.ok(item.tokens.totalTokens > 0)
    assert.ok(item.tokens.estimatedCostUsd > 0)
    assert.ok(item.providerCalls.length >= 1)
    for (const call of item.providerCalls) {
      assert.match(
        call.endpoint,
        /^(?:http:\/\/localhost:11434\/v1\/chat\/completions|https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/)/,
      )
    }
  }

  const golden = caseById(report, "openai-boxes-glossary-golden")
  assert.deepEqual(golden.metrics.referenceMatches, {
    matched: 2,
    total: 2,
    ratio: 1,
    mismatches: [],
  })
  assert.equal(golden.metrics.idCoverage, 1)
  assert.equal(golden.metrics.glossaryCompliance, 1)

  const retried = caseById(report, "gemini-boxes-retry-golden")
  assert.equal(retried.steps, 2)
  assert.deepEqual(retried.providerCalls.map(call => call.status), [503, 200])

  const guarded = caseById(report, "openai-boxes-missing-id-guard")
  assert.equal(guarded.expectedError.matched, true)
  assert.match(guarded.expectedError.actual, /thiếu hoặc trùng mã thoại/)

  const summary = formatSummary(report)
  assert.match(summary, /fixture schema v1/)
  assert.match(summary, /All fixture gates passed/)
  assert.match(summary, /not provider prices/)
  for (const item of report.cases) assert.ok(summary.includes(item.id), `summary is missing ${item.id}`)
})

test("a changed reference translation fails the gate with the case, metric and box", async (t) => {
  const folder = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "openai-boxes-glossary-golden")
    target.expected.translations.b2 = "Hãy chiến đấu như một Chú thuật sư."
  })
  const report = await evaluateAgentCorpus({ fixturesDirectory: folder })
  assert.equal(report.gates.passed, false)
  const failures = report.gates.failures.join("\n")
  assert.match(failures, /case "openai-boxes-glossary-golden": reference match ratio 0\.500 is below the required 1\.000/)
  assert.match(failures, /reference mismatch for box b2: expected "Hãy chiến đấu như một Chú thuật sư\." but got "Hãy chiến đấu với tư cách một Chú thuật sư\."/)
  const failed = caseById(report, "openai-boxes-glossary-golden")
  assert.equal(failed.status, "fail")
  assert.equal(failed.metrics.referenceMatches.mismatches.length, 1)
})

test("dropping an approved glossary term lowers compliance and fails the gate", async (t) => {
  const folder = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "openai-boxes-glossary-golden")
    target.script[0].reply.choices[0].message.content = JSON.stringify({
      lines: [
        { id: "B1", text: "Kẻ mạnh nhất." },
        { id: "B2", text: "Chiến đấu đi." },
      ],
    })
  })
  const report = await evaluateAgentCorpus({ fixturesDirectory: folder })
  const failed = caseById(report, "openai-boxes-glossary-golden")
  assert.equal(failed.metrics.glossaryCompliance, 0)
  assert.deepEqual(failed.metrics.glossary.missingTerms, [
    { boxId: "b1", term: "Gojo Satoru" },
    { boxId: "b2", term: "Chú thuật sư" },
  ])
  assert.match(failed.failures.join("\n"), /glossary compliance 0\.000 is below the required 1\.000/)
  assert.match(failed.failures.join("\n"), /reference match ratio 0\.000 is below the required 1\.000/)
})

test("a wrong expected tool call fails precision, recall and order with named calls", async (t) => {
  const folder = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "openai-agent-update-boxes")
    target.expected.toolCalls[2] = { name: "update_box", args: { boxId: "b9", text: "Đi thôi." } }
  })
  const report = await evaluateAgentCorpus({ fixturesDirectory: folder })
  assert.equal(report.gates.passed, false)
  const failures = caseById(report, "openai-agent-update-boxes").failures.join("\n")
  assert.match(failures, /tool precision 0\.667 is below the required 1\.000/)
  assert.match(failures, /tool recall 0\.667 is below the required 1\.000/)
  assert.match(failures, /tool call order does not match the expected sequence/)
  assert.match(failures, /missing expected tool call update_box\(\{"boxId":"b9","text":"Đi thôi\."\}\)/)
  assert.match(failures, /unexpected tool call update_box\(\{"boxId":"b2","text":"Đi thôi\."\}\)/)
})

test("the CLI exits non-zero for a broken corpus and writes an actionable report", async (t) => {
  const outlet = await mkdtemp(path.join(os.tmpdir(), "nixio-agent-eval-out-"))
  t.after(() => rm(outlet, { recursive: true, force: true }))
  const passingCorpus = await tempCorpus(t)
  const passingReport = path.join(outlet, "passing.json")
  const passing = spawnSync(process.execPath, [cli, "--fixtures", passingCorpus, "--output", passingReport], {
    cwd: root,
    encoding: "utf8",
  })
  assert.equal(passing.status, 0, passing.stderr)
  assert.match(passing.stdout, /5\/5 cases passed/)
  assert.equal(JSON.parse(await readFile(passingReport, "utf8")).gates.passed, true)

  const broken = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "gemini-agent-audit-parallel")
    target.expected.toolCalls = [{ name: "list_boxes", args: {} }]
  })
  const failingReport = path.join(outlet, "failing.json")
  const failing = spawnSync(process.execPath, [cli, "--fixtures", broken, "--output", failingReport], {
    cwd: root,
    encoding: "utf8",
  })
  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /FAIL case "gemini-agent-audit-parallel": tool precision 0\.500 is below the required 1\.000/)
  assert.match(failing.stderr, /unexpected tool call lint_chapter_qa\(\{\}\)/)
  assert.match(failing.stdout, /4\/5 cases passed, 1 failed/)
  const report = JSON.parse(await readFile(failingReport, "utf8"))
  assert.equal(report.gates.passed, false)
  assert.equal(report.totals.failed, 1)
  assert.ok(report.gates.failures.length >= 2)
})

test("the simulated provider refuses real endpoints and detects extra or unused exchanges", async () => {
  const provider = createSimulatedProvider({
    id: "guard",
    provider: "openai",
    script: [{ reply: { choices: [{ message: { content: "{}" } }] } }],
  })
  await assert.rejects(
    () => provider.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" }),
    error => error.code === EVAL_NETWORK_BLOCKED && /api\.openai\.com/.test(error.message),
  )
  await assert.rejects(
    () => provider.fetch("http://localhost:11434/v1/models", { method: "POST", body: "{}" }),
    { code: EVAL_NETWORK_BLOCKED },
  )
  const served = await provider.fetch("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "fixture-model" }),
  })
  assert.equal(served.status, 200)
  await assert.rejects(
    () => provider.fetch("http://localhost:11434/v1/chat/completions", { method: "POST", body: "{}" }),
    /unexpected provider request #2/,
  )
  assert.throws(() => provider.assertConsumed(), { code: EVAL_NETWORK_BLOCKED })

  const unused = createSimulatedProvider({
    id: "unused",
    provider: "gemini",
    script: [{ status: 503 }, { reply: { candidates: [] } }],
  })
  await unused.fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent", {
    method: "POST",
    body: "{}",
  })
  assert.throws(() => unused.assertConsumed(), { code: EVAL_SCRIPT_UNUSED, message: /1 fixture response\(s\) were never requested/ })
})

test("an unused or missing simulated response fails a case instead of passing silently", async (t) => {
  const extra = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "gemini-agent-audit-parallel")
    target.script.push({ reply: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thừa" }] } }] } })
  })
  const extraReport = await evaluateAgentCorpus({ fixturesDirectory: extra })
  const unusedCase = caseById(extraReport, "gemini-agent-audit-parallel")
  assert.equal(unusedCase.status, "fail")
  assert.match(unusedCase.failures.join("\n"), /used 2\/3 simulated provider response\(s\): 1 fixture response\(s\) were never requested/)

  const missing = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "openai-agent-update-boxes")
    target.script.pop()
  })
  const missingReport = await evaluateAgentCorpus({ fixturesDirectory: missing })
  const truncatedCase = caseById(missingReport, "openai-agent-update-boxes")
  assert.equal(truncatedCase.status, "fail")
  assert.match(truncatedCase.failures.join("\n"), /unexpected provider request #3 to http:\/\/localhost:11434\/v1\/chat\/completions/)
})

test("a step count different from the golden expectation fails even within the budget", async (t) => {
  const folder = await tempCorpus(t, (manifest) => {
    const target = manifest.cases.find(item => item.id === "gemini-boxes-retry-golden")
    target.expected.steps = 1
  })
  const report = await evaluateAgentCorpus({ fixturesDirectory: folder })
  const result = caseById(report, "gemini-boxes-retry-golden")
  assert.equal(result.status, "fail")
  assert.ok(result.failures.includes("used 2 step(s) but expected 1"))
})

test("cases without usage metadata report tokens unavailable instead of a made-up cost", async (t) => {
  const folder = await tempCorpus(t, (manifest) => {
    delete manifest.testRates
    const target = manifest.cases.find(item => item.id === "openai-boxes-glossary-golden")
    delete target.script[0].reply.usage
  })
  const report = await evaluateAgentCorpus({ fixturesDirectory: folder })
  const item = caseById(report, "openai-boxes-glossary-golden")
  assert.equal(item.status, "pass")
  assert.equal(item.tokens.available, false)
  assert.equal(item.tokens.totalTokens, null)
  assert.equal(item.tokens.estimatedCostUsd, null)
  assert.match(item.tokens.note, /unavailable/)
  assert.equal(report.totals.estimatedCostUsd, null)
  assert.match(formatSummary(report), /estimated unavailable at fixture test rates/)
})

test("the stub tool registry exposes only fixture tools and hides writes without edit permission", async () => {
  const manifest = await loadCorpus()
  const agentCase = manifest.cases.find(item => item.kind === "agent")
  const registry = createStubToolRegistry(agentCase)
  assert.deepEqual(registry.definitions({ allowEdits: true }).map(tool => tool.name), agentCase.tools.map(tool => tool.name))
  assert.deepEqual(
    registry.definitions({ allowEdits: false, planMode: true }).map(tool => tool.name),
    agentCase.tools.filter(tool => tool.category !== "write").map(tool => tool.name),
  )
  const unknown = await registry.execute("delete_box", {})
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /Công cụ không tồn tại: delete_box/)
  assert.equal(registry.calls.length, 0)
  const allowed = await registry.execute("list_boxes", { pageIndex: 1 })
  assert.equal(allowed.ok, true)
  assert.deepEqual(registry.calls, [{ name: "list_boxes", args: { pageIndex: 1 } }])
})

test("verify CI runs the offline eval after the visual comparison and uploads the report", async () => {
  const workflow = await readFile(path.join(root, ".github", "workflows", "verify.yml"), "utf8")
  const visual = workflow.indexOf("Compare visual baselines")
  const evaluation = workflow.indexOf("Evaluate agent output")
  assert.ok(visual > 0, "the visual comparison step is missing")
  assert.ok(evaluation > visual, "the agent eval step must run after the visual comparison")
  assert.match(workflow, /run: npm run eval:agent -- --output artifacts\/agent-eval\.json/)
  assert.match(workflow, /name: agent-eval-\$\{\{ runner\.os \}\}/)
  assert.match(workflow, /path: artifacts\/agent-eval\.json/)
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.equal(manifest.scripts["eval:agent"], "node scripts/agent-eval.mjs")
})
